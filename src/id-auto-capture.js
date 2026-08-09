// Cheap, client-side camera readiness checks for ID auto-shutter. This does
// not attempt identity extraction; it only verifies that the guide region is
// exposed, contrasted and sharp enough to send to the existing OCR pipeline.

export function analyzeFrameReadiness(imageData) {
  const { data, width, height } = imageData || {};
  if (!data || !width || !height) {
    return { readable: false, reason: 'waiting', score: 0, pixels: null };
  }

  const pixels = new Uint8Array(width * height);
  let sum = 0;
  let sumSq = 0;
  let clipped = 0;
  let gradient = 0;
  let gradientSamples = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const i = p * 4;
      const lum = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      pixels[p] = lum;
      sum += lum;
      sumSq += lum * lum;
      if (lum < 16 || lum > 245) clipped += 1;
      if (x > 0) {
        gradient += Math.abs(lum - pixels[p - 1]);
        gradientSamples += 1;
      }
      if (y > 0) {
        gradient += Math.abs(lum - pixels[p - width]);
        gradientSamples += 1;
      }
    }
  }

  const count = pixels.length;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  const contrast = Math.sqrt(variance);
  const sharpness = gradientSamples ? gradient / gradientSamples : 0;
  const clippedRatio = clipped / count;

  const exposureOk = mean >= 42 && mean <= 218 && clippedRatio < 0.48;
  const contrastOk = contrast >= 28;
  const sharpnessOk = sharpness >= 10;
  const readable = exposureOk && contrastOk && sharpnessOk;
  const score = Math.min(1, (
    Math.min(1, contrast / 48) * 0.45
    + Math.min(1, sharpness / 20) * 0.45
    + (exposureOk ? 0.1 : 0)
  ));
  const reason = !exposureOk ? (mean < 42 ? 'too-dark' : 'glare')
    : !contrastOk ? 'no-document'
      : !sharpnessOk ? 'blurry'
        : 'readable';

  return {
    readable,
    reason,
    score,
    mean,
    contrast,
    sharpness,
    clippedRatio,
    pixels,
  };
}

export function frameDifference(previous, current) {
  if (!previous || !current || previous.length !== current.length || previous.length === 0) {
    return Infinity;
  }
  let difference = 0;
  // Sampling every fourth pixel is enough to detect camera/document motion
  // while keeping this inexpensive on older iPhones.
  let samples = 0;
  for (let i = 0; i < current.length; i += 4) {
    difference += Math.abs(current[i] - previous[i]);
    samples += 1;
  }
  return samples ? difference / samples : Infinity;
}

export function autoCapturePrompt(reason, stableFrames = 0) {
  if (stableFrames > 0) return stableFrames >= 2 ? 'Hold still…' : 'Document found — hold still';
  return {
    waiting: 'Starting camera…',
    'too-dark': 'More light needed',
    glare: 'Reduce glare',
    'no-document': 'Align the ID inside the frame',
    blurry: 'Move closer and hold steady',
    readable: 'Hold still…',
  }[reason] || 'Align the ID inside the frame';
}
