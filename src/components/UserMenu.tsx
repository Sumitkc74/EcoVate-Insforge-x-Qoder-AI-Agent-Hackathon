/**
 * Signed-in user menu for the header: avatar + name (and email when
 * showEmail is set) on the right. Tapping it opens a dropdown with
 * the account details and Sign out. Renders nothing when signed out.
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signOutAll } from '@/lib/client-auth';

export interface MenuUser {
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export default function UserMenu({ user, showEmail = false }: { user: MenuUser | null; showEmail?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const displayName = user.name || user.email || 'User';

  const handleSignOut = async () => {
    // Signs out of Google and clears a guest session, if any.
    await signOutAll();
    router.push('/login');
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
          <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-200 py-2 z-20">
            <div className="px-4 py-2 border-b border-gray-100">
              <p className="text-sm font-semibold text-gray-900 truncate">{displayName}</p>
              {user.email && <p className="text-xs text-gray-500 truncate">{user.email}</p>}
            </div>
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
