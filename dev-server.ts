/**
 * Local development server for testing the API.
 * Uses Hono with Bun for local development.
 * 
 * This follows Hono best practices:
 * - Global error handling with onError
 * - Custom 404 handling with notFound
 * - Logger middleware for development
 * - HTTPException for structured errors
 * - Proper Bun.serve configuration
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { stream } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import { Embeddings } from "./rag/embeddings.js";
import { DocsStore } from "./rag/store-upstash.js";
import { Retriever } from "./rag/retriever-upstash.js";
import { checkRateLimit, getClientIp } from "./rag/ratelimit.js";
import { indexDocs, verifyGitHubSignature, isMainBranchPush } from "./rag/indexer.js";

const MAX_MESSAGE_LENGTH = 2000;

// Create Hono app with base path
const app = new Hono();

// =============================================================================
// Middleware Stack (order matters)
// =============================================================================

// Logger middleware - logs all requests in development
app.use("*", logger());

// CORS middleware - restrict origins via ALLOWED_ORIGINS env var (comma-separated)
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

// Pretty JSON middleware - formats JSON responses in development
app.use("*", prettyJSON());

// Secure headers middleware - adds security headers
app.use("*", secureHeaders());

// =============================================================================
// Global Error Handler
// =============================================================================

app.onError((err, c) => {
  console.error(`[Error] ${err.message}`, err.stack);

  // Handle HTTPException (structured errors)
  if (err instanceof HTTPException) {
    return c.json(
      {
        error: err.message,
        status: err.status,
      },
      err.status
    );
  }

  // Handle other errors
  return c.json(
    {
      error: "Internal Server Error",
      message: process.env.NODE_ENV === "development" ? err.message : undefined,
    },
    500
  );
});

// =============================================================================
// Custom 404 Handler
// =============================================================================

app.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      message: `The endpoint ${c.req.method} ${c.req.path} does not exist`,
      availableEndpoints: {
        "GET /": "Home page with interactive UI",
        "GET /health": "Health check endpoint",
        "POST /chat": "Chat endpoint with streaming response",
      },
    },
    404
  );
});

// =============================================================================
// Routes
// =============================================================================

// Favicon handler (prevents 404)
app.get("/favicon.ico", (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚖️</text></svg>`;
  return c.body(svg, 200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=86400",
  });
});

// Health check endpoint
app.get("/health", async (c) => {
  try {
    const store = new DocsStore();
    const count = await store.count();
    return c.json({ ok: true, chunks: count, mode: "upstash-vector" });
  } catch (err) {
    console.error("Health check error:", err);
    return c.json(
      { ok: false, error: "Failed to connect to vector store" },
      500
    );
  }
});

// Home page with interactive UI
app.get("/", async (c) => {
  let status = { ok: false, chunks: 0, mode: "upstash-vector" };
  try {
    const store = new DocsStore();
    const count = await store.count();
    status = { ok: true, chunks: count, mode: "upstash-vector" };
  } catch {
    // Status remains false
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenClaw Chat API</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚖️</text></svg>">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #e4e4e7;
      line-height: 1.6;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
    }
    header {
      text-align: center;
      padding: 3rem 0 2rem;
    }
    h1 {
      font-size: 2.5rem;
      font-weight: 700;
      background: linear-gradient(90deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: #a1a1aa;
      font-size: 1.1rem;
    }
    .status-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 1.5rem;
      margin: 2rem 0;
    }
    .status-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: ${status.ok ? "#22c55e" : "#ef4444"};
      box-shadow: 0 0 8px ${status.ok ? "#22c55e" : "#ef4444"};
    }
    .status-text {
      font-weight: 600;
      color: ${status.ok ? "#22c55e" : "#ef4444"};
    }
    .status-details {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
    }
    .stat {
      background: rgba(255, 255, 255, 0.03);
      padding: 1rem;
      border-radius: 8px;
      text-align: center;
    }
    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: #60a5fa;
    }
    .stat-label {
      font-size: 0.85rem;
      color: #71717a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .chat-section {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 1.5rem;
      margin: 2rem 0;
    }
    .chat-section h2 {
      font-size: 1.25rem;
      margin-bottom: 1rem;
      color: #e4e4e7;
    }
    .chat-form {
      display: flex;
      gap: 0.75rem;
    }
    .chat-input {
      flex: 1;
      padding: 0.875rem 1rem;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.3);
      color: #e4e4e7;
      font-size: 1rem;
      transition: border-color 0.2s;
    }
    .chat-input:focus {
      outline: none;
      border-color: #60a5fa;
    }
    .chat-input::placeholder {
      color: #71717a;
    }
    .chat-btn {
      padding: 0.875rem 1.5rem;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      border: none;
      border-radius: 8px;
      color: white;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .chat-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
    }
    .chat-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .response-area {
      margin-top: 1rem;
      padding: 1rem;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 8px;
      min-height: 100px;
      display: none;
      white-space: pre-wrap;
      font-family: inherit;
    }
    .response-area.visible {
      display: block;
    }
    .endpoints {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 1.5rem;
    }
    .endpoints h2 {
      font-size: 1.25rem;
      margin-bottom: 1rem;
    }
    .endpoint {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      padding: 1rem 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    .endpoint:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .method {
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .method.get { background: #22c55e; color: #052e16; }
    .method.post { background: #3b82f6; color: #1e3a8a; }
    .endpoint-info h3 {
      font-size: 1rem;
      font-family: 'SF Mono', Monaco, monospace;
      color: #e4e4e7;
      margin-bottom: 0.25rem;
    }
    .endpoint-info p {
      font-size: 0.9rem;
      color: #a1a1aa;
    }
    footer {
      text-align: center;
      padding: 2rem;
      color: #71717a;
      font-size: 0.85rem;
    }
    footer a {
      color: #60a5fa;
      text-decoration: none;
    }
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>OpenClaw Chat API</h1>
      <p class="subtitle">RAG-powered documentation assistant</p>
    </header>

    <div class="status-card">
      <div class="status-header">
        <div class="status-dot"></div>
        <span class="status-text">${status.ok ? "Operational" : "Service Unavailable"}</span>
      </div>
      <div class="status-details">
        <div class="stat">
          <div class="stat-value">${status.chunks.toLocaleString()}</div>
          <div class="stat-label">Doc Chunks</div>
        </div>
        <div class="stat">
          <div class="stat-value">${status.mode.replace("upstash-", "").toUpperCase()}</div>
          <div class="stat-label">Storage</div>
        </div>
        <div class="stat">
          <div class="stat-value">GPT-4o</div>
          <div class="stat-label">Model</div>
        </div>
      </div>
    </div>

    <div class="chat-section">
      <h2>Try It Out</h2>
      <form class="chat-form" id="chatForm">
        <input type="text" class="chat-input" id="messageInput" placeholder="Ask a question about OpenClaw docs..." maxlength="${MAX_MESSAGE_LENGTH}" required>
        <button type="submit" class="chat-btn" id="submitBtn">Send</button>
      </form>
      <div class="response-area" id="response"></div>
    </div>

    <div class="endpoints">
      <h2>API Endpoints</h2>
      <div class="endpoint">
        <span class="method get">GET</span>
        <div class="endpoint-info">
          <h3>/health</h3>
          <p>Health check endpoint. Returns API status and vector store count.</p>
        </div>
      </div>
      <div class="endpoint">
        <span class="method post">POST</span>
        <div class="endpoint-info">
          <h3>/chat</h3>
          <p>Send a message and receive a streaming response. Body: <code>{ "message": "your question" }</code></p>
        </div>
      </div>
    </div>

    <footer>
      <p>Built by <a href="https://github.com/OpenKnots" target="_blank">OpenKnot AI</a> | <a href="https://github.com/OpenKnots/openclaw-chat-api" target="_blank">View on GitHub</a></p>
    </footer>
  </div>

  <script>
    const form = document.getElementById('chatForm');
    const input = document.getElementById('messageInput');
    const response = document.getElementById('response');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const message = input.value.trim();
      if (!message) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';
      response.classList.add('visible');
      response.textContent = '';

      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });

        if (!res.ok) {
          const err = await res.json();
          response.textContent = 'Error: ' + (err.error || 'Unknown error');
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          response.textContent += decoder.decode(value, { stream: true });
        }
      } catch (err) {
        response.textContent = 'Error: ' + err.message;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send';
      }
    });
  </script>
</body>
</html>`;

  return c.html(html);
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

// =============================================================================
// Webhook Routes (for GitHub docs update)
// =============================================================================

// Store indexing status
let indexingStatus = {
  isIndexing: false,
  lastIndexed: null as Date | null,
  lastResult: null as {
    success: boolean;
    pagesProcessed: number;
    chunksCreated: number;
    duration: number;
    errors: string[];
  } | null,
};

// GET /api/webhook - Status endpoint
app.get("/api/webhook", (c) => {
  return c.json({
    status: "ok",
    webhook: "GitHub docs update webhook",
    isIndexing: indexingStatus.isIndexing,
    lastIndexed: indexingStatus.lastIndexed?.toISOString() || null,
    lastResult: indexingStatus.lastResult,
  });
});

// POST /api/reindex - Manual re-index endpoint (development only)
app.post("/api/reindex", async (c) => {
  const isDevelopment = !process.env.NODE_ENV || process.env.NODE_ENV === "development";
  
  if (!isDevelopment) {
    throw new HTTPException(403, {
      message: "Manual re-indexing is only available in development mode",
    });
  }

  // Prevent concurrent indexing
  if (indexingStatus.isIndexing) {
    return c.json({
      status: "skipped",
      message: "Indexing already in progress",
    });
  }

  console.log("Starting manual documentation re-index...");
  indexingStatus.isIndexing = true;

  try {
    const result = await indexDocs();

    indexingStatus.lastIndexed = new Date();
    indexingStatus.lastResult = result;
    indexingStatus.isIndexing = false;

    if (result.success) {
      console.log(`Indexing complete: ${result.chunksCreated} chunks from ${result.pagesProcessed} pages`);
      return c.json({
        status: "success",
        message: "Documentation re-indexed successfully",
        result: {
          pagesProcessed: result.pagesProcessed,
          chunksCreated: result.chunksCreated,
          duration: result.duration,
        },
      });
    } else {
      console.error("Indexing failed:", result.errors);
      return c.json({
        status: "error",
        message: "Indexing failed",
        errors: result.errors,
      }, 500);
    }
  } catch (error) {
    indexingStatus.isIndexing = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Indexing error:", error);
    throw new HTTPException(500, {
      message: `Indexing failed: ${errorMessage}`,
    });
  }
});

// POST /api/webhook - GitHub webhook handler
app.post("/api/webhook", async (c) => {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const isDevelopment = !process.env.NODE_ENV || process.env.NODE_ENV === "development";

  // For development, allow triggering without secret
  if (!webhookSecret && !isDevelopment) {
    console.error("GITHUB_WEBHOOK_SECRET not configured");
    throw new HTTPException(500, {
      message: "Webhook not configured",
    });
  }

  // Get raw body for signature verification
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const event = c.req.header("X-GitHub-Event") ?? null;
  const deliveryId = c.req.header("X-GitHub-Delivery");

  console.log(`Webhook received: event=${event}, delivery=${deliveryId}`);

  // Verify signature (skip in development when no secret is configured)
  if (webhookSecret) {
    if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
      console.error("Invalid webhook signature");
      throw new HTTPException(401, {
        message: "Invalid signature",
      });
    }
  } else if (!isDevelopment) {
    // Already handled above, but double-check
    throw new HTTPException(500, { message: "Webhook not configured" });
  } else {
    console.log("Skipping signature verification (development mode, no secret)");
  }

  // Parse payload
  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new HTTPException(400, {
      message: "Invalid JSON payload",
    });
  }

  // Handle ping event
  if (event === "ping") {
    console.log("Webhook ping received");
    return c.json({
      status: "ok",
      message: "Webhook configured successfully",
    });
  }

  // For development, allow manual trigger without push event check
  if (!isDevelopment && !isMainBranchPush(event, payload)) {
    console.log(`Ignoring event: ${event} (not a main branch push)`);
    return c.json({
      status: "ignored",
      message: "Not a main branch push event",
    });
  }

  // Prevent concurrent indexing
  if (indexingStatus.isIndexing) {
    console.log("Indexing already in progress, skipping");
    return c.json({
      status: "skipped",
      message: "Indexing already in progress",
    });
  }

  // Trigger indexing
  console.log("Starting documentation re-index...");
  indexingStatus.isIndexing = true;

  try {
    const result = await indexDocs();

    indexingStatus.lastIndexed = new Date();
    indexingStatus.lastResult = result;
    indexingStatus.isIndexing = false;

    if (result.success) {
      console.log(`Indexing complete: ${result.chunksCreated} chunks from ${result.pagesProcessed} pages`);
      return c.json({
        status: "success",
        message: "Documentation re-indexed successfully",
        result: {
          pagesProcessed: result.pagesProcessed,
          chunksCreated: result.chunksCreated,
          duration: result.duration,
        },
      });
    } else {
      console.error("Indexing failed:", result.errors);
      return c.json({
        status: "error",
        message: "Indexing failed",
        errors: result.errors,
      }, 500);
    }
  } catch (error) {
    indexingStatus.isIndexing = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Indexing error:", error);
    throw new HTTPException(500, {
      message: `Indexing failed: ${errorMessage}`,
    });
  }
});

// =============================================================================
// Server Configuration
// =============================================================================

const port = parseInt(process.env.PORT || "3000", 10);

console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    OpenClaw Chat API                         ║
║                  Development Server                          ║
╠══════════════════════════════════════════════════════════════╣
║  Local:   http://localhost:${port.toString().padEnd(35)}║
║  Mode:    ${(process.env.NODE_ENV || "development").padEnd(45)}║
╚══════════════════════════════════════════════════════════════╝
`);

// Use Bun.serve with proper configuration
export default {
  port,
  fetch: app.fetch,
  // Enable request IP access for rate limiting
  // Enable larger request bodies if needed
  maxRequestBodySize: 1024 * 1024 * 10, // 10MB
  // Increase idle timeout for long-running operations like indexing (max 255 seconds)
  idleTimeout: 255,
};
