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
 * set here (and change later via /api/profile). A guest account does
 * not live forever: signing out deletes it at once, and guests
 * quiet for 7 days are swept here, when a new guest arrives.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import {
  assertServiceKey,
  createAnonToken,
  normalizeDisplayName,
  guestPoolUsed,
  sweepExpiredGuests,
  sweepOrphanedStorage,
  GUEST_DAILY_POOL,
  GUEST_POOL_MESSAGE,
  handleRouteError,
} from '@/lib/server-auth';

export async function POST(request: NextRequest) {
  try {
    assertServiceKey();
    // Sweep guests dead for 7+ days before anything else: their
    // cap attempts no longer count toward the shared pool, and the
    // board stays clean without a scheduler. Never blocks the new
    // session — a failed sweep just leaves the rows for next time.
    await sweepExpiredGuests();
    // Same run, same terms: files whose owner is gone (a row
    // deleted straight from the dashboard or API, bypassing the
    // account delete) are removed too, so orphans never pile up.
    await sweepOrphanedStorage();
    // No point creating a guest account that cannot scan: when the
    // shared daily pool is already used up, say so now instead of
    // letting the guest in and failing their first scan.
    if ((await guestPoolUsed()) >= GUEST_DAILY_POOL) {
      return NextResponse.json(
        { success: false, error: GUEST_POOL_MESSAGE },
        { status: 429 },
      );
    }
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
