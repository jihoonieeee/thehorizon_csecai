/**
 * Ask Agent — evidence-backed Q&A interface.
 * POSTs to /api/agent. Falls back to deterministic mock if API unavailable.
 */

import { useState, useRef, useEffect } from "react";
import { StatusBadge }                  from "../../components/dashboard/StatusBadge.jsx";

const SUGGESTIONS = [
  "What is the most critical finding this period?",
  "What evidence supports the RAG injection claim?",
  "Which categories have insufficient evidence?",
  "What are the top attack vectors in the corpus?",
  "Show me early signals for agentic AI threats",
];

function CitationTag({ citation }) {
  return (
    <a
      href={citation.url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display:     "inline-block",
        padding:     "1px 7px",
        borderRadius:"8px",
        background:  "rgba(99,102,241,0.12)",
        color:       "#818cf8",
        fontSize:    "0.65rem",
        textDecoration:"none",
        fontWeight:  600,
        marginRight: "4px",
        marginTop:   "3px",
      }}
    >
      [{citation.evidence_id || citation.source_id}] {citation.title || citation.publisher}
    </a>
  );
}

function MessageBubble({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div style={{
      display:     "flex",
      flexDirection:"column",
      alignItems:  isUser ? "flex-end" : "flex-start",
      gap:         "4px",
      marginBottom:"16px",
    }}>
      <div style={{
        maxWidth:    "80%",
        padding:     "10px 14px",
        borderRadius:"10px",
        background:  isUser ? "rgba(99,102,241,0.18)" : "rgba(15,23,42,0.7)",
        border:      isUser ? "1px solid rgba(99,102,241,0.3)" : "1px solid #1e293b",
        fontSize:    "0.83rem",
        color:       "#e2e8f0",
        lineHeight:  1.6,
        textAlign:   isUser ? "right" : "left",
      }}>
        {msg.content}
      </div>

      {/* Evidence IDs */}
      {msg.evidence_ids?.length > 0 && (
        <div style={{ maxWidth: "80%", display: "flex", flexWrap: "wrap", gap: "3px" }}>
          {msg.evidence_ids.map((id) => (
            <span key={id} style={{
              fontSize: "0.62rem", padding: "1px 6px", borderRadius: "8px",
              background: "rgba(16,185,129,0.1)", color: "#34d399",
            }}>{id}</span>
          ))}
        </div>
      )}

      {/* Citations */}
      {msg.citations?.length > 0 && (
        <div style={{ maxWidth: "80%", display: "flex", flexWrap: "wrap", gap: "2px" }}>
          {msg.citations.map((c, i) => <CitationTag key={i} citation={c} />)}
        </div>
      )}

      {/* Confidence */}
      {msg.confidence && !isUser && (
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <StatusBadge status={msg.confidence} label={`${msg.confidence} confidence`} />
          {msg.is_mock && <span style={{ fontSize: "0.6rem", color: "#334155", fontStyle: "italic" }}>mock response</span>}
        </div>
      )}
    </div>
  );
}

export function AskAgentPage({ data }) {
  const [messages, setMessages] = useState([
    {
      role:      "assistant",
      content:   "I can answer questions about the current threat landscape using the live source corpus (last 90 days). Ask about findings, attack vectors, specific categories, or coverage gaps. All answers cite real sources from the database.",
      confidence:"high",
      is_mock:   false,
    },
  ]);
  const [query,    setQuery]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [category, setCategory] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendQuery = async (text) => {
    const q = text || query;
    if (!q.trim() || loading) return;
    setQuery("");

    const userMsg = { role: "user", content: q };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch("/api/agent", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ query: q, period: data?.period || "2026-05", category }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      setMessages((prev) => [...prev, {
        role:        "assistant",
        content:     json.answer || "No answer returned.",
        evidence_ids:json.evidence_ids || [],
        claim_ids:   json.claim_ids    || [],
        citations:   json.citations    || [],
        confidence:  json.confidence   || "low",
        is_mock:     json.is_mock      || false,
      }]);
    } catch (err) {
      // Deterministic mock fallback
      const answer = buildMockAnswer(q);
      setMessages((prev) => [...prev, { ...answer, role: "assistant" }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", height: "calc(100vh - 180px)" }}>
      <div>
        <h2 style={{ margin: "0 0 4px", fontSize: "0.95rem", fontWeight: 700, color: "#e2e8f0" }}>Ask Agent</h2>
        <p style={{ margin: 0, fontSize: "0.73rem", color: "#475569" }}>
          Evidence-backed answers using the {data?.period || "current"} corpus. All responses cite evidence IDs and source URLs.
        </p>
      </div>

      {/* Category filter */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <span style={{ fontSize: "0.65rem", color: "#475569", fontWeight: 700, textTransform: "uppercase" }}>Filter</span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: "6px", color: "#94a3b8", fontSize: "0.75rem", padding: "4px 8px" }}
        >
          <option value="">All categories</option>
          <option value="llm_threats">LLM Threats</option>
          <option value="agentic_ai_threats">Agentic AI Threats</option>
          <option value="traditional_ai_threats">Traditional AI Threats</option>
          <option value="ai_enabled_threats">AI-Enabled Threats</option>
        </select>
      </div>

      {/* Suggestions */}
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => sendQuery(s)}
            style={{
              padding:     "4px 11px",
              borderRadius:"14px",
              border:      "1px solid #1e293b",
              background:  "transparent",
              color:       "#475569",
              cursor:      "pointer",
              fontSize:    "0.73rem",
              transition:  "border-color 0.12s, color 0.12s",
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Chat window */}
      <div style={{
        flex:       1,
        overflowY:  "auto",
        padding:    "14px",
        borderRadius:"10px",
        background: "rgba(8,12,20,0.6)",
        border:     "1px solid #0f1827",
      }}>
        {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}
        {loading && (
          <div style={{ color: "#334155", fontSize: "0.78rem", fontStyle: "italic", marginBottom: "12px" }}>
            Retrieving evidence and generating answer…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendQuery()}
          placeholder="Ask about claims, evidence, or categories…"
          style={{
            flex:         1,
            padding:      "9px 14px",
            borderRadius: "8px",
            border:       "1px solid #1e293b",
            background:   "#0f172a",
            color:        "#e2e8f0",
            fontSize:     "0.83rem",
            outline:      "none",
          }}
        />
        <button
          onClick={() => sendQuery()}
          disabled={loading || !query.trim()}
          style={{
            padding:      "9px 18px",
            borderRadius: "8px",
            border:       "none",
            background:   loading ? "#1e293b" : "#4338ca",
            color:        loading ? "#334155" : "#fff",
            cursor:       loading ? "not-allowed" : "pointer",
            fontSize:     "0.83rem",
            fontWeight:   600,
            transition:   "background 0.15s",
          }}
        >
          {loading ? "…" : "Send"}
        </button>
      </div>

      <div style={{ fontSize: "0.65rem", color: "#1e3a5f" }}>
        Answers use only the current corpus evidence. No invented sources, statistics, or claims.
        If evidence is insufficient, the agent will say so.
      </div>
    </div>
  );
}

// ── Deterministic mock fallback (used when /api/agent network call fails) ─────

function buildMockAnswer(query) {
  return {
    content:     `Unable to reach the agent API for "${query}". Check that the local server is running (npx vercel dev) and your API keys are configured.`,
    confidence:  "low",
    evidence_ids:[],
    citations:   [],
    is_mock:     true,
  };

}
