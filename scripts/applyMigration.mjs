#!/usr/bin/env node
/**
 * applyMigration.mjs — apply a SQL migration to Supabase Postgres.
 *
 * DDL (ALTER TABLE / CREATE INDEX) cannot run through the PostgREST REST API
 * (the SUPABASE_URL + service-role key surface). It needs a DIRECT Postgres
 * connection. This script uses one.
 *
 * Setup (one time):
 *   1. Supabase → Project Settings → Database → Connection string → URI.
 *      Copy the URI (contains your DB password), e.g.:
 *        postgresql://postgres:[PASSWORD]@db.<ref>.supabase.co:5432/postgres
 *      (or the pooler form on port 6543).
 *   2. Add it to .env as:    SUPABASE_DB_URL=postgresql://...
 *   3. Install the driver:   npm install pg
 *
 * Usage:
 *   node scripts/applyMigration.mjs [path/to/migration.sql]
 *   # defaults to docs/migrations/rawfact-analytics-v1.sql
 *
 * Safe to re-run: the bundled migrations use IF NOT EXISTS guards.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MIGRATION = "docs/migrations/rawfact-analytics-v1.sql";

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(
      "✗ No SUPABASE_DB_URL in .env.\n" +
      "  Add the DIRECT connection string (Project Settings → Database → Connection string → URI).\n" +
      "  This is NOT the service-role key — it contains your database password."
    );
    process.exit(1);
  }

  let Client;
  try {
    ({ default: { Client } } = await import("pg").then((m) => ({ default: m })));
  } catch {
    console.error("✗ The 'pg' package is not installed.  Run:  npm install pg");
    process.exit(1);
  }

  const relPath = process.argv[2] || DEFAULT_MIGRATION;
  const sqlPath = resolve(ROOT, relPath);
  const sql = readFileSync(sqlPath, "utf8");

  console.log(`Applying migration: ${relPath}`);
  // Supabase requires TLS; the pooler/direct hosts present a valid cert but
  // rejectUnauthorized:false avoids local CA issues for a one-off admin task.
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  await client.connect();
  try {
    await client.query(sql);           // multi-statement; no params → runs the whole file
    console.log("✓ Migration applied.");

    // Verify the columns the rawfact-analytics migration adds.
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'sources'
         AND column_name = ANY($1)
       ORDER BY column_name`,
      [[
        "layer3_status", "downstream_route", "rawfact_evidence",
        "rawfact_summary", "rawfact_version", "analytics_features", "analytics_version",
      ]]
    );
    console.log("✓ Columns now present on 'sources':", rows.map((r) => r.column_name).join(", ") || "(none — check migration)");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
