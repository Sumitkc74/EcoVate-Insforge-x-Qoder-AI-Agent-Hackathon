/**
 * Verification Page
 * 
 * User submits completion photo for DIY project verification.
 * Awards impact points if verified.
 */

'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { auth } from '@/lib/insforge';

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
  }, [searchParams]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        setError('Please select an image file');
        return;
      }
      setSelectedFile(file);
      setPreviewImage(URL.createObjectURL(file));
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
      // Get current user for authentication
      const { data: userData, error: userError } = await auth.getCurrentUser();
      if (userError || !userData?.user) {
        throw new Error('Please log in again');
      }

      const formData = new FormData();
      formData.append('image', selectedFile);
      formData.append('scanId', scanId);
      formData.append('projectTitle', projectTitle);
      formData.append('packagingType', packagingType);
      formData.append('estimatedCo2Saved', String(estimatedCo2Saved));
      formData.append('userId', userData.user.id);

      const response = await fetch('/api/verify', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

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
              <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-10 h-10 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Verification Pending</h1>
              <p className="text-gray-600 mb-6">{result.feedback}</p>
              {result.saved === false && (
                <p className="text-sm text-red-600 mb-6">
                  Your project was not saved to History{result.saveError ? `: ${result.saveError}` : '.'} The database needs a one-time fix before pending projects can save, so please submit again after that fix.
                </p>
              )}
              <p className="text-sm text-gray-500 mb-6">
                Confidence: {Math.round(result.confidence * 100)}% (need 85%+ for automatic approval)
              </p>
            </>
          )}

          {result.saved === false && result.verified && result.confidence >= 0.85 && (
            <p className="text-sm text-red-600 mb-6">
              Your project was verified but was not saved to History{result.saveError ? `: ${result.saveError}` : '.'} The database needs a one-time fix before pending projects can save, so please submit again after that fix.
            </p>
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
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-md mx-auto px-4 py-4">
          <button
            onClick={() => router.back()}
            className="flex items-center text-gray-600 hover:text-gray-900"
          >
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Complete Your Project</h1>
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
