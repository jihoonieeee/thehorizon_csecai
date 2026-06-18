/**
 * AskAgentPage — clean chat interface for AI threat intelligence Q&A.
 * Calls POST /api/agent. No mock data — real API only.
 */

import { useState, useRef, useEffect } from "react";

const CATEGORY_OPTIONS = [
  { value: "",                       label: "All categories" },
  { value: "traditional_ai_threats", label: "Traditional AI Threats" },
  { value: "llm_threats",            label: "LLM Threats" },
  { value: "agentic_ai_threats",     label: "Agentic AI Threats" },
  { value: "ai_enabled_threats",     label: "AI-Enabled Threats" },
];

const SUGGESTIONS = [
  "What is the most critical finding this period?",
  "Are LLM jailbreak attacks increasing?",
  "What agentic AI incidents were documented?",
  "What should defenders watch for in the next 90 days?",
  "Find sources on MCP vulnerabilities",
  "Compare threat activity across all four categories",
];

// ── Simple text renderer (handles **bold** and line breaks) ──────────────────

function AnswerText({ text }) {
  if (!text) return null;
  return (
    <div>
      {text.split("\n").map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height: "6px" }} />;
        // Render **bold**
        const parts = [];
        const re = /\*\*(.+?)\*\*/g;
        let last = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          if (m.index > last) parts.push(line.slice(last, m.index));
          parts.push(<strong key={m.index}>{m[1]}</strong>);
          last = m.index + m[0].length;
        }
        if (last < line.length) parts.push(line.slice(last));
        if (/^[-•*]\s/.test(line) || /^\d+\.\s/.test(line)) {
          return (
            <div key={i} style={{ display: "flex", gap: "6px", marginBottom: "3px" }}>
              <span style={{ color: "var(--accent)", flexShrink: 0 }}>-</span>
              <span>{parts.length ? parts : line.replace(/^[-•*\d.]+\s+/, "")}</span>
            </div>
          );
        }
        return <div key={i} style={{ marginBottom: "2px", lineHeight: 1.6 }}>{parts.length ? parts : line}</div>;
      })}
    </div>
  );
}

// ── Citation chip ─────────────────────────────────────────────────────────────

function CitationChip({ c }) {
  const label = c.source_title || c.publisher || c.ref || "Source";
  return (
    <span className="hz-citation-chip">
      {c.ref && (
        <span style={{ fontFamily: "monospace", fontSize: "0.6em", color: "var(--text-tertiary)" }}>
          {c.ref.slice(0, 10)}
        </span>
      )}
      {c.url
        ? <a href={c.url} target="_blank" rel="noopener noreferrer">
            {label.length > 40 ? label.slice(0, 40) + "…" : label}
          </a>
        : <span>{label.length > 40 ? label.slice(0, 40) + "…" : label}</span>
      }
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
      {/* Answer bubble */}
      <div className="hz-msg-assistant-bubble">
        <AnswerText text={msg.content} />
      </div>

      {/* Meta row */}
      {(msg.confidence || msg.qa_pass !== undefined) && (
        <div className="hz-msg-meta">
          {msg.confidence && (
            <span
              className={`hz-msg-conf ${confCls}`}
              title={msg.confidence_reason}
            >
              {msg.confidence} confidence
            </span>
          )}
          {msg.qa_pass === true && (
            <span style={{ fontSize: "0.64rem", color: "#15803d", background: "#dcfce7", padding: "1px 6px", borderRadius: 8 }}>
              QA pass
            </span>
          )}
          {msg.qa_pass === false && (
            <span style={{ fontSize: "0.64rem", color: "#991b1b", background: "#fee2e2", padding: "1px 6px", borderRadius: 8 }}>
              QA issues
            </span>
          )}
        </div>
      )}

      {/* Caveat */}
      {msg.caveat && (
        <div className="hz-caveat">{msg.caveat}</div>
      )}

      {/* Citations */}
      {msg.citations?.length > 0 && (
        <div className="hz-citations">
          {msg.citations.map((c, i) => <CitationChip key={i} c={c} />)}
        </div>
      )}

      {/* Followup suggestions */}
      {msg.suggested_followups?.length > 0 && (
        <div className="hz-followups">
          {msg.suggested_followups.slice(0, 3).map((s, i) => (
            <button
              key={i}
              className="hz-suggestion-pill"
              onClick={() => onFollowUp(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AskAgentPage({ data }) {
  const [messages, setMessages] = useState([{
    role: "assistant",
    content: "Ask me about the AI threat landscape — findings, techniques, incidents, trends, or coverage gaps.\n\nEvery claim I make cites a source or evidence item.",
  }]);
  const [query,    setQuery]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [category, setCategory] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async (text) => {
    const q = (text || query).trim();
    if (!q || loading) return;
    setQuery("");
    setMessages((prev) => [...prev, { role: "user", content: q }]);
    setLoading(true);

    try {
      const res  = await fetch("/api/agent", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ query: q, period: data?.period, category }),
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
      }]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role:    "assistant",
        content: `**Error:** ${err.message}\n\nCheck that the API server is running and environment variables are set.`,
        citations: [],
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="hz-chat-shell">
      {/* Header */}
      <div className="hz-chat-header">
        <h1 className="hz-chat-title">Ask Agent</h1>
        <p className="hz-chat-sub">Grounded answers from the corpus — every claim cites a source.</p>
      </div>

      {/* Category filter */}
      <div className="hz-chat-filters">
        <span className="hz-filter-label">Filter</span>
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
          <div className="hz-loading-dot">Querying corpus...</div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="hz-chat-input-row">
        <input
          className="hz-chat-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Ask about findings, techniques, incidents, trends..."
        />
        <button
          className="hz-chat-send"
          onClick={() => send()}
          disabled={loading || !query.trim()}
        >
          {loading ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
