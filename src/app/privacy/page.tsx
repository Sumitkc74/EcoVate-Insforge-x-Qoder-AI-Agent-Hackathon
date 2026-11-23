/**
 * Privacy Policy
 *
 * Short and plain: what EcoVate collects, why, and how long it
 * keeps it. The photo-storage paragraph must stay honest — photos
 * currently live in a public bucket (see the scan page's privacy
 * note); update it when private storage lands.
 */

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-md mx-auto px-4 py-4">
          <a href="/login" className="text-sm font-medium text-green-600 hover:text-green-700">
            &larr; Back to sign in
          </a>
        </div>
      </header>
      <main className="max-w-md mx-auto px-4 py-6 space-y-4 text-sm text-gray-700">
        <h1 className="text-xl font-bold text-gray-900">Privacy Policy</h1>
        <h2 className="text-base font-semibold text-gray-900">What we collect</h2>
        <p>
          If you sign in with Google, we store your name, email
          address, and profile photo so your scans, projects, and
          leaderboard entry can be tied to your account. If you
          continue as a guest, we store only the display name you
          pick, if any. We also store the photos you upload, your
          scan history, and the DIY projects you complete.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Photos</h2>
        <p>
          Photos you upload are currently stored in a public bucket
          and can be viewed by anyone with the link. Please do not
          upload photos showing people, personal information, or the
          inside of your home. Photos are sent to our AI providers
          (Google Gemini and Groq) so the scan can run; we do not
          sell your photos or your data to anyone.
        </p>
        <h2 className="text-base font-semibold text-gray-900">How long we keep it</h2>
        <p>
          A guest account — including its photos, scans, and history
          — is deleted when you sign out, and after 7 days without
          activity. A Google account and its history are kept until
          you ask for them to be removed. Your leaderboard name and
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
