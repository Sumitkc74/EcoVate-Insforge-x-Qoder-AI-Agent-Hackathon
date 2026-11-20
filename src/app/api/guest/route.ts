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
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, 'Guest delete API error:');
  }
}

export const runtime = 'edge';
