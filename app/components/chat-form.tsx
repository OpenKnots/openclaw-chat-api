"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { BlockRenderer, useMarkdown } from "@create-markdown/react";

const MAX_MESSAGE_LENGTH = 2000;

const AVAILABLE_MODELS = [
  { id: "gpt-5-nano", name: "GPT-5 nano", description: "Cheapest, Fastest, Efficient" },
  { id: "gpt-5-mini", name: "GPT-5 mini", description: "Fast, Cost-efficient, Versatile" },
  { id: "gpt-5", name: "GPT-5", description: "Reasoning, Coding, Agentic" },
  { id: "gpt-5.1", name: "GPT-5.1", description: "Advanced, Reasoning, Agentic" },
  { id: "gpt-5.2", name: "GPT-5.2", description: "Flagship, Coding, Agentic" },
] as const;

const RETRIEVAL_STRATEGIES = [
  { id: "auto", name: "Auto", description: "Query, Retrieval, Hybrid" },
  { id: "hybrid", name: "Hybrid", description: "Semantic, Keyword, Hybrid" },
  { id: "semantic", name: "Semantic", description: "Meaning, Semantic" },
  { id: "keyword", name: "Keyword", description: "Exact Match, Keywords, Keyword" },
] as const;

type ModelId = (typeof AVAILABLE_MODELS)[number]["id"];
type RetrievalStrategy = (typeof RETRIEVAL_STRATEGIES)[number]["id"];

export default function ChatForm() {
  const [message, setMessage] = useState("");
  const { blocks, setMarkdown } = useMarkdown("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelId>("gpt-5.2");
  const [selectedStrategy, setSelectedStrategy] = useState<RetrievalStrategy>("auto");
  const [strictMode, setStrictMode] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.3);
  const [diagnostics, setDiagnostics] = useState<{
    bestScore: string;
    threshold: string;
    lowConfidence: string;
    resultCount: string;
    strategy: string;
    intent: string;
    retrievalMs: string;
    rerankMs: string;
  } | null>(null);
  const [rawResponse, setRawResponse] = useState("");
  const [copied, setCopied] = useState(false);
  const responseRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(async () => {
    if (!rawResponse || copied) return;
    try {
      await navigator.clipboard.writeText(rawResponse);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = rawResponse;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [rawResponse, copied]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    setIsLoading(true);
    setIsVisible(true);
    setMarkdown("");
    setRawResponse("");
    setCopied(false);
    setDiagnostics(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedMessage,
          model: selectedModel,
          retrieval: selectedStrategy,
          strict: strictMode,
          confidenceThreshold,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setMarkdown(`Error: ${err.error || "Unknown error"}`);
        setIsLoading(false);
        return;
      }

      setDiagnostics({
        bestScore: res.headers.get("X-Best-Score") || "—",
        threshold: res.headers.get("X-Threshold") || "—",
        lowConfidence: res.headers.get("X-Low-Confidence") || "—",
        resultCount: res.headers.get("X-Result-Count") || "—",
        strategy: res.headers.get("X-Strategy") || "—",
        intent: res.headers.get("X-Intent") || "—",
        retrievalMs: res.headers.get("X-Retrieval-Ms") || "—",
        rerankMs: res.headers.get("X-Rerank-Ms") || "—",
      });

      const reader = res.body?.getReader();
      if (!reader) {
        setMarkdown("Error: No response body");
        setIsLoading(false);
        return;
      }

      const decoder = new TextDecoder();
      let rawText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawText += decoder.decode(value, { stream: true });
        setMarkdown(rawText);
        setRawResponse(rawText);
        if (responseRef.current) {
          responseRef.current.scrollTop = responseRef.current.scrollHeight;
        }
      }
    } catch (err) {
      setMarkdown(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const container = responseRef.current;
    if (!container || isLoading) return;

    const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    container.querySelectorAll<HTMLPreElement>("pre").forEach((pre) => {
      if (pre.querySelector(".code-copy-btn")) return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy-btn";
      btn.title = "Copy code";
      btn.setAttribute("aria-label", "Copy code");
      btn.innerHTML = COPY_ICON;

      btn.addEventListener("click", async () => {
        const code = pre.querySelector("code");
        const text = (code ?? pre).textContent ?? "";
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        btn.innerHTML = CHECK_ICON;
        btn.classList.add("copied");
        setTimeout(() => {
          btn.innerHTML = COPY_ICON;
          btn.classList.remove("copied");
        }, 2000);
      });

      pre.appendChild(btn);
    });
  }, [blocks, isLoading]);

  const currentModel = AVAILABLE_MODELS.find((m) => m.id === selectedModel);

  return (
    <>
      <div className="selectors-row">
        <div className="model-selector">
          <label htmlFor="model-select" className="model-label">
            Model
          </label>
          <select
            id="model-select"
            className="model-select"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value as ModelId)}
            disabled={isLoading}
          >
            {AVAILABLE_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.description})
              </option>
            ))}
          </select>
        </div>
        <div className="model-selector">
          <label htmlFor="strategy-select" className="model-label">
            Search
          </label>
          <select
            id="strategy-select"
            className="model-select"
            value={selectedStrategy}
            onChange={(e) => setSelectedStrategy(e.target.value as RetrievalStrategy)}
            disabled={isLoading}
          >
            {RETRIEVAL_STRATEGIES.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name} ({strategy.description})
              </option>
            ))}
          </select>
        </div>
        <div className="model-selector strict-toggle">
          <label htmlFor="strict-toggle" className="model-label">
            Strict
          </label>
          <label className="toggle-switch">
            <input
              id="strict-toggle"
              type="checkbox"
              checked={strictMode}
              onChange={(e) => setStrictMode(e.target.checked)}
              disabled={isLoading}
              aria-label="Strict mode: docs only, no general knowledge"
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="model-selector threshold-control">
          <label htmlFor="threshold-slider" className="model-label">
            Confidence <span className="threshold-value">{confidenceThreshold.toFixed(2)}</span>
          </label>
          <input
            id="threshold-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={confidenceThreshold}
            onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
            disabled={isLoading || strictMode}
            className="threshold-slider"
            aria-label="Confidence threshold for general response fallback"
          />
          <div className="threshold-labels">
            <span>Always docs</span>
            <span>Always general</span>
          </div>
        </div>
      </div>
      <form className="chat-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="chat-input"
          placeholder="How do I get started with OpenClaw?"
          maxLength={MAX_MESSAGE_LENGTH}
          autoComplete="off"
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button type="submit" className="chat-btn" disabled={isLoading}>
          {isLoading ? `${currentModel?.name}...` : <>Ask Molty <img src="/logo.svg" alt="" width={20} height={20} className="btn-logo" /></>}
        </button>
      </form>
      <div
        ref={responseRef}
        className={`response-area ${isVisible ? "visible" : ""} ${isLoading ? "loading" : ""}`}
      >
        {isVisible && rawResponse && !isLoading && (
          <button
            type="button"
            className={`copy-btn ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            aria-label={copied ? "Copied" : "Copy response"}
            title={copied ? "Copied!" : "Copy"}
          >
            {copied ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        )}
        <div className="markdown-body">
          <BlockRenderer blocks={blocks} />
        </div>
      </div>
      {diagnostics && (
        <div className="diagnostics-panel">
          <div className="diagnostics-header">
            <span className="diagnostics-title">Diagnostics</span>
            <span className={`diagnostics-badge ${diagnostics.lowConfidence === "true" ? "badge-general" : "badge-docs"}`}>
              {diagnostics.lowConfidence === "true" ? "General Response" : "Docs Response"}
            </span>
          </div>
          <div className="diagnostics-grid">
            <div className="diag-item">
              <span className="diag-label">Best Score</span>
              <span className="diag-value diag-score">{diagnostics.bestScore}</span>
            </div>
            <div className="diag-item">
              <span className="diag-label">Threshold</span>
              <span className="diag-value">{diagnostics.threshold}</span>
            </div>
            <div className="diag-item">
              <span className="diag-label">Results</span>
              <span className="diag-value">{diagnostics.resultCount}</span>
            </div>
            <div className="diag-item">
              <span className="diag-label">Strategy</span>
              <span className="diag-value">{diagnostics.strategy}</span>
            </div>
            <div className="diag-item">
              <span className="diag-label">Intent</span>
              <span className="diag-value">{diagnostics.intent}</span>
            </div>
            <div className="diag-item">
              <span className="diag-label">Retrieval</span>
              <span className="diag-value">{diagnostics.retrievalMs}ms</span>
            </div>
            <div className="diag-item">
              <span className="diag-label">Rerank</span>
              <span className="diag-value">{diagnostics.rerankMs}ms</span>
            </div>
            <div className="diag-item diag-verdict">
              <span className="diag-label">Verdict</span>
              <span className="diag-value">
                {parseFloat(diagnostics.bestScore) >= parseFloat(diagnostics.threshold)
                  ? `${diagnostics.bestScore} >= ${diagnostics.threshold} → Docs`
                  : `${diagnostics.bestScore} < ${diagnostics.threshold} → General`}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
