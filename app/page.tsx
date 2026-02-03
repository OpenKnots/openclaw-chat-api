import { DocsStore } from "@/rag/store-upstash";
import ChatForm from "./components/ChatForm";

async function getStatus() {
  try {
    const store = new DocsStore();
    const count = await store.count();
    return { ok: true, chunks: count };
  } catch {
    return { ok: false, chunks: 0 };
  }
}

export default async function Home() {
  const status = await getStatus();

  return (
    <div className="container">
      <header>
        <div className="logo">
          <svg
            viewBox="0 0 100 100"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
          >
            <circle cx="50" cy="50" r="40" />
            <path d="M30 50 Q50 25 70 50 Q50 75 30 50" strokeWidth="3" />
          </svg>
        </div>
        <h1>OpenClaw</h1>
        <p className="subtitle">Documentation Assistant</p>
      </header>

      <div className="status-bar">
        <div className="status-item">
          <div className={`status-dot ${status.ok ? "online" : "offline"}`} />
          <span className="status-value">{status.ok ? "Online" : "Offline"}</span>
        </div>
        <div className="status-item">
          <span className="status-label">Indexed</span>
          <span className="status-value">{status.chunks.toLocaleString()} chunks</span>
        </div>
        <div className="status-item">
          <span className="status-label">Model</span>
          <span className="status-value">GPT-4o</span>
        </div>
      </div>

      <div className="glass-card chat-section">
        <div className="chat-header">
          <h2>Ask a Question</h2>
        </div>
        <div className="chat-body">
          <ChatForm />
        </div>
      </div>

      <div className="glass-card endpoints-section">
        <div className="chat-header">
          <h2>API Reference</h2>
        </div>
        <div className="endpoint-list">
          <div className="endpoint">
            <span className="method get">GET</span>
            <span className="endpoint-path">/api/health</span>
            <span className="endpoint-desc">Health check &amp; stats</span>
          </div>
          <div className="endpoint">
            <span className="method post">POST</span>
            <span className="endpoint-path">/api/chat</span>
            <span className="endpoint-desc">Streaming chat response</span>
          </div>
          <div className="endpoint">
            <span className="method post">POST</span>
            <span className="endpoint-path">/api/webhook</span>
            <span className="endpoint-desc">GitHub docs webhook</span>
          </div>
        </div>
      </div>

      <footer>
        <div className="footer-links">
          <a href="https://docs.openclaw.ai" target="_blank" rel="noopener noreferrer">
            Documentation
          </a>
          <a href="https://github.com/OpenKnots/openclaw-chat-api" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href="/api/health">API Status</a>
        </div>
        <p className="footer-brand">
          Threaded by{" "}
          <a href="https://github.com/OpenKnots" target="_blank" rel="noopener noreferrer">
            OpenKnot
          </a>
        </p>
      </footer>
    </div>
  );
}
