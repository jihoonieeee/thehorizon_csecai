/**
 * AgentChatSkeleton — chat-style input + response placeholder for the Ask Agent page.
 * TODO: wire to real agent API when backend is ready.
 */

import { useState } from "react";

const PLACEHOLDER_RESPONSES = [
  {
    query: "What is the most critical finding this week?",
    response: "Based on 51 validated sources, the most critical finding is prompt injection crossing from research to operational exploitation. Evidence: ev_src1_1 (NIST, 3 documented incidents) and ev_src2_1 (Anthropic, 12/50 evaluated deployments). Claim cl_llm_1 is rated critical.",
    evidence_ids: ["ev_src1_1", "ev_src2_1"],
    claim_ids: ["cl_llm_1"],
    confidence: "high",
  },
];

export function AgentChatSkeleton() {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    if (!query.trim()) return;

    const userMessage = { role: "user", text: query };
    // Mock response for skeleton
    const mockResponse = PLACEHOLDER_RESPONSES[0];
    const agentMessage = {
      role:         "agent",
      text:         "[PLACEHOLDER] " + mockResponse.response,
      evidence_ids: mockResponse.evidence_ids,
      claim_ids:    mockResponse.claim_ids,
      confidence:   mockResponse.confidence,
      is_mock:      true,
    };

    setHistory((h) => [...h, userMessage, agentMessage]);
    setQuery("");
    setLoading(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "12px" }}>
      {/* Warning banner */}
      <div style={{
        padding:      "10px 14px",
        borderRadius: "8px",
        background:   "#1c0a0a",
        border:       "1px solid #7f1d1d",
        fontSize:     "0.78rem",
        color:        "#fca5a5",
        lineHeight:   1.5,
      }}>
        ⚠️ <strong>Evidence-backed answers only.</strong> The agent may only respond using evidence in the current corpus.
        Responses must cite evidence IDs and claim IDs. Unsupported answers must be flagged as speculative.
        <br />
        <span style={{ color: "#6b7280", fontSize: "0.72rem" }}>Backend not yet wired — showing placeholder responses.</span>
      </div>

      {/* Chat history */}
      <div style={{
        flex:         1,
        minHeight:    "280px",
        overflowY:    "auto",
        border:       "1px solid #1e293b",
        borderRadius: "8px",
        padding:      "12px",
        display:      "flex",
        flexDirection:"column",
        gap:          "12px",
        background:   "rgba(7,11,18,0.6)",
      }}>
        {history.length === 0 && (
          <div style={{ color: "#334155", fontSize: "0.8rem", textAlign: "center", marginTop: "40px" }}>
            Ask a question about the current threat landscape.<br />
            <span style={{ fontSize: "0.72rem" }}>e.g. "What is the strongest evidence for LLM threats?"</span>
          </div>
        )}
        {history.map((msg, i) => (
          <div key={i} style={{
            alignSelf:   msg.role === "user" ? "flex-end" : "flex-start",
            maxWidth:    "85%",
            padding:     "10px 14px",
            borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
            background:  msg.role === "user" ? "#1e3a5f" : "#0f172a",
            border:      msg.role === "user" ? "1px solid #1e40af55" : "1px solid #1e293b",
            fontSize:    "0.82rem",
            color:       "#e2e8f0",
            lineHeight:  1.5,
          }}>
            {msg.text}
            {msg.evidence_ids?.length > 0 && (
              <div style={{ marginTop: "8px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {msg.evidence_ids.map((id) => (
                  <span key={id} style={{
                    fontSize: "0.68rem", fontFamily: "monospace",
                    background: "#1a2033", color: "#60a5fa",
                    padding: "2px 6px", borderRadius: "4px",
                  }}>{id}</span>
                ))}
                {(msg.claim_ids || []).map((id) => (
                  <span key={id} style={{
                    fontSize: "0.68rem", fontFamily: "monospace",
                    background: "#1a0a1a", color: "#c084fc",
                    padding: "2px 6px", borderRadius: "4px",
                  }}>{id}</span>
                ))}
              </div>
            )}
            {msg.is_mock && (
              <div style={{ fontSize: "0.68rem", color: "#475569", marginTop: "6px" }}>
                [Mock response — backend not wired]
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div style={{ color: "#475569", fontSize: "0.78rem" }}>Agent is thinking…</div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: "8px" }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask about evidence, claims, or threat categories…"
          style={{
            flex:         1,
            padding:      "10px 14px",
            borderRadius: "8px",
            border:       "1px solid #334155",
            background:   "#0f172a",
            color:        "#e2e8f0",
            fontSize:     "0.85rem",
            outline:      "none",
          }}
        />
        <button
          type="submit"
          disabled={!query.trim()}
          style={{
            padding:      "10px 18px",
            borderRadius: "8px",
            border:       "none",
            background:   query.trim() ? "#1d4ed8" : "#1e293b",
            color:        query.trim() ? "#e2e8f0" : "#475569",
            cursor:       query.trim() ? "pointer" : "default",
            fontWeight:   600,
            fontSize:     "0.85rem",
            transition:   "background 0.15s",
          }}
        >
          Ask
        </button>
      </form>
    </div>
  );
}
