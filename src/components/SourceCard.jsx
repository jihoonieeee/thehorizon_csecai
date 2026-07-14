import { formatLabel, formatDate, getCredibilityLabel } from "../utils.js";

export function TagList({ tags = [] }) {
  const cleanTags = [...new Set(tags)].filter(Boolean).slice(0, 10);
  if (!cleanTags.length) return null;

  return (
    <div className="tag-row">
      {cleanTags.map((tag) => (
        <span key={tag}>{formatLabel(tag)}</span>
      ))}
    </div>
  );
}

export function SourceCard({ source, featured = false }) {
  const credibility    = getCredibilityLabel(source);
  const priorityLabel  = source.priority_label || "unscored";
  const priorityScore  = source.priority_score ?? "—";
  const relevanceTier  = source.relevance_tier;
  const aiScore        = typeof source.ai_specificity_score === "number"
    ? source.ai_specificity_score
    : null;

  const previewText =
    source.short_summary ||
    source.analyst_brief?.what_happened ||
    source.summary ||
    source.full_text ||
    "";
  const maxLen = featured ? 600 : 380;

  return (
    <article className={`source-card${featured ? " featured-card" : ""}`}>
      <div className="source-card-top">
        <span className="source-type">{formatLabel(source.source_type)}</span>
        <div className="card-badges">
          {relevanceTier && relevanceTier !== "context" && (
            <span className={`relevance-tier ${relevanceTier}`}>{relevanceTier}</span>
          )}
          <span className={`priority-pill ${priorityLabel}`}>
            {formatLabel(priorityLabel)} · {priorityScore}
          </span>
        </div>
      </div>

      <h3>{source.title}</h3>

      <p className="meta">
        {source.publisher || "Unknown publisher"} · {formatDate(source.date_published)}
        {aiScore !== null && (
          <span className="ai-score-badge" title="AI specificity score (0–100)">
            AI {aiScore}
          </span>
        )}
      </p>

      {source.priority_reason && (
        <p className="reason">{source.priority_reason}</p>
      )}

      <p className="summary">
        {previewText ? previewText.slice(0, maxLen) : "No summary available."}
      </p>

      <TagList tags={source.tags || []} />

      <div className="card-footer">
        <span className={`credibility ${credibility}`}>{formatLabel(credibility)}</span>
        <a href={source.url} target="_blank" rel="noreferrer">
          Open source →
        </a>
      </div>
    </article>
  );
}
