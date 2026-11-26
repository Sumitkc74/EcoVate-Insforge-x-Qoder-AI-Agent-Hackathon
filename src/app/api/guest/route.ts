/**
 * DELETE /api/guest
 *
 * A guest deleting their own account — used when a guest signs
 * out. A guest account is gone the moment its owner logs out: the
 * token lives only in that browser's localStorage, so a logged-out
 * guest can never come back, and keeping the rows would only leave
 * orphaned accounts behind. Only guest accounts can be deleted
 * here; Google accounts are never touched by this route.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  assertServiceKey,
  requireUser,
  deleteGuestAccount,
  clearAnonCookie,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

export async function DELETE(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    if (!user.isAnonymous) {
      return NextResponse.json(
        { error: 'Only guest accounts can be deleted this way.' },
        { status: 403 },
      );
    }
    await deleteGuestAccount(user.id);
    // The guest is gone, so the photo cookie goes with it: without
    // this a signed link plus the stale cookie would keep proving
    // an identity that no longer exists (validateAnonToken would
    // refuse it anyway — the users row is gone — but a dead cookie
    // should not linger in the browser).
    const response = NextResponse.json({ success: true });
    clearAnonCookie(response);
    return response;
  } catch (error) {
    return handleRouteError(error, 'Guest delete API error:');
  }
}

export const runtime = 'edge';
