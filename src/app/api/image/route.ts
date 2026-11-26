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
 *   lib/storage.ts) AND only to the session that owns the photo.
 *   A plain <img> tag cannot send an Authorization header, so the
 *   session is proved by cookies instead: the Supabase session for
 *   Google users, the guest-token cookie for guests. A signature
 *   alone is a bearer token — anyone holding the link could open
 *   the photo — so it is never enough on its own.
 * A missing, expired, or forged signature, a missing session, or
 * a photo that belongs to someone else all answer 404, never 403:
 * the response must not confirm whether the photo exists.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverStorage, getServerUser } from '@/lib/supabase';
import {
  assertServiceKey,
  validateAnonToken,
  ANON_COOKIE_NAME,
  handleRouteError,
} from '@/lib/server-auth';
import { verifyImageSignature } from '@/lib/storage';

// The owner id is the second segment of the key:
// scans/<userId>/... or verifications/<userId>/...
async function keyBelongsToSession(request: NextRequest, key: string): Promise<boolean> {
  const ownerId = key.split('/')[1];
  if (!ownerId) return false;
  try {
    // A guest proves itself with the guest-token cookie. A cookie
    // for a deleted account (sign-out, migration, 7-day sweep) is
    // dead — validateAnonToken requires the users row — so fall
    // through to the Google session, which is the live identity
    // after a migration.
    const anonToken = request.cookies.get(ANON_COOKIE_NAME)?.value;
    if (anonToken) {
      const guest = await validateAnonToken(anonToken);
      if (guest && guest.id === ownerId) return true;
    }
    // Google users prove themselves with the Supabase session
    // cookies, read the same way getServerUser does elsewhere.
    const { user } = await getServerUser(request);
    return !!user && user.id === ownerId;
  } catch {
    // Any auth failure fails closed: no photo.
    return false;
  }
}

// Keys are <prefix>/<user uuid>/<file>.<ext> — uploadImage is
// the only writer and names new files with a uuid, but the March
// 2026 files were named with a millisecond timestamp instead, so
// the filename is a uuid or 10+ digits. Anything else is rejected
// before it can touch storage (no traversal, no other prefixes).
const KEY_PATTERN = /^(avatars|scans|verifications)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{10,})\.(jpg|png|webp)$/;

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
      if (!(await keyBelongsToSession(request, key))) {
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
