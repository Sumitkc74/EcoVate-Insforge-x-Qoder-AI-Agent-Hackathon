/**
 * Signed-in user menu for the header: avatar + name (and email when
 * showEmail is set) on the right. Tapping it opens a dropdown with
 * the account details, an edit-profile form (the leaderboard name —
 * it does not have to be the Google account name), Sign in with
 * Google for guests, and Sign out. Renders nothing when signed out.
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signOutAll, authedFetch, readApiJson, updateAnonSessionName } from '@/lib/client-auth';
import { signInWithGoogle } from '@/lib/auth';

export interface MenuUser {
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export default function UserMenu({
  user,
  showEmail = false,
  onNameChange,
}: {
  user: MenuUser | null;
  showEmail?: boolean;
  onNameChange?: (name: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  // A name saved in this menu, until the parent re-renders with it.
  const [nameOverride, setNameOverride] = useState<string | null>(null);

  if (!user) return null;

  // Guests have no email; Google users always do.
  const isGuest = !user.email;
  const displayName = nameOverride || user.name || user.email || 'User';

  const handleSignOut = async () => {
    // Signs out of Google and clears a guest session, if any.
    await signOutAll();
    router.push('/login');
  };

  const handleGuestSignIn = async () => {
    setSignInError(null);
    const { error } = await signInWithGoogle();
    if (error) setSignInError(error.message);
    // Success redirects to Google; the callback moves the guest
    // history onto the Google account.
  };

  const handleSaveName = async () => {
    setIsSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const response = await authedFetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput }),
      });
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || 'Could not save the name');
      setNameOverride(result.name);
      onNameChange?.(result.name);
      if (isGuest) updateAnonSessionName(result.name);
      setSaved(true);
      setEditing(false);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center space-x-2 rounded-lg p-1 hover:bg-gray-100 transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {user.avatar ? (
          <img src={user.avatar} alt="" className="w-8 h-8 rounded-full" />
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
              <div className="px-4 py-3 space-y-2">
                <label htmlFor="profile-name" className="block text-sm font-medium text-gray-700">
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
                {saveError && <p className="text-sm text-red-600">{saveError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveName}
                    disabled={isSaving}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold py-2 px-3 rounded-xl transition-colors disabled:opacity-50"
                  >
                    {isSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => {
                      setEditing(false);
                      setSaveError(null);
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
          </div>
        </>
      )}
    </div>
  );
}
