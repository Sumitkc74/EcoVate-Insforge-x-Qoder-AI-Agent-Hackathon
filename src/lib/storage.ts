/**
 * Storage Helpers
 *
 * Functions for uploading and retrieving images from Supabase Storage.
 * Uploads happen from API routes only, so they use the service-role
 * client (bypasses storage policies).
 *
 * Photos are PRIVATE: the user-uploads bucket is private, and nothing
 * in the app hands out a permanent public URL any more. Images are
 * served through /api/image instead:
 * - avatars/<userId>/... are profile photos on the public leaderboard,
 *   so the proxy serves them to anyone, unsigned;
 * - scans/<userId>/... and verifications/<userId>/... are the owner's
 *   household photos, so the proxy serves them only on a short-lived
 *   signed URL (15 minutes) minted by the server when it returns the
 *   row that references the photo — and only to the session that owns
 *   the photo (the Supabase session cookies for Google users, the
 *   guest-token cookie for guests). A signed URL works in a plain
 *   <img> tag, which cannot send an Authorization header, but the
 *   signature alone is a bearer token, so it is never the whole
 *   access check: a signed link opened without the owner's session
 *   answers 404.
 * The signature is an HMAC over `image:<key>:<exp>` with the service
 * key — the same pattern guest tokens use in server-auth.ts.
 *
 * NOTE (migration): the Nov 10 Supabase plan called for a PUBLIC
 * bucket, but the live app went private on Nov 22-23 (bucket flipped
 * to private, signed-URL proxy, privacy copy updated). This port
 * keeps the live private design, not the plan's public one — the
 * bucket must be created PRIVATE in Supabase, and the /api/image
 * proxy is the only way photos are served. Supabase's own signed
 * URLs are not used; the app's HMAC proxy works the same on either
 * backend and keeps one code path.
 */

import { serverStorage } from './supabase';

const BUCKET_NAME = 'user-uploads';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';

export const IMAGE_PROXY_PATH = '/api/image';
// Signed scan/verification URLs live 15 minutes: long enough for a
// page view, short enough that a leaked link is useless soon after.
export const IMAGE_URL_TTL_SECONDS = 15 * 60;

// Only real photo types are accepted, and the extension comes from
// the validated MIME type — never from the client-supplied file name.
// Names are random UUIDs: the old `scans/<userId>/<timestamp>.jpg`
// pattern was predictable, and user ids are public via the
// leaderboard, so anyone could guess another user's photo URLs.
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Extract the storage key from any form a stored image URL takes:
// the Supabase permanent public URL
// (.../storage/v1/object/public/user-uploads/<key>), the old
// Insforge permanent public URL
// (.../api/storage/buckets/user-uploads/objects/<key>, still on
// rows exported from Insforge), the new proxy URL
// (/api/image?key=<key>), or a bare key. External URLs (Google
// profile photos) and anything else return null.
export function storageKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith(`${IMAGE_PROXY_PATH}?key=`)) {
    try {
      const key = new URL(url, 'https://x').searchParams.get('key');
      return key || null;
    } catch {
      return null;
    }
  }
  const markers = [
    `/storage/v1/object/public/${BUCKET_NAME}/`,
    `/api/storage/buckets/${BUCKET_NAME}/objects/`,
  ];
  for (const marker of markers) {
    const i = url.indexOf(marker);
    if (i >= 0) {
      try {
        return decodeURIComponent(url.slice(i + marker.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Sign one storage key for short-lived private access. Only the
// server can mint these (the service key never leaves it).
export async function signImageKey(key: string, ttlSeconds: number = IMAGE_URL_TTL_SECONDS): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await signImageKeyAt(key, exp);
  return `${IMAGE_PROXY_PATH}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
}

async function signImageKeyAt(key: string, exp: number): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(process.env.SUPABASE_SERVICE_ROLE_KEY || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(`image:${key}:${exp}`),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Check a signature from /api/image. Constant-time comparison: the
// failure mode must not leak whether the key exists.
export async function verifyImageSignature(key: string, exp: number, sig: string): Promise<boolean> {
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = await signImageKeyAt(key, exp);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// The URL the client renders for a stored image value:
// - a storage URL (old public format or new proxy format) for a
//   scan/verification photo becomes a signed proxy URL;
// - a storage URL for an avatar becomes the unsigned proxy URL
//   (avatars are public by design, on the leaderboard);
// - an external URL (a Google profile photo) passes through;
// - anything unrecognised passes through rather than breaking the
//   render — the proxy itself still enforces access.
export async function imageUrlForDisplay(value: string | null): Promise<string | null> {
  if (!value) return null;
  if (value.startsWith(`${IMAGE_PROXY_PATH}?key=`)) {
    const key = storageKeyFromUrl(value);
    if (!key) return value;
    return key.startsWith('avatars/') ? value : signImageKey(key);
  }
  const key = storageKeyFromUrl(value);
  if (!key) return value;
  return key.startsWith('avatars/')
    ? `${IMAGE_PROXY_PATH}?key=${encodeURIComponent(key)}`
    : signImageKey(key);
}

// Upload image to storage bucket
export async function uploadImage(file: File, path: string): Promise<{ url: string | null; key: string | null; error: Error | null }> {
  try {
    const fileExt = ALLOWED_IMAGE_TYPES[file.type];
    if (!fileExt) {
      return { url: null, key: null, error: new Error('Only JPEG, PNG and WebP photos are accepted') };
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return { url: null, key: null, error: new Error('Photo is too large (max 5 MB)') };
    }
    const fileName = `${path}/${crypto.randomUUID()}.${fileExt}`;

    const { data, error } = await serverStorage
      .from(BUCKET_NAME)
      .upload(fileName, file);

    if (error) throw error;
    if (!data) throw new Error('Upload failed - no data returned');

    // The stored URL is the proxy URL, never a permanent public
    // one. It is unsigned here: callers that return it to the
    // client for a scan/verification photo must run it through
    // imageUrlForDisplay first, which signs it. (Avatar uploads
    // are public, so the unsigned proxy URL is the display URL.)
    const url = `${IMAGE_PROXY_PATH}?key=${encodeURIComponent(data.path)}`;

    return { url, key: data.path, error: null };
  } catch (error) {
    console.error('Upload error:', error);
    return { url: null, key: null, error: error as Error };
  }
}

// Get a public URL for an image key. Only meaningful while the
// bucket is public; the live bucket is private, so nothing in the
// app calls this for display — imageUrlForDisplay is the display
// path. Kept for the data-export tooling and for any caller that
// genuinely needs the storage URL form.
export function getPublicUrl(key: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${encodeURIComponent(key)}`;
}
