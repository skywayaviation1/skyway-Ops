// Prepares raw preview captures for the marketing PDF.
//
// Captures taken through a browser include tab/address-bar chrome and, on tall
// viewports, a band of empty page below the content. Both look amateurish in a
// brochure, so each image is trimmed to the application surface only.
//
// Usage: node scripts/prepare-marketing-shots.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const rawDir = path.join(root, 'marketing/raw');
const outDir = path.join(root, 'marketing/shots');
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

def row_mean(y):
    total = 0
    for x in range(0, w, max(1, w // 240)):
        r, g, b = px[x, y]
        total += r + g + b
    return total / (len(range(0, w, max(1, w // 240))) * 3)

# Browser chrome is light; the product is near-black. Find the first sustained
# dark row in the top 15% and treat everything above it as chrome.
top = 0
limit = int(h * 0.15)
for y in range(limit):
    if row_mean(y) < 60 and all(row_mean(min(y + k, h - 1)) < 70 for k in range(1, 6)):
        top = y
        break

# Trim a uniform dark tail so a tall capture does not end in dead space.
bottom = h
baseline = row_mean(h - 3)
y = h - 3
while y > top + 200:
    if abs(row_mean(y) - baseline) > 3:
        bottom = min(h, y + 24)
        break
    y -= 1

im.crop((0, top, w, bottom)).save(dst, 'PNG', optimize=True)
print(f"{dst} {w}x{bottom - top} (trimmed top={top} bottom={h - bottom})")
`;

// Raw capture -> trimmed working image. The dashboard and boards captures are
// trimmed here and then cropped further by hand into the framed images the PDF
// embeds (fleet-map, flight-board, on-duty), which is why they are listed with
// their intermediate names.
const SHOTS = [
  'dashboard.png',
  'boards.png',
  'email-open.png',
  'teams-channel.png',
  'accounting-all.png',
];

for (const name of SHOTS) {
  const out = execFileSync('python3', ['-c', PY, path.join(rawDir, name), path.join(outDir, name)], {
    encoding: 'utf8',
  });
  process.stdout.write(out);
}
