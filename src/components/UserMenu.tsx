/**
 * Signed-in user menu for the header: avatar + name (and email when
 * showEmail is set) on the right. Tapping it opens a dropdown with
 * the account details, an edit-profile form (the leaderboard name
 * and photo — neither has to come from Google), Sign in with Google
 * for guests, Delete account for Google users (guests are deleted
 * when they sign out), and Sign out. Renders nothing when signed out.
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signOutAll, authedFetch, readApiJson, updateAnonSessionName } from '@/lib/client-auth';
import { signInWithGoogle } from '@/lib/auth';
import { downscaleImageFile } from '@/lib/image-resize';

export interface MenuUser {
  name: string | null;
  email: string | null;
  avatar: string | null;
  hasCustomAvatar?: boolean;
}

const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export default function UserMenu({
  user,
  showEmail = false,
  onNameChange,
  onAvatarChange,
}: {
  user: MenuUser | null;
  showEmail?: boolean;
  onNameChange?: (name: string) => void;
  onAvatarChange?: (avatar: string | null, hasCustomAvatar: boolean) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Values saved in this menu, until the parent re-renders with them.
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [avatarOverride, setAvatarOverride] = useState<string | null | undefined>(undefined);
  const [customAvatarOverride, setCustomAvatarOverride] = useState<boolean | null>(null);

  if (!user) return null;

  // Guests have no email; Google users always do.
  const isGuest = !user.email;
  const displayName = nameOverride || user.name || user.email || 'User';
  const displayAvatar = avatarOverride !== undefined ? avatarOverride : user.avatar;
  const hasCustomAvatar = customAvatarOverride ?? user.hasCustomAvatar ?? false;

  const handleSignOut = async () => {
    // A guest signing out is gone for good: the token lives only in
    // this browser, so there is no way back to the account. Delete
    // it server-side now instead of leaving orphaned rows behind.
    // Best effort — sign-out still proceeds if the delete fails
    // (the 7-day sweep catches the orphan).
    if (isGuest) {
      try {
        await authedFetch('/api/guest', { method: 'DELETE' });
      } catch {
        // Proceed with sign-out either way.
      }
    }
    // Signs out of Google and clears a guest session, if any.
    await signOutAll();
    router.push('/login');
  };

  const handleDeleteAccount = async () => {
    // Google users only — guests are deleted when they sign out.
    // Removes the scans, projects, points and photos, then signs
    // out. Signing in again afterwards starts fresh.
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const response = await authedFetch('/api/account', { method: 'DELETE' });
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || 'Could not delete the account');
      await signOutAll();
      router.push('/login');
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleGuestSignIn = async () => {
    setSignInError(null);
    const { error } = await signInWithGoogle();
    if (error) setSignInError(error.message);
    // Success redirects to Google; the callback moves the guest
    // history onto the Google account.
  };

  const handleAvatarSelect = async (file: File | undefined) => {
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) {
      setSaveError('Please choose a JPEG, PNG or WebP photo.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setSaveError('That photo is too large (max 5 MB).');
      return;
    }
    setSaveError(null);
    // Shrink big phone photos before upload; 512px is plenty for
    // an avatar shown at 32px.
    const resized = await downscaleImageFile(file, 512);
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarFile(resized);
    setAvatarPreview(URL.createObjectURL(resized));
    setRemoveAvatar(false);
  };

  const handleSaveProfile = async () => {
    setIsSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      let response: Response;
      if (avatarFile || removeAvatar) {
        const form = new FormData();
        form.set('name', nameInput);
        if (avatarFile) form.set('avatar', avatarFile);
        if (removeAvatar) form.set('remove_avatar', '1');
        response = await authedFetch('/api/profile', { method: 'PATCH', body: form });
      } else {
        response = await authedFetch('/api/profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput }),
        });
      }
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || 'Could not save the profile');
      setNameOverride(result.name);
      onNameChange?.(result.name);
      if (typeof result.avatar === 'string' || result.avatar === null) {
        setAvatarOverride(result.avatar);
        onAvatarChange?.(result.avatar, result.hasCustomAvatar ?? false);
      }
      if (typeof result.hasCustomAvatar === 'boolean') setCustomAvatarOverride(result.hasCustomAvatar);
      if (isGuest) updateAnonSessionName(result.name);
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
      setAvatarFile(null);
      setAvatarPreview(null);
      setRemoveAvatar(false);
      setSaved(true);
      setEditing(false);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const previewSrc = avatarPreview || displayAvatar;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center space-x-2 rounded-lg p-1 hover:bg-gray-100 transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {displayAvatar ? (
          <img src={displayAvatar} alt="" className="w-8 h-8 rounded-full object-cover" />
        ) : (
          <div className="w-8 h-8 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center">
            <span className="text-white text-sm font-bold">{displayName[0].toUpperCase()}</span>
          </div>
        )}
        <span className="text-left leading-tight">
          <span className="block text-sm font-semibold text-gray-900 max-w-[110px] truncate">{displayName}</span>
          {showEmail && user.email && (
            <span className="block text-xs text-gray-500 max-w-[140px] truncate">{user.email}</span>
          )}
        </span>
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <>
          <button
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 cursor-default"
          />
          <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-lg border border-gray-200 py-2 z-20">
            <div className="px-4 py-2 border-b border-gray-100">
              <p className="text-sm font-semibold text-gray-900 truncate">{displayName}</p>
              {user.email && <p className="text-xs text-gray-500 truncate">{user.email}</p>}
              {isGuest && <p className="text-xs text-gray-500">Guest account — this browser only</p>}
            </div>
            {saved && <p className="px-4 pt-2 text-sm text-green-600">Saved.</p>}
            {editing ? (
              <div className="px-4 py-3 space-y-3">
                <div className="flex items-center gap-3">
                  {previewSrc ? (
                    <img src={previewSrc} alt="" className="w-12 h-12 rounded-full object-cover" />
                  ) : (
                    <div className="w-12 h-12 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center">
                      <span className="text-white text-lg font-bold">{displayName[0].toUpperCase()}</span>
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-green-700 hover:text-green-800 cursor-pointer">
                      Change photo
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={(e) => void handleAvatarSelect(e.target.files?.[0])}
                      />
                    </label>
                    {hasCustomAvatar && !removeAvatar && !avatarFile && (
                      <button
                        onClick={() => {
                          setRemoveAvatar(true);
                          setAvatarFile(null);
                          if (avatarPreview) URL.revokeObjectURL(avatarPreview);
                          setAvatarPreview(null);
                        }}
                        className="text-sm text-gray-500 hover:text-red-600 text-left"
                      >
                        Remove photo
                      </button>
                    )}
                    {removeAvatar && (
                      <span className="text-sm text-gray-500">Photo will be removed.</span>
                    )}
                  </div>
                </div>
                <div>
                  <label htmlFor="profile-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Your leaderboard name
                  </label>
                  <input
                    id="profile-name"
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    maxLength={40}
                    aria-label="Leaderboard name"
                    className="w-full border-2 border-gray-200 rounded-xl py-2 px-3 text-gray-900 focus:border-green-500 focus:outline-none"
                  />
                </div>
                {saveError && <p className="text-sm text-red-600">{saveError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveProfile}
                    disabled={isSaving}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold py-2 px-3 rounded-xl transition-colors disabled:opacity-50"
                  >
                    {isSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => {
                      setEditing(false);
                      setSaveError(null);
                      setAvatarFile(null);
                      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
                      setAvatarPreview(null);
                      setRemoveAvatar(false);
                    }}
                    className="flex-1 bg-white border-2 border-gray-200 hover:border-gray-300 text-gray-700 text-sm font-medium py-2 px-3 rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setNameInput(displayName);
                  setSaved(false);
                  setSaveError(null);
                  setEditing(true);
                }}
                className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span>Edit profile</span>
              </button>
            )}
            {isGuest && (
              <button
                onClick={handleGuestSignIn}
                className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                </svg>
                <span>Sign in with Google</span>
              </button>
            )}
            {signInError && <p className="px-4 py-1 text-sm text-red-600">{signInError}</p>}
            <button
              onClick={handleSignOut}
              className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              <span>Sign out</span>
            </button>
            {!isGuest && !confirmingDelete && (
              <button
                onClick={() => {
                  setConfirmingDelete(true);
                  setDeleteError(null);
                }}
                className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16" />
                </svg>
                <span>Delete account</span>
              </button>
            )}
            {!isGuest && confirmingDelete && (
              <div className="px-4 py-3 space-y-3 border-t border-gray-100">
                <p className="text-sm text-gray-700">
                  This permanently deletes your EcoVate data — your scans, completed projects, points and photos. You can sign in again later, but you will start fresh.
                </p>
                {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={handleDeleteAccount}
                    disabled={isDeleting}
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold py-2 px-3 rounded-xl transition-colors disabled:opacity-50"
                  >
                    {isDeleting ? 'Deleting…' : 'Yes, delete my account'}
                  </button>
                  <button
                    onClick={() => {
                      setConfirmingDelete(false);
                      setDeleteError(null);
                    }}
                    className="flex-1 bg-white border-2 border-gray-200 hover:border-gray-300 text-gray-700 text-sm font-medium py-2 px-3 rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
