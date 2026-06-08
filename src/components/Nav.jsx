import { formatLabel } from "../utils.js";

const PAGES = ["dashboard", "report", "daily", "weekly", "monthly", "quarterly", "archive"];
const PAGE_LABELS = { dashboard: "Dashboard", report: "Report" };

export function Nav({ page, setPage }) {
  return (
    <nav className="top-nav">
      <strong>The Horizon</strong>
      <div>
        {PAGES.map((item) => (
          <button
            key={item}
            className={page === item ? "active" : ""}
            onClick={() => setPage(item)}
          >
            {PAGE_LABELS[item] || formatLabel(item)}
          </button>
        ))}
      </div>
    </nav>
  );
}
