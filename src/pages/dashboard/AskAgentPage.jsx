/**
 * AskAgentPage — ChatGPT-style AI threat intelligence Q&A.
 * Renders structured numbered responses. No category focus filter.
 */

import { useState, useRef, useEffect } from "react";
import { useAuth } from "../../AuthContext.jsx";
import { getAccessLevel, getSessionToken } from "../../auth.js";

const SUGGESTIONS = [
  { label: "Most important finding",    prompt: "What's the most important finding right now?" },
  { label: "LLM jailbreak trends",      prompt: "Are LLM jailbreaks getting more common?" },
  { label: "Agentic AI risks",          prompt: "What agentic AI risks should I prioritize?" },
  { label: "Deepfakes & disinformation", prompt: "What deepfake or AI-generated disinformation threats have emerged recently?" },
  { label: "AI as an attack tool",      prompt: "How is AI being used as an attack tool?" },
  { label: "Defender watch list",       prompt: "What should defenders watch in the next 90 days?" },
];

// ── Structured text renderer ───────────────────────────────────────────────────
// Handles: 1. / 1 numbered points, section headers, --- dividers,
// "Confirmed: YES/NO/PARTIAL" status lines, **bold**, plain paragraphs.

function renderInline(text, sourceRefs) {
  if (!text) return null;
  const parts = [];
  // Match **bold** and [src-N] citation markers
  const re = /\*\*(.+?)\*\*|\[src-(\d+)\]/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
       // **bold** — recurse so [src-N] inside a bolded heading are converted too
      parts.push(<strong key={m.index}>{renderInline(m[1], sourceRefs)}</strong>);
    } else {
      // [src-N] inline citation
      const n = parseInt(m[2], 10);
      const src = Array.isArray(sourceRefs) ? sourceRefs[n - 1] : null;
      const label = src?.publisher || src?.title?.slice(0, 24) || `${n}`;
      if (src?.url) {
        parts.push(
          <a key={m.index} href={src.url} target="_blank" rel="noopener noreferrer"
             className="hz-inline-ref" title={src.title || src.publisher}>
            {n}
          </a>
        );
      } else {
        parts.push(<span key={m.index} className="hz-inline-ref hz-inline-ref-nolink">{n}</span>);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

// Detect a section heading: "THREAT 1:", "**Heading**", all-caps label lines
const isHeading = (t) =>
  /^(THREAT\s+\d+|KEY\s+SOURCES|FOR\s+DEFENDERS|EVIDENCE\s+MATURITY)[\s:]/i.test(t) ||
  (/^[A-Z][A-Z &/-]{5,}:/.test(t) && t.length < 80);

// Detect exploitation status lines
const statusMatch = (t) => t.match(/^(confirmed\s+exploitation[^:]*:?\s*)(YES\.?|NO\.?|PARTIAL\.?)/i);

// LLM metadata footer — strip these lines both during streaming and in final answer
const METADATA_LINE = /^(SCOPE|CONFIDENCE|CONFIDENCE_REASON|CAVEAT|FOLLOWUP):/i;

// Labeled section keywords (Assessment, So what, Defenders, etc.)
const LABEL_RE = /^(Assessment|So what|So-what|Bottom line|Defenders|Watch|Gap)\s*:\s*([\s\S]*)/i;

function StructuredText({ text, sourceRefs }) {
  if (!text) return null;

  // Normalise: collapse 3+ newlines → 2, mark --- dividers
  const normalised = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^-{3,}$/gm, "§DIV§");

  const blocks = normalised.split(/\n{2,}/).filter(b => b.trim());

  return (
    <div className="hz-response-body">
      {blocks.map((block, bi) => {
        const t = block.trim();

        // Section divider
        if (t === "§DIV§") {
          return <div key={bi} className="hz-response-divider" />;
        }

        // Strip LLM metadata footer lines (SCOPE:/CONFIDENCE:/CAVEAT: etc.).
        // Check the whole block — during streaming these may arrive as standalone
        // blocks OR embedded with content; strip any block that starts with a
        // metadata key OR whose ONLY non-empty lines are metadata keys.
        if (METADATA_LINE.test(t)) return null;
        const blockLinesRaw = t.split("\n");
        const nonMetaLines = blockLinesRaw.filter(l => !METADATA_LINE.test(l.trim()) && l.trim());
        if (nonMetaLines.length === 0) return null;  // all lines were metadata

        // Markdown headings: ###/##/# — LLM uses these for section titles.
        // mdHeading[2] only captures the first line; extract content from
        // subsequent lines in the same block too (LLM often puts label on one
        // line and content on the next with a single newline, not double).
        const mdHeading = t.match(/^(#{1,3})\s+(.*)/);
        if (mdHeading) {
          const level    = mdHeading[1].length;
          const firstLine = mdHeading[2].replace(/\*\*/g, "").trim();
          // Content on subsequent lines of the same block
          const restText = blockLinesRaw.slice(1).map(l => l.trim()).filter(Boolean).join(" ").trim();

          // h1/h2 are document-level titles (e.g. "## AI as an Attack Tool: ...") — suppress
          if (level <= 2) return null;

          // Labeled section: ### So what: / ### Defenders: / ### Assessment:
          const labelM = LABEL_RE.exec(firstLine);
          if (labelM) {
            const content = (labelM[2].trim() || restText).trim();
            if (!content) return null;  // empty section — skip entirely
            return (
              <p key={bi} className="hz-response-para hz-response-labeled">
                <strong className="hz-response-label">{labelM[1]}:</strong>{" "}
                {renderInline(content, sourceRefs)}
              </p>
            );
          }

          // Numbered section heading: ### 1. Title
          const numM = firstLine.match(/^(\d+)[.)]\s+(.*)/);
          if (numM) {
            return (
              <div key={bi}>
                <div className="hz-response-section-heading">
                  <span className="hz-section-num">{numM[1]}</span>
                  <span className="hz-section-title">{renderInline(numM[2], sourceRefs)}</span>
                </div>
                {restText && <p className="hz-response-para" style={{ marginTop: 4 }}>{renderInline(restText, sourceRefs)}</p>}
              </div>
            );
          }

          // Plain h3 heading
          if (!firstLine) return null;
          return (
            <div key={bi}>
              <div className="hz-response-heading">{renderInline(firstLine, sourceRefs)}</div>
              {restText && <p className="hz-response-para">{renderInline(restText, sourceRefs)}</p>}
            </div>
          );
        }

        const lines = t.split("\n").map(l => l.trim()).filter(Boolean);

        // Legacy section heading (THREAT 1:, KEY SOURCES:, all-caps)
        if (lines.length === 1 && isHeading(lines[0])) {
          const hText = lines[0].replace(/\*\*/g, "");
          return <div key={bi} className="hz-response-heading">{renderInline(hText, sourceRefs)}</div>;
        }

        // Exploitation status badge line
        const sm = statusMatch(lines[0]);
        if (sm) {
          const status = sm[2].replace(/\.$/, "").toUpperCase();
          const cls = status === "YES" ? "confirmed" : status === "PARTIAL" ? "partial" : "not-confirmed";
          return (
            <div key={bi} className={`hz-status-line ${cls}`}>
              <span className="hz-status-label">{sm[1].replace(/:$/, "").trim()}</span>
              <span className={`hz-status-badge ${cls}`}>{status}</span>
            </div>
          );
        }

        // Numbered list with optional "- " sub-bullets under each point.
        const hasNumbered = lines.some(l => /^\d+[.)]\s+\S/.test(l));
        if (hasNumbered) {
          const merged = [];
          for (const line of lines) {
            const nm = line.match(/^(\d+)[.)]\s+(.*)/);
            const sub = line.match(/^[-•]\s+(.*)/);
            if (nm) {
              merged.push({ num: nm[1], text: nm[2], subs: [] });
            } else if (sub && merged.length > 0) {
              merged[merged.length - 1].subs.push(sub[1]);
            } else if (merged.length > 0) {
              const item = merged[merged.length - 1];
              if (item.subs.length) item.subs[item.subs.length - 1] += " " + line;
              else item.text += " " + line;
            } else {
              merged.push({ num: null, text: line, subs: [] });
            }
          }
          return (
            <ol key={bi} className="hz-response-list">
              {merged.map((item, li) => (
                <li key={li} className={`hz-response-point${item.num ? "" : " hz-response-point-plain"}`}>
                  {item.num && <span className="hz-point-num">{item.num}</span>}
                  <span className="hz-point-text">
                    {renderInline(item.text, sourceRefs)}
                    {item.subs.length > 0 && (
                      <ul className="hz-response-sublist">
                        {item.subs.map((s, si) => (
                          <li key={si} className="hz-response-subpoint">{renderInline(s, sourceRefs)}</li>
                        ))}
                      </ul>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          );
        }

        // Standalone bullet list (no numbers)
        const hasBullets = lines.some(l => /^[-•]\s+\S/.test(l));
        if (hasBullets) {
          const items = [];
          for (const line of lines) {
            const b = line.match(/^[-•]\s+(.*)/);
            if (b) items.push(b[1]);
            else if (items.length) items[items.length - 1] += " " + line;
            else items.push(line);
          }
          return (
            <ul key={bi} className="hz-response-list hz-response-bullets">
              {items.map((t, li) => (
                <li key={li} className="hz-response-point hz-response-point-plain">
                  <span className="hz-point-text">{renderInline(t, sourceRefs)}</span>
                </li>
              ))}
            </ul>
          );
        }

        // Plain paragraph — bold a leading analyst label (Assessment:/So what:/Defenders:)
        const joined = lines.join(" ");
        const labelM = LABEL_RE.exec(joined);
        if (labelM) {
          return (
            <p key={bi} className="hz-response-para hz-response-labeled">
              <strong className="hz-response-label">{labelM[1]}:</strong>{" "}
              {renderInline(labelM[2].trim(), sourceRefs)}
            </p>
          );
        }
        return (
          <p key={bi} className="hz-response-para">
            {renderInline(joined, sourceRefs)}
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
  // Use the src-N number from c.ref so the footer number matches the inline [src-N] citation.
  const num = c.ref ? (parseInt(c.ref.match(/\d+/)?.[0], 10) || index + 1) : index + 1;
  return c.url ? (
    <a href={c.url} target="_blank" rel="noopener noreferrer" className="hz-source-btn" title={c.source_title || label}>
      <span className="hz-source-btn-num">{num}</span>
      {short}
    </a>
  ) : (
    <span className="hz-source-btn hz-source-btn-nolink" title={label}>
      <span className="hz-source-btn-num">{num}</span>
      {short}
    </span>
  );
}

// ── Message ───────────────────────────────────────────────────────────────────

function Message({ msg, onFollowUp, showCost }) {
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
      {msg.answer_mode === "general" && !msg.streaming && (
        <div className="hz-answer-mode-badge" title="No corpus sources matched this question; answered from general background knowledge.">
          General knowledge — not grounded in the corpus
        </div>
      )}
      {msg.retrieval_verdict === "thin" && msg.answer_mode !== "general" && !msg.streaming && (
        <div className="hz-answer-mode-badge hz-answer-mode-thin" title="The selector found relevant sources but judged coverage incomplete for this question — answer may have gaps.">
          Limited coverage — answer may be incomplete
        </div>
      )}
      <div className="hz-msg-assistant-content">
        <StructuredText text={msg.content} sourceRefs={msg.source_refs} />
      </div>

      {msg.citations?.length > 0 && (() => {
        const sorted = [...msg.citations].sort((a, b) =>
          (parseInt(a.ref?.match(/\d+/)?.[0] || 0, 10)) - (parseInt(b.ref?.match(/\d+/)?.[0] || 0, 10))
        );
        const isAIID = (c) => c.url?.includes("incidentdatabase.ai") || /ai incident database/i.test(c.publisher || "");
        const main = sorted.filter(c => !isAIID(c));
        const aiid = sorted.filter(c => isAIID(c));
        return (
          <div className="hz-source-row">
            <span className="hz-source-row-label">Sources</span>
            <div className="hz-source-buttons">
              {main.map((c, i) => <SourceButton key={i} c={c} index={i} />)}
            </div>
            {aiid.length > 0 && (
              <div className="hz-source-aiid-group">
                <span className="hz-source-aiid-note">AI Incident Database — incidents are user-reported; treat as indicators, not verified findings</span>
                <div className="hz-source-buttons">
                  {aiid.map((c, i) => <SourceButton key={main.length + i} c={c} index={main.length + i} />)}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      <div className="hz-msg-meta">
        {msg.confidence && msg.confidence !== "low" && (
          <span className={`hz-msg-conf ${confCls}`} title={msg.confidence_reason}>
            {msg.confidence} confidence
          </span>
        )}
        {msg.temporal_scope && msg.temporal_scope !== "all available data" && (
          <span className="hz-msg-scope">{msg.temporal_scope}</span>
        )}
        {showCost && msg.token_usage && (
          <span
            className="hz-msg-tokens"
            title={`Input: ${msg.token_usage.input_tokens.toLocaleString()} · Output: ${msg.token_usage.output_tokens.toLocaleString()} · ${msg.token_usage.rounds} round${msg.token_usage.rounds !== 1 ? "s" : ""}`}
          >
            {msg.token_usage.total_tokens.toLocaleString()} tokens · {msg.token_usage.estimated_cost_usd < 0.01 ? "<$0.01" : `$${msg.token_usage.estimated_cost_usd.toFixed(3)}`}
          </span>
        )}
      </div>

      {msg.caveat && <div className="hz-caveat">{msg.caveat}</div>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function historyKey(userId) {
  return userId ? `hz_chat_history:${userId}` : null;
}

function agentLogKey(userId) {
  return userId ? `hz_agent_log:${userId}` : null;
}

function loadHistory(userId) {
  const key = historyKey(userId);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Drop any message that was mid-stream when the page was closed
    return Array.isArray(parsed) ? parsed.filter(m => !m.streaming) : [];
  } catch { return []; }
}

function saveHistory(userId, msgs) {
  const key = historyKey(userId);
  if (!key) return;
  try {
    const toSave = msgs.filter(m => !m.streaming).slice(-200);
    localStorage.setItem(key, JSON.stringify(toSave));
  } catch (_) {}
}

export function AskAgentPage() {
  const session = useAuth();
  const userId  = session?.user?.id ?? null;
  const isAdmin = getAccessLevel(session) === "admin";

  const [messages, setMessages] = useState(() => loadHistory(userId));
  const [query,    setQuery]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const hasConversation = messages.length > 0;

  // Reload history when the user changes (e.g. someone else logs in on same browser)
  useEffect(() => {
    setMessages(loadHistory(userId));
  }, [userId]);

  // Persist history whenever messages change (skip mid-stream updates)
  useEffect(() => {
    if (!loading) saveHistory(userId, messages);
  }, [messages, loading, userId]);

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
      const res = await fetch("/api/agent", {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${getSessionToken(session)}`,
        },
        body:    JSON.stringify({ query: q, history, stream: true }),
      });
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `API error ${res.status}`);
      }

      // Insert a placeholder assistant message we grow as deltas arrive.
      setMessages(prev => [...prev, { role: "assistant", content: "", streaming: true, citations: [], source_refs: [] }]);
      const setLast = (patch) => setMessages(prev => {
        const m = [...prev];
        m[m.length - 1] = typeof patch === "function" ? patch(m[m.length - 1]) : { ...m[m.length - 1], ...patch };
        return m;
      });

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", done = null;
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let e; try { e = JSON.parse(data); } catch { continue; }
          if (e.type === "status") {
            setLast(prev => ({ ...prev, status: e.text }));
          } else if (e.type === "delta") {
            setLast(prev => ({ ...prev, content: prev.content + e.text, status: null }));
          } else if (e.type === "done") {
            done = e;
            setLast({
              role:                "assistant",
              content:             e.answer || "No answer returned.",
              citations:           e.citations            || [],
              source_refs:         e.source_refs          || [],
              confidence:          e.confidence           || null,
              confidence_reason:   e.confidence_reason    || "",
              caveat:              e.caveat               || null,
              suggested_followups: e.suggested_followups  || [],
              temporal_scope:      e.temporal_scope       || null,
              token_usage:         e.token_usage          || null,
              qa_issues:           e.qa_issues            || [],
              qa_pass:             e.qa_pass !== false,
              answer_mode:         e.answer_mode          || null,
              retrieval_verdict:   e.retrieval_verdict    || null,
              streaming:           false,
            });
            // Phase 2: run verifier in the background — separate Vercel call
            // so synthesis completes within 10s. Patches answer if issues found.
            if (e.answer && e.answer_mode === "grounded" && (e.source_refs || []).length) {
              fetch("/api/agent-verify", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getSessionToken(session)}` },
                body: JSON.stringify({ answer: e.answer, sources: e.source_refs || [], evidence: [] }),
              }).then(r => r.ok ? r.json() : null).then(v => {
                if (!v?.ran || !v.unsupported?.length) return;
                const note = `\n\n**Note — the following specific claims could not be verified against the provided source summaries and may be inaccurate:**\n${v.unsupported.map(u => `- ${u}`).join("\n")}`;
                setLast(prev => ({ ...prev, content: prev.content + note }));
              }).catch(() => {});
            }
          } else if (e.type === "error") {
            throw new Error(e.error);
          }
        }
      }

      // Persist call log entry to localStorage for the Logs page
      try {
        const logEntry = {
          ts:          new Date().toISOString(),
          query:       q,
          confidence:  done?.confidence || null,
          tools:       (done?.tool_calls || []).map(t => t.tool),
          token_usage: done?.token_usage || null,
        };
        const key = agentLogKey(userId);
        if (key) {
          const stored = JSON.parse(localStorage.getItem(key) || "[]");
          stored.unshift(logEntry);
          localStorage.setItem(key, JSON.stringify(stored.slice(0, 100)));
        }
      } catch (_) {}
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
            <Message key={i} msg={msg} onFollowUp={send} showCost={isAdmin} />
          ))}
          {loading && (() => {
            // Show status/progress until the first streamed token lands; once the
            // assistant bubble has content, the streaming text itself is the signal.
            const last = messages[messages.length - 1];
            const streamingWithText = last && last.role === "assistant" && last.content;
            const statusText = last?.role === "assistant" ? last.status : null;
            return streamingWithText ? null : (
              <div className="hz-loading-dot">
                <span className="hz-loading-dots"><span /><span /><span /></span>
                {statusText || "Thinking…"}
              </div>
            );
          })()}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Loading in empty state */}
      {!hasConversation && loading && (
        <div className="hz-chat-window" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="hz-loading-dot">
            <span className="hz-loading-dots"><span /><span /><span /></span>
            {(() => { const last = messages[messages.length - 1]; return last?.role === "assistant" && last.status ? last.status : "Thinking…"; })()}
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
        <div className="hz-chat-input-footer">
          <p className="hz-chat-input-hint">
            90-day default · specify timeframe for broader or narrower results
          </p>
          <button
            className="hz-chat-clear"
            onClick={() => { setMessages([]); const k = historyKey(userId); if (k) localStorage.removeItem(k); }}
            disabled={loading}
          >
            Clear history
          </button>
        </div>
      </div>

    </div>
  );
}
