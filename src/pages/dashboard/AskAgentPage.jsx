/**
 * AskAgentPage — conversational AI threat intelligence Q&A.
 * Sends conversation history for smart follow-up detection.
 * Renders plain-text responses (no markdown).
 */

import { useState, useRef, useEffect } from "react";

const CATEGORY_OPTIONS = [
  { value: "",                       label: "All categories" },
  { value: "traditional_ai_threats", label: "Traditional AI" },
  { value: "llm_threats",            label: "LLM Threats" },
  { value: "agentic_ai_threats",     label: "Agentic AI" },
  { value: "ai_enabled_threats",     label: "AI-Enabled" },
];

const SUGGESTIONS = [
  "What's the most important finding right now?",
  "Are LLM jailbreaks getting more common?",
  "What agentic AI risks should I prioritize?",
  "Tell me about MCP vulnerabilities",
  "How is AI being used as an attack tool?",
  "What should defenders watch in the next 90 days?",
];

// ── Plain text renderer ────────────────────────────────────────────────────────

function PlainText({ text }) {
  if (!text) return null;
  // Split into paragraphs on double newlines, then handle single newlines
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {paragraphs.map((para, i) => {
        const lines = para.split("\n").filter(l => l.trim());
        if (!lines.length) return null;
        return (
          <p key={i} style={{ margin: 0, lineHeight: 1.65 }}>
            {lines.join(" ")}
          </p>
        );
      })}
    </div>
  );
}

// ── Citation button ────────────────────────────────────────────────────────────

function SourceButton({ c, index }) {
  const label = c.publisher || c.source_title || "Source";
  const short = label.length > 32 ? label.slice(0, 32) + "…" : label;
  return c.url ? (
    <a
      href={c.url}
      target="_blank"
      rel="noopener noreferrer"
      className="hz-source-btn"
      title={c.source_title || label}
    >
      <span className="hz-source-btn-num">{index + 1}</span>
      {short}
    </a>
  ) : (
    <span className="hz-source-btn hz-source-btn-nolink" title={c.source_title || label}>
      <span className="hz-source-btn-num">{index + 1}</span>
      {short}
    </span>
  );
}

// ── Message ───────────────────────────────────────────────────────────────────

function Message({ msg, onFollowUp }) {
  if (msg.role === "user") {
    return (
      <div className="hz-msg-user">
        <div className="hz-msg-user-bubble">{msg.content}</div>
      </div>
    );
  }

  const confCls = msg.confidence === "high" ? "high"
    : msg.confidence === "moderate" ? "moderate"
    : msg.confidence === "low" ? "low"
    : "";

  return (
    <div className="hz-msg-assistant">
      <div className="hz-msg-assistant-bubble">
        <PlainText text={msg.content} />
      </div>

      {/* Citations */}
      {msg.citations?.length > 0 && (
        <div className="hz-source-row">
          <span className="hz-source-row-label">Sources</span>
          <div className="hz-source-buttons">
            {msg.citations.map((c, i) => <SourceButton key={i} c={c} index={i} />)}
          </div>
        </div>
      )}

      {/* Meta row */}
      <div className="hz-msg-meta">
        {msg.confidence && (
          <span className={`hz-msg-conf ${confCls}`} title={msg.confidence_reason}>
            {msg.confidence} confidence
          </span>
        )}
        {msg.temporal_scope && (
          <span className="hz-msg-scope">{msg.temporal_scope}</span>
        )}
        {msg.caveat && (
          <span className="hz-msg-caveat" title={msg.caveat}>
            Note
          </span>
        )}
      </div>

      {/* Caveat detail */}
      {msg.caveat && (
        <div className="hz-caveat">{msg.caveat}</div>
      )}

      {/* Follow-up suggestions */}
      {msg.suggested_followups?.length > 0 && (
        <div className="hz-followups">
          {msg.suggested_followups.slice(0, 2).map((s, i) => (
            <button key={i} className="hz-suggestion-pill" onClick={() => onFollowUp(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AskAgentPage({ data, period }) {
  const [messages, setMessages] = useState([{
    role: "assistant",
    content: "Ask me anything about the AI threat landscape. I search the last 90 days by default — but you can ask about any timeframe, like \"in the past 2 weeks\" or \"since January\" or \"all time\".",
  }]);
  const [query,    setQuery]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [category, setCategory] = useState("");
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async (text) => {
    const q = (text || query).trim();
    if (!q || loading) return;
    setQuery("");

    const userMsg = { role: "user", content: q };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    // Build text-only history (exclude the current message, exclude system greeting)
    const history = messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const res  = await fetch("/api/agent", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ query: q, period: data?.period, category, history }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `API error ${res.status}`);

      setMessages((prev) => [...prev, {
        role:                "assistant",
        content:             json.answer || "No answer returned.",
        citations:           json.citations            || [],
        confidence:          json.confidence           || null,
        confidence_reason:   json.confidence_reason    || "",
        caveat:              json.caveat               || null,
        suggested_followups: json.suggested_followups  || [],
        qa_pass:             json.qa_pass              ?? undefined,
        temporal_scope:      json.temporal_scope       || null,
      }]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role:    "assistant",
        content: `Something went wrong: ${err.message}. Check that the API server is running.`,
        citations: [],
      }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="hz-chat-shell">
      {/* Header */}
      <div className="hz-chat-header">
        <h1 className="hz-chat-title">Ask Agent</h1>
        <p className="hz-chat-sub">Grounded answers from the corpus — every response cites its sources.</p>
      </div>

      {/* Category filter */}
      <div className="hz-chat-filters">
        <span className="hz-filter-label">Focus</span>
        {CATEGORY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`hz-cat-pill${category === opt.value ? " active" : ""}`}
            onClick={() => setCategory(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Suggestion pills */}
      <div className="hz-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="hz-suggestion-pill" onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>

      {/* Chat window */}
      <div className="hz-chat-window">
        {messages.map((msg, i) => (
          <Message key={i} msg={msg} onFollowUp={send} />
        ))}
        {loading && (
          <div className="hz-loading-dot">
            <span className="hz-loading-dots">
              <span /><span /><span />
            </span>
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="hz-chat-input-row">
        <input
          ref={inputRef}
          className="hz-chat-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Ask about findings, techniques, incidents, trends…"
        />
        <button
          className="hz-chat-send"
          onClick={() => send()}
          disabled={loading || !query.trim()}
        >
          {loading ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
