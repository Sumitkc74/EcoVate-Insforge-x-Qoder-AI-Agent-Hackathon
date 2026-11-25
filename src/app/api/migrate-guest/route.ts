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
 * The guest users row is deleted after its rows move. If the guest
 * had picked a custom leaderboard name and the Google account never
 * picked one of its own (its users-row name still matches its Google
 * profile name), the guest's name carries over — otherwise the
 * guest's chosen name would silently vanish on sign-in. The caller
 * clears the guest session in localStorage only after this returns
 * success.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb, serverStorage } from '@/lib/supabase';
import { storageKeyFromUrl } from '@/lib/storage';
import {
  assertServiceKey,
  requireUser,
  validateAnonToken,
  isMissingTableError,
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
    // Cap history moves too, so migration does not reset the guest's
    // daily caps on the Google account. Best effort: the one-time
    // usage_attempts table may not exist yet, and a failure here
    // must not fail the move.
    const { error: attemptsError } = await serverDb
      .from('usage_attempts')
      .update({ user_id: googleId })
      .eq('user_id', guestId);
    if (attemptsError && !isMissingTableError(attemptsError)) {
      console.error('Migrate usage_attempts error:', attemptsError);
    }
    // A custom guest name carries over when the Google account never
    // picked one of its own (its row still matches its Google profile
    // name). A name the Google user picked themselves is never
    // overwritten. Best effort: a failure here must not fail the move.
    if (guest.name && guest.name !== 'Guest') {
      try {
        const { data: googleRow } = await serverDb
          .from('users')
          .select('name')
          .eq('id', googleId)
          .single();
        const googleRowName = (googleRow as { name?: string | null } | null)?.name ?? null;
        if (!googleRowName || googleRowName === user.name) {
          await serverDb.from('users').update({ name: guest.name }).eq('id', googleId);
        }
      } catch {
        // Keep the move; the Google account keeps its current name.
      }
    }
    // The guest's avatar does not carry over (only the name does),
    // so delete its file best-effort before the row goes — otherwise
    // it stays orphaned in storage after every migration.
    try {
      const { data: guestRow } = await serverDb
        .from('users')
        .select('avatar')
        .eq('id', guestId)
        .single();
      const avatarUrl = (guestRow as { avatar?: string | null } | null)?.avatar || null;
      const avatarKey = avatarUrl ? storageKeyFromUrl(avatarUrl) : null;
      if (avatarKey && avatarKey.startsWith(`avatars/${guestId}/`)) {
        await serverStorage.from('user-uploads').remove([avatarKey]);
      }
    } catch {
      // Best effort: the orphaned file is unreferenced either way.
    }
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
