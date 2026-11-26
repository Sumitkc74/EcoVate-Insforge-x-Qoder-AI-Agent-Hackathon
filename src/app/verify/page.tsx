/**
 * Verification Page
 *
 * Two ways to check a completed DIY project:
 *
 * - For points: take a photo with the in-app camera showing the
 *   challenge code (issued when this page loads) written on paper
 *   beside the finished project. The server awards points only when
 *   the project matches AND the code is visible in the photo. A
 *   visual match alone earns nothing.
 * - For feedback only: upload a gallery photo to see whether it
 *   matches the project. No points, no History row, no attempt spent.
 *
 * A failed or pending project can always be retried — each retry
 * gets a fresh code. Only an awarded project is locked.
 */

'use client';

import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { getCurrentIdentity, authedFetch, readApiJson } from '@/lib/client-auth';
import { downscaleImageFile } from '@/lib/image-resize';
import UserMenu from '@/components/UserMenu';
import CameraCapture from '@/components/CameraCapture';
import { openAddDiy } from '@/lib/diy-continue';

// Loading fallback
function VerifyLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full"></div>
    </div>
  );
}

type Challenge = { code: string; token: string; expiresAt: number };

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
    hasCustomAvatar?: boolean;
  } | null>(null);

  // Challenge code for the points path: issued per attempt, good
  // for 15 minutes. A retry always fetches a fresh one.
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [challengeLoading, setChallengeLoading] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // Which path the chosen photo will take: camera capture earns
  // points, a gallery upload is feedback only.
  const [captureMode, setCaptureMode] = useState<'points' | 'feedback' | null>(null);
  // Verifications left today, from /api/dashboard: guests get their
  // own 2/day count, signed-in users their 30/day count. Null until
  // loaded (or when the fetch fails — the line is then hidden rather
  // than showing a wrong number; the server still enforces the cap).
  const [verifyUsage, setVerifyUsage] = useState<{
    remaining: number;
    cap: number;
    isGuest: boolean;
    poolExhausted: boolean;
  } | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [result, setResult] = useState<{
    verified: boolean;
    confidence: number;
    feedback: string;
    impactScore: number;
    approved?: boolean;
    codeOk?: boolean;
    codeSeen?: string | null;
    feedbackOnly?: boolean;
    verificationUnavailable?: boolean;
    saved?: boolean;
    saveError?: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Timed progress messages while a verification runs. The server
  // does the whole check in one round trip, so these are timed, not
  // live stage reports — they say what the check is doing, not the
  // exact moment. Points checks rotate after ~12s; feedback-only
  // checks have a single step.
  const VERIFY_STEPS_POINTS = [
    'Checking that the finished project matches your idea…',
    'Reading the code on the paper…',
  ];
  const VERIFY_STEPS_FEEDBACK = ['Checking that the photo matches your idea…'];
  const [verifyStep, setVerifyStep] = useState(0);

  useEffect(() => {
    if (!isVerifying) {
      setVerifyStep(0);
      return;
    }
    if (captureMode !== 'points') return;
    const t = setTimeout(() => setVerifyStep(1), 12000);
    return () => clearTimeout(t);
  }, [isVerifying, captureMode]);

  const fetchUsage = useCallback(async () => {
    try {
      const response = await authedFetch('/api/dashboard');
      const data = await readApiJson(response);
      if (!response.ok) return;
      if (data.guestUsage) {
        // Guests: their own count only, never the shared pool number.
        // When the pool is done the count is effectively 0 even if
        // this guest has attempts left — the server refuses those too.
        const poolExhausted = data.guestPoolExhausted === true;
        const remaining = poolExhausted ? 0 : Math.max(0, 2 - (data.guestUsage.verifications || 0));
        setVerifyUsage({ remaining, cap: 2, isGuest: true, poolExhausted });
      } else if (data.verifyUsage) {
        setVerifyUsage({
          remaining: Math.max(0, data.verifyUsage.cap - data.verifyUsage.used),
          cap: data.verifyUsage.cap,
          isGuest: false,
          poolExhausted: false,
        });
      }
    } catch {
      // Leave the line hidden on failure (see the state comment).
    }
  }, []);

  const fetchChallenge = useCallback(async () => {
    if (!scanId) return false;
    setChallengeLoading(true);
    setChallengeError(null);
    try {
      const response = await authedFetch('/api/verify/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId }),
      });
      const data = await readApiJson(response);
      if (!response.ok) {
        throw new Error(data.error || 'Could not get a verification code');
      }
      setChallenge({ code: data.code, token: data.token, expiresAt: data.expiresAt });
      return true;
    } catch (e) {
      setChallenge(null);
      setChallengeError((e as Error).message);
      return false;
    } finally {
      setChallengeLoading(false);
    }
  }, [scanId]);

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
          hasCustomAvatar: identity.hasCustomAvatar ?? false,
        });
      }
    }).catch(() => {});
    // Verifications left today, shown above the capture buttons.
    fetchUsage();
  }, [searchParams, fetchUsage]);

  // A fresh code per attempt: fetched when the page loads for this
  // scan, and again on every retry.
  useEffect(() => {
    if (scanId) fetchChallenge();
  }, [scanId, fetchChallenge]);

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

  // Back to the upload form for the SAME chosen DIY, to try again.
  // A retry always gets a fresh code — the old photo cannot carry
  // it, so the preview is cleared too.
  const handleRetry = async () => {
    setIsComplete(false);
    setResult(null);
    setSelectedFile(null);
    setPreviewImage(null);
    setCaptureMode(null);
    setError(null);
    await fetchChallenge();
    await fetchUsage();
  };

  // The line shown above the capture buttons and on the result
  // screens: what is left before this submit, so the user is never
  // surprised by the cap afterwards.
  const usageLine = verifyUsage
    ? verifyUsage.poolExhausted
      ? 'Guest verifications are exhausted for the day. Sign in with Google to continue.'
      : verifyUsage.remaining === 0
        ? verifyUsage.isGuest
          ? "You've used both of today's verifications. Sign in with Google for 30 a day."
          : "You've used all 30 of today's verifications. Try again tomorrow."
        : `You have ${verifyUsage.remaining} of ${verifyUsage.cap} verification${verifyUsage.remaining === 1 ? '' : 's'} left today.`
    : null;

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
      // Gallery uploads are feedback only — they never earn points.
      setCaptureMode('feedback');
      setError(null);
    }
    // Reset the input so the same file can be picked again.
    event.target.value = '';
  };

  const handleCameraCapture = async (file: File) => {
    const resized = await downscaleImageFile(file);
    setSelectedFile(resized);
    setPreviewImage(URL.createObjectURL(resized));
    setCaptureMode('points');
    setCameraOpen(false);
    setError(null);
  };

  const handleSubmit = async () => {
    if (!selectedFile) {
      setError('Please take a photo of your completed project');
      return;
    }
    if (captureMode === 'points' && !challenge) {
      setError('No verification code yet — please get a fresh code and try again.');
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
      if (captureMode === 'points' && challenge) {
        formData.append('challengeToken', challenge.token);
      } else {
        formData.append('feedbackOnly', 'true');
      }

      const response = await authedFetch('/api/verify', {
        method: 'POST',
        body: formData,
      });

      const data = await readApiJson(response);

      if (!response.ok) {
        // An expired code just needs a fresh one: fetch it, clear
        // the photo (it cannot carry the new code) and say so.
        if (data.codeExpired) {
          await fetchChallenge();
          setSelectedFile(null);
          setPreviewImage(null);
          setCaptureMode(null);
        }
        throw new Error(data.error || 'Verification failed');
      }

      setResult(data);
      setIsComplete(true);
      // A points submit spent an attempt — refresh the count so the
      // result screen shows what is actually left now. A feedback
      // check spent nothing, so the number is unchanged.
      await fetchUsage();
    } catch (err) {
      setError((err as Error).message);
      // The cap claim runs before the AI work, so a failed submit
      // may still have spent the attempt — refresh the count.
      await fetchUsage();
    } finally {
      setIsVerifying(false);
    }
  };

  if (isComplete && result) {
    // Feedback-only result: a match check, not an award.
    if (result.feedbackOnly) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 text-center">
            <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 ${result.verified ? 'bg-green-100' : 'bg-red-100'}`}>
              {result.verified ? (
                <svg className="w-10 h-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              {result.verified ? 'Looks Like a Match' : 'Doesn\u2019t Look Like a Match Yet'}
            </h1>
            <p className="text-gray-600 mb-4">{result.feedback}</p>
            <p className="text-sm text-gray-500 mb-6">
              {result.verified
                ? `The AI is ${Math.floor(result.confidence * 100)}% confident this shows your project.`
                : `The AI is ${Math.floor(result.confidence * 100)}% confident this photo does not show your project yet.`}
            </p>
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3 mb-6">
              This was a feedback check only — no points were awarded. To earn points, take a photo with the camera showing your verification code.
            </p>
            {usageLine && (
              <p className="text-sm text-gray-500 mb-6">{usageLine}</p>
            )}
            <div className="space-y-2 mb-4">
              <button
                onClick={handleRetry}
                className="w-full bg-gradient-to-r from-green-700 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
              >
                Take a Camera Photo for Points
              </button>
              <button
                onClick={handleChooseAgain}
                disabled={choosingAgain}
                className="w-full text-sm font-medium text-green-700 hover:text-green-700 disabled:opacity-50 py-1"
              >
                {choosingAgain ? 'Loading ideas…' : 'Choose a different DIY'}
              </button>
            </div>
            <button
              onClick={() => router.push('/dashboard')}
              className="w-full bg-gradient-to-r from-green-700 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
            >
              View Dashboard
            </button>
          </div>
        </div>
      );
    }

    // Points result: green only when the award was actually made
    // (match + code). A match without the code is a failed attempt,
    // not a pending one; a low-confidence match is pending.
    const codeFailed = result.codeOk === false;
    const heading = result.approved
      ? 'Project Verified!'
      : result.verificationUnavailable
        ? 'Verification Pending'
        : codeFailed
          ? 'Code Not Verified'
          : result.verified
            ? 'Verification Pending'
            : 'Project Not Verified';
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 text-center">
          {result.approved ? (
            <>
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-10 h-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Project Verified!</h1>
              <p className="text-gray-600 mb-6">{result.feedback}</p>

              <div className="bg-gradient-to-r from-green-700 to-emerald-700 rounded-2xl p-6 mb-6">
                <p className="text-white text-sm mb-1">You earned</p>
                <p className="text-4xl font-bold text-white">{result.impactScore} points</p>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-blue-50 rounded-xl p-4">
                  <p className="text-2xl font-bold text-blue-600">{estimatedCo2Saved}</p>
                  <p className="text-xs text-blue-800">kg CO2 saved</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-4">
                  <p className="text-2xl font-bold text-amber-700">{(estimatedCo2Saved * 2.5).toFixed(1)}</p>
                  <p className="text-xs text-amber-800">L water saved</p>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* An AI outage is pending, not a verdict: the amber
                  icon and Pending heading, never a red X with a
                  "0% confident" line (see below). A code failure is
                  a failed attempt, so it gets the red icon even when
                  the project itself matched. */}
              {!codeFailed && (result.verified || result.verificationUnavailable) ? (
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
              <h1 className="text-2xl font-bold text-gray-900 mb-2">{heading}</h1>
              <p className="text-gray-600 mb-6">{result.feedback}</p>
              {result.saved === false && (
                <p className="text-sm text-red-600 mb-6">
                  Your project was not saved to History{result.saveError ? `: ${result.saveError}` : '.'} The database needs a one-time fix before {result.verified ? 'pending' : 'failed'} projects can save, so please submit again after that fix.
                </p>
              )}
              {/* Floor, don't round: a pending result at 84.5% must
                  never display as 85% next to "85%+ is needed".
                  And when the AI was unavailable there is no verdict
                  at all — never show "0% confident". A code failure
                  is explained by the feedback above, not a
                  confidence line. */}
              {!result.verificationUnavailable && !codeFailed && (
                <p className="text-sm text-gray-500 mb-6">
                  {result.verified
                    ? `The AI thinks this may be complete, but is only ${Math.floor(result.confidence * 100)}% confident — 85%+ is needed for automatic approval.`
                    : `The AI is ${Math.floor(result.confidence * 100)}% confident this photo does not show a completed project yet.`}
                </p>
              )}
            </>
          )}

          {result.saved === false && result.approved && (
            <p className="text-sm text-red-600 mb-6">
              Your project was verified but was not saved to History{result.saveError ? `: ${result.saveError}` : '.'} The database needs a one-time fix before verified projects can save, so please submit again after that fix.
            </p>
          )}

          {!result.approved && (
            <div className="space-y-2 mb-4">
              <button
                onClick={handleRetry}
                className="w-full bg-gradient-to-r from-green-700 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
              >
                Retry with a new code
              </button>
              <button
                onClick={handleChooseAgain}
                disabled={choosingAgain}
                className="w-full text-sm font-medium text-green-700 hover:text-green-700 disabled:opacity-50 py-1"
              >
                {choosingAgain ? 'Loading ideas…' : 'Choose a different DIY'}
              </button>
            </div>
          )}
          {error && (
            <p className="text-sm text-red-600 mb-4">{error}</p>
          )}
          {usageLine && (
            <p className="text-sm text-gray-500 mb-4">{usageLine}</p>
          )}

          <button
            onClick={() => router.push('/dashboard')}
            className="w-full bg-gradient-to-r from-green-700 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
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
          <UserMenu
            user={headerUser}
            onNameChange={(name) => setHeaderUser((prev) => (prev ? { ...prev, name } : prev))}
            onAvatarChange={(avatar, hasCustomAvatar) => setHeaderUser((prev) => (prev ? { ...prev, avatar, hasCustomAvatar } : prev))}
          />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <p className="text-gray-600">Show us what you made with your {packagingType}!</p>
        </div>

        {/* Project Info */}
        <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
          <h1 className="font-semibold text-gray-900 mb-1">{projectTitle}</h1>
          <p className="text-sm text-gray-500">Estimated CO2 savings: {estimatedCo2Saved} kg</p>
        </div>

        {/* What is left before this submit — a camera photo for
            points spends one, a gallery check spends none. */}
        {usageLine && (
          <p className={`text-sm text-center mb-6 ${verifyUsage?.remaining === 0 ? 'text-amber-700 font-medium' : 'text-gray-600'}`}>
            {usageLine}
          </p>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* Challenge code: points need a photo taken with the camera
            showing this code on paper beside the project. */}
        {challengeLoading ? (
          <div className="bg-white rounded-2xl shadow-lg p-6 mb-6 text-center">
            <div className="animate-spin w-6 h-6 border-4 border-green-500 border-t-transparent rounded-full mx-auto"></div>
            <p className="text-sm text-gray-500 mt-3">Getting your verification code…</p>
          </div>
        ) : challenge ? (
          <div className="bg-white rounded-2xl shadow-lg p-6 mb-6 text-center">
            <p className="text-sm text-gray-600 mb-2">Your verification code — write it on paper and place it next to your finished project:</p>
            <p className="text-5xl font-mono font-bold tracking-[0.3em] text-gray-900 mb-2">{challenge.code}</p>
            <p className="text-xs text-gray-500 mb-4">Good for 15 minutes. Each retry gets a fresh code.</p>
            <button
              onClick={fetchChallenge}
              disabled={challengeLoading}
              className="text-sm font-medium text-green-700 hover:text-green-700 disabled:opacity-50"
            >
              Get a new code
            </button>
          </div>
        ) : challengeError ? (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-6">
            <p className="text-sm text-red-600">{challengeError}</p>
            <button
              onClick={() => router.push('/dashboard')}
              className="mt-3 w-full bg-white border-2 border-gray-200 hover:border-green-400 text-gray-700 font-semibold py-3 px-4 rounded-xl transition-all duration-200"
            >
              View Dashboard
            </button>
          </div>
        ) : null}

        {/* Photo capture */}
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
          {cameraOpen ? (
            <CameraCapture
              onCapture={handleCameraCapture}
              onCancel={() => setCameraOpen(false)}
              onNoCamera={(message) => {
                setCameraOpen(false);
                setError(message);
              }}
            />
          ) : previewImage ? (
            isVerifying ? (
              // Checking State — same loading-card pattern as the scan
              // page: the check takes ~30s, and a bare button spinner
              // reads as stuck. Steps are timed (see verifyStep), not
              // live server stages.
              <div className="p-8 text-center">
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6 animate-pulse">
                  <svg className="w-10 h-10 text-green-500 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                <h2 className="text-xl font-bold text-gray-900 mb-2">Checking your project...</h2>
                <p className="text-gray-600">{(captureMode === 'points' ? VERIFY_STEPS_POINTS : VERIFY_STEPS_FEEDBACK)[verifyStep]}</p>
                <p className="text-gray-500 text-sm mt-3">This usually takes about 30 seconds.</p>
              </div>
            ) : (
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
                  className="w-full bg-gradient-to-r from-green-700 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 disabled:opacity-50"
                >
                  {isVerifying ? (
                    <span className="flex items-center justify-center">
                      <svg className="animate-spin w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Verifying...
                    </span>
                  ) : captureMode === 'points' ? (
                    'Submit for Points'
                  ) : (
                    'Check if It Matches'
                  )}
                </button>
                <button
                  onClick={() => {
                    setPreviewImage(null);
                    setSelectedFile(null);
                    setCaptureMode(null);
                  }}
                  className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-3 px-4 rounded-xl transition-colors"
                >
                  Take a Different Photo
                </button>
              </div>
            </>
            )
          ) : (
            <div className="p-8 text-center">
              <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-12 h-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Show Your Finished Project</h3>
              <p className="text-gray-600 text-sm mb-6">
                Take a clear photo with the camera — with your code on paper beside the project — to earn points. Or upload a gallery photo to check the match for feedback only.
              </p>
              <button
                onClick={() => setCameraOpen(true)}
                disabled={!challenge || verifyUsage?.remaining === 0}
                className="w-full bg-gradient-to-r from-green-700 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 disabled:opacity-50 mb-3"
              >
                Take a Photo with the Camera
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full bg-white border-2 border-gray-200 hover:border-green-400 text-gray-700 font-semibold py-3 px-4 rounded-xl transition-all duration-200"
              >
                Upload from Gallery (Feedback Only)
              </button>
              <p className="text-xs text-gray-500 mt-3">
                A camera photo for points uses 1 of your daily verifications. Gallery checks are free.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
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
            className="w-full text-sm font-medium text-green-700 hover:text-green-700 disabled:opacity-50 py-1"
          >
            {choosingAgain ? 'Loading ideas…' : 'Choose a different DIY'}
          </button>
        </div>

        {/* Photo privacy disclaimer */}
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-3">
          <p className="text-xs text-amber-800">
            Photo privacy: your photos are stored privately and are only shown inside the app. Your profile photo is visible on the leaderboard. Please avoid photos showing people, personal information, or the inside of your home.
          </p>
        </div>

        {/* Tips */}
        <div className="mt-6 bg-blue-50 rounded-xl p-4">
          <h4 className="font-semibold text-blue-900 mb-2">Tips for verification:</h4>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• Write the code on paper and place it next to your project</li>
            <li>• Show the entire completed project</li>
            <li>• Ensure good lighting</li>
            <li>• Include the original packaging if visible</li>
            <li>• Make sure the project — and the code — are clearly visible</li>
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
