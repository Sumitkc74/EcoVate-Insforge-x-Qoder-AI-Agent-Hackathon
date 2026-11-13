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
}

// Validate the Bearer token from the request and return the user it
// belongs to, or null when the token is missing, invalid or expired.
// (The service-key check is separate — routes that use the service
// client call assertServiceKey() first; routes that only validate a
// token, like /api/material-guess, do not need the service key.)
export async function requireUser(request: NextRequest): Promise<AuthedUser | null> {
  const header = request.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return null;
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
    };
  } catch {
    return null;
  }
}

// Daily cap on AI-costly endpoints, counted from tables that already
// exist — no new infrastructure. Returns true when this user already
// has more than `cap` rows in the last 24 hours.
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
    return rows.filter((r) => r.created_at >= since).length > cap;
  } catch {
    // A counting failure must not block a legitimate request — the
    // auth gate above already stops anonymous abuse.
    return false;
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
