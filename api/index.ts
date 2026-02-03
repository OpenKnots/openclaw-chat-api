/**
 * Hono-based API for docs-chat.
 * Handles RAG-based question answering with streaming responses.
 * 
 * This follows Hono best practices:
 * - Global error handling with onError
 * - Custom 404 handling with notFound
 * - HTTPException for structured errors
 * - Vercel adapter for serverless deployment
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { stream } from "hono/streaming";
import { handle } from "hono/vercel";
import { HTTPException } from "hono/http-exception";
import { Embeddings } from "../rag/embeddings.js";
import { DocsStore } from "../rag/store-upstash.js";
import { Retriever } from "../rag/retriever-upstash.js";
import { checkRateLimit, getClientIp } from "../rag/ratelimit.js";

const MAX_MESSAGE_LENGTH = 2000;

// Create Hono app
const app = new Hono();

// =============================================================================
// Middleware Stack
// =============================================================================

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

// Pretty JSON middleware - formats JSON responses
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

// Favicon handler - Knot logo
app.get("/favicon.ico", (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="white" stroke-width="4">
    <rect width="100" height="100" fill="#0a0a0a"/>
    <circle cx="50" cy="50" r="35" stroke-width="3"/>
    <path d="M28 50 Q50 25 72 50 Q50 75 28 50" stroke-width="2.5"/>
  </svg>`;
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

// Home page with interactive UI - Glassmorphic black/white design with markdown rendering
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
  <title>OpenClaw | Documentation Assistant</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='none' stroke='white' stroke-width='4'/><path d='M30 50 Q50 30 70 50 Q50 70 30 50' fill='none' stroke='white' stroke-width='3'/></svg>">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root{--bg-primary:#0a0a0a;--bg-secondary:#111;--glass-bg:rgba(255,255,255,.03);--glass-border:rgba(255,255,255,.08);--glass-hover:rgba(255,255,255,.06);--text-primary:#fafafa;--text-secondary:#a1a1a1;--text-muted:#666;--accent:#fff;--success:#4ade80;--error:#f87171;--radius:16px;--radius-sm:8px}*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg-primary);min-height:100vh;color:var(--text-primary);line-height:1.6;-webkit-font-smoothing:antialiased}body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px);background-size:60px 60px;pointer-events:none;z-index:-1}.container{max-width:720px;margin:0 auto;padding:3rem 1.5rem}header{text-align:center;margin-bottom:3rem}.logo{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;margin-bottom:1.5rem;border:1px solid var(--glass-border);border-radius:16px;background:var(--glass-bg);backdrop-filter:blur(10px)}.logo svg{width:32px;height:32px}h1{font-size:2rem;font-weight:600;letter-spacing:-.03em;margin-bottom:.5rem}.subtitle{color:var(--text-secondary);font-size:.95rem}.status-bar{display:flex;align-items:center;justify-content:center;gap:2rem;padding:1rem 1.5rem;margin-bottom:2rem;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius);backdrop-filter:blur(10px)}.status-item{display:flex;align-items:center;gap:.5rem;font-size:.85rem}.status-dot{width:8px;height:8px;border-radius:50%;background:\${status.ok?"var(--success)":"var(--error)"};box-shadow:0 0 8px \${status.ok?"var(--success)":"var(--error)"}}.status-label{color:var(--text-muted)}.status-value{color:var(--text-secondary);font-weight:500}.glass-card{background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius);backdrop-filter:blur(10px);overflow:hidden}.chat-section{margin-bottom:2rem}.chat-header{padding:1.25rem 1.5rem;border-bottom:1px solid var(--glass-border)}.chat-header h2{font-size:.85rem;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}.chat-body{padding:1.5rem}.chat-form{display:flex;gap:.75rem}.chat-input{flex:1;padding:.875rem 1rem;border:1px solid var(--glass-border);border-radius:var(--radius-sm);background:rgba(0,0,0,.4);color:var(--text-primary);font-size:.95rem;font-family:inherit;transition:all .2s}.chat-input:focus{outline:none;border-color:rgba(255,255,255,.2);background:rgba(0,0,0,.6)}.chat-input::placeholder{color:var(--text-muted)}.chat-btn{padding:.875rem 1.5rem;background:var(--accent);border:none;border-radius:var(--radius-sm);color:var(--bg-primary);font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s}.chat-btn:hover{opacity:.9;transform:translateY(-1px)}.chat-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}.response-area{margin-top:1.5rem;padding:1.25rem 1.5rem;background:rgba(0,0,0,.3);border:1px solid var(--glass-border);border-radius:var(--radius-sm);display:none;min-height:120px;max-height:500px;overflow-y:auto}.response-area.visible{display:block}.response-area.loading::after{content:'';display:inline-block;width:12px;height:12px;border:2px solid var(--text-muted);border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;margin-left:.5rem}@keyframes spin{to{transform:rotate(360deg)}}.markdown-body{font-size:.95rem;line-height:1.7}.markdown-body p{margin-bottom:1rem}.markdown-body ul,.markdown-body ol{margin-bottom:1rem;padding-left:1.5rem}.markdown-body li{margin-bottom:.5rem}.markdown-body a{color:var(--text-primary);text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--text-muted)}.markdown-body code{font-family:'SF Mono','Fira Code',monospace;font-size:.875em;padding:.2em .4em;background:rgba(255,255,255,.08);border-radius:4px}.markdown-body pre{margin:1rem 0;padding:1rem;background:rgba(0,0,0,.4);border:1px solid var(--glass-border);border-radius:var(--radius-sm);overflow-x:auto}.markdown-body pre code{padding:0;background:none;font-size:.85rem}.endpoints-section{margin-bottom:2rem}.endpoint-list{padding:.5rem 0}.endpoint{display:flex;align-items:center;gap:1rem;padding:1rem 1.5rem;border-bottom:1px solid var(--glass-border);transition:background .2s}.endpoint:last-child{border-bottom:none}.endpoint:hover{background:var(--glass-hover)}.method{padding:.25rem .5rem;border-radius:4px;font-size:.7rem;font-weight:700;font-family:'SF Mono',monospace;text-transform:uppercase}.method.get{background:rgba(74,222,128,.15);color:var(--success)}.method.post{background:rgba(255,255,255,.1);color:var(--text-primary)}.endpoint-path{font-family:'SF Mono',monospace;font-size:.9rem}.endpoint-desc{flex:1;text-align:right;font-size:.85rem;color:var(--text-muted)}footer{text-align:center;padding:2rem 0;border-top:1px solid var(--glass-border)}.footer-links{display:flex;align-items:center;justify-content:center;gap:1.5rem;margin-bottom:.75rem}.footer-links a{color:var(--text-secondary);text-decoration:none;font-size:.85rem;transition:color .2s}.footer-links a:hover{color:var(--text-primary)}.footer-brand{font-size:.8rem;color:var(--text-muted)}.footer-brand a{color:var(--text-muted);text-decoration:none}@media(max-width:640px){.container{padding:2rem 1rem}.status-bar{flex-wrap:wrap;gap:1rem}.chat-form{flex-direction:column}.endpoint{flex-direction:column;align-items:flex-start;gap:.5rem}.endpoint-desc{text-align:left}}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo"><svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="4"><circle cx="50" cy="50" r="40"/><path d="M30 50 Q50 25 70 50 Q50 75 30 50" stroke-width="3"/></svg></div>
      <h1>OpenClaw</h1>
      <p class="subtitle">Documentation Assistant</p>
    </header>
    <div class="status-bar">
      <div class="status-item"><div class="status-dot"></div><span class="status-value">\${status.ok?"Online":"Offline"}</span></div>
      <div class="status-item"><span class="status-label">Indexed</span><span class="status-value">\${status.chunks.toLocaleString()} chunks</span></div>
      <div class="status-item"><span class="status-label">Model</span><span class="status-value">GPT-4o</span></div>
    </div>
    <div class="glass-card chat-section">
      <div class="chat-header"><h2>Ask a Question</h2></div>
      <div class="chat-body">
        <form class="chat-form" id="chatForm">
          <input type="text" class="chat-input" id="messageInput" placeholder="How do I get started with OpenClaw?" maxlength="\${MAX_MESSAGE_LENGTH}" autocomplete="off" required>
          <button type="submit" class="chat-btn" id="submitBtn">Ask</button>
        </form>
        <div class="response-area" id="response"><div class="markdown-body" id="markdownContent"></div></div>
      </div>
    </div>
    <div class="glass-card endpoints-section">
      <div class="chat-header"><h2>API Reference</h2></div>
      <div class="endpoint-list">
        <div class="endpoint"><span class="method get">GET</span><span class="endpoint-path">/health</span><span class="endpoint-desc">Health check & stats</span></div>
        <div class="endpoint"><span class="method post">POST</span><span class="endpoint-path">/chat</span><span class="endpoint-desc">Streaming chat response</span></div>
        <div class="endpoint"><span class="method post">POST</span><span class="endpoint-path">/api/webhook</span><span class="endpoint-desc">GitHub docs webhook</span></div>
      </div>
    </div>
    <footer>
      <div class="footer-links"><a href="https://docs.openclaw.ai" target="_blank">Documentation</a><a href="https://github.com/OpenKnots/openclaw-chat-api" target="_blank">GitHub</a><a href="/health">API Status</a></div>
      <p class="footer-brand">Threaded by <a href="https://github.com/OpenKnots" target="_blank">OpenKnot</a></p>
    </footer>
  </div>
  <script>
    marked.setOptions({breaks:true,gfm:true,headerIds:false,mangle:false});
    const form=document.getElementById('chatForm'),input=document.getElementById('messageInput'),responseArea=document.getElementById('response'),markdownContent=document.getElementById('markdownContent'),submitBtn=document.getElementById('submitBtn');
    let rawText='';
    form.addEventListener('submit',async e=>{e.preventDefault();const message=input.value.trim();if(!message)return;submitBtn.disabled=true;submitBtn.textContent='Thinking...';responseArea.classList.add('visible','loading');markdownContent.innerHTML='';rawText='';try{const res=await fetch('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message})});responseArea.classList.remove('loading');if(!res.ok){const err=await res.json();markdownContent.innerHTML='<p style="color:var(--error)">Error: '+(err.error||'Unknown error')+'</p>';return}const reader=res.body.getReader(),decoder=new TextDecoder();while(true){const{done,value}=await reader.read();if(done)break;rawText+=decoder.decode(value,{stream:true});markdownContent.innerHTML=marked.parse(rawText);responseArea.scrollTop=responseArea.scrollHeight}markdownContent.innerHTML=marked.parse(rawText)}catch(err){responseArea.classList.remove('loading');markdownContent.innerHTML='<p style="color:var(--error)">Error: '+err.message+'</p>'}finally{submitBtn.disabled=false;submitBtn.textContent='Ask'}});
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
// Vercel Export
// =============================================================================

// Export handlers for Vercel serverless functions
const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
export const OPTIONS = handler;
export default handler;
