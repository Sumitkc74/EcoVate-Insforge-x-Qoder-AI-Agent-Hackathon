/**
 * DELETE /api/account
 *
 * A Google user deleting their own account. Removes the app data
 * tied to them — scans, completed projects, points, photos — via
 * the same cleanup as the guest delete. Only Google accounts can
 * be deleted here; guests are deleted when they sign out
 * (DELETE /api/guest). Signing in again afterwards starts fresh:
 * the Google sign-in itself lives with Google/Insforge, not in
 * this app's data.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  assertServiceKey,
  requireUser,
  deleteGuestAccount,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

export async function DELETE(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    if (user.isAnonymous) {
      return NextResponse.json(
        { error: 'Guest accounts are deleted when you sign out.' },
        { status: 403 },
      );
    }
    await deleteGuestAccount(user.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, 'Account delete API error:');
  }
}

export const runtime = 'edge';
