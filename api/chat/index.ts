/**
 * Chat Endpoint
 * Handles RAG-based question answering with streaming responses.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { handle } from "hono/vercel";
import { HTTPException } from "hono/http-exception";
import { Embeddings } from "../../rag/embeddings.js";
import { DocsStore } from "../../rag/store-upstash.js";
import { Retriever } from "../../rag/retriever-upstash.js";
import { checkRateLimit, getClientIp } from "../../rag/ratelimit.js";

const MAX_MESSAGE_LENGTH = 2000;

const app = new Hono();

// CORS middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ?? [];
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin || allowedOrigins.length === 0) return origin ?? "*";
      return allowedOrigins.includes(origin) ? origin : null;
    },
  })
);

// Error handler
app.onError((err, c) => {
  console.error(`[Error] ${err.message}`, err.stack);

  if (err instanceof HTTPException) {
    return c.json(
      {
        error: err.message,
        status: err.status,
      },
      err.status
    );
  }

  return c.json(
    {
      error: "Internal Server Error",
    },
    500
  );
});

/**
 * POST /api/chat - Chat endpoint with streaming
 */
app.post("/", async (c) => {
  // Rate limiting
  const clientIp = getClientIp(
    Object.fromEntries(
      [...c.req.raw.headers.entries()].map(([k, v]) => [k, v])
    )
  );
  const rateLimitResult = await checkRateLimit(clientIp);

  if (rateLimitResult) {
    c.header("X-RateLimit-Limit", rateLimitResult.limit.toString());
    c.header("X-RateLimit-Remaining", rateLimitResult.remaining.toString());
    c.header("X-RateLimit-Reset", rateLimitResult.reset.toString());

    if (!rateLimitResult.success) {
      c.header(
        "Retry-After",
        Math.ceil((rateLimitResult.reset - Date.now()) / 1000).toString()
      );
      throw new HTTPException(429, {
        message: "Too many requests. Please try again later.",
      });
    }
  }

  // Validate environment
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new HTTPException(500, {
      message: "Server configuration error",
    });
  }

  // Parse body
  let message = "";
  try {
    const body = await c.req.json();
    message = body?.message;
  } catch {
    throw new HTTPException(400, {
      message: "Invalid JSON",
    });
  }

  if (!message || typeof message !== "string") {
    throw new HTTPException(400, {
      message: "message required",
    });
  }

  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new HTTPException(400, {
      message: "message required",
    });
  }

  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    throw new HTTPException(400, {
      message: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`,
    });
  }

  // Initialize RAG components
  const embeddings = new Embeddings(apiKey);
  const store = new DocsStore();
  const retriever = new Retriever(store, embeddings);

  // Retrieve relevant docs
  const results = await retriever.retrieve(trimmedMessage, 8);

  if (results.length === 0) {
    return c.text(
      "I couldn't find relevant documentation excerpts for that question. Try rephrasing or search the docs."
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
  return stream(c, async (s) => {
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
          { role: "user", content: trimmedMessage },
        ],
      }),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      throw new HTTPException(502, {
        message: `OpenAI API error: ${response.status}`,
      });
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
            await s.write(delta);
          }
        } catch {
          // Ignore malformed SSE lines
        }
      }
    }
  });
});

// Use Edge Runtime for Web API Request compatibility with Hono
export const config = {
  runtime: 'edge',
};

// Export handlers for Vercel
const handler = handle(app);
export const GET = handler;
export const POST = handler;
export default handler;
