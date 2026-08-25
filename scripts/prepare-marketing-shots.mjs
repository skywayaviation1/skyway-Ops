// Prepares raw preview captures for the marketing booklet.
//
// Captures taken through a browser can include tab/address-bar chrome and, on
// tall viewports, a band of empty page below the content. Both look amateurish
// in a brochure, so each image is trimmed to the application surface only.
// Phone captures are exact-viewport and are passed through untouched.
//
// Usage: node scripts/prepare-marketing-shots.mjs

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const TENANT = process.env.TENANT || 'skyway';

const outDir = path.join(root, 'marketing/shots', TENANT);
mkdirSync(outDir, { recursive: true });

// Python + Pillow does the pixel work; it is already present in the image and
// avoids adding an image dependency to the app's package.json.
const PY = `
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
w, h = im.size
px = im.load()
step = max(1, w // 240)
cols = list(range(0, w, step))

def row_mean(y):
    return sum(sum(px[x, y]) for x in cols) / (len(cols) * 3)

# Browser chrome is light; the product is near-black. Find the first sustained
# dark row in the top 20% and treat everything above it as chrome.
top = 0
for y in range(int(h * 0.20)):
    if row_mean(y) < 60 and all(row_mean(min(y + k, h - 1)) < 70 for k in range(1, 6)):
        top = y
        break

# Trim a uniform tail so a tall capture does not end in dead space.
bottom = h
baseline = row_mean(h - 3)
y = h - 3
while y > top + 200:
    if abs(row_mean(y) - baseline) > 3:
        bottom = min(h, y + 24)
        break
    y -= 1

im.crop((0, top, w, bottom)).save(dst, 'PNG', optimize=True)
print(f"  {dst.split('/')[-1]:26s} {w}x{bottom - top}  (trimmed top={top} bottom={h - bottom})")
`;

const raw2 = (name) => path.join(root, 'marketing/raw2', TENANT, name);
const out = (name) => path.join(outDir, name);

/** Captures that only need chrome/dead-space trimming. */
const TRIM = [
  [raw2('crew-grouped.png'), 'crew-grouped.png'],
  [raw2('dispatch.png'), 'dispatch.png'],
  [raw2('schedule.png'), 'schedule.png'],
  [raw2('broker.png'), 'broker.png'],
  [raw2('flight-board-tv.png'), 'flight-board-tv.png'],
  [raw2('email-open.png'), 'email-open.png'],
  [raw2('teams-channel.png'), 'teams-channel.png'],
  [raw2('accounting-all.png'), 'accounting-all.png'],
];

/** Phone captures: already exactly the device viewport. */
const PHONE = [
  'phone-pilot-home.png',
  'phone-flights.png',
  'phone-trip.png',
  'phone-trip-status.png',
  'phone-trip-pax.png',
  'phone-duty.png',
  'phone-expenses.png',
];

/**
 * Individual cards, captured as elements by the capture script so they arrive at
 * full resolution and exactly the card. A whole-screen capture scaled onto a page
 * loses the type sizes these were designed at.
 */
const CARDS = [
  'on-duty-crews.png',
  'expense-summary.png',
  'duty-report-table.png',
];

console.log(`Preparing shots for tenant: ${TENANT}\n\nTrimming captures:`);
for (const [src, name] of TRIM) {
  if (!existsSync(src)) {
    console.log(`  ${name.padEnd(26)} MISSING (${path.relative(root, src)})`);
    continue;
  }
  process.stdout.write(execFileSync('python3', ['-c', PY, src, out(name)], { encoding: 'utf8' }));
}

console.log('\nPhone captures (passed through):');
for (const name of PHONE) {
  if (!existsSync(raw2(name))) {
    console.log(`  ${name.padEnd(26)} MISSING`);
    continue;
  }
  copyFileSync(raw2(name), out(name));
  console.log(`  ${name.padEnd(26)} copied`);
}

console.log('\nCard captures (passed through):');
for (const name of CARDS) {
  if (!existsSync(raw2(name))) {
    console.log(`  ${name.padEnd(26)} MISSING`);
    continue;
  }
  copyFileSync(raw2(name), out(name));
  console.log(`  ${name.padEnd(26)} copied`);
}
