/**
 * In-app camera capture for verification photos.
 *
 * Points require a photo taken live through the camera — not a file
 * picked from the gallery — so the completion photo is evidence
 * captured for this submission. If the device has no camera, or the
 * user denies access, the parent shows the gallery-feedback path
 * instead (match check only, no points).
 */

'use client';

import { useEffect, useRef, useState } from 'react';

export default function CameraCapture({
  onCapture,
  onCancel,
  onNoCamera,
}: {
  onCapture: (file: File) => void;
  onCancel: () => void;
  onNoCamera: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        // Prefer the rear camera on phones; fall back to any camera
        // (desktops have no 'environment' camera).
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStarting(false);
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera access was denied. You can still check a gallery photo for feedback, but points need a camera photo.'
            : 'No camera is available on this device. You can still check a gallery photo for feedback, but points need a camera photo.';
        setError(message);
        onNoCamera(message);
      }
    }
    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // onNoCamera is stable from the parent (a setState wrapper); run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCapture = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      onCapture(new File([blob], 'camera-photo.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  };

  const handleCancel = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    onCancel();
  };

  if (error) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-gray-700">{error}</p>
        <button
          onClick={handleCancel}
          className="mt-4 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-3 px-4 rounded-xl transition-colors"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="relative bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          className="w-full aspect-square object-cover"
        />
        {starting && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="animate-spin w-8 h-8 border-4 border-white border-t-transparent rounded-full"></div>
          </div>
        )}
      </div>
      <div className="p-4 space-y-3">
        <button
          onClick={handleCapture}
          disabled={starting}
          className="w-full bg-gradient-to-r from-green-700 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 disabled:opacity-50"
        >
          Take Photo
        </button>
        <button
          onClick={handleCancel}
          className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-3 px-4 rounded-xl transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
