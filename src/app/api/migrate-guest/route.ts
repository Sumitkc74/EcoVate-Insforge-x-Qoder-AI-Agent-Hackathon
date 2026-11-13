/**
 * POST /api/migrate-guest
 *
 * Move a guest account's scans and verifications onto the signed-in
 * Google account — so a guest who signs in with Google keeps their
 * history instead of starting over.
 *
 * Two proofs are required, both from the caller:
 * - the Google session (Bearer token in the header), which becomes
 *   the new owner of the rows;
 * - the guest token (in the body), which proves the caller owns the
 *   guest identity being moved. Without it, anyone could move any
 *   guest's rows by guessing a user id.
 *
 * The guest users row is deleted after its rows move (the name on it
 * was the guest's chosen leaderboard name; the Google account keeps
 * its own name from Google). The caller clears the guest session in
 * localStorage only after this returns success.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import {
  assertServiceKey,
  requireUser,
  validateAnonToken,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

export async function POST(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    if (user.isAnonymous) {
      return NextResponse.json(
        { error: 'Sign in with Google first, then move your guest history.' },
        { status: 403 },
      );
    }
    const googleId = user.id;

    const body = await request.json().catch(() => ({}));
    const guestToken = typeof body?.guestToken === 'string' ? body.guestToken : '';
    const guest = guestToken ? await validateAnonToken(guestToken) : null;
    if (!guest) {
      return NextResponse.json(
        { error: 'Guest session not found. Your guest history stays on the guest account.' },
        { status: 400 },
      );
    }
    const guestId = guest.id;
    if (guestId === googleId) {
      return NextResponse.json({ success: true, movedScans: 0, movedActions: 0 });
    }

    // Count first, then move the rows, then delete the guest account
    // — the scans/actions reference users.id, so the delete must come
    // last. Each step checks its error, so a partial move is reported
    // instead of silently claimed.
    const { data: scans } = await serverDb
      .from('scans')
      .select('id')
      .eq('user_id', guestId);
    const { data: actions } = await serverDb
      .from('user_actions')
      .select('id')
      .eq('user_id', guestId);
    const { error: scansError } = await serverDb
      .from('scans')
      .update({ user_id: googleId })
      .eq('user_id', guestId);
    if (scansError) throw scansError;
    const { error: actionsError } = await serverDb
      .from('user_actions')
      .update({ user_id: googleId })
      .eq('user_id', guestId);
    if (actionsError) throw actionsError;
    const { error: deleteError } = await serverDb
      .from('users')
      .delete()
      .eq('id', guestId);
    if (deleteError) throw deleteError;

    return NextResponse.json({
      success: true,
      movedScans: (scans || []).length,
      movedActions: (actions || []).length,
    });
  } catch (error) {
    return handleRouteError(error, 'Migrate guest API error:');
  }
}

export const runtime = 'edge';
