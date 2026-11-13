/**
 * Results Page
 * 
 * Displays scan results with 3 tabs: Product Details, Environmental Impact, DIY Upcycling.
 */

'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { auth, type ScanResult, type DIYIdea } from '@/lib/insforge';
import UserMenu from '@/components/UserMenu';

// Loading fallback
function ResultsLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full"></div>
    </div>
  );
}

// Main results component
function ResultsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<'details' | 'impact' | 'diy'>('details');
  const [scanData, setScanData] = useState<ScanResult | null>(null);
  const [scanId, setScanId] = useState<string>('');
  const [selectedDIY, setSelectedDIY] = useState<DIYIdea | null>(null);
  const [userId, setUserId] = useState<string>('');
  // Signed-in user for the header menu (name + Sign out dropdown).
  const [headerUser, setHeaderUser] = useState<{
    name: string | null;
    email: string | null;
    avatar: string | null;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [apiVersion, setApiVersion] = useState<string>('');
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const [detailWarning, setDetailWarning] = useState<string | null>(null);
  const [visionFallback, setVisionFallback] = useState<string | null>(null);

  useEffect(() => {
    const dataParam = searchParams.get('data');
    const idParam = searchParams.get('scanId');

    if (dataParam) {
      try {
        setScanData(JSON.parse(dataParam));
      } catch (e) {
        console.error('Failed to parse scan data');
      }
    }
    if (idParam) {
      setScanId(idParam);
    }
    setSaveError(searchParams.get('saveError'));
    setApiVersion(searchParams.get('version') || '');
    setImageUploadError(searchParams.get('imageUploadError'));
    setDetailWarning(searchParams.get('detailWarning'));
    setVisionFallback(searchParams.get('visionFallback'));
    // Deep link from History / dashboard "Add DIY": open on the DIY tab.
    if (searchParams.get('tab') === 'diy') {
      setActiveTab('diy');
    }
    // The user id is needed to save a chosen idea (the API takes it
    // in the body — the session lives client-side).
    auth.getCurrentUser().then(({ data }) => {
      if (data?.user) {
        setUserId(data.user.id);
        setHeaderUser({
          name: data.user.profile?.name || null,
          email: data.user.email,
          avatar: data.user.profile?.avatar_url || null,
        });
      }
    }).catch(() => {});
  }, [searchParams]);

  const handleDIYSelect = (diy: DIYIdea) => {
    // Tapping only highlights the idea; the choice is recorded when
    // the user taps Start Project or Upload later, so re-tapping
    // ideas does not create a row per tap.
    setSelectedDIY(diy);
  };

  // Record the chosen idea (with its title, packaging type and CO2
  // estimate) so it can be resumed later from the dashboard or History.
  const logSelection = (diy: DIYIdea) => {
    if (!userId) return;
    fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        scanId,
        actionType: 'diy_selected',
        projectTitle: diy.title,
        packagingType: scanData?.packaging_type,
        estimatedCo2Saved: diy.estimated_co2_saved_kg,
        userId,
      }),
    }).catch(console.error);
  };

  const handleSaveForLater = () => {
    if (selectedDIY) {
      logSelection(selectedDIY);
      router.push('/dashboard');
    }
  };

  const handleStartProject = () => {
    if (selectedDIY && scanData) {
      logSelection(selectedDIY);
      const queryParams = new URLSearchParams({
        scanId,
        projectTitle: selectedDIY.title,
        packagingType: scanData.packaging_type,
        estimatedCo2Saved: String(selectedDIY.estimated_co2_saved_kg),
      });
      router.push(`/verify?${queryParams.toString()}`);
    }
  };

  if (!scanData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600 mb-4">No scan data found</p>
          <button
            onClick={() => router.push('/scan')}
            className="bg-green-500 text-white px-4 py-2 rounded-lg"
          >
            Go Back to Scan
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 pb-20">
      {/* Header: back arrow + page title on the left, signed-in user
          on the right — same nav as Scan and Dashboard. */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <button
              onClick={() => router.push('/scan')}
              aria-label="Back to scan"
              className="p-2 text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="font-bold text-gray-900">Scan Results</span>
          </div>
          <UserMenu user={headerUser} />
        </div>
      </header>

      {/* Product Header */}
      <div className="max-w-md mx-auto px-4 py-6">
        {(saveError || scanId.startsWith('temp_')) && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-6">
            <p className="text-sm font-semibold text-red-700">This scan was not saved to your history.</p>
            {saveError && <p className="text-sm text-red-600 mt-1">{saveError}</p>}
            {apiVersion && <p className="text-xs text-red-500 mt-1">Scan API: {apiVersion}</p>}
          </div>
        )}
        {imageUploadError && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6">
            <p className="text-sm font-semibold text-amber-700">Your photo could not be uploaded, so it won&apos;t show in History.</p>
            <p className="text-sm text-amber-600 mt-1">{imageUploadError}</p>
          </div>
        )}
        {detailWarning && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6">
            <p className="text-sm font-semibold text-amber-700">Double-check the details for this scan.</p>
            <p className="text-sm text-amber-600 mt-1">{detailWarning}</p>
          </div>
        )}
        {visionFallback && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6">
            <p className="text-sm font-semibold text-amber-700">This scan used the on-device reading.</p>
            <p className="text-sm text-amber-600 mt-1">{visionFallback}</p>
          </div>
        )}
        <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
          <h2 className="text-xl font-bold text-gray-900 mb-1">{scanData.product_name}</h2>
          <p className="text-gray-500 capitalize">{scanData.packaging_type}</p>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
          <div className="flex border-b border-gray-200">
            <button
              onClick={() => setActiveTab('details')}
              className={`flex-1 py-4 px-4 text-sm font-medium transition-colors ${
                activeTab === 'details'
                  ? 'text-green-600 border-b-2 border-green-600 bg-green-50'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Details
            </button>
            <button
              onClick={() => setActiveTab('impact')}
              className={`flex-1 py-4 px-4 text-sm font-medium transition-colors ${
                activeTab === 'impact'
                  ? 'text-green-600 border-b-2 border-green-600 bg-green-50'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Impact
            </button>
            <button
              onClick={() => setActiveTab('diy')}
              className={`flex-1 py-4 px-4 text-sm font-medium transition-colors ${
                activeTab === 'diy'
                  ? 'text-green-600 border-b-2 border-green-600 bg-green-50'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              DIY Ideas
            </button>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {activeTab === 'details' && (
              <div className="space-y-6">
                {/* Materials */}
                <div>
                  <h3 className="font-semibold text-gray-900 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    Detected Materials
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {scanData.detected_materials.map((material, idx) => (
                      <span
                        key={idx}
                        className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium"
                      >
                        {material}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Label Text */}
                {scanData.label_text && (
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-3 flex items-center">
                      <svg className="w-5 h-5 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                      </svg>
                      Label Information
                    </h3>
                    <p className="text-gray-600 bg-gray-50 p-3 rounded-lg">{scanData.label_text}</p>
                  </div>
                )}

                {/* Packaging Type */}
                <div>
                  <h3 className="font-semibold text-gray-900 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                    Packaging Type
                  </h3>
                  <p className="text-gray-600 capitalize bg-gray-50 p-3 rounded-lg">{scanData.packaging_type}</p>
                </div>
              </div>
            )}

            {activeTab === 'impact' && (
              <div className="space-y-6">
                {/* Carbon Footprint */}
                <div className="bg-gradient-to-br from-red-50 to-orange-50 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-gray-900">Carbon Footprint</h3>
                    <span className="text-2xl font-bold text-red-600">{scanData.carbon_footprint_kg} kg</span>
                  </div>
                  <p className="text-sm text-gray-600">CO2 equivalent from production</p>
                </div>

                {/* Recyclability Score */}
                <div>
                  <h3 className="font-semibold text-gray-900 mb-3">Recyclability Score</h3>
                  <div className="relative pt-1">
                    <div className="flex mb-2 items-center justify-between">
                      <div>
                        <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full text-green-600 bg-green-200">
                          Score
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-2xl font-bold text-green-600">{scanData.recyclability_score}%</span>
                      </div>
                    </div>
                    <div className="overflow-hidden h-4 mb-4 text-xs flex rounded-full bg-gray-200">
                      <div
                        style={{ width: `${scanData.recyclability_score}%` }}
                        className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-gradient-to-r from-green-400 to-green-600 transition-all duration-500"
                      ></div>
                    </div>
                  </div>
                </div>

                {/* Material Breakdown */}
                <div>
                  <h3 className="font-semibold text-gray-900 mb-3">Material Breakdown</h3>
                  <div className="space-y-3">
                    {scanData.material_breakdown?.map((item, idx) => (
                      <div key={idx} className="flex items-center">
                        <div className="w-24 text-sm text-gray-600">{item.material}</div>
                        <div className="flex-1 mx-3">
                          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              style={{ width: `${item.percentage}%` }}
                              className="h-full bg-blue-500 rounded-full"
                            ></div>
                          </div>
                        </div>
                        <div className="w-12 text-sm font-medium text-gray-900 text-right">{item.percentage}%</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'diy' && (
              <div className="space-y-4">
                <p className="text-gray-600 mb-4">Choose a project to upcycle this packaging:</p>
                
                {scanData.diy_ideas?.map((idea, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleDIYSelect(idea)}
                    className={`border-2 rounded-xl p-4 cursor-pointer transition-all ${
                      selectedDIY?.title === idea.title
                        ? 'border-green-500 bg-green-50'
                        : 'border-gray-200 hover:border-green-300'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h4 className="font-bold text-gray-900">{idea.title}</h4>
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          idea.difficulty === 'easy'
                            ? 'bg-green-100 text-green-700'
                            : idea.difficulty === 'medium'
                            ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {idea.difficulty}
                      </span>
                    </div>
                    
                    <p className="text-sm text-gray-600 mb-3">
                      <span className="font-medium">Materials needed:</span> {idea.materials_needed.join(', ')}
                    </p>
                    
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-green-600 font-medium">
                        Save {idea.estimated_co2_saved_kg} kg CO2
                      </span>
                      {selectedDIY?.title === idea.title && (
                        <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  </div>
                ))}

                {selectedDIY && (
                  <div className="space-y-2 mt-4">
                    <button
                      onClick={handleStartProject}
                      className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 shadow-md"
                    >
                      I&apos;ll do this! Start Project
                    </button>
                    {!scanId.startsWith('temp_') && (
                      <button
                        onClick={handleSaveForLater}
                        className="w-full bg-white border-2 border-gray-200 hover:border-green-400 text-gray-700 font-semibold py-3 px-4 rounded-xl transition-all duration-200"
                      >
                        Upload later
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Main export with suspense boundary
export default function ResultsPage() {
  return (
    <Suspense fallback={<ResultsLoading />}>
      <ResultsContent />
    </Suspense>
  );
}
