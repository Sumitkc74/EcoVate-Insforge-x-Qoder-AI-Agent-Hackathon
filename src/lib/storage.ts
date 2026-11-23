/**
 * Storage Helpers
 *
 * Functions for uploading and retrieving images from InsForge S3 storage.
 * Uploads happen from API routes only, so they use the service-key
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
 *   row that references the photo. A signed URL works in a plain
 *   <img> tag, which cannot send an Authorization header.
 * The signature is an HMAC over `image:<key>:<exp>` with the service
 * key — the same pattern guest tokens use in server-auth.ts.
 */

import { serverStorage } from './insforge';

const BUCKET_NAME = 'user-uploads';
// No fallback URL here: the old hard-coded fallback pointed at a
// dead backend, so a deploy without the env var built every public
// photo URL against a dead host. Fail loudly instead.
const INSFORGE_URL = (() => {
  const url = process.env.NEXT_PUBLIC_INSFORGE_URL;
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_INSFORGE_URL is not set — set it in Vercel (Production) to the Insforge backend URL.',
    );
  }
  return url;
})();

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
// the old permanent public URL
// (.../api/storage/buckets/user-uploads/objects/<key>), the new
// proxy URL (/api/image?key=<key>), or a bare key. External URLs
// (Google profile photos) and anything else return null.
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
  const marker = `/api/storage/buckets/${BUCKET_NAME}/objects/`;
  const i = url.indexOf(marker);
  if (i >= 0) {
    try {
      return decodeURIComponent(url.slice(i + marker.length));
    } catch {
      return null;
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
    new TextEncoder().encode(process.env.INSFORGE_SERVICE_KEY || ''),
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
    const url = `${IMAGE_PROXY_PATH}?key=${encodeURIComponent(data.key)}`;

    return { url, key: data.key, error: null };
  } catch (error) {
    console.error('Upload error:', error);
    return { url: null, key: null, error: error as Error };
  }
}
