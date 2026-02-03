/**
 * Vercel serverless function for docs-chat API.
 * Handles RAG-based question answering with streaming responses.
 *
 * Environment variables:
 *   OPENAI_API_KEY - for embeddings and chat completions
 *   UPSTASH_VECTOR_REST_URL - Upstash Vector endpoint
 *   UPSTASH_VECTOR_REST_TOKEN - Upstash Vector auth token
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Embeddings } from "../rag/embeddings.js";
import { DocsStore } from "../rag/store-upstash.js";
import { Retriever } from "../rag/retriever-upstash.js";

const MAX_MESSAGE_LENGTH = 2000;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(
  res: VercelResponse,
  status: number,
  body: Record<string, unknown>,
) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  res.status(status).json(body);
}

async function streamOpenAI(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  res: VercelResponse,
) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(`OpenAI ${response.status}: ${errorText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          res.write(delta);
        }
      } catch {
        // Ignore malformed SSE lines
      }
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    res.status(204).end();
    return;
  }

  // Only accept POST
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Validate environment
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: "Server configuration error" });
    return;
  }

  // Parse body
  let message = "";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    message = body?.message;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (!message || typeof message !== "string") {
    sendJson(res, 400, { error: "message required" });
    return;
  }

  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    sendJson(res, 400, { error: "message required" });
    return;
  }

  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    sendJson(res, 400, {
      error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`,
    });
    return;
  }

  try {
    // Initialize RAG components
    const embeddings = new Embeddings(apiKey);
    const store = new DocsStore();
    const retriever = new Retriever(store, embeddings);

    // Retrieve relevant docs
    const results = await retriever.retrieve(trimmedMessage, 8);

    if (results.length === 0) {
      Object.entries(corsHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.status(200).send(
        "I couldn't find relevant documentation excerpts for that question. Try rephrasing or search the docs.",
      );
      return;
    }

    // Build context from retrieved chunks
    const context = results
      .map(
        (result) =>
          `[${result.chunk.title}](${result.chunk.url})\n${result.chunk.content.slice(0, 1200)}`,
      )
      .join("\n\n---\n\n");

    const systemPrompt =
      "You are a helpful assistant for OpenClaw documentation. " +
      "Answer only from the provided documentation excerpts. " +
      "If the answer is not in the excerpts, say so and suggest checking the docs. " +
      "Cite sources by name or URL when relevant.\n\nDocumentation excerpts:\n" +
      context;

    // Set up streaming response
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    await streamOpenAI(apiKey, systemPrompt, trimmedMessage, res);
    res.end();
  } catch (err) {
    console.error("Chat error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    } else {
      res.end("\n\n[Error processing request]");
    }
  }
}
