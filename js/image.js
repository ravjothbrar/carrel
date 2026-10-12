// Images: downscale to about 512 px JPEG. Redrawing through a canvas also drops EXIF (location,
// camera, timestamps), so the stored copy carries no hidden metadata.

import { LIMITS } from './config.js';

export class ImageError extends Error {}

function loadElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImageError('That file could not be read as an image.'));
    };
    img.src = url;
  });
}

/** @returns {Promise<{blob: Blob, width: number, height: number}>} */
export async function downscaleToJpeg(file, { maxSide = LIMITS.imageMaxSide, quality = LIMITS.imageJpegQuality } = {}) {
  if (file.size > LIMITS.maxImageBytes) throw new ImageError(`${file.name} is larger than ${Math.round(LIMITS.maxImageBytes / 1e6)} MB.`);
  const img = await loadElement(file);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new ImageError(`${file.name} has no size, so it cannot be used.`);
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no alpha
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new ImageError(`${file.name} could not be converted.`);
  return { blob, width, height };
}

export function captionFromFilename(name) {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
