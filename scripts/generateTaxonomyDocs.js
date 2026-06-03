#!/usr/bin/env node
/**
 * generateTaxonomyDocs.js — Generate taxonomy documentation FROM the registry,
 * so the docs can never drift from the code (Validated AI Threat Taxonomy, June 2026).
 *
 * Emits:
 *   docs/taxonomy-reference.md   — per-domain tag tables + hierarchy + AI-enabled pairs
 *   docs/taxonomy-provenance.md  — per-tag reference/URL provenance + secondary dimensions
 *
 * Usage: node scripts/generateTaxonomyDocs.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  TAXONOMY, DOMAINS, PRIMARY_TAGS_BY_DOMAIN, SECONDARY_DIMENSIONS,
  childrenOf,
} from "../lib/config/taxonomyRegistry.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DOMAIN_TITLES = {
  traditional_ai_threats: "Traditional AI Threats (MITRE ATLAS)",
  llm_threats:            "LLM Threats (OWASP LLM Top 10 + MITRE ATLAS)",
  agentic_ai_threats:     "Agentic AI Threats (OWASP Agentic / MCP)",
  ai_enabled_threats:     "AI-Enabled Threats (paired ATT&CK + AI modifier)",
};

function mdEscape(s) { return String(s ?? "").replace(/\|/g, "\\|"); }

function referenceTable() {
  const lines = [
    "# Validated AI Threat Taxonomy — Reference (June 2026)",
    "",
    "_Generated from `lib/config/taxonomyRegistry.js`. Do not edit by hand._",
    "",
  ];
  for (const domain of DOMAINS) {
    lines.push(`## ${DOMAIN_TITLES[domain] || domain}`, "");
    if (domain === "ai_enabled_threats") {
      lines.push("| Tag | Threat meaning | Operational mapping | AI modifier | Subdomain |", "|---|---|---|---|---|");
      for (const tag of PRIMARY_TAGS_BY_DOMAIN[domain]) {
        const e = TAXONOMY[tag];
        lines.push(`| \`${tag}\` | ${mdEscape(e.threat_meaning)} | ${mdEscape(e.operational_mapping)} | ${mdEscape(e.ai_capability_modifier)} | ${e.subdomain || ""} |`);
      }
    } else {
      const hasSub = domain === "agentic_ai_threats";
      lines.push(`| Tag | Threat meaning | Reference | Parent${hasSub ? " | Subdomain" : ""} |`, `|---|---|---|---${hasSub ? "|---" : ""}|`);
      for (const tag of PRIMARY_TAGS_BY_DOMAIN[domain]) {
        const e = TAXONOMY[tag];
        lines.push(`| \`${tag}\` | ${mdEscape(e.threat_meaning)} | ${mdEscape(e.primary_reference)} | ${e.parent_tag || ""}${hasSub ? ` | ${e.subdomain || ""}` : ""} |`);
      }
    }
    lines.push("");
  }
  // Hierarchy
  lines.push("## Hierarchy (parent → children)", "");
  for (const tag of Object.keys(TAXONOMY)) {
    const kids = childrenOf(tag);
    if (kids.length) lines.push(`- \`${tag}\` → ${kids.map((k) => `\`${k}\``).join(", ")}`);
  }
  lines.push("");
  // Secondary dimensions
  lines.push("## Secondary Dimensions (NOT primary threats)", "", "| Label | Dimension | Use rule |", "|---|---|---|");
  for (const s of Object.values(SECONDARY_DIMENSIONS)) {
    lines.push(`| \`${s.tag}\` | ${s.dimension_type} | ${mdEscape(s.use_rule)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function provenanceTable() {
  const lines = [
    "# Taxonomy Provenance (June 2026)",
    "",
    "_Generated from `lib/config/taxonomyRegistry.js`. Per-tag references and resolved URLs._",
    "",
    "| Tag | Domain | Primary reference | Secondary references | URLs |",
    "|---|---|---|---|---|",
  ];
  for (const e of Object.values(TAXONOMY)) {
    lines.push(`| \`${e.tag}\` | ${e.domain} | ${mdEscape(e.primary_reference)} | ${mdEscape((e.secondary_references || []).join("; "))} | ${(e.reference_urls || []).join(" ")} |`);
  }
  lines.push("", "## Secondary Dimensions", "", "| Label | Dimension | References |", "|---|---|---|");
  for (const s of Object.values(SECONDARY_DIMENSIONS)) {
    lines.push(`| \`${s.tag}\` | ${s.dimension_type} | ${mdEscape((s.references || []).join("; "))} |`);
  }
  lines.push("");
  return lines.join("\n");
}

fs.writeFileSync(path.join(ROOT, "docs/taxonomy-reference.md"), referenceTable());
fs.writeFileSync(path.join(ROOT, "docs/taxonomy-provenance.md"), provenanceTable());
console.log("Wrote docs/taxonomy-reference.md and docs/taxonomy-provenance.md");
