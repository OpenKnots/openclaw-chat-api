/**
 * Chat Endpoint
 * Handles RAG-based question answering with streaming responses.
 */
import { NextRequest } from "next/server";
import { Embeddings } from "@/rag/embeddings";
import { DocsStore } from "@/rag/store-upstash";
import { Retriever } from "@/rag/retriever-upstash";
import { checkRateLimit, getClientIp } from "@/rag/ratelimit";

export const runtime = "edge";

const MAX_MESSAGE_LENGTH = 2000;

const ALLOWED_ORIGINS = [
  "https://docs.openclaw.ai",
  "https://claw-api.openknot.ai",
  "https://claw.openknot.ai"
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// Handle preflight requests
export async function OPTIONS(request: NextRequest) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request),
  });
}

function jsonResponse(
  request: NextRequest,
  data: object,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(request),
      ...headers,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const headersObj: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headersObj[key] = value;
    });
    const clientIp = getClientIp(headersObj);
    const rateLimitResult = await checkRateLimit(clientIp);

    const rateLimitHeaders: Record<string, string> = {};
    if (rateLimitResult) {
      rateLimitHeaders["X-RateLimit-Limit"] = rateLimitResult.limit.toString();
      rateLimitHeaders["X-RateLimit-Remaining"] = rateLimitResult.remaining.toString();
      rateLimitHeaders["X-RateLimit-Reset"] = rateLimitResult.reset.toString();

      if (!rateLimitResult.success) {
        rateLimitHeaders["Retry-After"] = Math.ceil(
          (rateLimitResult.reset - Date.now()) / 1000
        ).toString();
        return jsonResponse(
          request as NextRequest,
          { error: "Too many requests. Please try again later.", status: 429 },
          429,
          rateLimitHeaders
        );
      }
    }

    // Validate environment
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return jsonResponse(
        request as NextRequest,
        { error: "Server configuration error", status: 500 },
        500,
        rateLimitHeaders
      );
    }

    // Parse body
    let message = "";
    try {
      const body = await request.json();
      message = body?.message;
    } catch {
      return jsonResponse(
        request as NextRequest,
        { error: "Invalid JSON", status: 400 },
        400,
        rateLimitHeaders
      );
    }

    if (!message || typeof message !== "string") {
      return jsonResponse(
        request as NextRequest,
        { error: "message required", status: 400 },
        400,
        rateLimitHeaders
      );
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return jsonResponse(
        request as NextRequest,
        { error: "message required", status: 400 },
        400,
        rateLimitHeaders
      );
    }

    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse(
        request as NextRequest,
        { error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`, status: 400 },
        400,
        rateLimitHeaders
      );
    }

    // Initialize RAG components
    const embeddings = new Embeddings(apiKey);
    const store = new DocsStore();
    const retriever = new Retriever(store, embeddings);

    // Retrieve relevant docs
    const results = await retriever.retrieve(trimmedMessage, 8);

    if (results.length === 0) {
      return new Response(
        "I couldn't find relevant documentation excerpts for that question. Try rephrasing or search the docs.",
        { headers: { "Content-Type": "text/plain", ...getCorsHeaders(request), ...rateLimitHeaders } }
      );
    }

    // Build context from retrieved chunks
    const context = results
      .map(
        (result) =>
          `[${result.chunk.title}](${result.chunk.url})\n${result.chunk.content.slice(0, 1200)}`
      )
      .join("\n\n---\n\n");

    const systemPrompt =
      "You are a helpful assistant for OpenClaw documentation. " +
      "Answer only from the provided documentation excerpts. " +
      "If the answer is not in the excerpts, say so and suggest checking the docs. " +
      "Cite sources by name or URL when relevant.\n\nDocumentation excerpts:\n" +
      context;

    // Stream response from OpenAI
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: trimmedMessage },
        ],
      }),
    });

    if (!openaiResponse.ok || !openaiResponse.body) {
      return jsonResponse(
        request as NextRequest,
        { error: `OpenAI API error: ${openaiResponse.status}`, status: 502 },
        502,
        rateLimitHeaders
      );
    }

    // Create a TransformStream to process SSE data
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let buffer = "";

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");

        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              controller.enqueue(encoder.encode(delta));
            }
          } catch {
            // Ignore malformed SSE lines
          }
        }
      },
      flush() {
        // Process any remaining buffered data on stream end
        if (buffer.trim().startsWith("data:")) {
          const data = buffer.trim().slice(5).trim();
          if (data && data !== "[DONE]") {
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                encoder.encode(delta);
              }
            } catch {
              // Ignore
            }
          }
        }
      },
    });

    // Pipe the OpenAI response through our transform
    const readable = openaiResponse.body.pipeThrough(transformStream);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        ...getCorsHeaders(request),
        ...rateLimitHeaders,
      },
    });
  } catch (error) {
    console.error("[Error]", error);
    return jsonResponse(
      request as NextRequest,
      { error: "Internal Server Error", status: 500 },
      500
    );
  }
}
