/**
 * Create an invited user account in Supabase Auth (invite-only platform).
 *
 * Usage:
 *   node scripts/createUser.js <email> [role]   — create new user + print temp credentials
 *   node scripts/createUser.js <email> --resend  — print fresh temp password for existing user
 *   role: "admin" | "guest" (default: "guest")
 *
 * Share the printed email + temporary password with the user.
 * On first login they will be prompted to set their own permanent password.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args   = process.argv.slice(2);
const email  = args.find(a => a.includes("@"));
const role   = args.find(a => a === "admin" || a === "guest") ?? "guest";
const resend = args.includes("--resend");

if (!email) {
  console.error("Usage: node scripts/createUser.js <email> [admin|guest] [--resend]");
  process.exit(1);
}

if (!["admin", "guest"].includes(role)) {
  console.error("Role must be 'admin' or 'guest'");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Readable temp password: Hzn- + 8 random alphanumeric chars (no ambiguous 0/O/1/l)
function genTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "Hzn-" + Array.from(bytes).map(b => chars[b % chars.length]).join("");
}

function printCredentials(email, tempPassword) {
  console.log("\nShare these credentials with the user:");
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${tempPassword}`);
  console.log("\nThey will be prompted to set their own password on first login.");
}

if (resend) {
  // Reset the needs_password_setup flag and give a fresh temp password
  const tempPassword = genTempPassword();
  const { error } = await supabase.auth.admin.updateUserById(
    // look up the user first
    (await supabase.auth.admin.listUsers()).data.users.find(u => u.email === email)?.id,
    { password: tempPassword, user_metadata: { role, needs_password_setup: true } }
  );
  if (error) { console.error("Failed to reset user:", error.message); process.exit(1); }
  printCredentials(email, tempPassword);
  process.exit(0);
}

const tempPassword = genTempPassword();

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password:      tempPassword,
  email_confirm: true,
  user_metadata: { role, needs_password_setup: true },
});

if (error) {
  if (error.message?.toLowerCase().includes("already been registered")) {
    console.log(`User ${email} already exists — run with --resend to issue fresh credentials.`);
    process.exit(1);
  }
  console.error("Failed to create user:", error.message);
  process.exit(1);
}

console.log(`Created user: ${data.user.id}  ${email}  role=${role}`);
printCredentials(email, tempPassword);
