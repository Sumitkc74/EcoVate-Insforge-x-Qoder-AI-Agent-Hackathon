/**
 * /api/profile
 *
 * Your own leaderboard profile: the display name shown on the
 * leaderboard and in the header, for Google and guest accounts alike.
 * The name does not have to be the Google account name — it lives in
 * the users row, which Google sign-in never overwrites (see
 * ensureUserProfile), so a name picked here sticks across sign-ins.
 *
 * GET returns the effective profile: the users-row name/avatar when
 * present, otherwise the auth profile (Google) values, otherwise
 * 'Guest'. PATCH renames the account (trimmed, at most 40 chars).
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

export async function GET(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const { data: row } = await serverDb
      .from('users')
      .select('name, avatar')
      .eq('id', user.id)
      .single();
    const profile = (row as { name?: string | null; avatar?: string | null } | null) || {};
    return NextResponse.json({
      success: true,
      name: profile.name || user.name || 'Guest',
      avatar: profile.avatar || user.avatar || null,
      email: user.email,
      isAnonymous: user.isAnonymous,
    });
  } catch (error) {
    return handleRouteError(error, 'Profile API error:');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const body = await request.json().catch(() => ({}));
    const name = normalizeDisplayName(body?.name);

    const { error } = await serverDb
      .from('users')
      .update({ name })
      .eq('id', user.id);
    if (error) throw error;

    return NextResponse.json({ success: true, name });
  } catch (error) {
    return handleRouteError(error, 'Profile API error:');
  }
}

export const runtime = 'edge';
