/**
 * /api/profile
 *
 * Your own leaderboard profile: the display name and avatar shown on
 * the leaderboard and in the header, for Google and guest accounts
 * alike. Neither has to come from Google — both live in the users
 * row, which Google sign-in never overwrites (see
 * ensureUserProfile), so a name and photo picked here stick across
 * sign-ins.
 *
 * GET returns the effective profile: the users-row name/avatar when
 * present, otherwise the auth profile (Google) values, otherwise
 * 'Guest' / no avatar. hasCustomAvatar tells the menu whether the
 * avatar is one the user uploaded (a storage URL) as opposed to
 * their Google photo.
 *
 * PATCH renames the account and/or changes the avatar. It accepts
 * JSON ({ name, remove_avatar }) or multipart form-data (name,
 * avatar file, remove_avatar). A name is only changed when the field
 * is present; an avatar file (jpeg/png/webp, max 5 MB — enforced by
 * uploadImage) is stored under avatars/<userId>/ in the user-uploads
 * bucket, and the previous custom avatar file is deleted
 * best-effort. remove_avatar clears the stored avatar: Google users
 * fall back to their Google photo, guests to the initial circle.
 * Only the caller's own row is ever touched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb, serverStorage } from '@/lib/supabase';
import { uploadImage, storageKeyFromUrl, imageUrlForDisplay } from '@/lib/storage';
import {
  assertServiceKey,
  requireUser,
  unauthorizedResponse,
  normalizeDisplayName,
  handleRouteError,
} from '@/lib/server-auth';

const BUCKET_NAME = 'user-uploads';

// A custom avatar is a photo the user uploaded (a storage URL under
// avatars/); a Google photo URL is not.
function isCustomAvatarUrl(url: string | null): boolean {
  const key = storageKeyFromUrl(url);
  return key !== null && key.startsWith('avatars/');
}

async function deleteOldAvatar(userId: string, oldUrl: string | null): Promise<void> {
  const key = storageKeyFromUrl(oldUrl);
  // Only ever delete this user's own avatar files.
  if (!key || !key.startsWith(`avatars/${userId}/`)) return;
  try {
    await serverStorage.from(BUCKET_NAME).remove([key]);
  } catch {
    // Best effort: the orphaned file is unreferenced either way.
  }
}

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
      // The avatar the client renders: a storage photo becomes the
      // proxy URL (public for avatars), a Google photo passes
      // through untouched.
      avatar: await imageUrlForDisplay(profile.avatar || user.avatar || null),
      hasCustomAvatar: isCustomAvatarUrl(profile.avatar || null),
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

    // Name and avatar arrive as JSON or as multipart form-data.
    let nameInput: unknown;
    let namePresent = false;
    let avatarFile: File | null = null;
    let removeAvatar = false;
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      namePresent = form.has('name');
      nameInput = form.get('name');
      const file = form.get('avatar');
      if (file instanceof File && file.size > 0) avatarFile = file;
      removeAvatar = form.get('remove_avatar') === '1';
    } else {
      const body = await request.json().catch(() => ({}));
      namePresent = Object.prototype.hasOwnProperty.call(body, 'name');
      nameInput = body?.name;
      removeAvatar = body?.remove_avatar === true;
    }

    const { data: row } = await serverDb
      .from('users')
      .select('name, avatar')
      .eq('id', user.id)
      .single();
    const current = (row as { name?: string | null; avatar?: string | null } | null) || {};

    const updates: { name?: string; avatar?: string | null } = {};
    if (namePresent) updates.name = normalizeDisplayName(nameInput);
    if (avatarFile) {
      const { url, error } = await uploadImage(avatarFile, `avatars/${user.id}`);
      if (error || !url) {
        return NextResponse.json(
          { error: error?.message || 'Could not upload the photo' },
          { status: 400 },
        );
      }
      updates.avatar = url;
    } else if (removeAvatar) {
      updates.avatar = null;
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({
        success: true,
        name: current.name || user.name || 'Guest',
        avatar: current.avatar || user.avatar || null,
        hasCustomAvatar: isCustomAvatarUrl(current.avatar || null),
      });
    }

    const { error } = await serverDb.from('users').update(updates).eq('id', user.id);
    if (error) throw error;

    // The old custom avatar file is unreferenced now — remove it.
    if ('avatar' in updates) {
      await deleteOldAvatar(user.id, current.avatar || null);
    }

    const nextName = updates.name ?? current.name ?? user.name ?? 'Guest';
    const nextAvatar = 'avatar' in updates ? updates.avatar : current.avatar;
    return NextResponse.json({
      success: true,
      name: nextName,
      avatar: nextAvatar || user.avatar || null,
      hasCustomAvatar: isCustomAvatarUrl(nextAvatar || null),
    });
  } catch (error) {
    return handleRouteError(error, 'Profile API error:');
  }
}
