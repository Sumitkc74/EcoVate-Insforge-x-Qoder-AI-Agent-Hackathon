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
import { serverDb, serverStorage } from './insforge';
import { storageKeyFromUrl } from './storage';

// No fallback URL here: the old hard-coded fallback pointed at a
// dead backend, so a deploy without the env var silently broke
// session validation for every Google user. Fail loudly instead.
const INSFORGE_URL = (() => {
  const url = process.env.NEXT_PUBLIC_INSFORGE_URL;
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_INSFORGE_URL is not set — set it in Vercel (Production) to the Insforge backend URL.',
    );
  }
  return url;
})();

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
  // changeable later via /api/profile). The row must exist: a token
  // whose account was deleted (sign-out, migration, expiry sweep)
  // is dead — without this check the HMAC would still verify and
  // the next scan would silently resurrect the account.
  const { data: profile } = await serverDb
    .from('users')
    .select('name')
    .eq('id', userId)
    .single();
  if (!profile) return null;
  const name = (profile as { name?: string | null }).name ?? 'Guest';
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
    // even after its rows are deleted (see countAttempts). Guesses
    // and DIY refreshes count too — they used to be outside the
    // pool, so minting a fresh guest bought 10 more of each with no
    // aggregate limit, and each one burns AI quota.
    const { data: attempts, error: attemptsError } = await serverDb
      .from('usage_attempts')
      .select('id, created_at')
      .in('user_id', guestIds)
      .in('kind', ['scan', 'verify', 'material_guess', 'diy_refresh'])
      .order('created_at', { ascending: false })
      .limit(GUEST_DAILY_POOL + 1);
    if (!attemptsError) {
      return ((attempts || []) as { created_at: string }[]).filter(
        (r) => r.created_at >= since,
      ).length;
    }
    // A missing table (one-time SQL not run yet) falls back to
    // counting surviving rows, the old behavior. Any other counting
    // failure fails CLOSED: returning 0 would silently disable the
    // shared pool and let guests burn unlimited AI quota.
    if (!isMissingTableError(attemptsError)) {
      console.error('Guest pool count failed (fail-closed):', attemptsError);
      return GUEST_DAILY_POOL;
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
        .in('action_type', ['diy_completed', 'diy_pending', 'diy_failed', 'material_guess'])
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
  } catch (err) {
    // A counting failure must not silently disable the pool.
    console.error('Guest pool count failed (fail-closed):', err);
    return GUEST_DAILY_POOL;
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
    if (typeof scanAttempts === 'number' && typeof verifyAttempts === 'number') {
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
  } catch (err) {
    // Fail CLOSED: a counting failure used to return "not over the
    // cap", silently disabling every daily cap until someone
    // noticed. A transient DB error now blocks one AI-costly
    // attempt instead of opening unlimited ones.
    console.error('Daily cap count failed (fail-closed):', err);
    return true;
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
//     kind TEXT NOT NULL CHECK (kind IN ('scan', 'verify', 'material_guess', 'diy_refresh')),
//     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS usage_attempts_user_kind_created_idx
//     ON public.usage_attempts (user_id, kind, created_at DESC);
export type AttemptKind = 'scan' | 'verify' | 'material_guess' | 'diy_refresh';

// Whether an SDK/DB error means "the usage_attempts table does not
// exist yet" (the one-time SQL was never run) as opposed to a real
// failure. Only the missing-table case may fall back to counting
// surviving rows; every other counting failure fails closed, so a
// DB hiccup never silently disables the caps.
export function isMissingTableError(err: unknown): boolean {
  const text = `${(err as { code?: unknown })?.code || ''} ${(err as { message?: unknown })?.message || ''} ${String(err)}`;
  return /42P01|PGRST205|does not exist|relation .* not.*exist|Could not find the table/i.test(text);
}

// Attempts in the last 24h; 'missing' when the table does not exist
// yet, 'error' on any other counting failure. 'missing' means
// "unknown, fall back to the legacy surviving-rows count"; 'error'
// means "fail closed" — callers must not treat it as no usage.
async function countAttempts(
  userId: string,
  kind: AttemptKind,
  cap: number,
): Promise<number | 'missing' | 'error'> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await serverDb
      .from('usage_attempts')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('kind', kind)
      .order('created_at', { ascending: false })
      .limit(cap + 1);
    if (error) return isMissingTableError(error) ? 'missing' : 'error';
    return ((data || []) as { created_at: string }[]).filter(
      (r) => r.created_at >= since,
    ).length;
  } catch (err) {
    return isMissingTableError(err) ? 'missing' : 'error';
  }
}

// Like overDailyCap, but counts attempts from usage_attempts when
// the table exists, and falls back to counting surviving rows (the
// old behavior, hole included) only when the table does not exist
// yet. A counting failure fails CLOSED (over the cap): the old code
// returned "not over the cap" on any error, so one DB hiccup
// silently disabled every cap. Some kinds have no legacy rows to
// count (diy_refresh never wrote one) — pass null for those, and a
// missing table simply means "not over the cap" until the one-time
// SQL creates it.
export async function overAttemptCap(
  userId: string,
  kind: AttemptKind,
  legacyTable: 'scans' | 'user_actions' | null,
  legacyTypes: string[] | null,
  cap: number,
): Promise<boolean> {
  const attempts = await countAttempts(userId, kind, cap);
  if (typeof attempts === 'number') return attempts >= cap;
  if (attempts === 'error') {
    console.error('Attempt cap count failed (fail-closed):', kind, userId);
    return true;
  }
  if (legacyTable === null) return false;
  return overDailyCap(userId, legacyTable, legacyTypes, cap);
}

// Claim one attempt: insert the attempt row FIRST, then count.
// The old pattern was check-then-log, so two requests racing the
// cap check could both pass and both burn AI quota before either
// logged. Now the second one sees the first one's row and is turned
// away. Returns true when the caller should answer 429. The early
// overAttemptCap check stays in the routes as a cheap fast path;
// this is the enforcement. A rejected claim still leaves its row
// logged — the attempt was made. When the usage_attempts table does
// not exist yet, falls back to the legacy check (and nothing is
// logged, as before).
export async function claimAttempt(
  userId: string,
  kind: AttemptKind,
  legacyTable: 'scans' | 'user_actions' | null,
  legacyTypes: string[] | null,
  cap: number,
): Promise<boolean> {
  try {
    const { error } = await serverDb
      .from('usage_attempts')
      .insert([{ user_id: userId, kind }]);
    if (error) {
      if (isMissingTableError(error)) {
        if (legacyTable === null) return false;
        return overDailyCap(userId, legacyTable, legacyTypes, cap);
      }
      console.error('Attempt claim failed (fail-closed):', error);
      return true;
    }
  } catch (err) {
    console.error('Attempt claim failed (fail-closed):', err);
    return true;
  }
  const attempts = await countAttempts(userId, kind, cap);
  if (typeof attempts === 'number') return attempts > cap;
  // A count failure after a successful insert fails closed.
  console.error('Attempt claim count failed (fail-closed):', kind, userId);
  return true;
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Guest expiry. A guest account is gone the moment its owner logs
// out: the token lives only in that browser's localStorage, so a
// logged-out guest can never come back — the next visit makes a new
// guest. Guests who never log out but go quiet are swept after
// GUEST_EXPIRY_DAYS without activity (no scan, action or cap
// attempt). Google accounts never expire.
export const GUEST_EXPIRY_DAYS = 7;

const STORAGE_BUCKET = 'user-uploads';

// Delete one guest account and everything it owns. Only call with
// ids already proven to be guests (an anon token, or the sweep's
// @anon.ecovate.local filter) — this never checks the email itself.
export async function deleteGuestAccount(userId: string): Promise<void> {
  // Photos first, best effort: a missing file or a storage error
  // must not block the row deletes. The avatar lives in the users
  // row itself (not in scans/actions), so it is fetched here too —
  // without this the avatar file survived every account deletion.
  try {
    const [{ data: scans }, { data: actions }, { data: userRow }] = await Promise.all([
      serverDb.from('scans').select('image_url').eq('user_id', userId),
      serverDb.from('user_actions').select('image_url').eq('user_id', userId),
      serverDb.from('users').select('avatar').eq('id', userId).single(),
    ]);
    const urls = [
      ...((scans || []) as { image_url?: string | null }[]),
      ...((actions || []) as { image_url?: string | null }[]),
    ]
      .map((r) => r.image_url)
      .filter((u): u is string => typeof u === 'string' && !!u);
    const avatarUrl = (userRow as { avatar?: string | null } | null)?.avatar;
    if (typeof avatarUrl === 'string' && avatarUrl) urls.push(avatarUrl);
    for (const url of urls) {
      const key = storageKeyFromUrl(url);
      if (
        key &&
        (key.startsWith(`scans/${userId}/`) ||
          key.startsWith(`verifications/${userId}/`) ||
          key.startsWith(`avatars/${userId}/`))
      ) {
        try {
          await serverStorage.from(STORAGE_BUCKET).remove(key);
        } catch {
          // Best effort: the orphaned file is unreferenced either way.
        }
      }
    }
  } catch {
    // Photos are best effort; the rows still go.
  }
  // Rows: scans and actions reference users.id, so the users row
  // goes last. A missing usage_attempts table just returns an
  // error object, not a throw.
  await serverDb.from('usage_attempts').delete().eq('user_id', userId);
  await serverDb.from('user_actions').delete().eq('user_id', userId);
  await serverDb.from('scans').delete().eq('user_id', userId);
  await serverDb.from('users').delete().eq('id', userId);
}

// Sweep guests inactive for GUEST_EXPIRY_DAYS or more. Last
// activity is the newest of the account's creation, scans, actions
// and cap attempts. Runs on guest creation (see /api/anon-session),
// so no scheduler, cron secret or dashboard step is needed: a new
// guest arriving is what keeps the board clean. Never throws and
// never blocks the caller — a failed sweep just leaves the rows for
// the next one. Returns how many accounts were deleted.
export async function sweepExpiredGuests(): Promise<number> {
  const cutoffMs = Date.now() - GUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  try {
    const { data: users, error } = await serverDb
      .from('users')
      .select('id, email, created_at');
    if (error || !users) return 0;
    // Only accounts created before the cutoff can be expired; a
    // newer account is alive by definition, however quiet.
    const candidates = (
      users as { id: string; email: string | null; created_at: string }[]
    ).filter(
      (u) =>
        typeof u.email === 'string' &&
        u.email.endsWith('@anon.ecovate.local') &&
        new Date(u.created_at).getTime() < cutoffMs,
    );
    if (candidates.length === 0) return 0;
    const ids = candidates.map((u) => u.id);
    // Any scan, action or attempt at/after the cutoff keeps the
    // account. The SDK has no .gte, so read the newest rows and
    // filter in JS — newest first, so the cutoff check is exact.
    const [scansRes, actionsRes, attemptsRes] = await Promise.all([
      serverDb
        .from('scans')
        .select('user_id, created_at')
        .in('user_id', ids)
        .order('created_at', { ascending: false })
        .limit(500),
      serverDb
        .from('user_actions')
        .select('user_id, created_at')
        .in('user_id', ids)
        .order('created_at', { ascending: false })
        .limit(500),
      serverDb
        .from('usage_attempts')
        .select('user_id, created_at')
        .in('user_id', ids)
        .order('created_at', { ascending: false })
        .limit(500),
    ]);
    const active = new Set<string>();
    for (const rows of [scansRes.data, actionsRes.data, attemptsRes.data]) {
      for (const r of (rows || []) as { user_id: string; created_at: string }[]) {
        if (new Date(r.created_at).getTime() >= cutoffMs) active.add(r.user_id);
      }
    }
    let deleted = 0;
    for (const c of candidates) {
      if (active.has(c.id)) continue;
      try {
        await deleteGuestAccount(c.id);
        deleted++;
      } catch (err) {
        console.error('Guest expiry delete failed:', c.id, err);
      }
    }
    return deleted;
  } catch (err) {
    console.error('Guest expiry sweep failed:', err);
    return 0;
  }
}

// Delete storage files whose owner no longer has a users row.
// Direct row deletes (dashboard, API) bypass deleteGuestAccount,
// so their files would otherwise sit orphaned forever. Runs on
// guest creation next to sweepExpiredGuests — no scheduler, no
// secret. Fail-closed: if the users list cannot be read, nothing
// is deleted. Bounded (100 files per run) so guest creation stays
// fast. Never throws, never blocks the new session.
export async function sweepOrphanedStorage(): Promise<number> {
  try {
    const { data: users, error: usersError } = await serverDb.from('users').select('id');
    if (usersError || !users) return 0;
    const liveIds = new Set((users as { id: string }[]).map((u) => u.id));
    // A file is only orphaned when nothing references it.
    // Migration moves a guest's rows to the Google account but
    // leaves the photos under the guest's folder, so a users-row
    // check alone would delete a live Google user's photos. Collect
    // every stored URL the rows still point at first; if any of
    // these reads fails, delete nothing.
    const [scansRes, actionsRes, avatarsRes] = await Promise.all([
      serverDb.from('scans').select('image_url'),
      serverDb.from('user_actions').select('image_url'),
      serverDb.from('users').select('avatar'),
    ]);
    if (scansRes.error || actionsRes.error || avatarsRes.error) return 0;
    const referenced = new Set<string>();
    for (const row of [...(scansRes.data || []), ...(actionsRes.data || [])] as {
      image_url?: string | null;
    }[]) {
      const key = storageKeyFromUrl(row.image_url ?? null);
      if (key) referenced.add(key);
    }
    for (const row of (avatarsRes.data || []) as { avatar?: string | null }[]) {
      const key = storageKeyFromUrl(row.avatar ?? null);
      if (key) referenced.add(key);
    }
    // Every file the app writes lives under one of these prefixes,
    // in a folder named after its owner's user id.
    const orphanKeyPattern = /^(scans|verifications|avatars)\/([^/]+)\//;
    let deleted = 0;
    for (const prefix of ['scans/', 'verifications/', 'avatars/']) {
      const { data, error } = await serverStorage.from(STORAGE_BUCKET).list({ prefix, limit: 100 });
      if (error || !data) continue;
      const objects = ((data as { objects?: { key: string }[] }).objects ||
        (Array.isArray(data) ? (data as { key: string }[]) : [])) as { key: string }[];
      for (const obj of objects) {
        if (deleted >= 100) return deleted;
        const match = orphanKeyPattern.exec(obj.key);
        if (!match) continue;
        if (referenced.has(obj.key)) continue;
        if (liveIds.has(match[2])) continue;
        try {
          await serverStorage.from(STORAGE_BUCKET).remove(obj.key);
          deleted++;
        } catch {
          // Best effort: a leftover file is unreferenced either way.
        }
      }
    }
    return deleted;
  } catch (err) {
    console.error('Orphan storage sweep failed:', err);
    return 0;
  }
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
