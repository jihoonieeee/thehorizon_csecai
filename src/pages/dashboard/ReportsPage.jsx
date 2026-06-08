/**
 * Reports — generate monthly PPTX, speaker script, weekly brief, and monthly report.
 * Calls backend endpoints if available, shows mock triggered status otherwise.
 */

import { useState } from "react";

const REPORT_TYPES = [
  {
    id:          "pptx",
    label:       "Monthly PPTX Deck",
    description: "Full horizon scan slide deck with claims, evidence, and recommendations.",
    endpoint:    "/api/generate-report",
    icon:        "▤",
    accent:      "#6366f1",
  },
  {
    id:          "script",
    label:       "Speaker Script",
    description: "Markdown speaker notes for the full deck — ready for presenter review.",
    endpoint:    "/api/generate-report",
    icon:        "✎",
    accent:      "#0ea5e9",
  },
  {
    id:          "brief",
    label:       "Weekly Brief",
    description: "Condensed 1-page intelligence brief for rapid executive consumption.",
    endpoint:    "/api/generate-report",
    icon:        "◈",
    accent:      "#10b981",
  },
  {
    id:          "monthly",
    label:       "Monthly Report",
    description: "Full written report with all categories, claims, evidence, and methodology.",
    endpoint:    "/api/generate-report",
    icon:        "⬡",
    accent:      "#f59e0b",
  },
];

function JobStatusBadge({ status }) {
  const styles = {
    idle:       { color: "#334155", bg: "transparent" },
    pending:    { color: "#f59e0b", bg: "rgba(245,158,11,0.1)" },
    generating: { color: "#6366f1", bg: "rgba(99,102,241,0.1)" },
    completed:  { color: "#10b981", bg: "rgba(16,185,129,0.1)" },
    error:      { color: "#ef4444", bg: "rgba(239,68,68,0.1)" },
  };
  const s = styles[status] || styles.idle;
  return (
    <span style={{
      fontSize:   "0.65rem",
      fontWeight: 700,
      padding:    "2px 7px",
      borderRadius:"8px",
      background: s.bg,
      color:      s.color,
      textTransform:"uppercase",
      letterSpacing:"0.06em",
    }}>
      {status}
    </span>
  );
}

function ReportCard({ report, period, jobState, onGenerate }) {
  const job = jobState[report.id] || { status: "idle" };
  return (
    <div style={{
      padding:      "16px 18px",
      borderRadius: "10px",
      background:   "rgba(8,12,20,0.7)",
      border:       `1px solid ${report.accent}22`,
      display:      "flex",
      gap:          "14px",
      alignItems:   "flex-start",
    }}>
      <div style={{
        width:       "38px",
        height:      "38px",
        borderRadius:"8px",
        background:  `${report.accent}18`,
        display:     "flex",
        alignItems:  "center",
        justifyContent:"center",
        fontSize:    "1.1rem",
        color:       report.accent,
        flexShrink:  0,
      }}>
        {report.icon}
      </div>

      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
          <span style={{ fontSize: "0.88rem", fontWeight: 700, color: "#e2e8f0" }}>{report.label}</span>
          <JobStatusBadge status={job.status} />
        </div>
        <div style={{ fontSize: "0.73rem", color: "#475569", marginBottom: "10px" }}>
          {report.description}
        </div>

        {job.status === "completed" && job.download_url && (
          <a
            href={job.download_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display:        "inline-block",
              padding:        "4px 12px",
              borderRadius:   "6px",
              background:     `${report.accent}22`,
              color:          report.accent,
              fontSize:       "0.75rem",
              fontWeight:     600,
              textDecoration: "none",
              marginBottom:   "8px",
            }}
          >
            ↓ Download
          </a>
        )}

        {job.error && (
          <div style={{ fontSize: "0.72rem", color: "#ef4444", marginBottom: "8px" }}>
            Error: {job.error}
          </div>
        )}

        {job.message && (
          <div style={{ fontSize: "0.72rem", color: "#475569", marginBottom: "8px", lineHeight: 1.5 }}>
            {job.message}
          </div>
        )}

        <button
          onClick={() => onGenerate(report)}
          disabled={job.status === "generating" || job.status === "pending"}
          style={{
            padding:      "6px 14px",
            borderRadius: "6px",
            border:       `1px solid ${report.accent}44`,
            background:   (job.status === "generating" || job.status === "pending") ? "transparent" : `${report.accent}18`,
            color:        (job.status === "generating" || job.status === "pending") ? "#334155" : report.accent,
            cursor:       (job.status === "generating" || job.status === "pending") ? "not-allowed" : "pointer",
            fontSize:     "0.75rem",
            fontWeight:   600,
            transition:   "background 0.15s",
          }}
        >
          {job.status === "generating" ? "Generating…"
           : job.status === "completed" ? "Re-generate"
           : `Generate ${report.label}`}
        </button>
      </div>
    </div>
  );
}

export function ReportsPage({ data }) {
  const [jobState, setJobState] = useState({});
  const period = data?.period || "2026-05";

  const updateJob = (id, update) =>
    setJobState((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...update } }));

  const handleGenerate = async (report) => {
    updateJob(report.id, { status: "pending", message: "Queuing…", error: null, download_url: null });
    setTimeout(() => updateJob(report.id, { status: "generating", message: "Generating — this may take 30–90s…" }), 350);

    try {
      const res = await fetch(report.endpoint, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${import.meta.env?.VITE_CRON_SECRET || ""}` },
        body:    JSON.stringify({ format: report.id, period, dryRun: false, skipIngest: true }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        updateJob(report.id, { status: "error", error: err.error || `HTTP ${res.status}`, message: null });
        return;
      }

      const json = await res.json();
      updateJob(report.id, {
        status:       "completed",
        message:      `Generated: ${json.message || "done"}`,
        download_url: json.download_url || json.blob_url || null,
        job_id:       json.job_id || null,
      });
    } catch {
      // Backend unavailable — mock trigger confirmation
      setTimeout(() => {
        updateJob(report.id, {
          status:       "completed",
          message:      `[Mock] ${report.label} triggered for ${period}. In production, the deck would be generated and a download link returned here. Run the pipeline locally via scripts/runHorizonScanMVP.js for full generation.`,
          download_url: null,
        });
      }, 1800);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div>
        <h2 style={{ margin: "0 0 4px", fontSize: "0.95rem", fontWeight: 700, color: "#e2e8f0" }}>Reports</h2>
        <p style={{ margin: 0, fontSize: "0.73rem", color: "#475569" }}>
          Generate analysis outputs for <strong style={{ color: "#94a3b8" }}>{period}</strong>.
          Generation runs the full pipeline on the backend — allow 30–90 seconds.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {REPORT_TYPES.map((report) => (
          <ReportCard
            key={report.id}
            report={report}
            period={period}
            jobState={jobState}
            onGenerate={handleGenerate}
          />
        ))}
      </div>

      <div style={{
        padding:      "12px 14px",
        borderRadius: "8px",
        background:   "rgba(8,12,20,0.4)",
        border:       "1px solid #0f1827",
        fontSize:     "0.7rem",
        color:        "#334155",
        lineHeight:   1.7,
      }}>
        <strong style={{ color: "#475569" }}>Notes: </strong>
        Generation calls POST /api/generate-report (requires CRON_SECRET). Full deck generation may exceed Vercel's 10s timeout — run locally via <code>node scripts/runHorizonScanMVP.js</code> for large corpora. Long-running jobs can be polled via GET /api/jobs/:jobId once implemented.
      </div>
    </div>
  );
}
