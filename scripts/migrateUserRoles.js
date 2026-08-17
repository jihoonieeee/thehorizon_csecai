/**
 * Migrate application roles out of user-writable user_metadata into app_metadata.
 *
 * Background: the app used to authorize on `user_metadata.role`. Supabase lets
 * any authenticated user rewrite their own user_metadata via PUT /auth/v1/user,
 * so any guest could set {"role":"admin"}, refresh their session, and receive a
 * validly signed JWT that the API accepted as admin (guest-to-admin privilege
 * escalation). `app_metadata` is writable only via the service-role admin API.
 *
 * This script does NOT trust the existing user_metadata.role value — that value
 * is exactly what an attacker could have set. Admins must be named explicitly:
 *
 *   node scripts/migrateUserRoles.js --admins alice@example.com,bob@example.com
 *       → dry run: prints the planned change for every user, and flags any
 *         account whose current user_metadata.role is admin but which is not in
 *         the allowlist (a possible historical self-escalation worth auditing).
 *
 *   node scripts/migrateUserRoles.js --admins alice@example.com --apply
 *       → writes app_metadata.role for every user and deletes the stale
 *         user_metadata.role key so nothing can read it by accident.
 *
 * Everyone not named in --admins becomes a guest.
 *
 * Run this BEFORE (or together with) deploying the app_metadata-reading code:
 * populating app_metadata early is harmless, but deploying the new guard while
 * app_metadata is still empty would lock your real admins out.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args   = process.argv.slice(2);
const apply  = args.includes("--apply");
const adminArg = args.find(a => a.startsWith("--admins="))
  ?? (args.includes("--admins") ? args[args.indexOf("--admins") + 1] : "");

const adminEmails = new Set(
  String(adminArg || "")
    .replace(/^--admins=/, "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

if (!adminEmails.size) {
  console.error("Usage: node scripts/migrateUserRoles.js --admins a@b.com[,c@d.com] [--apply]");
  console.error("Refusing to run with an empty admin allowlist — that would demote everyone.");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Page through the full user list (listUsers caps at 1000 per page).
const users = [];
for (let page = 1; ; page++) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) { console.error("Failed to list users:", error.message); process.exit(1); }
  users.push(...data.users);
  if (data.users.length < 1000) break;
}

const unknownAdmins = [...adminEmails].filter(
  e => !users.some(u => (u.email || "").toLowerCase() === e)
);
if (unknownAdmins.length) {
  console.error(`No such user(s): ${unknownAdmins.join(", ")}`);
  console.error("Fix the --admins list before applying — aborting.");
  process.exit(1);
}

console.log(`${users.length} user(s); ${adminEmails.size} named admin(s).`);
console.log(apply ? "Mode: APPLY\n" : "Mode: DRY RUN (re-run with --apply to write)\n");

const suspicious = [];
let changed = 0;

for (const user of users) {
  const email    = (user.email || "").toLowerCase();
  const target   = adminEmails.has(email) ? "admin" : "guest";
  const oldUser  = user.user_metadata?.role ?? "(none)";
  const oldApp   = user.app_metadata?.role  ?? "(none)";

  // An account that granted itself admin in user_metadata without being on the
  // allowlist is the exact fingerprint of the escalation — worth auditing.
  if (oldUser === "admin" && target !== "admin") suspicious.push(user.email);

  const needsWrite = oldApp !== target || user.user_metadata?.role !== undefined;
  if (!needsWrite) {
    console.log(`  ok    ${user.email.padEnd(34)} app_metadata.role=${oldApp}`);
    continue;
  }

  changed++;
  console.log(`  ${apply ? "write" : "plan "} ${user.email.padEnd(34)} user_metadata.role=${oldUser} app_metadata.role=${oldApp} → ${target}`);

  if (!apply) continue;

  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    app_metadata:  { role: target },
    // Setting a key to null deletes it from the metadata object.
    user_metadata: { role: null },
  });
  if (error) console.error(`        FAILED: ${error.message}`);
}

console.log(`\n${changed} user(s) ${apply ? "updated" : "would be updated"}.`);

if (suspicious.length) {
  console.log("\n⚠  These accounts carried user_metadata.role=admin but are not on the");
  console.log("   admin allowlist. Each is either a stale grant or a self-escalation —");
  console.log("   audit their source edits, deletions, and flag changes:");
  for (const e of suspicious) console.log(`     ${e}`);
}

if (apply) {
  console.log("\nNext: existing browser sessions keep a stale role claim in their cached");
  console.log("token until it refreshes (≤1h). Server-side authorization is already");
  console.log("correct — the only effect is that a demoted user may briefly still see");
  console.log("admin buttons, which now return 403. Force it sooner by having affected");
  console.log("users sign out and back in.");
}
