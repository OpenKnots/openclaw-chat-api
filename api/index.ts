/**
 * Hono-based API for docs-chat.
 * Handles RAG-based question answering with streaming responses.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { handle } from "hono/vercel";
import { Embeddings } from "../rag/embeddings.js";
import { DocsStore } from "../rag/store-upstash.js";
import { Retriever } from "../rag/retriever-upstash.js";
import { checkRateLimit, getClientIp } from "../rag/ratelimit.js";

const MAX_MESSAGE_LENGTH = 2000;

const app = new Hono().basePath("/");

// CORS middleware for all routes
app.use("*", cors());

// Health check endpoint
app.get("/health", async (c) => {
  try {
    const store = new DocsStore();
    const count = await store.count();
    return c.json({ ok: true, chunks: count, mode: "upstash-vector" });
  } catch (err) {
    console.error("Health check error:", err);
    return c.json({ ok: false, error: "Failed to connect to vector store" }, 500);
  }
});

// Chat endpoint with streaming
app.post("/chat", async (c) => {
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
      return c.json({ error: "Too many requests. Please try again later." }, 429);
    }
  }

  // Validate environment
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Server configuration error" }, 500);
  }

  // Parse body
  let message = "";
  try {
    const body = await c.req.json();
    message = body?.message;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!message || typeof message !== "string") {
    return c.json({ error: "message required" }, 400);
  }

  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return c.json({ error: "message required" }, 400);
  }

  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    return c.json(
      { error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` },
      400
    );
  }

  try {
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
              await s.write(delta);
            }
          } catch {
            // Ignore malformed SSE lines
          }
        }
      }
    });
  } catch (err) {
    console.error("Chat error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Catch-all returns health status
app.all("*", async (c) => {
  try {
    const store = new DocsStore();
    const count = await store.count();
    return c.json({ ok: true, chunks: count, mode: "upstash-vector" });
  } catch (err) {
    console.error("Health check error:", err);
    return c.json({ ok: false, error: "Failed to connect to vector store" }, 500);
  }
});

export default handle(app);
