-- 028_strip_user_metadata_role.sql
--
-- Defence in depth for the guest-to-admin privilege escalation.
--
-- The application no longer reads user_metadata.role for authorization — the
-- role lives in app_metadata (raw_app_meta_data), writable only by the
-- service-role admin API. See lib/api/requireAuth.js. This migration removes
-- the escalation *primitive* as well: it deletes any `role` key from
-- raw_user_meta_data on every insert and update, so
--
--     PUT /auth/v1/user  {"data":{"role":"admin"}}
--
-- cannot persist the value at all. The request still returns 200 — GoTrue is a
-- managed service and cannot be made to return 403 — but the row and every
-- subsequently issued JWT come back with no role key in user_metadata.
--
-- WHY UNCONDITIONAL: GoTrue connects to Postgres as the same database role for
-- both self-service updates and the admin API, so a trigger CANNOT distinguish
-- "user edited their own metadata" from "our script called updateUserById".
-- The strip therefore applies to everyone. That is intentional and safe here:
-- nothing in this codebase writes a role to user_metadata any more
-- (scripts/createUser.js writes app_metadata), and scripts/migrateUserRoles.js
-- deletes the key regardless.
--
-- This trigger does NOT store or grant roles. It only guarantees the absence of
-- a misleading, self-assignable field. app_metadata remains the source of truth,
-- and lib/api/requireAuth.js remains the actual access control.
--
-- Apply via the Supabase SQL editor (needs privileges to create a trigger on
-- auth.users). Verification and rollback queries are at the bottom.

-- ── 1. The strip function ───────────────────────────────────────────────────
-- SECURITY INVOKER (the default): the function touches no tables, only the NEW
-- row, so it needs no elevated privileges.

create or replace function public.strip_user_metadata_role()
returns trigger
language plpgsql
as $$
begin
  -- jsonb `-` deletes a top-level key and is a no-op when the key is absent.
  if new.raw_user_meta_data is not null then
    new.raw_user_meta_data := new.raw_user_meta_data - 'role';
  end if;
  return new;
end;
$$;

comment on function public.strip_user_metadata_role() is
  'Deletes the self-assignable role key from auth.users.raw_user_meta_data. '
  'Authorization roles live in raw_app_meta_data; see lib/api/requireAuth.js.';

-- Trigger creation checks EXECUTE on the function; grant it to the role GoTrue
-- connects as so the trigger cannot fail to attach.
grant execute on function public.strip_user_metadata_role() to supabase_auth_admin;

-- ── 2. Attach to auth.users ─────────────────────────────────────────────────

drop trigger if exists strip_user_metadata_role on auth.users;

create trigger strip_user_metadata_role
  before insert or update on auth.users
  for each row execute function public.strip_user_metadata_role();

-- ── 3. One-time cleanup of rows that already carry the key ──────────────────
-- Existing accounts still hold a stale (and possibly self-assigned) role in
-- user_metadata. This clears them; the trigger keeps them clear.

update auth.users
set    raw_user_meta_data = raw_user_meta_data - 'role'
where  raw_user_meta_data -> 'role' is not null;

-- ── Verification ────────────────────────────────────────────────────────────
-- Both should return zero rows / the expected trigger. Re-check after any
-- Supabase platform upgrade, since the trigger lives on a managed schema.
--
--   -- no account carries a role in user_metadata:
--   select email, raw_user_meta_data -> 'role' as leaked_role
--   from   auth.users
--   where  raw_user_meta_data -> 'role' is not null;
--
--   -- the trigger is still attached and enabled (tgenabled = 'O'):
--   select tgname, tgenabled from pg_trigger
--   where  tgrelid = 'auth.users'::regclass and not tgisinternal;
--
--   -- roles are intact in the trusted field:
--   select email, raw_app_meta_data -> 'role' as role from auth.users order by email;
--
-- End-to-end check: as a guest, send
--   PUT /auth/v1/user  {"data":{"role":"admin"}}
-- It returns 200, but the response body's user_metadata has no role key, and
-- PATCH /api/sources still returns 403 after a session refresh.
--
-- ── Rollback ────────────────────────────────────────────────────────────────
--   drop trigger if exists strip_user_metadata_role on auth.users;
--   drop function if exists public.strip_user_metadata_role();
