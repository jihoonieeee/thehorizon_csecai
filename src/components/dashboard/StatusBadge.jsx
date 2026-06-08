/**
 * StatusBadge — displays a categorical status with color coding.
 * Used for: evidence_strength, claim_priority, slide_suitability, confidence.
 */

const BADGE_STYLES = {
  // Evidence strength
  strong:           { bg: "#14532d", color: "#4ade80",  label: "Strong" },
  usable:           { bg: "#1e3a5f", color: "#60a5fa",  label: "Usable" },
  context:          { bg: "#3f3f46", color: "#a1a1aa",  label: "Context" },
  archive:          { bg: "#1c1917", color: "#78716c",  label: "Archive" },
  // Claim priority
  critical:         { bg: "#450a0a", color: "#f87171",  label: "Critical" },
  high:             { bg: "#431407", color: "#fb923c",  label: "High" },
  medium:           { bg: "#1c1917", color: "#d6b847",  label: "Medium" },
  rejected:         { bg: "#18181b", color: "#71717a",  label: "Rejected" },
  // Slide suitability
  embed:            { bg: "#14532d", color: "#4ade80",  label: "Embed" },
  redraw:           { bg: "#1e3a5f", color: "#60a5fa",  label: "Redraw" },
  cite:             { bg: "#3b2a1a", color: "#fbbf24",  label: "Cite Only" },
  manual_review:    { bg: "#2a1f3d", color: "#c084fc",  label: "Manual Review" },
  reject:           { bg: "#3f3f46", color: "#71717a",  label: "Reject" },
  // Confidence
  validated:        { bg: "#14532d", color: "#4ade80",  label: "Validated" },
  low:              { bg: "#2a1f2a", color: "#e879f9",  label: "Low" },
  // Visual usefulness
  none:             { bg: "#18181b", color: "#52525b",  label: "No Use" },
  // Catch-all
  unknown:          { bg: "#27272a", color: "#a1a1aa",  label: "Unknown" },
};

export function StatusBadge({ status, label: labelOverride, style: styleOverride }) {
  const key = (status || "unknown").toLowerCase();
  const style = BADGE_STYLES[key] || BADGE_STYLES.unknown;
  const label = labelOverride || style.label;

  return (
    <span style={{
      display:       "inline-block",
      padding:       "2px 8px",
      borderRadius:  "12px",
      fontSize:      "0.72rem",
      fontWeight:    700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      backgroundColor: style.bg,
      color:           style.color,
      border:          `1px solid ${style.color}33`,
      ...styleOverride,
    }}>
      {label}
    </span>
  );
}
