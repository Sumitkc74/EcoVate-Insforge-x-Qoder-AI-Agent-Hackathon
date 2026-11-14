/**
 * Verification Page
 * 
 * User submits completion photo for DIY project verification.
 * Awards impact points if verified.
 */

'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { getCurrentIdentity, authedFetch, readApiJson } from '@/lib/client-auth';
import { downscaleImageFile } from '@/lib/image-resize';
import UserMenu from '@/components/UserMenu';
import { openAddDiy } from '@/lib/diy-continue';

// Loading fallback
function VerifyLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full"></div>
    </div>
  );
}

// Main verification component
function VerifyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [scanId, setScanId] = useState('');
  const [projectTitle, setProjectTitle] = useState('');
  const [packagingType, setPackagingType] = useState('');
  const [estimatedCo2Saved, setEstimatedCo2Saved] = useState(0.5);
  const [choosingAgain, setChoosingAgain] = useState(false);
  // Signed-in user for the header menu (name + Sign out dropdown).
  const [headerUser, setHeaderUser] = useState<{
    name: string | null;
    email: string | null;
    avatar: string | null;
  } | null>(null);
  
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [result, setResult] = useState<{
    verified: boolean;
    confidence: number;
    feedback: string;
    impactScore: number;
    saved?: boolean;
    saveError?: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setScanId(searchParams.get('scanId') || '');
    setProjectTitle(searchParams.get('projectTitle') || '');
    setPackagingType(searchParams.get('packagingType') || '');
    const co2 = parseFloat(searchParams.get('estimatedCo2Saved') || '0.5');
    setEstimatedCo2Saved(co2);
    // Signed-in user for the header menu (name + Sign out dropdown).
    getCurrentIdentity().then((identity) => {
      if (identity) {
        setHeaderUser({
          name: identity.name,
          email: identity.email,
          avatar: identity.avatar,
        });
      }
    }).catch(() => {});
  }, [searchParams]);

  // Back to the DIY options for this scan to pick a different idea.
  const handleChooseAgain = async () => {
    if (!scanId) return;
    setChoosingAgain(true);
    setError(null);
    try {
      await openAddDiy(router, scanId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChoosingAgain(false);
    }
  };

  // Back to the upload form for the SAME chosen DIY, to try a new photo.
  const handleRetry = () => {
    setIsComplete(false);
    setResult(null);
    setSelectedFile(null);
    setPreviewImage(null);
    setError(null);
  };

  // The photo is downscaled to 1024px on the longest side first
  // (same as the scan page): a full-resolution phone photo is
  // several megabytes, and the verification route sends it to the
  // AI as base64. 1024px is plenty for the verification read.
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        setError('Please select an image file');
        return;
      }
      const resized = await downscaleImageFile(file);
      setSelectedFile(resized);
      setPreviewImage(URL.createObjectURL(resized));
      setError(null);
    }
  };

  const handleSubmit = async () => {
    if (!selectedFile) {
      setError('Please take a photo of your completed project');
      return;
    }

    setIsVerifying(true);
    setError(null);

    try {
      // The caller must be signed in (Google or guest) — the token
      // goes out in the header via authedFetch below.
      const identity = await getCurrentIdentity();
      if (!identity) {
        throw new Error('Please log in again');
      }

      const formData = new FormData();
      formData.append('image', selectedFile);
      formData.append('scanId', scanId);
      formData.append('projectTitle', projectTitle);
      formData.append('packagingType', packagingType);
      formData.append('estimatedCo2Saved', String(estimatedCo2Saved));

      const response = await authedFetch('/api/verify', {
        method: 'POST',
        body: formData,
      });

      const data = await readApiJson(response);

      if (!response.ok) {
        throw new Error(data.error || 'Verification failed');
      }

      setResult(data);
      setIsComplete(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsVerifying(false);
    }
  };

  if (isComplete && result) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 text-center">
          {result.verified && result.confidence >= 0.85 ? (
            <>
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-10 h-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Project Verified!</h1>
              <p className="text-gray-600 mb-6">{result.feedback}</p>
              
              <div className="bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl p-6 mb-6">
                <p className="text-green-100 text-sm mb-1">You earned</p>
                <p className="text-4xl font-bold text-white">{result.impactScore} points</p>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-blue-50 rounded-xl p-4">
                  <p className="text-2xl font-bold text-blue-600">{estimatedCo2Saved}</p>
                  <p className="text-xs text-blue-800">kg CO2 saved</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-4">
                  <p className="text-2xl font-bold text-amber-600">{(estimatedCo2Saved * 2.5).toFixed(1)}</p>
                  <p className="text-xs text-amber-800">L water saved</p>
                </div>
              </div>
            </>
          ) : (
            <>
              {result.verified ? (
                <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
                  <svg className="w-10 h-10 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
              ) : (
                <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
                  <svg className="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
              )}
              <h1 className="text-2xl font-bold text-gray-900 mb-2">{result.verified ? 'Verification Pending' : 'Project Not Verified'}</h1>
              <p className="text-gray-600 mb-6">{result.feedback}</p>
              {result.saved === false && (
                <p className="text-sm text-red-600 mb-6">
                  Your project was not saved to History{result.saveError ? `: ${result.saveError}` : '.'} The database needs a one-time fix before {result.verified ? 'pending' : 'failed'} projects can save, so please submit again after that fix.
                </p>
              )}
              {/* Floor, don't round: a pending result at 84.5% must
                  never display as 85% next to "85%+ is needed". */}
              <p className="text-sm text-gray-500 mb-6">
                {result.verified
                  ? `The AI thinks this may be complete, but is only ${Math.floor(result.confidence * 100)}% confident — 85%+ is needed for automatic approval.`
                  : `The AI is ${Math.floor(result.confidence * 100)}% confident this photo does not show a completed project yet.`}
              </p>
            </>
          )}

          {result.saved === false && result.verified && result.confidence >= 0.85 && (
            <p className="text-sm text-red-600 mb-6">
              Your project was verified but was not saved to History{result.saveError ? `: ${result.saveError}` : '.'} The database needs a one-time fix before verified projects can save, so please submit again after that fix.
            </p>
          )}

          {!(result.verified && result.confidence >= 0.85) && (
            <div className="space-y-2 mb-4">
              <button
                onClick={handleRetry}
                className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
              >
                Retry with a new photo
              </button>
              <button
                onClick={handleChooseAgain}
                disabled={choosingAgain}
                className="w-full text-sm font-medium text-green-600 hover:text-green-700 disabled:opacity-50 py-1"
              >
                {choosingAgain ? 'Loading ideas…' : 'Choose a different DIY'}
              </button>
            </div>
          )}
          {error && (
            <p className="text-sm text-red-600 mb-4">{error}</p>
          )}

          <button
            onClick={() => router.push('/dashboard')}
            className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
          >
            View Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100">
      {/* Header: back arrow + page title on the left, signed-in user
          on the right — same nav as Scan and Dashboard. The title
          lives here now, not in the body. */}
      <header className="bg-white shadow-sm">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <button
              onClick={() => router.back()}
              aria-label="Back"
              className="p-2 text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="font-bold text-gray-900">Complete Your Project</span>
          </div>
          <UserMenu user={headerUser} />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <p className="text-gray-600">Show us what you made with your {packagingType}!</p>
        </div>

        {/* Project Info */}
        <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-1">{projectTitle}</h2>
          <p className="text-sm text-gray-500">Estimated CO2 savings: {estimatedCo2Saved} kg</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* Photo Upload */}
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
          {previewImage ? (
            <>
              <img
                src={previewImage}
                alt="Project preview"
                className="w-full aspect-square object-cover"
              />
              <div className="p-4 space-y-3">
                <button
                  onClick={handleSubmit}
                  disabled={isVerifying}
                  className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 disabled:opacity-50"
                >
                  {isVerifying ? (
                    <span className="flex items-center justify-center">
                      <svg className="animate-spin w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Verifying...
                    </span>
                  ) : (
                    'Submit for Verification'
                  )}
                </button>
                <button
                  onClick={() => {
                    setPreviewImage(null);
                    setSelectedFile(null);
                  }}
                  className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-3 px-4 rounded-xl transition-colors"
                >
                  Take Different Photo
                </button>
              </div>
            </>
          ) : (
            <div className="p-8 text-center">
              <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-12 h-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Upload Completion Photo</h3>
              <p className="text-gray-600 text-sm mb-6">
                Take a clear photo showing your completed DIY project
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
              >
                Choose Photo
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>
          )}
        </div>

        {/* Do it later / pick a different idea. The choice is already
            saved (choosing the idea logs it), so leaving now shows the
            scan as DIY Incomplete and the DIY in History. */}
        <div className="mt-6 space-y-2">
          <button
            onClick={() => router.push('/dashboard')}
            className="w-full bg-white border-2 border-gray-200 hover:border-green-400 text-gray-700 font-semibold py-3 px-4 rounded-xl transition-all duration-200"
          >
            Complete later
          </button>
          <button
            onClick={handleChooseAgain}
            disabled={choosingAgain}
            className="w-full text-sm font-medium text-green-600 hover:text-green-700 disabled:opacity-50 py-1"
          >
            {choosingAgain ? 'Loading ideas…' : 'Choose a different DIY'}
          </button>
        </div>

        {/* Photo privacy disclaimer */}
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-3">
          <p className="text-xs text-amber-800">
            Photo privacy: photos you upload are stored in a public bucket and can be viewed by anyone with the link. Please avoid photos showing people, personal information, or the inside of your home.
          </p>
        </div>

        {/* Tips */}
        <div className="mt-6 bg-blue-50 rounded-xl p-4">
          <h4 className="font-semibold text-blue-900 mb-2">Tips for verification:</h4>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• Show the entire completed project</li>
            <li>• Ensure good lighting</li>
            <li>• Include the original packaging if visible</li>
            <li>• Make sure the project is clearly visible</li>
          </ul>
        </div>
      </main>
    </div>
  );
}

// Main export with suspense boundary
export default function VerifyPage() {
  return (
    <Suspense fallback={<VerifyLoading />}>
      <VerifyContent />
    </Suspense>
  );
}
