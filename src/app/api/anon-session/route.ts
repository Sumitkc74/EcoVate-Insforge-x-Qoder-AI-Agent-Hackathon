/**
 * POST /api/anon-session
 *
 * Create an anonymous identity for someone who does not want to sign
 * in with Google. Returns a server-signed token (see
 * lib/server-auth.ts) that the client stores in localStorage and
 * sends as its Bearer token. Anonymous accounts get 2 scans and 2
 * verifications a day; their history lives in this browser only.
 *
 * The identity is a real row in public.users, so scans, actions and
 * the leaderboard all work exactly as for signed-in users — the only
 * difference is the cap and the display name, which the caller may
 * set here (and change later via /api/anon-name).
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import {
  assertServiceKey,
  createAnonToken,
  normalizeDisplayName,
  handleRouteError,
} from '@/lib/server-auth';

export async function POST(request: NextRequest) {
  try {
    assertServiceKey();
    const body = await request.json().catch(() => ({}));
    const name = normalizeDisplayName(body?.name);

    const userId = crypto.randomUUID();
    const { error } = await serverDb.from('users').insert([
      {
        id: userId,
        // Anonymous accounts have no email. The placeholder can never
        // collide with a real address and is unique per identity.
        email: `${userId}@anon.ecovate.local`,
        name,
        avatar: null,
        sustainability_score: 0,
      },
    ]);
    if (error) throw error;

    const token = await createAnonToken(userId);
    return NextResponse.json({ success: true, userId, token, name });
  } catch (error) {
    return handleRouteError(error, 'Anonymous session API error:');
  }
}

export const runtime = 'edge';
