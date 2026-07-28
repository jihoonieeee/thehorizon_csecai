/**
 * Create an invited user account in Supabase Auth (invite-only platform).
 *
 * Usage:
 *   node scripts/createUser.js <email> [role]
 *   role: "admin" | "guest" (default: "guest")
 *
 * The user is created with email_confirm=true and a random password.
 * A password-reset link is printed — send it to the user so they can set their own password.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const [,, email, role = "guest"] = process.argv;

if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/createUser.js <email> [admin|guest]");
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

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password:      crypto.randomUUID(),
  email_confirm: true,
  user_metadata: { role },
});

if (error) {
  console.error("Failed to create user:", error.message);
  process.exit(1);
}

console.log(`Created user: ${data.user.id}  ${email}  role=${role}`);

// Generate a password-reset link so the user can set their own password.
const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
  type:  "recovery",
  email,
  options: { redirectTo: "https://the-horizon-csec.vercel.app" },
});

if (linkError) {
  console.warn("Could not generate reset link:", linkError.message);
  console.log("Send the user to your app and have them use 'Forgot password'.");
} else {
  console.log("\nSend this link to the user (expires in 1 hour):");
  console.log(linkData.properties.action_link);
}
