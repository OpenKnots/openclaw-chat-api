"use client";

import { useState, useRef } from "react";
import ReactMarkdown from "react-markdown";

const MAX_MESSAGE_LENGTH = 2000;

export default function ChatForm() {
  const [message, setMessage] = useState("");
  const [response, setResponse] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
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
        body: JSON.stringify({ message: trimmedMessage }),
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

  return (
    <>
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
          {isLoading ? "Thinking..." : "Ask"}
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
