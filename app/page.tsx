import Image from "next/image";
import { DocsStore } from "@/rag/store-upstash";
import ChatForm from "@/app/components/chat-form";

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
      <header className="hero-header">
        <div className="logo-mark">
          <Image
            src="/openknots-logo.png"
            alt="OpenKnots Logo"
            width={40}
            height={40}
            priority
          />
        </div>
        <div className="hero-text">
          <h1>OpenClaw</h1>
          <span className="hero-sep">/</span>
          <span className="hero-tag">Hybrid Search</span>
        </div>
        <span className="hero-badge">by OpenKnots</span>
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
      </div>

      <div className="glass-card chat-section">
        <div className="chat-header">
          <h2>Ask a Question</h2>
        </div>
        <div className="chat-body">
          <ChatForm />
        </div>
      </div>

      {/* <div className="glass-card endpoints-section">
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
      </div> */}

      <footer>
        <a href="https://github.com/OpenKnots" className="footer-brand" target="_blank" rel="noopener noreferrer">
          <Image src="/openknots-logo.png" alt="OpenKnots" width={20} height={20} />
          <span>OpenKnots</span>
        </a>
        <nav className="footer-nav">
          <a href="https://docs.openclaw.ai" target="_blank" rel="noopener noreferrer">Docs</a>
          <a href="https://github.com/OpenKnots/openclaw-chat-api" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="/api/health">Status</a>
        </nav>
        <span className="footer-copy">MIT License</span>
      </footer>
    </div>
  );
}
