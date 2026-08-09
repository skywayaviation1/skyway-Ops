import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeFrameReadiness,
  autoCapturePrompt,
  frameDifference,
} from '../src/id-auto-capture.js';

function image(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test('flat preview is not considered a readable document', () => {
  const result = analyzeFrameReadiness(image(80, 50, () => 140));
  assert.equal(result.readable, false);
  assert.equal(result.reason, 'no-document');
});

test('dark and overexposed frames produce actionable prompts', () => {
  assert.equal(analyzeFrameReadiness(image(80, 50, () => 5)).reason, 'too-dark');
  assert.equal(analyzeFrameReadiness(image(80, 50, () => 252)).reason, 'glare');
  assert.equal(autoCapturePrompt('too-dark'), 'More light needed');
  assert.equal(autoCapturePrompt('glare'), 'Reduce glare');
});

test('sharp contrasted ID-like frame is eligible for auto capture', () => {
  const result = analyzeFrameReadiness(image(120, 75, (x, y) => (
    ((Math.floor(x / 5) + Math.floor(y / 4)) % 2) ? 205 : 55
  )));
  assert.equal(result.readable, true);
  assert.ok(result.contrast >= 28);
  assert.ok(result.sharpness >= 10);
});

test('frame difference identifies a steady camera preview', () => {
  const a = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
  const b = Uint8Array.from([12, 22, 32, 42, 52, 62, 72, 82]);
  const moving = Uint8Array.from([80, 70, 60, 50, 40, 30, 20, 10]);
  assert.equal(frameDifference(a, b), 2);
  assert.ok(frameDifference(a, moving) > 8);
  assert.equal(frameDifference(null, b), Infinity);
});

test('stable-frame prompt tells the user to hold still', () => {
  assert.equal(autoCapturePrompt('readable', 1), 'Document found — hold still');
  assert.equal(autoCapturePrompt('readable', 2), 'Hold still…');
});
