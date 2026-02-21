"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { BlockRenderer, useMarkdown } from "@create-markdown/react";

const MAX_MESSAGE_LENGTH = 2000;

const MODEL = "gpt-5.2" as const;
const BENCH_MODEL = "gpt-5-mini" as const;

const RETRIEVAL_STRATEGIES = [
  { id: "auto", name: "Auto", description: "Query, Retrieval, Hybrid" },
  { id: "hybrid", name: "Hybrid", description: "Semantic, Keyword, Hybrid" },
  { id: "semantic", name: "Semantic", description: "Meaning, Semantic" },
  { id: "keyword", name: "Keyword", description: "Exact Match, Keywords, Keyword" },
] as const;

type RetrievalStrategy = (typeof RETRIEVAL_STRATEGIES)[number]["id"];

const MAX_HISTORY = 5;

type DiagSnapshot = {
  query: string;
  relevanceRank: number;
  strategy: string;
  latencyMs: number;
  isDocsResponse: boolean;
};

const BENCHMARK_THRESHOLDS = [0.0, 0.33, 0.66, 1.0] as const;
const MAX_BENCH_RUNS = 50;

type BenchmarkResult = {
  threshold: number;
  relevanceRank: number;
  strategy: string;
  latencyMs: number;
  isDocsResponse: boolean;
  responseText: string;
  model: string;
};

export default function ChatForm() {
  const [message, setMessage] = useState("");
  const { blocks, setMarkdown } = useMarkdown("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState<RetrievalStrategy>("auto");
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.3);
  const [diagnostics, setDiagnostics] = useState<{
    relevanceRank: string;
    lowConfidence: string;
    strategy: string;
    latencyMs: string;
  } | null>(null);
  const [rawResponse, setRawResponse] = useState("");
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<DiagSnapshot[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>([]);
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [benchmarkProgress, setBenchmarkProgress] = useState(0);
  const [benchExpanded, setBenchExpanded] = useState<Set<number>>(new Set());
  const [winTally, setWinTally] = useState<Record<number, number>>({});
  const [benchRunCount, setBenchRunCount] = useState(0);
  const [benchWinner, setBenchWinner] = useState<number | null>(null);
  const [benchRegenerating, setBenchRegenerating] = useState<number | null>(null);
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

  const handleBenchmark = useCallback(async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || isBenchmarking || isLoading) return;

    setIsBenchmarking(true);
    setBenchmarkProgress(0);
    setBenchmarkResults([]);
    setBenchExpanded(new Set());
    setBenchWinner(null);

    const results: BenchmarkResult[] = [];

    for (let i = 0; i < BENCHMARK_THRESHOLDS.length; i++) {
      const threshold = BENCHMARK_THRESHOLDS[i];
      setBenchmarkProgress(i + 1);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmedMessage,
            model: BENCH_MODEL,
            retrieval: selectedStrategy,
            confidenceThreshold: threshold,
          }),
        });

        if (!res.ok) continue;

        const retrievalMs = parseInt(res.headers.get("X-Retrieval-Ms") || "0", 10);
        const rerankMs = parseInt(res.headers.get("X-Rerank-Ms") || "0", 10);

        let responseText = "";
        const reader = res.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let chunk;
          while (!(chunk = await reader.read()).done) {
            responseText += decoder.decode(chunk.value, { stream: true });
          }
        }

        results.push({
          threshold,
          relevanceRank: parseInt(res.headers.get("X-Relevance-Rank") || "0", 10),
          strategy: res.headers.get("X-Strategy") || "—",
          latencyMs: retrievalMs + rerankMs,
          isDocsResponse: res.headers.get("X-Low-Confidence") !== "true",
          responseText,
          model: BENCH_MODEL,
        });
      } catch {
        // Skip failed requests
      }
    }

    results.sort((a, b) => b.relevanceRank - a.relevanceRank || a.latencyMs - b.latencyMs);
    setBenchmarkResults(results);

    if (results.length > 0) {
      setBenchWinner(0);
      const winner = results[0].threshold;
      setWinTally((prev) => ({ ...prev, [winner]: (prev[winner] || 0) + 1 }));
      setBenchRunCount((prev) => prev + 1);
    }

    setIsBenchmarking(false);
  }, [message, isBenchmarking, isLoading, selectedStrategy]);

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
          model: MODEL,
          retrieval: selectedStrategy,
          confidenceThreshold,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setMarkdown(`Error: ${err.error || "Unknown error"}`);
        setIsLoading(false);
        return;
      }

      const retrievalMs = parseInt(res.headers.get("X-Retrieval-Ms") || "0", 10);
      const rerankMs = parseInt(res.headers.get("X-Rerank-Ms") || "0", 10);

      const relevanceRankStr = res.headers.get("X-Relevance-Rank") || "—";
      const lowConfStr = res.headers.get("X-Low-Confidence") || "—";
      const strategyStr = res.headers.get("X-Strategy") || "—";
      const totalLatency = retrievalMs + rerankMs;

      setDiagnostics({
        relevanceRank: relevanceRankStr,
        lowConfidence: lowConfStr,
        strategy: strategyStr,
        latencyMs: totalLatency.toString(),
      });

      setHistory((prev) => {
        const snapshot: DiagSnapshot = {
          query: trimmedMessage.length > 40 ? trimmedMessage.slice(0, 37) + "..." : trimmedMessage,
          relevanceRank: parseInt(relevanceRankStr, 10) || 0,
          strategy: strategyStr,
          latencyMs: totalLatency,
          isDocsResponse: lowConfStr !== "true",
        };
        const next = [...prev, snapshot];
        return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
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

    container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
      if (a.target) return;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
  }, [blocks, isLoading]);

  return (
    <>
      <div className="selectors-row">
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
        {!isBenchmarking && benchmarkResults.length === 0 && (
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
              disabled={isLoading}
              className="threshold-slider"
              aria-label="Confidence threshold for general response fallback"
            />
            <div className="threshold-labels">
              <span>Always docs</span>
              <span>Always general</span>
            </div>
          </div>
        )}
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
        <button type="submit" className="chat-btn" disabled={isLoading || isBenchmarking}>
          {isLoading ? "GPT-5.2..." : <>Ask Molty <img src="/logo.svg" alt="" width={20} height={20} className="btn-logo" /></>}
        </button>
        <button
          type="button"
          className={`bench-btn ${isBenchmarking ? "bench-active" : ""}`}
          disabled={isLoading || isBenchmarking || !message.trim() || benchRunCount >= MAX_BENCH_RUNS}
          onClick={handleBenchmark}
          title="Run query at 5 confidence thresholds and compare"
        >
          {isBenchmarking ? (
            <>{benchmarkProgress}/{BENCHMARK_THRESHOLDS.length}</>
          ) : (
            <>Bench</>
          )}
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
      {diagnostics && (() => {
        const prev = history.length >= 2 ? history[history.length - 2] : null;
        const curRank = parseInt(diagnostics.relevanceRank, 10) || 0;
        const curLatency = parseInt(diagnostics.latencyMs, 10) || 0;
        const rankDelta = prev ? curRank - prev.relevanceRank : null;
        const latencyDelta = prev ? curLatency - prev.latencyMs : null;

        const rankLabels: Record<number, string> = {
          5: "Excellent",
          4: "Good",
          3: "Partial",
          2: "Weak",
          1: "Off-topic",
        };

        return (
          <div className="diagnostics-panel">
            <div className="diagnostics-header">
              <span className="diagnostics-title">Diagnostics</span>
              <span className={`diagnostics-badge ${diagnostics.lowConfidence === "true" ? "badge-general" : "badge-docs"}`}>
                {diagnostics.lowConfidence === "true" ? "General Response" : "Docs Response"}
              </span>
            </div>
            <div className="diagnostics-grid">
              <div className="diag-item">
                <span className="diag-label">Relevance</span>
                <span className="diag-value diag-rank" data-rank={curRank}>
                  {"★".repeat(curRank)}{"☆".repeat(5 - curRank)}
                  <span className="rank-label">{rankLabels[curRank] || "—"}</span>
                  {rankDelta !== null && rankDelta !== 0 && (
                    <span className={`diag-delta ${rankDelta > 0 ? "delta-up" : "delta-down"}`}>
                      {rankDelta > 0 ? "\u25B2" : "\u25BC"} {rankDelta > 0 ? "+" : ""}{rankDelta}
                    </span>
                  )}
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Strategy</span>
                <span className="diag-value">{diagnostics.strategy}</span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Latency</span>
                <span className="diag-value">
                  {diagnostics.latencyMs}ms
                  {latencyDelta !== null && (
                    <span className={`diag-delta ${latencyDelta <= 0 ? "delta-up" : "delta-down"}`}>
                      {latencyDelta <= 0 ? "\u25BC" : "\u25B2"} {latencyDelta >= 0 ? "+" : ""}{latencyDelta}ms
                    </span>
                  )}
                </span>
              </div>
            </div>
            {history.length > 1 && (
              <>
                <button
                  type="button"
                  className="history-toggle"
                  onClick={() => setHistoryOpen((o) => !o)}
                >
                  History ({history.length}/{MAX_HISTORY})
                  <span className={`history-chevron ${historyOpen ? "open" : ""}`}>{"\u25B6"}</span>
                </button>
                {historyOpen && (
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Query</th>
                        <th>Rank</th>
                        <th>Strategy</th>
                        <th>Latency</th>
                        <th>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...history].reverse().map((h, i) => (
                        <tr key={history.length - i}>
                          <td>{history.length - i}</td>
                          <td className="history-query">{h.query}</td>
                          <td>{"★".repeat(h.relevanceRank)}{"☆".repeat(5 - h.relevanceRank)}</td>
                          <td>{h.strategy}</td>
                          <td>{h.latencyMs}ms</td>
                          <td>
                            <span className={`diagnostics-badge ${h.isDocsResponse ? "badge-docs" : "badge-general"}`}>
                              {h.isDocsResponse ? "Docs" : "General"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        );
      })()}
      {(isBenchmarking || benchmarkResults.length > 0) && (() => {
        const allExpanded = benchmarkResults.length > 0 && benchExpanded.size === benchmarkResults.length;

        const toggleRow = (idx: number) => {
          setBenchExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
          });
        };

        const toggleAll = () => {
          if (allExpanded) {
            setBenchExpanded(new Set());
          } else {
            setBenchExpanded(new Set(benchmarkResults.map((_, i) => i)));
          }
        };

        const overrideWinner = (idx: number) => {
          if (benchWinner === null || benchWinner === idx) return;
          const prevThreshold = benchmarkResults[benchWinner].threshold;
          const newThreshold = benchmarkResults[idx].threshold;
          setWinTally((prev) => ({
            ...prev,
            [prevThreshold]: Math.max(0, (prev[prevThreshold] || 0) - 1),
            [newThreshold]: (prev[newThreshold] || 0) + 1,
          }));
          setBenchWinner(idx);
        };

        const regenerateWith52 = async (idx: number) => {
          const r = benchmarkResults[idx];
          if (!r || benchRegenerating !== null) return;
          setBenchRegenerating(idx);
          try {
            const res = await fetch("/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: message.trim(),
                model: MODEL,
                retrieval: selectedStrategy,
                confidenceThreshold: r.threshold,
              }),
            });
            if (!res.ok) return;
            const retrievalMs = parseInt(res.headers.get("X-Retrieval-Ms") || "0", 10);
            const rerankMs = parseInt(res.headers.get("X-Rerank-Ms") || "0", 10);
            let responseText = "";
            const reader = res.body?.getReader();
            if (reader) {
              const decoder = new TextDecoder();
              let chunk;
              while (!(chunk = await reader.read()).done) {
                responseText += decoder.decode(chunk.value, { stream: true });
              }
            }
            const updated: BenchmarkResult = {
              threshold: r.threshold,
              relevanceRank: parseInt(res.headers.get("X-Relevance-Rank") || "0", 10),
              strategy: res.headers.get("X-Strategy") || "—",
              latencyMs: retrievalMs + rerankMs,
              isDocsResponse: res.headers.get("X-Low-Confidence") !== "true",
              responseText,
              model: MODEL,
            };
            setBenchmarkResults((prev) => prev.map((item, j) => j === idx ? updated : item));
          } catch {
            // ignore
          } finally {
            setBenchRegenerating(null);
          }
        };

        return (
          <div className="benchmark-panel">
            <div className="diagnostics-header">
              <span className="diagnostics-title">
                Benchmark {isBenchmarking && <span className="bench-progress">({benchmarkProgress}/{BENCHMARK_THRESHOLDS.length})</span>}
              </span>
              {benchmarkResults.length > 0 && !isBenchmarking && (
                <div className="bench-actions">
                  <button type="button" className="bench-clear" onClick={toggleAll}>
                    {allExpanded ? "Collapse All" : "Expand All"}
                  </button>
                  <button type="button" className="bench-clear" onClick={() => { setBenchmarkResults([]); setBenchExpanded(new Set()); setBenchWinner(null); }}>
                    Clear
                  </button>
                </div>
              )}
            </div>
            {isBenchmarking && (
              <div className="bench-progress-bar">
                <div
                  className="bench-progress-fill"
                  style={{ width: `${(benchmarkProgress / BENCHMARK_THRESHOLDS.length) * 100}%` }}
                />
              </div>
            )}
            {benchmarkResults.length > 0 && !isBenchmarking && (
              <div className="bench-results">
                {benchmarkResults.map((r, i) => (
                  <div key={r.threshold} className={`bench-row ${benchWinner === i ? "bench-best" : ""}`}>
                    <div className="bench-row-header-wrap">
                      <button type="button" className="bench-row-header" onClick={() => toggleRow(i)}>
                        <span className="bench-row-rank">#{i + 1}</span>
                        <span className="bench-row-threshold">{r.threshold.toFixed(2)}</span>
                        <span className="diag-rank" data-rank={r.relevanceRank}>
                          {"★".repeat(r.relevanceRank)}{"☆".repeat(5 - r.relevanceRank)}
                        </span>
                        <span className="bench-row-meta">{r.strategy}</span>
                        <span className="bench-row-meta">{r.latencyMs}ms</span>
                        <span className={`diagnostics-badge ${r.isDocsResponse ? "badge-docs" : "badge-general"}`}>
                          {r.isDocsResponse ? "Docs" : "General"}
                        </span>
                        <span className={`history-chevron ${benchExpanded.has(i) ? "open" : ""}`}>{"\u25B6"}</span>
                      </button>
                      <button
                        type="button"
                        className={`bench-override-btn ${benchWinner === i ? "override-active" : ""}`}
                        onClick={(e) => { e.stopPropagation(); overrideWinner(i); }}
                        title={benchWinner === i ? "Current winner" : "Override: pick this as winner"}
                        disabled={benchWinner === i}
                      >
                        {benchWinner === i ? "👑" : "Pick"}
                      </button>
                    </div>
                    {benchExpanded.has(i) && (
                      <div className="bench-row-response markdown-body">
                        <div className="bench-response-toolbar">
                          <span className="bench-model-tag">{r.model}</span>
                          {r.model !== MODEL && (
                            <button
                              type="button"
                              className="bench-regen-btn"
                              disabled={benchRegenerating !== null}
                              onClick={() => regenerateWith52(i)}
                              title="Regenerate this result using GPT-5.2"
                            >
                              {benchRegenerating === i ? "..." : "5.2"}
                            </button>
                          )}
                        </div>
                        <pre>{r.responseText || "(empty response)"}</pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      {benchRunCount > 0 && (() => {
        const sorted = BENCHMARK_THRESHOLDS
          .map((t) => ({ threshold: t, wins: winTally[t] || 0 }))
          .sort((a, b) => b.wins - a.wins);
        const maxWins = sorted[0]?.wins || 1;

        return (
          <div className="tally-panel">
            <div className="diagnostics-header">
              <span className="diagnostics-title">
                Win Tally <span className="bench-progress">({benchRunCount}/{MAX_BENCH_RUNS} runs)</span>
              </span>
              <button
                type="button"
                className="bench-clear"
                onClick={() => { setWinTally({}); setBenchRunCount(0); }}
              >
                Reset
              </button>
            </div>
            <div className="tally-rows">
              {sorted.map((entry) => (
                <div key={entry.threshold} className={`tally-row ${entry.wins === maxWins && entry.wins > 0 ? "tally-leader" : ""}`}>
                  <span className="tally-threshold">{entry.threshold.toFixed(2)}</span>
                  <div className="tally-bar-track">
                    <div
                      className="tally-bar-fill"
                      style={{ width: `${(entry.wins / maxWins) * 100}%` }}
                    />
                  </div>
                  <span className="tally-count">{entry.wins}</span>
                </div>
              ))}
            </div>
            {benchRunCount >= MAX_BENCH_RUNS && (
              <div className="tally-cap">Limit reached ({MAX_BENCH_RUNS} runs). Reset to continue.</div>
            )}
          </div>
        );
      })()}
    </>
  );
}
