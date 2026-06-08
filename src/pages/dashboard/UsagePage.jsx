import { useState, useEffect } from "react";

const CARD = {
  background:   "rgba(8,12,20,0.8)",
  border:       "1px solid #0f1827",
  borderRadius: "10px",
  padding:      "16px 20px",
};

const LABEL = { fontSize: "0.62rem", color: "#334155", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" };
const VALUE = { fontSize: "1.3rem", fontWeight: 700, color: "#e2e8f0" };
const SUB   = { fontSize: "0.7rem", color: "#334155", marginTop: "2px" };

const PROVIDER_COLORS = {
  gemini:     "#60a5fa",
  anthropic:  "#a78bfa",
  openai:     "#34d399",
  groq:       "#fbbf24",
  cloudflare: "#f97316",
  openrouter: "#e879f9",
  ollama:     "#94a3b8",
};

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd) {
  if (usd === 0)    return "$0.00";
  if (usd < 0.001)  return `<$0.001`;
  if (usd < 0.01)   return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ ...CARD, flex: 1 }}>
      <div style={LABEL}>{label}</div>
      <div style={{ ...VALUE, color: accent || "#e2e8f0" }}>{value}</div>
      {sub && <div style={SUB}>{sub}</div>}
    </div>
  );
}

function ProviderBar({ provider, data, maxTokens }) {
  const color = PROVIDER_COLORS[provider.toLowerCase()] || "#64748b";
  const pct = maxTokens > 0 ? (data.total_tokens / maxTokens) * 100 : 0;

  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontSize: "0.8rem", color: "#94a3b8", fontWeight: 600 }}>{data.label}</span>
          <span style={{ fontSize: "0.68rem", color: "#334155", background: "#0a0f1e", padding: "1px 6px", borderRadius: "4px", border: "1px solid #0f1827" }}>
            {data.calls} call{data.calls !== 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
            {fmt(data.input_tokens)} in / {fmt(data.output_tokens)} out
          </span>
          <span style={{ fontSize: "0.78rem", color: data.cost.total_usd > 0 ? "#fbbf24" : "#334155", fontWeight: 600, minWidth: "56px", textAlign: "right" }}>
            {fmtCost(data.cost.total_usd)}
          </span>
        </div>
      </div>
      <div style={{ height: "4px", background: "#0f172a", borderRadius: "2px", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: "2px", transition: "width 0.4s" }} />
      </div>
    </div>
  );
}

function TaskRow({ task, data, maxTokens }) {
  const pct = maxTokens > 0 ? (data.total_tokens / maxTokens) * 100 : 0;
  const taskLabel = task.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 0", borderBottom: "1px solid #0a0f1e" }}>
      <div style={{ width: "160px", fontSize: "0.75rem", color: "#64748b", flexShrink: 0 }}>{taskLabel}</div>
      <div style={{ flex: 1, height: "3px", background: "#0f172a", borderRadius: "2px" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "#4f46e5", borderRadius: "2px" }} />
      </div>
      <div style={{ fontSize: "0.72rem", color: "#94a3b8", minWidth: "60px", textAlign: "right" }}>{fmt(data.total_tokens)}</div>
      <div style={{ fontSize: "0.68rem", color: "#334155", minWidth: "44px", textAlign: "right" }}>{data.calls} calls</div>
    </div>
  );
}

function CacheStats({ cache }) {
  if (!cache) return null;
  const hitRate = cache.hits + cache.misses > 0
    ? Math.round((cache.hits / (cache.hits + cache.misses)) * 100)
    : 0;
  return (
    <div style={{ ...CARD, marginTop: "16px" }}>
      <div style={{ ...LABEL, marginBottom: "12px" }}>LLM Cache</div>
      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
        {[
          { label: "Hit rate",   value: `${hitRate}%`,        accent: hitRate > 40 ? "#34d399" : "#94a3b8" },
          { label: "Hits",       value: fmt(cache.hits || 0),   accent: "#34d399" },
          { label: "Misses",     value: fmt(cache.misses || 0), accent: "#64748b" },
          { label: "Entries",    value: fmt(cache.size  || 0),  accent: "#94a3b8" },
        ].map(({ label, value, accent }) => (
          <div key={label}>
            <div style={{ fontSize: "0.62rem", color: "#1e3a5f", fontWeight: 700, textTransform: "uppercase", marginBottom: "3px" }}>{label}</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: accent }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UsagePage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tick, setTick]       = useState(0);

  useEffect(() => {
    setLoading(true);
    fetch("/api/usage")
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [tick]);

  const refresh = () => setTick(t => t + 1);

  const maxProviderTokens = data
    ? Math.max(...(data.by_provider || []).map(p => p.total_tokens), 1)
    : 1;
  const maxTaskTokens = data
    ? Math.max(...(data.by_task || []).map(t => t.total_tokens), 1)
    : 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#e2e8f0" }}>API Usage</div>
          <div style={{ fontSize: "0.7rem", color: "#334155", marginTop: "2px" }}>
            Session token tracking — resets on server restart
          </div>
        </div>
        <button
          onClick={refresh}
          style={{
            background: "transparent", border: "1px solid #1e293b", borderRadius: "6px",
            color: "#64748b", fontSize: "0.72rem", padding: "5px 12px", cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {loading && <div style={{ color: "#334155", fontSize: "0.8rem" }}>Loading usage data…</div>}
      {error   && <div style={{ color: "#f87171", fontSize: "0.8rem" }}>Error: {error}</div>}

      {data && (
        <>
          {/* Summary row */}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <StatCard
              label="Session Tokens"
              value={fmt(data.daily_total_tokens || 0)}
              sub={`${data.session_date} · budget: ${data.daily_budget}`}
            />
            <StatCard
              label="Estimated Cost"
              value={fmtCost(data.total_cost_usd || 0)}
              sub={data.pricing_note}
              accent="#fbbf24"
            />
            <StatCard
              label="Providers Used"
              value={data.by_provider?.length || 0}
              sub={data.exhausted_providers?.length
                ? `${data.exhausted_providers.join(", ")} exhausted`
                : "all providers healthy"}
              accent={data.exhausted_providers?.length ? "#f87171" : "#34d399"}
            />
            <StatCard
              label="Cache Hit Rate"
              value={
                data.cache && (data.cache.hits + data.cache.misses) > 0
                  ? `${Math.round((data.cache.hits / (data.cache.hits + data.cache.misses)) * 100)}%`
                  : "n/a"
              }
              sub={`${fmt(data.cache?.hits || 0)} hits · ${fmt(data.cache?.misses || 0)} misses`}
              accent="#34d399"
            />
          </div>

          {/* By Provider */}
          <div style={CARD}>
            <div style={{ ...LABEL, marginBottom: "16px" }}>Usage by Provider</div>
            {data.by_provider?.length > 0
              ? data.by_provider
                  .sort((a, b) => b.total_tokens - a.total_tokens)
                  .map(p => (
                    <ProviderBar
                      key={p.provider}
                      provider={p.provider}
                      data={p}
                      maxTokens={maxProviderTokens}
                    />
                  ))
              : <div style={{ color: "#334155", fontSize: "0.8rem" }}>No LLM calls recorded this session.</div>
            }
            {data.by_provider?.length > 0 && (
              <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #0a0f1e", fontSize: "0.65rem", color: "#1e3a5f" }}>
                Token counts estimated (chars ÷ 4). Costs use approximate published pricing.
              </div>
            )}
          </div>

          {/* By Task */}
          {data.by_task?.length > 0 && (
            <div style={CARD}>
              <div style={{ ...LABEL, marginBottom: "4px" }}>Usage by Pipeline Task</div>
              {data.by_task.map(t => (
                <TaskRow key={t.task} task={t.task} data={t} maxTokens={maxTaskTokens} />
              ))}
            </div>
          )}

          {/* Cache */}
          <CacheStats cache={data.cache} />

          {/* Exhausted providers */}
          {data.exhausted_providers?.length > 0 && (
            <div style={{ ...CARD, borderColor: "rgba(239,68,68,0.3)" }}>
              <div style={{ ...LABEL, color: "#f87171" }}>Quota-Exhausted Providers</div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "6px" }}>
                {data.exhausted_providers.map(p => (
                  <span key={p} style={{
                    fontSize: "0.72rem", padding: "3px 10px", borderRadius: "6px",
                    background: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.25)",
                  }}>
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
