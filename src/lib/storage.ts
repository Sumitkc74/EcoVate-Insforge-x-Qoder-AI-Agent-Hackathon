/**
 * Storage Helpers
 *
 * Functions for uploading and retrieving images from InsForge S3 storage.
 * Uploads happen from API routes only, so they use the service-key
 * client (bypasses storage policies). Public URLs use InsForge's
 * public-object format; the bucket must exist and be public.
 */

import { serverStorage } from './insforge';

const BUCKET_NAME = 'user-uploads';
const INSFORGE_URL = process.env.NEXT_PUBLIC_INSFORGE_URL || 'https://8t37jscx.us-west.insforge.app';

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

    // Construct a permanent public URL (not presigned)
    // Format: {insforge_url}/api/storage/buckets/{bucket}/objects/{key}
    const publicUrl = `${INSFORGE_URL}/api/storage/buckets/${BUCKET_NAME}/objects/${encodeURIComponent(data.key)}`;

    return { url: publicUrl, key: data.key, error: null };
  } catch (error) {
    console.error('Upload error:', error);
    return { url: null, key: null, error: error as Error };
  }
}

// Get public URL for an image key
export function getPublicUrl(key: string): string {
  return `${INSFORGE_URL}/api/storage/buckets/${BUCKET_NAME}/objects/${encodeURIComponent(key)}`;
}
