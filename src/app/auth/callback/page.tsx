/**
 * Auth Callback Page
 *
 * Handles OAuth callback from Google. Creates user profile if needed.
 *
 * Supabase redirects back with a `code` param (or `error` on
 * failure); the code is exchanged for a session, which the browser
 * client stores in cookies.
 */

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/supabase';
import { ensureUserProfile, signInWithGoogle } from '@/lib/auth';
import { authedFetch, readAnonSession, clearAnonSession } from '@/lib/client-auth';

export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState('Processing authentication...');
  const [error, setError] = useState<string | null>(null);
  const [showRetry, setShowRetry] = useState(false);

  useEffect(() => {
    const handleCallback = async () => {
      try {
        // Check for OAuth callback parameters. Supabase redirects back
        // with a `code` param (or `error` on failure); exchange the code
        // for a session, which the browser client stores in cookies.
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const errorParam = urlParams.get('error');
        const errorDescription = urlParams.get('error_description');

        if (errorParam) {
          setError(`Authentication failed: ${errorDescription || errorParam}`);
          setTimeout(() => router.push('/login'), 3000);
          return;
        }

        if (!code) {
          setError('Invalid callback parameters');
          setTimeout(() => router.push('/login'), 3000);
          return;
        }

        // If a session already exists (e.g. this callback URL was
        // opened twice, or a parallel run already exchanged the code),
        // skip the exchange — the code is single-use and the verifier
        // is gone after the first exchange.
        const { data: { session: existingSession } } = await auth.getSession();
        if (!existingSession) {
          const { error: exchangeError } = await auth.exchangeCodeForSession(code);

          if (exchangeError) {
            // The exchange may have failed while a session still landed
            // (parallel run); check again before giving up.
            const { data: { session: retrySession } } = await auth.getSession();
            if (!retrySession) {
              if (exchangeError.message.includes('code verifier')) {
                // The handshake was started in a different browser (or
                // its storage was cleared) — no verifier to exchange
                // with. A fresh sign-in sets a new one, so offer that
                // instead of a dead-end error.
                setError(
                  'This sign-in didn\u2019t finish in the same browser, so it couldn\u2019t be completed. Please try again and stay in this browser tab until you\u2019re back on EcoVate.',
                );
                setShowRetry(true);
                return;
              }
              setError(`Authentication failed: ${exchangeError.message}`);
              setTimeout(() => router.push('/login'), 3000);
              return;
            }
            // A session appeared — fall through to the steps below.
          }
        }

        // Get current user after OAuth redirect
        const { data: userData, error: userError } = await auth.getCurrentUser();

        if (userError || !userData?.user) {
          setError('Failed to get user information');
          setTimeout(() => router.push('/login'), 3000);
          return;
        }

        const user = userData.user;

        // Ensure user profile exists in our database
        const { error: profileError } = await ensureUserProfile(
          user.id,
          user.email,
          user.profile?.name ?? undefined,
          user.profile?.avatar_url ?? undefined,
        );

        if (profileError) {
          console.error('Profile creation error:', profileError);
          // Continue anyway - profile might already exist
        }

        // A Google account imported from Insforge has its history
        // under the old Insforge id; adopt it onto this new Supabase
        // id by verified email, so the first sign-in after the move
        // does not start from an empty account. No-op when there is
        // no legacy row. A failure here never blocks sign-in — the
        // next sign-in retries it.
        try {
          const adoptResponse = await authedFetch('/api/adopt-legacy-account', {
            method: 'POST',
          });
          const adoptResult = await adoptResponse.json().catch(() => ({}));
          if (!adoptResponse.ok) {
            console.error('Legacy adoption failed:', adoptResult.error);
          }
        } catch (adoptErr) {
          console.error('Legacy adoption failed:', adoptErr);
        }

        // A guest who signs in with Google keeps their history:
        // move the guest account's scans and verifications onto
        // this Google account. The guest session must still be in
        // localStorage — signing out first would have cleared it,
        // so the dashboard's guest card is the way in, not Sign out.
        const guestSession = readAnonSession();
        if (guestSession) {
          try {
            setStatus('Moving your guest history to this account...');
            const migrateResponse = await authedFetch('/api/migrate-guest', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ guestToken: guestSession.token }),
            });
            const migrateResult = await migrateResponse.json().catch(() => ({}));
            if (migrateResponse.ok && migrateResult.success) {
              clearAnonSession();
            } else {
              // Keep the guest session: the dashboard offers to
              // retry the move from there.
              console.error('Guest migration failed:', migrateResult.error);
            }
          } catch (migrateErr) {
            console.error('Guest migration failed:', migrateErr);
          }
        }

        setStatus('Authentication successful! Redirecting...');
        router.push('/dashboard');
      } catch (err) {
        console.error('Callback error:', err);
        setError('An unexpected error occurred');
        setTimeout(() => router.push('/login'), 3000);
      }
    };

    handleCallback();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-emerald-100">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full mx-4 text-center">
        {error ? (
          <>
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Authentication Failed</h1>
            <p className="text-red-600 mb-4">{error}</p>
            {showRetry ? (
              <button
                onClick={() => signInWithGoogle()}
                className="bg-green-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-green-700"
              >
                Try signing in again
              </button>
            ) : (
              <p className="text-gray-500 text-sm">Redirecting to login...</p>
            )}
          </>
        ) : (
          <>
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Ecovate</h1>
            <p className="text-gray-600">{status}</p>
            <div className="mt-4 flex justify-center">
              <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
