-- EcoVate Supabase schema
-- Run in the Supabase dashboard SQL editor after creating the project.
-- Derived from the Insforge backup (20260414_053413.sql.gz), public tables only.
-- Rebasing note (Nov 24, 2026): this file was rewritten from the Nov 10
-- version to match live head b568ffb. Columns added since Nov 10 are all
-- here (verdict columns, diy_ideas, usage_attempts, diy_failed /
-- material_guess in the CHECK). The live code tolerates missing columns
-- with tiered-insert fallbacks, but run this whole file once so the
-- fallbacks never trigger.
--
-- Design corrections vs the Nov 10 plan:
--   * public.users.id does NOT reference auth.users(id). Guest accounts
--     are plain UUID rows in public.users (their ids are not Supabase
--     Auth users), so the FK would reject every guest insert — including
--     the /api/anon-session row that every guest session starts with.
--     Google users' ids still equal their auth.users ids by convention
--     (set at profile creation); it just is not enforced by FK.
--     Account deletion is done explicitly by DELETE /api/account, so no
--     ON DELETE CASCADE from auth.users is needed.
--   * The user-uploads bucket must be PRIVATE, not public. The Nov 10
--     plan called for a public bucket, but the live app went private on
--     Nov 22-23 (signed-URL proxy /api/image, privacy copy updated).
--     Photos are served only through the proxy; uploads use the
--     service-role key. No storage policies are needed.
--   * RLS is ON. API routes use the service-role key and bypass RLS;
--     the policies below only cover what the browser client needs:
--     reading its own rows, and inserting its own users row from the
--     OAuth callback (the scan route also upserts it server-side).

create table if not exists public.users (
  id uuid primary key,
  email text not null,
  name text,
  avatar text,
  sustainability_score integer default 0,
  created_at timestamptz default now()
);

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  product_name text not null,
  materials text[] default '{}'::text[],
  carbon_footprint numeric(10,4),
  recyclability_score integer,
  image_url text,
  packaging_type text,
  estimated_co2_saved numeric(10,4),
  label_text text,
  diy_ideas jsonb default '[]'::jsonb,
  -- Set only when the AI analysis failed with no data (the scan
  -- route's 500): the plain error message. A row with this set is a
  -- failed scan — History shows it with a Retry action, the
  -- dashboard excludes it, and DIY/verify/actions refuse it until
  -- a retry clears it in place.
  scan_error text,
  created_at timestamptz default now(),
  constraint scans_recyclability_score_check
    check ((recyclability_score >= 0) and (recyclability_score <= 100))
);

create table if not exists public.user_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  scan_id uuid references public.scans (id) on delete set null,
  action_type text not null,
  impact_score integer default 0,
  image_url text,
  feedback text,
  project_title text,
  verify_match_confidence numeric(10,4),
  verify_code_seen text,
  verify_code_ok boolean,
  packaging_type text,
  estimated_co2_saved numeric(10,4),
  created_at timestamptz default now(),
  constraint user_actions_action_type_check
    check (action_type = any (array['scanned'::text, 'diy_selected'::text, 'diy_completed'::text, 'diy_pending'::text, 'diy_failed'::text, 'material_guess'::text]))
);

-- One row per AI-costly attempt (scan / verify / material guess /
-- DIY refresh). The daily caps count these rows, so deleting a scan
-- or a project no longer refunds quota. Never written or read by the
-- browser client — service-role key only.
create table if not exists public.usage_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('scan', 'verify', 'material_guess', 'diy_refresh')),
  created_at timestamptz not null default now()
);
create index if not exists usage_attempts_user_kind_created_idx
  on public.usage_attempts (user_id, kind, created_at desc);

-- RLS: browser client reads its own rows; writes go through the API
-- routes with the service-role key, which bypasses RLS.
alter table public.users enable row level security;
alter table public.scans enable row level security;
alter table public.user_actions enable row level security;
alter table public.usage_attempts enable row level security;

create policy "users_read_own_or_any" on public.users
  for select to authenticated using (true);

create policy "users_insert_own" on public.users
  for insert to authenticated with check (auth.uid() = id);

create policy "users_update_own" on public.users
  for update to authenticated using (auth.uid() = id);

create policy "scans_read_own" on public.scans
  for select to authenticated using (auth.uid() = user_id);

create policy "actions_read_own" on public.user_actions
  for select to authenticated using (auth.uid() = user_id);

-- Storage: create the bucket in Dashboard > Storage as a PRIVATE
-- bucket named "user-uploads", or run:
--   insert into storage.buckets (id, name, public) values ('user-uploads', 'user-uploads', false);
-- Uploads happen from API routes with the service-role key, so no
-- storage policies are needed for writes. Reads go through the
-- app's /api/image proxy (HMAC-signed URLs for scans and
-- verifications, unsigned for avatars), never through public
-- storage URLs — the bucket being private is what makes that true.
