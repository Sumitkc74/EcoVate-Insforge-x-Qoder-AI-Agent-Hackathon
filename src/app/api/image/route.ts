/**
 * GET /api/image?key=<storage key>[&exp=<unix>&sig=<hex>]
 *
 * Serves a photo from the private user-uploads bucket. No permanent
 * public URL exists for any photo any more, so every render goes
 * through here:
 * - avatars/<userId>/... are profile photos on the public
 *   leaderboard: served to anyone, unsigned.
 * - scans/<userId>/... and verifications/<userId>/... are the
 *   owner's household photos: served only on a short-lived signed
 *   URL minted by the server (see imageUrlForDisplay in
 *   lib/storage.ts). A plain <img> tag cannot send an Authorization
 *   header, so the signature — not a session — is the access check.
 * A missing, expired, or forged signature answers 404, never 403:
 * the response must not confirm whether the photo exists.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverStorage } from '@/lib/insforge';
import { assertServiceKey, handleRouteError } from '@/lib/server-auth';
import { verifyImageSignature } from '@/lib/storage';

// Keys are exactly <prefix>/<user uuid>/<file uuid>.<ext> —
// uploadImage is the only writer. Anything else is rejected
// before it can touch storage (no traversal, no other prefixes).
const KEY_PATTERN = /^(avatars|scans|verifications)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export async function GET(request: NextRequest) {
  try {
    assertServiceKey();
    const key = request.nextUrl.searchParams.get('key') || '';
    if (!KEY_PATTERN.test(key)) {
      return new NextResponse(null, { status: 404 });
    }
    const isAvatar = key.startsWith('avatars/');
    if (!isAvatar) {
      const exp = Number(request.nextUrl.searchParams.get('exp') || '');
      const sig = request.nextUrl.searchParams.get('sig') || '';
      if (!(await verifyImageSignature(key, exp, sig))) {
        return new NextResponse(null, { status: 404 });
      }
    }
    const { data, error } = await serverStorage.from('user-uploads').download(key);
    if (error || !data) {
      return new NextResponse(null, { status: 404 });
    }
    return new NextResponse(data, {
      headers: {
        'Content-Type': data.type || 'image/jpeg',
        // A signed scan URL lives 15 minutes; never cache it
        // publicly. Avatars are public by design.
        'Cache-Control': isAvatar ? 'public, max-age=3600' : 'private, max-age=900',
      },
    });
  } catch (error) {
    return handleRouteError(error, 'Image API error:');
  }
}

export const runtime = 'edge';
