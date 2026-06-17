/**
 * Ask the Analyst — tool-use chatbot for AI threat intelligence.
 *
 * Features:
 *   - Tool-call trace (shows which data sources Claude queried)
 *   - Citation chips with clickable source URLs
 *   - QA indicator (flags uncited claims)
 *   - Taxonomy explorer sidebar (tags + category breakdown)
 *   - Suggestion pills including taxonomy queries
 */

import { useState, useRef, useEffect } from "react";

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

const SUGGESTIONS = [
  "What is the most critical finding this period?",
  "Are LLM jailbreak attacks becoming more frequent?",
  "What agentic AI incidents have been documented?",
  "Show me the top attack tags across all categories",
  "What sources cover MCP vulnerabilities?",
  "What should defenders watch for in the next 90 days?",
  "Explore sources tagged LLM01_prompt_injection",
  "Compare threat activity across all four categories",
];

const TOOL_LABELS = {
  search_corpus:   { label: "corpus search",   color: "#38bdf8" },
  get_judgments:   { label: "L6 judgments",    color: "#4ade80" },
  get_evidence:    { label: "evidence items",  color: "#a78bfa" },
  trend_analysis:  { label: "trend analysis",  color: "#fbbf24" },
  search_taxonomy: { label: "taxonomy",        color: "#fb923c" },
};

// ── Lightweight markdown renderer ─────────────────────────────────────────────

function renderInline(text) {
  if (!text) return null;
  const parts = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[(ev-[^\]]+|src-\d+)\]/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] != null) {
      parts.push(<strong key={m.index}>{m[1]}</strong>);
    } else if (m[2] != null) {
      parts.push(<code key={m.index} style={{ fontFamily:"monospace", fontSize:"0.8em", color:"#7dd3fc", background:"rgba(0,0,0,0.3)", padding:"0 3px", borderRadius:"3px" }}>{m[2]}</code>);
    } else {
      // [ev-xxx] or [src-N] citation tag — render as a small badge
      parts.push(<span key={m.index} style={{ fontFamily:"monospace", fontSize:"0.72em", color:"#64748b", background:"rgba(0,0,0,0.25)", padding:"0 3px", borderRadius:"3px", marginLeft:"2px" }}>{m[0]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownBlock({ text }) {
  if (!text) return null;
  const lines = text.split("\n");
  const out = [];
  let bullets = [];
  let i = 0;

  const flush = () => {
    if (!bullets.length) return;
    out.push(
      <ul key={`ul${i}`} style={{ margin:"4px 0 4px 10px", padding:0, listStyle:"none" }}>
        {bullets.map((b, bi) => (
          <li key={bi} style={{ display:"flex", gap:"6px", marginBottom:"4px", lineHeight:1.55 }}>
            <span style={{ color:"#4f46e5", flexShrink:0, marginTop:"2px" }}>▸</span>
            <span>{renderInline(b)}</span>
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("|") && line.endsWith("|")) {
      flush();
      const cells = line.split("|").filter((_, idx, arr) => idx && idx < arr.length - 1);
      if (!cells.every(c => /^[-: ]+$/.test(c))) {
        out.push(
          <div key={`tr${i}`} style={{ display:"flex", marginBottom:"1px" }}>
            {cells.map((c, ci) => (
              <span key={ci} style={{ flex:1, padding:"2px 8px", fontSize:"0.78rem", color:ci===0?"#cbd5e1":"#94a3b8", borderBottom:"1px solid #1e293b" }}>{renderInline(c.trim())}</span>
            ))}
          </div>
        );
      }
      i++; continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      flush();
      out.push(<div key={`h${i}`} style={{ fontWeight:700, color:"#e2e8f0", fontSize:"0.82rem", marginTop:"8px", marginBottom:"2px" }}>{renderInline(line.replace(/^#{1,3}\s+/,""))}</div>);
      i++; continue;
    }
    if (/^[-•*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      bullets.push(line.replace(/^[-•*\d.]+\s+/,""));
      i++; continue;
    }
    if (!line.trim()) { flush(); if (out.length) out.push(<div key={`sp${i}`} style={{ height:"4px" }} />); i++; continue; }
    flush();
    out.push(<div key={`p${i}`} style={{ lineHeight:1.55, marginBottom:"1px" }}>{renderInline(line)}</div>);
    i++;
  }
  flush();
  return <div style={{ display:"flex", flexDirection:"column" }}>{out}</div>;
}

// ── Tool call trace ───────────────────────────────────────────────────────────

function ToolCallTrace({ toolCalls }) {
  if (!toolCalls?.length) return null;
  return (
    <div style={{ display:"flex", gap:"4px", flexWrap:"wrap", maxWidth:"90%" }}>
      {toolCalls.map((tc, i) => {
        const style = TOOL_LABELS[tc.tool] || { label: tc.tool, color: "#94a3b8" };
        const hint  = tc.input?.query || tc.input?.tag || tc.input?.category || (tc.input?.categories?.join(", ")) || "";
        return (
          <span key={i} style={{
            fontSize:"0.6rem", padding:"1px 6px", borderRadius:"8px",
            background:"rgba(0,0,0,0.3)", border:`1px solid ${style.color}33`,
            color: style.color,
          }} title={hint ? `Input: ${hint}` : undefined}>
            ⚡ {style.label}{hint ? ` — ${hint.slice(0,25)}${hint.length>25?"…":""}` : ""}
          </span>
        );
      })}
    </div>
  );
}

// ── Citation chip ─────────────────────────────────────────────────────────────

function CitationChip({ c }) {
  const label = c.source_title || c.publisher || c.ref || "";
  const tier  = c.trust_tier;
  const tierColor = tier === "primary" ? "#4ade80" : tier === "high" ? "#38bdf8" : "#94a3b8";
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:"4px",
      padding:"2px 7px", borderRadius:"8px",
      background:"rgba(30,41,59,0.8)", border:"1px solid #1e293b",
      fontSize:"0.65rem", marginRight:"4px", marginTop:"3px",
    }}>
      <span style={{ fontFamily:"monospace", color:"#334155" }}>{c.ref?.slice(0,14)}</span>
      {tier && <span style={{ color:tierColor, fontSize:"0.55rem" }}>●</span>}
      {c.url
        ? <a href={c.url} target="_blank" rel="noopener noreferrer"
             style={{ color:"#818cf8", textDecoration:"none", fontWeight:600 }}>
            {label.slice(0,42)}{label.length>42?"…":""} ↗
          </a>
        : <span style={{ color:"#64748b" }}>{label.slice(0,42)}{label.length>42?"…":""}</span>
      }
    </span>
  );
}

// ── QA indicator ──────────────────────────────────────────────────────────────

function QABadge({ qaPass, qaIssues }) {
  if (qaPass === undefined) return null;
  if (qaPass) return (
    <span style={{ fontSize:"0.6rem", padding:"1px 6px", borderRadius:"8px", background:"rgba(74,222,128,0.08)", color:"#4ade80", border:"1px solid rgba(74,222,128,0.2)" }}>✓ QA pass</span>
  );
  return (
    <span style={{ fontSize:"0.6rem", padding:"1px 6px", borderRadius:"8px", background:"rgba(239,68,68,0.08)", color:"#f87171", border:"1px solid rgba(239,68,68,0.2)" }}
          title={qaIssues?.join(" | ")}>
      ⚠ QA: {qaIssues?.[0] || "issues found"}
    </span>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg, onFollowUp }) {
  if (msg.role === "user") {
    return (
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:"12px" }}>
        <div style={{ maxWidth:"75%", padding:"8px 13px", borderRadius:"10px", background:"rgba(99,102,241,0.18)", border:"1px solid rgba(99,102,241,0.3)", fontSize:"0.83rem", color:"#e2e8f0", lineHeight:1.55 }}>
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-start", gap:"5px", marginBottom:"18px" }}>
      {/* Tool calls */}
      <ToolCallTrace toolCalls={msg.tool_calls} />

      {/* Answer */}
      <div style={{ maxWidth:"90%", padding:"11px 14px", borderRadius:"10px", background:"rgba(15,23,42,0.7)", border:"1px solid #1e293b", fontSize:"0.82rem", color:"#cbd5e1", lineHeight:1.55 }}>
        <MarkdownBlock text={msg.content} />
      </div>

      {/* Badges row */}
      <div style={{ display:"flex", gap:"5px", alignItems:"center", flexWrap:"wrap" }}>
        {msg.confidence && (
          <span style={{
            fontSize:"0.62rem", padding:"1px 7px", borderRadius:"8px",
            background: msg.confidence==="high" ? "rgba(74,222,128,0.1)" : msg.confidence==="moderate" ? "rgba(251,191,36,0.1)" : "rgba(239,68,68,0.08)",
            color: msg.confidence==="high" ? "#4ade80" : msg.confidence==="moderate" ? "#fbbf24" : "#f87171",
            border: `1px solid ${msg.confidence==="high" ? "rgba(74,222,128,0.25)" : msg.confidence==="moderate" ? "rgba(251,191,36,0.2)" : "rgba(239,68,68,0.2)"}`,
          }} title={msg.confidence_reason}>{msg.confidence} confidence</span>
        )}
        <QABadge qaPass={msg.qa_pass} qaIssues={msg.qa_issues} />
        {msg.evidence_items_used > 0 && (
          <span style={{ fontSize:"0.6rem", color:"#334155" }}>{msg.evidence_items_used} evidence items</span>
        )}
      </div>

      {/* Caveat */}
      {msg.caveat && (
        <div style={{ maxWidth:"90%", padding:"5px 10px", borderRadius:"6px", background:"rgba(245,158,11,0.07)", border:"1px solid rgba(245,158,11,0.18)", fontSize:"0.7rem", color:"#fbbf24", lineHeight:1.4 }}>
          ⚠ {msg.caveat}
        </div>
      )}

      {/* Citations */}
      {msg.citations?.length > 0 && (
        <div style={{ maxWidth:"90%", display:"flex", flexWrap:"wrap" }}>
          {msg.citations.map((c, i) => <CitationChip key={i} c={c} />)}
        </div>
      )}

      {/* Followup suggestions */}
      {msg.suggested_followups?.length > 0 && (
        <div style={{ display:"flex", gap:"4px", flexWrap:"wrap", maxWidth:"90%" }}>
          {msg.suggested_followups.slice(0,2).map((s, i) => (
            <button key={i} onClick={() => onFollowUp(s)} style={{ padding:"2px 8px", borderRadius:"10px", fontSize:"0.65rem", border:"1px solid #1e293b", background:"transparent", color:"#475569", cursor:"pointer" }}>{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Taxonomy sidebar ──────────────────────────────────────────────────────────

function TaxonomySidebar({ onQuery }) {
  const TAXONOMY_QUERIES = [
    { label: "Top attack tags", query: "Show me the top attack technique tags across all categories" },
    { label: "LLM Threats tags", query: "What are the most common tags in the LLM threats category?" },
    { label: "Agentic AI tags", query: "Explore the agentic AI threats category and its top tags" },
    { label: "Traditional AI tags", query: "What techniques are most common in traditional AI threats?" },
    { label: "AI-Enabled tags", query: "Show me what AI-enabled threat techniques are covered" },
    { label: "Prompt injection sources", query: "Find all sources tagged LLM01_prompt_injection" },
    { label: "Deepfake sources", query: "Find sources covering AI deepfakes and synthetic media" },
    { label: "Adversarial examples", query: "Sources on adversarial examples and evasion attacks" },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"4px" }}>
      <div style={{ fontSize:"0.63rem", color:"#475569", fontWeight:700, textTransform:"uppercase", marginBottom:"2px" }}>Taxonomy Explorer</div>
      {TAXONOMY_QUERIES.map(({ label, query }) => (
        <button key={label} onClick={() => onQuery(query)} style={{
          padding:"4px 8px", borderRadius:"6px", border:"1px solid #1e293b",
          background:"transparent", color:"#475569", cursor:"pointer",
          fontSize:"0.68rem", textAlign:"left",
        }}>{label}</button>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AskAgentPage({ data }) {
  const [messages, setMessages] = useState([{
    role:    "assistant",
    content: "Ask me about the AI threat landscape — findings, techniques, incidents, trends, or coverage gaps.\n\nI query the corpus database and pipeline analysis directly. Every claim I make cites a source or evidence item.",
  }]);
  const [query,       setQuery]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [category,    setCategory]    = useState("");
  const [showTaxonomy, setShowTaxonomy] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [messages]);

  const send = async (text) => {
    const q = (text || query).trim();
    if (!q || loading) return;
    setQuery("");
    setMessages(prev => [...prev, { role:"user", content:q }]);
    setLoading(true);

    try {
      const res  = await fetch("/api/agent", {
        method:  "POST",
        headers: { "Content-Type":"application/json" },
        body:    JSON.stringify({ query:q, period:data?.period, category }),
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
        tool_calls:          json.tool_calls           || [],
        qa_pass:             json.qa_pass              ?? undefined,
        qa_issues:           json.qa_issues            || [],
        evidence_items_used: json.evidence_items_used  || 0,
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role:    "assistant",
        content: `**Error:** ${err.message}\n\nCheck that the API server is running (\`npx vercel dev\`) and environment variables are set.`,
        citations: [], confidence: null,
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display:"flex", gap:"12px", height:"calc(100vh - 180px)" }}>
      {/* Main chat column */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", gap:"10px", minWidth:0 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <h2 style={{ margin:"0 0 3px", fontSize:"0.95rem", fontWeight:700, color:"#e2e8f0" }}>Ask the Analyst</h2>
            <p style={{ margin:0, fontSize:"0.7rem", color:"#475569" }}>Grounded answers from the corpus — every claim cites a source or evidence ID.</p>
          </div>
          <button onClick={() => setShowTaxonomy(v=>!v)} style={{ padding:"4px 10px", borderRadius:"6px", border:"1px solid #1e293b", background:"transparent", color:showTaxonomy?"#818cf8":"#475569", cursor:"pointer", fontSize:"0.7rem" }}>
            {showTaxonomy ? "Hide" : "Taxonomy"} Explorer
          </button>
        </div>

        {/* Category filter */}
        <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
          <span style={{ fontSize:"0.63rem", color:"#475569", fontWeight:700, textTransform:"uppercase" }}>Filter</span>
          <select value={category} onChange={e=>setCategory(e.target.value)} style={{ background:"#0f172a", border:"1px solid #1e293b", borderRadius:"6px", color:"#94a3b8", fontSize:"0.75rem", padding:"4px 8px" }}>
            <option value="">All categories</option>
            {Object.entries(CATEGORY_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>

        {/* Suggestion pills */}
        <div style={{ display:"flex", gap:"5px", flexWrap:"wrap" }}>
          {SUGGESTIONS.map(s => (
            <button key={s} onClick={() => send(s)} style={{ padding:"3px 10px", borderRadius:"12px", border:"1px solid #1e293b", background:"transparent", color:"#475569", cursor:"pointer", fontSize:"0.7rem" }}>{s}</button>
          ))}
        </div>

        {/* Chat window */}
        <div style={{ flex:1, overflowY:"auto", padding:"14px", borderRadius:"10px", background:"rgba(8,12,20,0.6)", border:"1px solid #0f1827" }}>
          {messages.map((msg, i) => <MessageBubble key={i} msg={msg} onFollowUp={send} />)}
          {loading && <div style={{ color:"#334155", fontSize:"0.77rem", fontStyle:"italic", marginBottom:"12px" }}>Querying corpus…</div>}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ display:"flex", gap:"8px" }}>
          <input
            value={query}
            onChange={e=>setQuery(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&send()}
            placeholder="Ask about findings, techniques, incidents, trends, or taxonomy…"
            style={{ flex:1, padding:"9px 14px", borderRadius:"8px", border:"1px solid #1e293b", background:"#0f172a", color:"#e2e8f0", fontSize:"0.82rem", outline:"none" }}
          />
          <button onClick={() => send()} disabled={loading||!query.trim()} style={{ padding:"9px 18px", borderRadius:"8px", border:"none", background:loading?"#1e293b":"#4338ca", color:loading?"#334155":"#fff", cursor:loading?"not-allowed":"pointer", fontSize:"0.82rem", fontWeight:600 }}>
            {loading ? "…" : "Send"}
          </button>
        </div>

        <div style={{ fontSize:"0.63rem", color:"#1e3a5f" }}>
          Claims without citable evidence are not made. Tool calls shown above each response.
        </div>
      </div>

      {/* Taxonomy sidebar */}
      {showTaxonomy && (
        <div style={{ width:"180px", flexShrink:0, padding:"10px", borderRadius:"10px", background:"rgba(8,12,20,0.5)", border:"1px solid #0f1827", overflowY:"auto" }}>
          <TaxonomySidebar onQuery={send} />
        </div>
      )}
    </div>
  );
}
