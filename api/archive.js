/**
 * GET /api/archive?type=sources        — replaces api/archive-sources.js
 * GET /api/archive?type=snapshots      — replaces api/snapshots.js
 * GET /api/archive?type=period-sources — replaces api/period-sources.js
 */
import { listSources, listSnapshots, getSnapshotById } from "../lib/storage/snapshotDatabase.js";
import { getSingaporePeriodWindow } from "../lib/time/reportingWindow.js";

export default async function handler(req, res) {
  const { type = "sources", start, end, id, publisher, source_type, tag, period } = req.query;
  try {
    if (type === "snapshots") {
      if (id) {
        const snapshot = await getSnapshotById(id);
        if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
        return res.status(200).json(snapshot);
      }
      const snapshots = await listSnapshots({ start, end });
      return res.status(200).json({ count: snapshots.length, snapshots });
    }

    if (type === "period-sources") {
      const win = getSingaporePeriodWindow(period || "daily");
      const sources = await listSources({ start: win.start_utc, end: win.end_utc, publisher, source_type, tag, limit: 3000 });
      return res.status(200).json({ period: period || "daily", reporting_window: win, start: win.start_utc, end: win.end_utc, count: sources.length, sources });
    }

    // default: type=sources
    const sources = await listSources({ start, end, publisher, source_type, tag, limit: 1000 });
    return res.status(200).json({ count: sources.length, sources });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
