/**
 * Cookie Policy
 *
 * The only cookies EcoVate sets: the Supabase sign-in session
 * cookie (Google sign-in) and the guest photo cookie. No
 * advertising or tracking cookies.
 */

export default function CookiePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-md mx-auto px-4 py-4">
          <a href="/login" className="text-sm font-medium text-green-700 hover:text-green-700">
            &larr; Back to sign in
          </a>
        </div>
      </header>
      <main className="max-w-md mx-auto px-4 py-6 space-y-4 text-sm text-gray-700">
        <h1 className="text-xl font-bold text-gray-900">Cookie Policy</h1>
        <p>
          EcoVate uses cookies only to keep you signed in and to show you your own photos.
          There are no advertising cookies and no tracking or analytics cookies.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Cookies we set</h2>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <span className="font-semibold text-gray-900">sb-bbjyzqowxnanwpplxogl-auth-token</span> — the
            Supabase sign-in session, set when you sign in with Google. It keeps you signed in
            so the app can load your scans and history. It lasts up to 400 days; signing out
            removes it.
          </li>
          <li>
            <span className="font-semibold text-gray-900">Temporary sign-in cookies</span> — while
            Google sign-in is in progress, Supabase sets short-lived cookies (their names start
            with sb-bbjyzqowxnanwpplxogl-auth-token and end in -code-verifier) to complete the
            sign-in securely. They are removed once sign-in finishes.
          </li>
          <li>
            <span className="font-semibold text-gray-900">ecovate_anon_token</span> — the guest
            photo cookie, set when a guest session starts. It lets the app show a guest&apos;s
            own photos: photo requests cannot carry a sign-in token, so this cookie proves the
            photo belongs to your guest session. It cannot be read by page scripts (HttpOnly)
            and, on the live site, is only sent over secure connections. It lasts 7 days, and
            is removed when you sign out, when the guest account is deleted, or after 7 days
            without activity.
          </li>
        </ul>
        <h2 className="text-base font-semibold text-gray-900">What we don&apos;t set</h2>
        <p>
          No advertising cookies, no analytics cookies, and no cookies from any other company.
          The app sets only the cookies listed above.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Managing cookies</h2>
        <p>
          You can clear cookies in your browser settings. Clearing them signs you out of a
          Google account. A guest session is kept in your browser separately, so clearing
          cookies alone does not delete a guest account — signing out does.
        </p>
      </main>
    </div>
  );
}
