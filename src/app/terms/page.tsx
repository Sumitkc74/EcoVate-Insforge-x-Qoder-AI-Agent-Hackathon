/**
 * Terms of Service
 *
 * Short and plain: what EcoVate is, what you agree to by using it,
 * and what happens to your account. The photo-storage paragraph
 * must stay honest — photos currently live in a public bucket
 * (see the scan page's privacy note); update it when private
 * storage lands.
 */

export default function TermsPage() {
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
        <h1 className="text-xl font-bold text-gray-900">Terms of Service</h1>
        <p>
          EcoVate helps you turn product packaging into do-it-yourself
          project ideas. Scan a photo of packaging, get material and
          project suggestions, and track the waste you keep out of the
          bin. It is a demonstration project, provided as-is with no
          warranty.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Your photos</h2>
        <p>
          You keep ownership of the photos you upload. By uploading
          one, you allow EcoVate to store it and send it to its AI
          providers so the scan can run. Photos are currently stored
          in a public bucket and can be viewed by anyone with the
          link, so please do not upload photos showing people,
          personal information, or the inside of your home.
        </p>
        <h2 className="text-base font-semibold text-gray-900">AI suggestions</h2>
        <p>
          Material guesses, CO2 estimates, and DIY ideas are produced
          by automated systems and can be wrong. They are suggestions
          only — use your own judgment before starting a project,
          especially where tools, heat, or chemicals are involved.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Accounts</h2>
        <p>
          You can use EcoVate as a guest, in this browser only, or
          sign in with Google for higher daily limits and to keep your
          history across devices. A guest account is deleted when you
          sign out, and after 7 days without activity. Do not use the
          service to upload anything unlawful or anything you do not
          have the right to share.
        </p>
        <h2 className="text-base font-semibold text-gray-900">Changes</h2>
        <p>
          These terms may change as the project develops. Continued
          use after a change means you accept the updated terms.
        </p>
      </main>
    </div>
  );
}
