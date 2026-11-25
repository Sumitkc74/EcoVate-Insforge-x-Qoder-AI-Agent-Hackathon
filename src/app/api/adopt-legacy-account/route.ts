/**
 * POST /api/adopt-legacy-account
 *
 * One-time adoption for Google accounts imported from Insforge.
 * A Google user signing in through Supabase gets a NEW auth id, so
 * the callback's ensureUserProfile would otherwise create a fresh
 * empty row and strand the imported history (scans, projects, points)
 * on the old Insforge id. This route fixes that at first sign-in:
 * it finds the imported users row with the same verified email but a
 * different id, moves its rows onto the new id, and deletes the old
 * row — the same move the guest migration already does.
 *
 * Safety: the email comes from the verified Supabase Auth session
 * (requireUser), never from the request body, so a caller can only
 * adopt their own account. Adoption runs only when exactly one
 * legacy row matches; zero matches is a no-op, more than one is a
 * 409 and adopts nothing. Idempotent: a second call finds no legacy
 * row and reports adopted: false. The old row is deleted last —
 * scans/actions reference users.id, so deleting first would cascade
 * away the very rows being moved.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb, serverStorage } from '@/lib/supabase';
import { storageKeyFromUrl } from '@/lib/storage';
import {
  assertServiceKey,
  requireUser,
  isMissingTableError,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

export async function POST(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    if (user.isAnonymous || !user.email) {
      return NextResponse.json(
        { error: 'Sign in with Google first. Guest accounts have no verified email to match.' },
        { status: 403 },
      );
    }
    const googleId = user.id;

    // The new row must exist (the callback creates it first via
    // ensureUserProfile) — moving rows onto a missing id would
    // violate the users FK. A retry on the next sign-in covers it.
    const { data: newRow } = await serverDb
      .from('users')
      .select('id')
      .eq('id', googleId)
      .single();
    if (!newRow) {
      return NextResponse.json(
        { error: 'Profile not ready yet. Please sign in again.' },
        { status: 409 },
      );
    }

    const { data: legacyRows } = await serverDb
      .from('users')
      .select('id, name, avatar')
      .eq('email', user.email)
      .neq('id', googleId);
    const legacy = (legacyRows || []) as { id: string; name?: string | null; avatar?: string | null }[];
    if (legacy.length === 0) {
      return NextResponse.json({ success: true, adopted: false });
    }
    if (legacy.length > 1) {
      return NextResponse.json(
        { error: 'More than one previous account matches this email. Nothing was moved.' },
        { status: 409 },
      );
    }
    const legacyId = legacy[0].id;

    // Count first, then move the rows, then delete the old row.
    // Each step checks its error, so a partial move is reported
    // instead of silently claimed.
    const { data: scans } = await serverDb
      .from('scans')
      .select('id')
      .eq('user_id', legacyId);
    const { data: actions } = await serverDb
      .from('user_actions')
      .select('id')
      .eq('user_id', legacyId);
    const { error: scansError } = await serverDb
      .from('scans')
      .update({ user_id: googleId })
      .eq('user_id', legacyId);
    if (scansError) throw scansError;
    const { error: actionsError } = await serverDb
      .from('user_actions')
      .update({ user_id: googleId })
      .eq('user_id', legacyId);
    if (actionsError) throw actionsError;
    // Cap history moves too, so adoption does not reset the daily
    // caps on the new account. Best effort: the table may not exist
    // yet, and a failure here must not fail the move.
    const { error: attemptsError } = await serverDb
      .from('usage_attempts')
      .update({ user_id: googleId })
      .eq('user_id', legacyId);
    if (attemptsError && !isMissingTableError(attemptsError)) {
      console.error('Adopt usage_attempts error:', attemptsError);
    }
    // A custom leaderboard name carries over when it differs from
    // the Google profile name — that means the user picked it
    // themselves on the old account. A name matching the Google
    // profile needs no carry-over.
    if (legacy[0].name && legacy[0].name !== user.name) {
      try {
        await serverDb.from('users').update({ name: legacy[0].name }).eq('id', googleId);
      } catch {
        // Keep the move; the new account keeps its current name.
      }
    }
    // A stored avatar file on the old row is orphaned once the row
    // goes (the new row already has the fresh Google avatar), so
    // delete it best-effort. Google-hosted avatar URLs are untouched.
    try {
      const avatarKey = legacy[0].avatar ? storageKeyFromUrl(legacy[0].avatar) : null;
      if (avatarKey && avatarKey.startsWith(`avatars/${legacyId}/`)) {
        await serverStorage.from('user-uploads').remove([avatarKey]);
      }
    } catch {
      // Best effort: the orphaned file is unreferenced either way.
    }
    const { error: deleteError } = await serverDb
      .from('users')
      .delete()
      .eq('id', legacyId);
    if (deleteError) throw deleteError;

    return NextResponse.json({
      success: true,
      adopted: true,
      movedScans: (scans || []).length,
      movedActions: (actions || []).length,
    });
  } catch (error) {
    return handleRouteError(error, 'Adopt legacy account API error:');
  }
}

export const runtime = 'edge';
