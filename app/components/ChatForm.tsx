"use client";

import { useState, useRef } from "react";
import ReactMarkdown from "react-markdown";

const MAX_MESSAGE_LENGTH = 2000;

const AVAILABLE_MODELS = [
  { id: "gpt-5-nano", name: "GPT-5 nano", description: "Cheapest" },
  { id: "gpt-4.1-nano", name: "GPT-4.1 nano", description: "Great with retrieval" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 mini", description: "Fast & capable" },
  { id: "gpt-4o-mini", name: "GPT-4o mini", description: "Quality/latency/value" },
  { id: "gpt-5-mini", name: "GPT-5 mini", description: "Better headroom" },
  { id: "gpt-5.2", name: "GPT-5.2", description: "Hard questions" },
] as const;

type ModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export default function ChatForm() {
  const [message, setMessage] = useState("");
  const [response, setResponse] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelId>("gpt-4o-mini");
  const responseRef = useRef<HTMLDivElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    setIsLoading(true);
    setIsVisible(true);
    setResponse("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmedMessage, model: selectedModel }),
      });

      if (!res.ok) {
        const err = await res.json();
        setResponse(`Error: ${err.error || "Unknown error"}`);
        setIsLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setResponse("Error: No response body");
        setIsLoading(false);
        return;
      }

      const decoder = new TextDecoder();
      let rawText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawText += decoder.decode(value, { stream: true });
        setResponse(rawText);
        if (responseRef.current) {
          responseRef.current.scrollTop = responseRef.current.scrollHeight;
        }
      }
    } catch (err) {
      setResponse(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  const currentModel = AVAILABLE_MODELS.find((m) => m.id === selectedModel);

  return (
    <>
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
              {model.name} — {model.description}
            </option>
          ))}
        </select>
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
          {isLoading ? `${currentModel?.name}...` : "Ask"}
        </button>
      </form>
      <div
        ref={responseRef}
        className={`response-area ${isVisible ? "visible" : ""} ${isLoading ? "loading" : ""}`}
      >
        <div className="markdown-body">
          <ReactMarkdown>{response}</ReactMarkdown>
        </div>
      </div>
    </>
  );
}
