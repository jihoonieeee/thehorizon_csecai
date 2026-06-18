/**
 * AskAgentPage — ChatGPT-style AI threat intelligence Q&A.
 * Renders structured numbered responses. No category focus filter.
 */

import { useState, useRef, useEffect } from "react";

const SUGGESTIONS = [
  { label: "Most important finding",    prompt: "What's the most important finding right now?" },
  { label: "LLM jailbreak trends",      prompt: "Are LLM jailbreaks getting more common?" },
  { label: "Agentic AI risks",          prompt: "What agentic AI risks should I prioritize?" },
  { label: "MCP vulnerabilities",       prompt: "Tell me about MCP vulnerabilities in the past 90 days" },
  { label: "AI as an attack tool",      prompt: "How is AI being used as an attack tool?" },
  { label: "Defender watch list",       prompt: "What should defenders watch in the next 90 days?" },
];

// ── Structured text renderer ───────────────────────────────────────────────────
// Handles: numbered points (1. 2. 3.), plain paragraphs, **bold**

function renderInline(text) {
  const parts = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<strong key={m.index}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
}

function StructuredText({ text }) {
  if (!text) return null;

  // Split on double newlines → blocks
  const blocks = text.split(/\n{2,}/).filter(b => b.trim());

  return (
    <div className="hz-response-body">
      {blocks.map((block, bi) => {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);

        // Numbered list block
        if (lines.some(l => /^\d+\.\s/.test(l))) {
          const items = lines.map((line, li) => {
            const numMatch = line.match(/^(\d+)\.\s+(.*)/);
            if (numMatch) {
              return (
                <li key={li} className="hz-response-point">
                  <span className="hz-point-num">{numMatch[1]}</span>
                  <span className="hz-point-text">{renderInline(numMatch[2])}</span>
                </li>
              );
            }
            // Non-numbered line inside a mixed block — render as a paragraph
            return (
              <li key={li} className="hz-response-point hz-response-point-plain">
                <span className="hz-point-text">{renderInline(line)}</span>
              </li>
            );
          });
          return <ol key={bi} className="hz-response-list">{items}</ol>;
        }

        // Plain paragraph(s)
        return (
          <p key={bi} className="hz-response-para">
            {renderInline(lines.join(" "))}
          </p>
        );
      })}
    </div>
  );
}

// ── Source button ─────────────────────────────────────────────────────────────

function SourceButton({ c, index }) {
  const label = c.publisher || c.source_title || "Source";
  const short = label.length > 28 ? label.slice(0, 28) + "…" : label;
  return c.url ? (
    <a href={c.url} target="_blank" rel="noopener noreferrer" className="hz-source-btn" title={c.source_title || label}>
      <span className="hz-source-btn-num">{index + 1}</span>
      {short}
    </a>
  ) : (
    <span className="hz-source-btn hz-source-btn-nolink" title={label}>
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
    : msg.confidence === "low" ? "low" : "";

  return (
    <div className="hz-msg-assistant">
      <div className="hz-msg-assistant-content">
        <StructuredText text={msg.content} />
      </div>

      {msg.citations?.length > 0 && (
        <div className="hz-source-row">
          <span className="hz-source-row-label">Sources</span>
          <div className="hz-source-buttons">
            {msg.citations.map((c, i) => <SourceButton key={i} c={c} index={i} />)}
          </div>
        </div>
      )}

      <div className="hz-msg-meta">
        {msg.confidence && (
          <span className={`hz-msg-conf ${confCls}`} title={msg.confidence_reason}>
            {msg.confidence} confidence
          </span>
        )}
        {msg.temporal_scope && (
          <span className="hz-msg-scope">{msg.temporal_scope}</span>
        )}
      </div>

      {msg.caveat && <div className="hz-caveat">{msg.caveat}</div>}

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
  const [messages, setMessages] = useState([]);
  const [query,    setQuery]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const hasConversation = messages.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async (text) => {
    const q = (text || query).trim();
    if (!q || loading) return;
    setQuery("");

    const userMsg = { role: "user", content: q };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    const history = messages.map(m => ({ role: m.role, content: m.content }));

    try {
      const res  = await fetch("/api/agent", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ query: q, period: data?.period, history }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `API error ${res.status}`);

      setMessages(prev => [...prev, {
        role:                "assistant",
        content:             json.answer || "No answer returned.",
        citations:           json.citations            || [],
        confidence:          json.confidence           || null,
        confidence_reason:   json.confidence_reason    || "",
        caveat:              json.caveat               || null,
        suggested_followups: json.suggested_followups  || [],
        temporal_scope:      json.temporal_scope       || null,
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `Something went wrong: ${err.message}. Make sure the API server is running.`,
        citations: [],
      }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="hz-chat-shell">

      {/* Empty state — centered welcome */}
      {!hasConversation && !loading && (
        <div className="hz-chat-welcome">
          <div className="hz-chat-welcome-icon">◈</div>
          <h2 className="hz-chat-welcome-title">Ask the Threat Intelligence Agent</h2>
          <p className="hz-chat-welcome-sub">
            Searches the last 90 days by default. Ask about any timeframe: "in the past 2 weeks", "since January", "all time".
          </p>
          <div className="hz-chat-suggestions-grid">
            {SUGGESTIONS.map((s) => (
              <button key={s.prompt} className="hz-suggestion-card" onClick={() => send(s.prompt)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chat messages */}
      {hasConversation && (
        <div className="hz-chat-window">
          {messages.map((msg, i) => (
            <Message key={i} msg={msg} onFollowUp={send} />
          ))}
          {loading && (
            <div className="hz-loading-dot">
              <span className="hz-loading-dots"><span /><span /><span /></span>
              Thinking…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Loading in empty state */}
      {!hasConversation && loading && (
        <div className="hz-chat-window" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="hz-loading-dot">
            <span className="hz-loading-dots"><span /><span /><span /></span>
            Thinking…
          </div>
        </div>
      )}

      {/* Input bar */}
      <div className={`hz-chat-input-wrap${hasConversation ? " has-messages" : ""}`}>
        <div className="hz-chat-input-row">
          <input
            ref={inputRef}
            className="hz-chat-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
            placeholder="Ask about findings, techniques, incidents, trends…"
          />
          <button
            className="hz-chat-send"
            onClick={() => send()}
            disabled={loading || !query.trim()}
          >
            {loading ? "…" : "↑"}
          </button>
        </div>
        <p className="hz-chat-input-hint">
          90-day default · specify timeframe for broader or narrower results
        </p>
      </div>

    </div>
  );
}
