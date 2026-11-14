/**
 * Server-side auth for API routes.
 *
 * The Insforge session lives client-side (in-memory token + httpOnly
 * refresh cookie), so the SDK's server-side getCurrentUser() has
 * nothing to read in an edge route and always fails — which is why
 * the routes used to trust a userId sent in the body. That meant
 * anyone could pass any user id (they are public via the leaderboard)
 * and read, write or delete another user's data.
 *
 * Now every user-scoped route validates the session instead: the
 * client sends its access token in the Authorization header (see
 * lib/client-auth.ts), and requireUser() checks it against the
 * Insforge backend — the same endpoint the SDK calls in server mode
 * (GET /api/auth/sessions/current). The user id used after that comes
 * from the validated token, never from the request body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from './insforge';

const INSFORGE_URL =
  process.env.NEXT_PUBLIC_INSFORGE_URL || 'https://8t37jscx.us-west.insforge.app';

// Thrown when the server itself is misconfigured (the service key is
// missing). Distinct from an auth failure so routes can answer 503.
export class ServiceConfigError extends Error {}

export function assertServiceKey(): void {
  if (!process.env.INSFORGE_SERVICE_KEY) {
    throw new ServiceConfigError('INSFORGE_SERVICE_KEY is not set');
  }
}

export interface AuthedUser {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  // Anonymous accounts (see below) get the tight caps instead of the
  // signed-in ones.
  isAnonymous: boolean;
}

// Display names for the leaderboard: trimmed, at most 40 chars,
// control characters stripped. Empty input becomes 'Guest'.
export function normalizeDisplayName(input: unknown): string {
  const raw = typeof input === 'string' ? input : '';
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
  return cleaned || 'Guest';
}

// Anonymous sessions: the Insforge SDK has no anonymous sign-in, so
// the server issues anonymous identities itself. The token is
// `anon_<userId>_<hex signature>` where the signature is
// HMAC-SHA256(service key, `anon:<userId>`). Only the server knows
// the key, so the token cannot be forged; the user id in it is the
// anonymous account's id in public.users. The token lives in the
// browser's localStorage, so clearing site data loses the identity —
// and with it the anonymous history. (A fresh identity also resets
// the daily cap; that is the honest limit of anonymous access without
// a per-IP store.)
const ANON_TOKEN_PREFIX = 'anon_';

async function getAnonKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(process.env.INSFORGE_SERVICE_KEY || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createAnonToken(userId: string): Promise<string> {
  const key = await getAnonKey();
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`anon:${userId}`),
  );
  const sigHex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${ANON_TOKEN_PREFIX}${userId}_${sigHex}`;
}

export async function validateAnonToken(token: string): Promise<AuthedUser | null> {
  assertServiceKey();
  const rest = token.slice(ANON_TOKEN_PREFIX.length);
  const sep = rest.lastIndexOf('_');
  if (sep <= 0) return null;
  const userId = rest.slice(0, sep);
  const sigHex = rest.slice(sep + 1);
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return null;
  try {
    const sigBytes = new Uint8Array(
      sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    const key = await getAnonKey();
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(`anon:${userId}`),
    );
    if (!valid) return null;
  } catch {
    return null;
  }
  // The display name comes from the users row (set at creation,
  // changeable later via /api/anon-name).
  const { data: profile } = await serverDb
    .from('users')
    .select('name')
    .eq('id', userId)
    .single();
  const name = (profile as { name?: string | null } | null)?.name ?? 'Guest';
  return { id: userId, email: null, name, avatar: null, isAnonymous: true };
}

// Validate the Bearer token from the request and return the user it
// belongs to, or null when the token is missing, invalid or expired.
// Two token kinds: Insforge access tokens (checked against the
// backend, as before) and anonymous tokens (checked locally above).
// (The service-key check is separate — routes that use the service
// client call assertServiceKey() first; routes that only validate a
// token, like /api/material-guess, do not need the service key.)
export async function requireUser(request: NextRequest): Promise<AuthedUser | null> {
  const header = request.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return null;
  if (token.startsWith(ANON_TOKEN_PREFIX)) return validateAnonToken(token);
  try {
    const res = await fetch(`${INSFORGE_URL}/api/auth/sessions/current`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const user = json?.user;
    if (!user?.id) return null;
    return {
      id: user.id,
      email: typeof user.email === 'string' ? user.email : null,
      name: user.profile?.name ?? null,
      avatar: user.profile?.avatar_url ?? null,
      isAnonymous: false,
    };
  } catch {
    return null;
  }
}

// Shared daily pool for ALL guest accounts: 40 guest scans +
// verifications combined per day (about 20 guests at 2 each). Counted
// from the tables that already exist — guest accounts are the users
// rows whose email ends in @anon.ecovate.local. When the pool is
// used up, guest scans and verifications stop for the day; signed-in
// users are unaffected.
export const GUEST_DAILY_POOL = 40;
export const GUEST_POOL_MESSAGE =
  'Guest logins are exhausted for the day. Sign in with Google to continue.';

export async function guestPoolUsed(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data: users } = await serverDb.from('users').select('id, email');
    const guestIds = ((users || []) as { id: string; email: string | null }[])
      .filter((u) => typeof u.email === 'string' && u.email.endsWith('@anon.ecovate.local'))
      .map((u) => u.id);
    if (guestIds.length === 0) return 0;
    // Attempts first: a scan or verification counts against the pool
    // even after its rows are deleted (see countAttempts).
    const { data: attempts, error: attemptsError } = await serverDb
      .from('usage_attempts')
      .select('id, created_at')
      .in('user_id', guestIds)
      .in('kind', ['scan', 'verify'])
      .order('created_at', { ascending: false })
      .limit(GUEST_DAILY_POOL + 1);
    if (!attemptsError) {
      return ((attempts || []) as { created_at: string }[]).filter(
        (r) => r.created_at >= since,
      ).length;
    }
    // Table missing (one-time SQL not run yet): fall back to
    // counting surviving rows, the old behavior.
    const [scansRes, actionsRes] = await Promise.all([
      serverDb
        .from('scans')
        .select('id, created_at')
        .in('user_id', guestIds)
        .order('created_at', { ascending: false })
        .limit(200),
      serverDb
        .from('user_actions')
        .select('id, created_at')
        .in('user_id', guestIds)
        .in('action_type', ['diy_completed', 'diy_pending', 'diy_failed'])
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    const scans = ((scansRes.data || []) as { created_at: string }[]).filter(
      (r) => r.created_at >= since,
    ).length;
    const actions = ((actionsRes.data || []) as { created_at: string }[]).filter(
      (r) => r.created_at >= since,
    ).length;
    return scans + actions;
  } catch {
    // A counting failure must not block a legitimate request.
    return 0;
  }
}

// How much of a guest's own daily allowance they have used —
// scans and verifications are separate caps (2 each), so both are
// counted. The shared pool count is deliberately NOT returned: the
// dashboard shows only these personal numbers, and says the guest
// logins are exhausted when the pool is done.
export async function guestPersonalUsage(
  userId: string,
): Promise<{ scans: number; verifications: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    // Attempts first: deleting a scan no longer resets the "Used
    // today" display (see countAttempts).
    const [scanAttempts, verifyAttempts] = await Promise.all([
      countAttempts(userId, 'scan', 2),
      countAttempts(userId, 'verify', 2),
    ]);
    if (scanAttempts !== null && verifyAttempts !== null) {
      return {
        scans: Math.min(scanAttempts, 2),
        verifications: Math.min(verifyAttempts, 2),
      };
    }
    // Table missing: fall back to surviving rows, the old behavior.
    const [scansRes, actionsRes] = await Promise.all([
      serverDb
        .from('scans')
        .select('id, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(3),
      serverDb
        .from('user_actions')
        .select('id, created_at')
        .eq('user_id', userId)
        .in('action_type', ['diy_completed', 'diy_pending', 'diy_failed'])
        .order('created_at', { ascending: false })
        .limit(3),
    ]);
    const count = (rows: { created_at: string }[] | null) =>
      Math.min((rows || []).filter((r) => r.created_at >= since).length, 2);
    return {
      scans: count(scansRes.data as { created_at: string }[] | null),
      verifications: count(actionsRes.data as { created_at: string }[] | null),
    };
  } catch {
    return { scans: 0, verifications: 0 };
  }
}

// Daily cap on AI-costly endpoints, counted from tables that already
// exist — no new infrastructure. Returns true when this user already
// has `cap` rows in the last 24 hours, i.e. the next one would be
// number cap+1. (It used to be `> cap`, which allowed one extra
// attempt — a guest at 2/2 could still scan a third time. The live
// deletion test caught it: the third scan went through.)
export async function overDailyCap(
  userId: string,
  table: 'scans' | 'user_actions',
  actionTypes: string[] | null,
  cap: number,
): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const query = serverDb
      .from(table)
      .select('id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(cap + 1);
    const { data } = actionTypes
      ? await query.in('action_type', actionTypes)
      : await query;
    const rows = (data || []) as { created_at: string }[];
    return rows.filter((r) => r.created_at >= since).length >= cap;
  } catch {
    // A counting failure must not block a legitimate request — the
    // auth gate above already stops anonymous abuse.
    return false;
  }
}

// Attempt log: one row per AI-costly attempt, in a table user-facing
// delete never touches. The daily caps used to count surviving rows
// (scans rows, verification result rows), so deleting a scan or a
// project refunded the quota — scan, delete, scan again, unlimited.
// The caps now count attempts instead; the old tables are only the
// fallback until the one-time SQL creates usage_attempts.
//
// One-time SQL (Insforge SQL Editor):
//   CREATE TABLE IF NOT EXISTS public.usage_attempts (
//     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     user_id UUID NOT NULL,
//     kind TEXT NOT NULL CHECK (kind IN ('scan', 'verify', 'material_guess')),
//     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS usage_attempts_user_kind_created_idx
//     ON public.usage_attempts (user_id, kind, created_at DESC);
export type AttemptKind = 'scan' | 'verify' | 'material_guess';

// Attempts in the last 24h, or null when the table does not exist
// yet. Null means "unknown", not zero — callers fall back to the
// legacy surviving-rows count instead of treating it as no usage.
async function countAttempts(
  userId: string,
  kind: AttemptKind,
  cap: number,
): Promise<number | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await serverDb
      .from('usage_attempts')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('kind', kind)
      .order('created_at', { ascending: false })
      .limit(cap + 1);
    if (error) return null;
    return ((data || []) as { created_at: string }[]).filter(
      (r) => r.created_at >= since,
    ).length;
  } catch {
    return null;
  }
}

// Like overDailyCap, but counts attempts from usage_attempts when
// the table exists, and falls back to counting surviving rows (the
// old behavior, hole included) when it does not.
export async function overAttemptCap(
  userId: string,
  kind: AttemptKind,
  legacyTable: 'scans' | 'user_actions',
  legacyTypes: string[] | null,
  cap: number,
): Promise<boolean> {
  const attempts = await countAttempts(userId, kind, cap);
  if (attempts !== null) return attempts >= cap;
  return overDailyCap(userId, legacyTable, legacyTypes, cap);
}

// Record an attempt AFTER the cap checks pass and BEFORE the AI work
// runs: the attempt burned quota whether or not the scan or
// verification later succeeds or its rows are deleted. A failure to
// log is swallowed (and logged server-side) — the request still
// proceeds, and its cap falls back to surviving rows until the
// one-time SQL creates the table.
export async function logAttempt(userId: string, kind: AttemptKind): Promise<void> {
  try {
    const { error } = await serverDb
      .from('usage_attempts')
      .insert([{ user_id: userId, kind }]);
    if (error) {
      console.error(
        'Attempt log error (caps fall back to surviving rows until usage_attempts exists):',
        error,
      );
    }
  } catch (err) {
    console.error(
      'Attempt log error (caps fall back to surviving rows until usage_attempts exists):',
      err,
    );
  }
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Generic 500 body: never send raw database/SDK error text to the
// client — it leaks table, column and constraint names. The real
// error stays in the server log via console.error in handleRouteError.
export function serverErrorResponse(): NextResponse {
  return NextResponse.json(
    { success: false, error: 'Something went wrong. Please try again.' },
    { status: 500 },
  );
}

// Shared catch handler for API routes: logs the real error
// server-side, answers 503 for a misconfigured server, and a generic
// 500 for everything else.
export function handleRouteError(error: unknown, label: string): NextResponse {
  console.error(label, error);
  if (error instanceof ServiceConfigError) {
    return NextResponse.json(
      { success: false, error: 'Server is not configured correctly.' },
      { status: 503 },
    );
  }
  return serverErrorResponse();
}
