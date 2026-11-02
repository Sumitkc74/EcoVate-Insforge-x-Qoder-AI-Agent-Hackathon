/**
 * Scan Page
 * 
 * Camera capture and image upload for product packaging analysis.
 */

'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/insforge';

export default function ScanPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Manual details: the free-plan path. When product name + packaging type
  // are both filled in, the scan skips AI vision entirely.
  const [productName, setProductName] = useState('');
  const [packagingType, setPackagingType] = useState('');
  const [materialsText, setMaterialsText] = useState('');
  // Image-to-text (OCR): free, runs on the device with Tesseract.js.
  // No paid AI, no API key, and the image is never sent to an AI
  // gateway for this step. The extracted text is shown for the user
  // to check, and it is sent as the scan's label text.
  const [ocrText, setOcrText] = useState('');
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  // Handle file selection
  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        setError('Please select an image file');
        return;
      }
      setSelectedFile(file);
      setPreviewImage(URL.createObjectURL(file));
      setError(null);
      setOcrText('');
      setOcrError(null);
    }
  }, []);

  // Store stream in a ref so we can access it immediately
  const streamRef = useRef<MediaStream | null>(null);

  // Start camera
  const startCamera = useCallback(async () => {
    try {
      // Check if mediaDevices is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('Camera not supported in this browser. Please use file upload instead.');
        return;
      }

      setCameraLoading(true);
      setError(null);

      // Try simple constraints first for maximum compatibility
      let stream: MediaStream;
      try {
        // First try with environment camera (back camera on mobile)
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
      } catch (err) {
        // Fallback to any camera
        console.log('Falling back to any camera');
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      }
      
      streamRef.current = stream;
      setShowCamera(true);
      setCameraLoading(false);
    } catch (err) {
      console.error('Camera error:', err);
      setCameraLoading(false);
      
      // Provide specific error messages
      const errorMsg = (err as Error).name;
      if (errorMsg === 'NotAllowedError' || errorMsg === 'PermissionDeniedError') {
        setError('Camera permission denied. Please allow camera access in your browser settings and try again.');
      } else if (errorMsg === 'NotFoundError' || errorMsg === 'DevicesNotFoundError') {
        setError('No camera found. Please use file upload instead.');
      } else if (errorMsg === 'NotReadableError' || errorMsg === 'TrackStartError') {
        setError('Camera is already in use by another application. Please close other apps using the camera.');
      } else {
        setError('Could not access camera: ' + (err as Error).message);
      }
    }
  }, []);

  // Capture photo from camera
  const capturePhoto = useCallback(() => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) {
            const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' });
            setSelectedFile(file);
            setPreviewImage(URL.createObjectURL(file));
            setShowCamera(false);
            // Stop camera stream
            if (streamRef.current) {
              streamRef.current.getTracks().forEach(track => track.stop());
              streamRef.current = null;
            }
          }
        }, 'image/jpeg');
      }
    }
  }, []);

  // Read the text printed on the packaging (OCR). This is the
  // image-to-text step that replaces the paid Vision AI call: it
  // runs entirely in the browser, suggests a packaging type and
  // materials only when those fields are still empty, and never
  // overwrites anything the user already typed.
  const handleReadText = useCallback(async () => {
    if (!previewImage) {
      setOcrError('Please select or capture an image first');
      return;
    }
    setIsOcrRunning(true);
    setOcrError(null);
    try {
      // Dynamic import so the OCR worker code is only loaded when
      // the user asks for it, and never during server rendering.
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      try {
        const { data } = await worker.recognize(previewImage);
        const text = (data.text || '').trim();
        setOcrText(text);
        if (!text) {
          setOcrError('No readable text found on this image. You can still enter the details yourself below.');
          return;
        }
        const lower = text.toLowerCase();
        // Suggest a packaging type from the printed text, if unset.
        if (!packagingType) {
          const packagingWords = ['bottle', 'jar', 'can', 'box', 'bag', 'carton', 'wrapper', 'container'];
          const foundPackaging = packagingWords.find((word) => new RegExp(`\\b${word}\\b`).test(lower));
          if (foundPackaging) {
            setPackagingType(foundPackaging);
          }
        }
        // Suggest materials from the printed text, if unset.
        if (!materialsText.trim()) {
          const materialWords: Array<[RegExp, string]> = [
            [/\bpet\b|polyethylene terephthalate/, 'PET plastic'],
            [/\bhdpe\b|high-density polyethylene/, 'HDPE plastic'],
            [/\bglass\b/, 'glass'],
            [/\balumin(i)?um\b/, 'aluminum'],
            [/\bsteel\b/, 'steel'],
            [/\bcardboard\b/, 'cardboard'],
            [/\bpaper\b/, 'paper'],
            [/\bplastic\b/, 'mixed plastic'],
          ];
          const foundMaterials = materialWords
            .filter(([pattern]) => pattern.test(lower))
            .map(([, material]) => material);
          if (foundMaterials.length > 0) {
            setMaterialsText(foundMaterials.join(', '));
          }
        }
      } finally {
        await worker.terminate();
      }
    } catch (err) {
      console.error('OCR error:', err);
      setOcrError('Could not read text from this image. Please try again or enter the details yourself below.');
    } finally {
      setIsOcrRunning(false);
    }
  }, [previewImage, packagingType, materialsText]);

  // Submit scan
  const handleScan = useCallback(async () => {
    if (!selectedFile) {
      setError('Please select or capture an image first');
      return;
    }

    setIsScanning(true);
    setError(null);

    try {
      // Get current user for authentication
      const { data: userData, error: userError } = await auth.getCurrentUser();
      if (userError || !userData?.user) {
        throw new Error('Please log in again');
      }

      // Convert file to base64 for the API
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64 = reader.result as string;
          resolve(base64);
        };
      });
      reader.readAsDataURL(selectedFile);
      const base64Image = await base64Promise;

      // Call the scan API with user ID. Manual details are sent only when
      // both product name and packaging type are filled in; otherwise the
      // server tries AI vision first.
      const manualReady = productName.trim() !== '' && packagingType !== '';
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: base64Image,
          userId: userData.user.id,
          // Needed so the server can create the public.users row that
          // scans.user_id references; without it the scan insert fails
          // on the foreign key and history stays empty.
          userEmail: userData.user.email,
          userName: (userData.user as { profile?: { name?: string } }).profile?.name,
          userAvatar: (userData.user as { profile?: { avatar_url?: string } }).profile?.avatar_url,
          ...(manualReady ? {
            product_name: productName.trim(),
            packaging_type: packagingType,
            materials: materialsText.split(',').map((m) => m.trim()).filter(Boolean),
            // Text read from the image by the free OCR step, shown
            // on the results page as the scan's label text.
            ...(ocrText.trim() ? { label_text: ocrText.trim() } : {}),
          } : {}),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || (result.errors ? result.errors.join('; ') : 'Scan failed'));
      }

      // Navigate to results page with scan data. Pass the save
      // diagnostic through when the scan was not saved, so the results
      // page can show the real database error instead of a false
      // "saved" impression.
      const queryParams = new URLSearchParams({
        scanId: result.scanId || '',
        data: JSON.stringify(result.data),
        ...(result.saveError ? {
          saveError: result.saveError,
          version: result.version || '',
          scanSaved: String(result.scanSaved ?? false),
        } : {}),
      });
      
      router.push(`/results?${queryParams.toString()}`);
    } catch (err) {
      setError((err as Error).message);
      setIsScanning(false);
    }
  }, [selectedFile, router, productName, packagingType, materialsText, ocrText]);

  // Reset selection
  const handleReset = useCallback(() => {
    setPreviewImage(null);
    setSelectedFile(null);
    setError(null);
    setProductName('');
    setPackagingType('');
    setMaterialsText('');
    setOcrText('');
    setOcrError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Handle video stream attachment when camera is shown
  useEffect(() => {
    if (showCamera && videoRef.current && streamRef.current) {
      // Attach stream to video element
      videoRef.current.srcObject = streamRef.current;
      
      // Play the video
      videoRef.current.play().catch(err => {
        console.error('Video play failed:', err);
      });
    }
  }, [showCamera]);

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      // Stop all tracks when component unmounts
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-gradient-to-br from-green-500 to-emerald-600 rounded-lg flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <span className="font-bold text-gray-900">Ecovate</span>
          </div>
          <a href="/dashboard" className="text-sm text-green-600 hover:text-green-700 font-medium">
            Dashboard
          </a>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto px-4 py-8">
        {isScanning ? (
          // Loading State
          <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6 animate-pulse">
              <svg className="w-10 h-10 text-green-500 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">Analyzing your product...</h2>
            <p className="text-gray-600">Our AI agents are examining the packaging materials and generating upcycling ideas.</p>
          </div>
        ) : showCamera ? (
          // Camera View
          <div className="bg-black rounded-2xl overflow-hidden shadow-lg">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              controls={false}
              className="w-full aspect-[3/4] object-cover"
              style={{ transform: 'scaleX(1)' }}
            />
            <div className="p-4 flex justify-center space-x-4 bg-gray-900">
              <button
                onClick={capturePhoto}
                className="w-16 h-16 bg-white rounded-full border-4 border-gray-300 flex items-center justify-center hover:bg-gray-100 transition-colors"
              >
                <div className="w-12 h-12 bg-green-500 rounded-full"></div>
              </button>
              <button
                onClick={() => {
                  if (streamRef.current) {
                    streamRef.current.getTracks().forEach(track => track.stop());
                    streamRef.current = null;
                  }
                  setShowCamera(false);
                }}
                className="px-4 py-2 text-white hover:text-gray-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : previewImage ? (
          // Preview State
          <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
            <img
              src={previewImage}
              alt="Preview"
              className="w-full aspect-square object-cover"
            />
            <div className="p-4 space-y-3">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-sm text-red-600">{error}</p>
                  <p className="text-sm text-red-600 mt-1">AI vision is unavailable on the free plan. Fill in the product name and packaging type below, then tap Analyze Product again — that path needs no AI vision.</p>
                </div>
              )}
              <div className="space-y-3 border border-gray-200 rounded-xl p-3">
                <p className="text-sm font-semibold text-gray-900">Step 1: Read the text on the packaging (free)</p>
                <p className="text-xs text-gray-500">This reads the printed text from your photo on your device — no paid AI, no API key. It may suggest a packaging type and materials below, which you can correct.</p>
                <button
                  onClick={handleReadText}
                  disabled={isOcrRunning}
                  className="w-full bg-white border border-green-500 hover:bg-green-50 disabled:opacity-50 text-green-700 font-medium py-2 px-4 rounded-xl transition-colors"
                >
                  {isOcrRunning ? 'Reading text…' : 'Read text from image'}
                </button>
                {ocrError && (
                  <p className="text-sm text-red-600">{ocrError}</p>
                )}
                {ocrText && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-gray-700">Text found on the image (you can edit it)</p>
                    <textarea
                      value={ocrText}
                      onChange={(e) => setOcrText(e.target.value)}
                      rows={4}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                )}
              </div>
              <div className="space-y-3 border border-gray-200 rounded-xl p-3">
                <p className="text-sm font-semibold text-gray-900">Step 2: Enter the details yourself (no AI needed)</p>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="Product name, e.g. Water bottle"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
                <select
                  value={packagingType}
                  onChange={(e) => setPackagingType(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">Packaging type</option>
                  <option value="bottle">Bottle</option>
                  <option value="box">Box</option>
                  <option value="bag">Bag</option>
                  <option value="jar">Jar</option>
                  <option value="can">Can</option>
                  <option value="wrapper">Wrapper</option>
                  <option value="container">Container</option>
                  <option value="carton">Carton</option>
                </select>
                <input
                  type="text"
                  value={materialsText}
                  onChange={(e) => setMaterialsText(e.target.value)}
                  placeholder="Materials, comma separated, e.g. plastic, paper"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
                <p className="text-xs text-gray-500">With a product name and packaging type filled in, the scan skips AI vision and still gives impact and DIY ideas.</p>
              </div>
              <button
                onClick={handleScan}
                className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 shadow-md hover:shadow-lg"
              >
                Analyze Product
              </button>
              <button
                onClick={handleReset}
                className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-3 px-4 rounded-xl transition-colors"
              >
                Take Another Photo
              </button>
            </div>
          </div>
        ) : (
          // Initial State
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Scan Product Packaging</h1>
              <p className="text-gray-600">Take a photo of any product to get upcycling ideas</p>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            {/* Camera Button */}
            <button
              onClick={startCamera}
              disabled={cameraLoading}
              className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-4 px-6 rounded-2xl transition-all duration-200 shadow-md hover:shadow-lg flex items-center justify-center space-x-3"
            >
              {cameraLoading ? (
                <>
                  <svg className="animate-spin w-6 h-6" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>Opening Camera...</span>
                </>
              ) : (
                <>
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span>Open Camera</span>
                </>
              )}
            </button>

            {/* Upload Button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full bg-white border-2 border-gray-200 hover:border-green-400 text-gray-700 font-semibold py-4 px-6 rounded-2xl transition-all duration-200 flex items-center justify-center space-x-3"
            >
              <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span>Upload from Gallery</span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Tips */}
            <div className="bg-blue-50 rounded-xl p-4">
              <h3 className="font-semibold text-blue-900 mb-2 flex items-center">
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Tips for best results
              </h3>
              <ul className="text-sm text-blue-800 space-y-1">
                <li>• Ensure good lighting</li>
                <li>• Capture the entire packaging</li>
                <li>• Include any recycling labels</li>
                <li>• Keep the image in focus</li>
              </ul>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
