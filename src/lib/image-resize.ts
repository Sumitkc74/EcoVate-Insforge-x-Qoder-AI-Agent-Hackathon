/**
 * Downscale a photo before it is sent anywhere.
 *
 * Phone photos are often 3000–4000px on a side, several megabytes —
 * sent as base64 they approach Vercel's 4.5MB function limit and
 * make every vision call slower. A 1024px longest side is plenty
 * for label reading, shape detection and the AI vision calls, and
 * shrinks a typical photo to a few hundred kilobytes.
 *
 * Returns the original file unchanged when it is already small
 * enough or cannot be decoded (e.g. an unsupported format) — the
 * caller never has to handle a failure here.
 */

export const MAX_PHOTO_DIMENSION = 1024;

export async function downscaleImageFile(file: File, maxDimension = MAX_PHOTO_DIMENSION): Promise<File> {
  try {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not decode image'));
        image.src = url;
      });
      const { naturalWidth: w, naturalHeight: h } = img;
      const longest = Math.max(w, h);
      if (longest <= maxDimension) return file;
      const scale = maxDimension / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.85),
      );
      if (!blob) return file;
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {
        type: 'image/jpeg',
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return file;
  }
}
