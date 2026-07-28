/**
 * Create an invited user account in Supabase Auth (invite-only platform).
 *
 * Usage:
 *   node scripts/createUser.js <email> [role]          — create new user + print invite link
 *   node scripts/createUser.js <email> [role] --resend — resend invite link for existing user
 *   role: "admin" | "guest" (default: "guest")
 *
 * The invite link expires after the OTP TTL configured in the Supabase dashboard
 * (Authentication → Email → OTP Expiry). Run with --resend to generate a fresh link.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args  = process.argv.slice(2);
const email = args.find(a => a.includes("@"));
const role  = args.find(a => a === "admin" || a === "guest") ?? "guest";
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

async function generateInviteLink(email) {
  const { data, error } = await supabase.auth.admin.generateLink({
    type:  "recovery",
    email,
    options: { redirectTo: "https://the-horizon-csec.vercel.app" },
  });
  if (error) {
    console.error("Could not generate invite link:", error.message);
    process.exit(1);
  }
  return data.properties.action_link;
}

if (resend) {
  const link = await generateInviteLink(email);
  console.log(`\nFresh invite link for ${email} (send this — the previous link is now invalid):`);
  console.log(link);
  process.exit(0);
}

// Create new user
const { data, error } = await supabase.auth.admin.createUser({
  email,
  password:      crypto.randomUUID(),
  email_confirm: true,
  user_metadata: { role },
});

if (error) {
  if (error.message?.toLowerCase().includes("already been registered")) {
    console.log(`User ${email} already exists — generating a fresh invite link.`);
    const link = await generateInviteLink(email);
    console.log("\nSend this link to the user:");
    console.log(link);
    process.exit(0);
  }
  console.error("Failed to create user:", error.message);
  process.exit(1);
}

console.log(`Created user: ${data.user.id}  ${email}  role=${role}`);

const link = await generateInviteLink(email);
console.log("\nSend this link to the user:");
console.log(link);
