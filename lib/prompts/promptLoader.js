/**
 * Prompt loader — reads prompt files from lib/prompts/ at runtime.
 *
 * Prompts are stored as .md files so they can be version-controlled,
 * reviewed, and edited without touching JS code.
 *
 * Usage:
 *   import { loadPrompt, extractSystemPrompt, interpolate } from '../prompts/promptLoader.js';
 *   const { system, user } = loadPrompt('validation/source-typing');
 *   const filled = interpolate(user, { title: source.title, ... });
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load a prompt file by name (without .md extension).
 * Returns the raw Markdown content.
 *
 * @param {string} name — e.g. "validation/source-typing"
 * @returns {string} raw prompt file content
 */
const _promptCache = new Map();

export function loadPromptRaw(name) {
  if (_promptCache.has(name)) return _promptCache.get(name);
  const filePath = path.join(__dirname, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  _promptCache.set(name, content);
  return content;
}

/**
 * Extract the system prompt from a prompt file.
 * System prompt is the content inside the first ```...``` block
 * under a "## System Prompt" heading.
 *
 * @param {string} raw — raw prompt file content
 * @returns {string} system prompt text
 */
export function extractSystemPrompt(raw) {
  const match = raw.match(/## System Prompt\s*\n```([\s\S]*?)```/);
  return match ? match[1].trim() : "";
}

/**
 * Extract a named user prompt template from a prompt file.
 * Looks for a "## User Prompt Template" or "## User Prompt Template — <name>" heading.
 *
 * @param {string} raw — raw prompt file content
 * @param {string} variant — optional variant name (e.g. "Category Section")
 * @returns {string} user prompt template text
 */
export function extractUserTemplate(raw, variant = "") {
  const heading = variant
    ? `## User Prompt Template — ${variant}`
    : "## User Prompt Template";

  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`${escaped}\\s*\\n\`\`\`([\\s\\S]*?)\`\`\``));
  if (match) return match[1].trim();

  // Fallback: first template block
  const fallback = raw.match(/## User Prompt Template\s*\n```([\s\S]*?)```/);
  return fallback ? fallback[1].trim() : "";
}

/**
 * Load system + user prompts from a named prompt file.
 *
 * @param {string} name — prompt file name without .md
 * @param {string} variant — optional user template variant
 * @returns {{ system: string, user: string, raw: string }}
 */
export function loadPrompt(name, variant = "") {
  const raw = loadPromptRaw(name);
  return {
    system: extractSystemPrompt(raw),
    user:   extractUserTemplate(raw, variant),
    raw,
  };
}

/**
 * Interpolate a template string with values.
 * Replaces {{key}} placeholders.
 *
 * @param {string} template
 * @param {object} values
 * @returns {string}
 */
export function interpolate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = values[key];
    if (val === undefined) return `{{${key}}}`;
    if (typeof val === "object") return JSON.stringify(val, null, 2);
    return String(val);
  });
}
