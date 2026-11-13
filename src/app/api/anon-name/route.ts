/**
 * PATCH /api/anon-name
 *
 * Change the leaderboard display name of an anonymous account.
 * Signed-in (Google) users get their name from Google, so this route
 * is anonymous-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import {
  assertServiceKey,
  requireUser,
  unauthorizedResponse,
  normalizeDisplayName,
  handleRouteError,
} from '@/lib/server-auth';

export async function PATCH(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    if (!user.isAnonymous) {
      return NextResponse.json(
        { error: 'Your display name comes from Google.' },
        { status: 403 },
      );
    }
    const body = await request.json().catch(() => ({}));
    const name = normalizeDisplayName(body?.name);

    const { error } = await serverDb
      .from('users')
      .update({ name })
      .eq('id', user.id);
    if (error) throw error;

    return NextResponse.json({ success: true, name });
  } catch (error) {
    return handleRouteError(error, 'Anonymous name API error:');
  }
}

export const runtime = 'edge';
