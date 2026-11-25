/**
 * Supabase Client Configuration
 *
 * Replaces the Insforge client (src/lib/insforge.ts, deleted in the
 * Nov 10, 2026 migration). Supabase's API mirrors Insforge's closely:
 * auth.signInWithOAuth / signOut, db.from().select/insert/upsert, and
 * storage buckets all work the same way at the call sites.
 *
 * Two differences to know:
 * 1. Supabase's user object carries profile fields in `user_metadata`,
 *    not `user.profile`. The `auth` wrapper below normalizes the shape
 *    so the pages keep reading `user.profile.name` / `avatar_url`.
 * 2. Server-side auth needs cookies. API routes must use
 *    `getServerUser(request)` instead of `auth.getCurrentUser()` —
 *    the browser client stores its session in cookies (via
 *    @supabase/ssr), which the server client then reads.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import type { NextRequest } from 'next/server';

// Supabase backend configuration. No fallback URL: if these are missing
// the app should fail loudly at startup, not silently point at a dead
// backend the way the old Insforge fallback did.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Browser client (cookie-based session, so API routes can read it).
// Safe to construct on the server too; it only touches cookies when
// an auth call actually runs.
export const supabase: SupabaseClient = createBrowserClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
);

// Normalized user shape, matching what the pages already expect.
export interface EcoUser {
  id: string;
  email: string;
  profile: {
    name: string | null;
    avatar_url: string | null;
  };
}

export function normalizeUser(user: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
} | null): EcoUser | null {
  if (!user) return null;
  const meta = user.user_metadata ?? {};
  return {
    id: user.id,
    email: user.email ?? '',
    profile: {
      name: (meta['name'] as string | undefined) ?? null,
      avatar_url: (meta['avatar_url'] as string | undefined) ?? null,
    },
  };
}

// Auth helpers with the same call shapes the app already uses.
export const auth = {
  // Supabase nests redirectTo under `options`; the app passes it
  // top-level (the old Insforge shape), so translate it here.
  signInWithOAuth: (options: {
    provider: 'google';
    redirectTo?: string;
  }) =>
    supabase.auth.signInWithOAuth({
      provider: options.provider,
      options: options.redirectTo
        ? { redirectTo: options.redirectTo }
        : undefined,
    }),

  signOut: () => supabase.auth.signOut(),

  exchangeCodeForSession: (code: string) =>
    supabase.auth.exchangeCodeForSession(code),

  // Current session (reads the cookie/local session, no network
  // when there is none) — the client uses this to get the access
  // token for API calls.
  getSession: () => supabase.auth.getSession(),

  // Refresh the session after a 401; the fresh access token is
  // data.session?.access_token.
  refreshSession: () => supabase.auth.refreshSession(),

  // Validate an access token with the auth server. Used by
  // server-side requireUser() for Google tokens; pass the Bearer
  // token, not the current session.
  getUser: (jwt?: string) => supabase.auth.getUser(jwt),

  // Same { data: { user }, error } shape as the old Insforge call,
  // with the user normalized to EcoUser.
  getCurrentUser: async () => {
    const { data, error } = await supabase.auth.getUser();
    return { data: { user: normalizeUser(data?.user ?? null) }, error };
  },
};

// Database: the Supabase client itself is the query builder
// (db.from('scans').select() ...), same as before.
export const db: SupabaseClient = supabase;
export const storage = supabase.storage;

// Server-side database client with the service-role key (bypasses RLS).
// Only use in API routes, never expose to the client. The key must NOT
// have a NEXT_PUBLIC_ prefix, so it never ships to the browser.
export const serverDb: SupabaseClient = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY,
);

// Server-side storage client (uploads happen from API routes only).
export const serverStorage = serverDb.storage;

// Server-side current user, read from the request's cookies.
// Use this in API routes instead of auth.getCurrentUser().
export async function getServerUser(request: NextRequest) {
  const serverClient = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      // Route handlers cannot set response cookies; the middleware
      // refreshes the session cookie on each request instead.
      setAll: () => {},
    },
  });
  const { data, error } = await serverClient.auth.getUser();
  return { user: normalizeUser(data?.user ?? null), error };
}

// Type definitions for database tables (unchanged from Insforge).
export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  sustainability_score: number;
  created_at: string;
}

export interface Scan {
  id: string;
  user_id: string;
  product_name: string;
  materials: string[];
  carbon_footprint: number | null;
  recyclability_score: number | null;
  image_url: string | null;
  created_at: string;
}

export interface UserAction {
  id: string;
  user_id: string;
  scan_id: string | null;
  action_type: 'scanned' | 'diy_selected' | 'diy_completed' | 'diy_pending' | 'diy_failed';
  impact_score: number;
  image_url: string | null;
  created_at: string;
  // Verification feedback (the AI's reason) and the project title,
  // saved by /api/verify. Null on older rows, which predate the columns.
  feedback?: string | null;
  project_title?: string | null;
  // Verdict numbers, saved best-effort by /api/verify.
  verify_match_confidence?: number | null;
  verify_code_seen?: string | null;
  verify_code_ok?: boolean | null;
}

// DIY Idea type for agent responses
export interface DIYIdea {
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  materials_needed: string[];
  steps: string[];
  estimated_co2_saved_kg: number;
}

// Scan result type
export interface ScanResult {
  product_name: string;
  detected_materials: string[];
  label_text: string;
  packaging_type: string;
  // True when the material was never actually determined and
  // 'mixed plastic' was substituted as the default (or nothing was
  // found at all): the results page says so instead of presenting
  // the fallback as a confident reading. Scan-time only — it is not
  // stored on the scan row.
  material_unknown?: boolean;
  // Null when the research step failed: there is no figure, and the
  // results page says so instead of showing a fabricated 0.
  carbon_footprint_kg: number | null;
  recyclability_score: number | null;
  material_breakdown: { material: string; percentage: number }[];
  diy_ideas: DIYIdea[];
}
