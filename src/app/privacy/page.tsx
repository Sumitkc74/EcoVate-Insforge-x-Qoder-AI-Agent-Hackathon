/**
 * Privacy Policy
 *
 * Short and plain: what EcoVate collects, why, and how long it
 * keeps it. Photos are stored privately and served through the
 * app only (see the scan page's privacy note); profile photos
 * are visible on the leaderboard.
 */

export default function PrivacyPage() {
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
        <h1 className="text-xl font-bold text-gray-900">Privacy Policy</h1>
        <h2 className="text-base font-semibold text-gray-900">What we collect</h2>
        <p>Each item below is collected for the reason given — nothing else.</p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <span className="font-semibold text-gray-900">Your Google name</span> — shown on the
            leaderboard and in the app, so your scans and projects are tied to your account.
          </li>
          <li>
            <span className="font-semibold text-gray-900">Your Google email address</span> — used
            to identify your account when you sign in. It is never shown to anyone.
          </li>
          <li>
            <span className="font-semibold text-gray-900">Your Google profile photo</span> — used
            as your profile photo on the leaderboard and in the app.
          </li>
          <li>
            <span className="font-semibold text-gray-900">Your guest display name, if you pick one</span> — shown
            on the leaderboard as your name.
          </li>
          <li>
            <span className="font-semibold text-gray-900">Photos you upload</span> — sent to our AI
            providers (Google Gemini and Groq) so the scan or verification can run, and stored
            privately so they can be shown in your History.
          </li>
          <li>
            <span className="font-semibold text-gray-900">Your scan history</span> — shown in your
            History, and used to count your points and leaderboard score.
          </li>
          <li>
            <span className="font-semibold text-gray-900">Your DIY projects</span> — checked when
            you verify them, awarded points when complete, and shown in your History.
          </li>
        </ul>
        <h2 className="text-base font-semibold text-gray-900">Age</h2>
        <p>
          EcoVate is for people aged 18 and older. If you are under 18, do not use EcoVate.
          Confirm you are 18 or older before signing in with Google or starting a guest
          session. Guests confirm again before uploading a photo.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Photos</h2>
        <p>
          Photos you upload are stored privately and are only shown
          inside the app; your profile photo is visible on the
          leaderboard. Please do not upload photos showing people,
          personal information, or the inside of your home. Photos
          are sent to our AI providers (Google Gemini and Groq) so
          the scan can run; we do not sell your photos or your data
          to anyone.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Cookies</h2>
        <p>
          EcoVate sets a small number of cookies to keep you signed in: a Supabase sign-in
          cookie when you use Google sign-in, and a guest cookie that lets the app show a
          guest&apos;s own photos. There are no advertising or tracking cookies. See the{' '}
          <a href="/cookie" className="text-green-700 hover:text-green-700 underline">Cookie Policy</a>{' '}
          for the full list.
        </p>
        <h2 className="text-base font-semibold text-gray-900">How long we keep it</h2>
        <p>
          A guest account — including its photos, scans, and history
          — is deleted when you sign out, and after 7 days without
          activity. A Google account and its history are kept until
          you delete your account from the account menu. Your leaderboard name and
          score are visible to other users; your email address is
          never shown to anyone.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Your choices</h2>
        <p>
          You can use EcoVate as a guest without signing in, pick a
          leaderboard name or use none, and change or remove your
          profile photo from the menu in the top-right corner.
        </p>
      </main>
    </div>
  );
}
