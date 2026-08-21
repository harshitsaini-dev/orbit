/** The stored avatar is a square of this size; anything larger is wasted bytes. */
export const AVATAR_SIZE = 192;
export const AVATAR_MAX_BYTES = 256 * 1024;

/**
 * Downscales and crops a picked image to a square data URL, in the browser.
 *
 * Doing it client-side matters: a phone photo is several megabytes, and the
 * server cap would simply reject it. Resizing here means the user picks any
 * photo and it works, rather than being told their picture is too big.
 */
export async function toAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('That file is not an image.');
  }

  const bitmap = await createImageBitmap(file);

  try {
    // Centre-crop to a square first, so a portrait photo is not squashed.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process that image.');

    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    // JPEG rather than PNG: a photograph as PNG is many times larger for no
    // visible gain at this size. Quality steps down until it fits the cap.
    for (const quality of [0.86, 0.72, 0.6, 0.45]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (byteLengthOfDataUrl(dataUrl) <= AVATAR_MAX_BYTES) return dataUrl;
    }

    throw new Error('That image could not be reduced enough. Try a smaller one.');
  } finally {
    bitmap.close();
  }
}

/** Base64 encodes three bytes per four characters; padding is not data. */
export function byteLengthOfDataUrl(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}
