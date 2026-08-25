/**
 * Builds the Elite Jets wordmark assets.
 *
 * The lockup is drawn as vector art and rasterised by the same headless browser
 * used for the marketing captures, so the output is crisp at 2x and can be
 * regenerated rather than being an opaque binary in the repo.
 *
 * Four files per density, matching what src/brand.js declares and ui.jsx loads:
 *
 *   elite-logo              stacked lockup, dark ink   (light surfaces)
 *   elite-logo-reverse      stacked lockup, light ink  (dark app shell)
 *   elite-logo-nav          compact strip, dark ink
 *   elite-logo-nav-reverse  compact strip, light ink
 *
 * Usage: node scripts/build-elite-logo.mjs
 */

import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'public');

const GOLD = '#B8912F';

/**
 * The check mark, drawn as a tapered brush stroke.
 *
 * Outline order: the short arm's upper edge down to the inner corner, up the
 * long arm's upper edge to its point, back down its lower edge to the outer
 * vertex, then back along the short arm's lower edge. Both ends taper, which is
 * what gives it the painted look rather than a geometric tick.
 */
const CHECK = `
<svg viewBox="0 0 180 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path fill="${GOLD}" d="
    M 2 26
    C 24 30 52 44 74 62
    L 176 2
    C 146 26 116 56 92 92
    C 68 66 34 40 6 34
    Z
  "/>
</svg>`;

/** One lockup, as a full HTML document ready to screenshot. */
function lockup({ ink, compact }) {
  const gap = compact ? 26 : 30;
  const checkW = compact ? 132 : 150;
  const eliteSize = compact ? 62 : 72;
  const jetsSize = compact ? 30 : 36;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: transparent; }
  body { display: inline-block; padding: ${compact ? 6 : 10}px; }
  .lockup { display: flex; align-items: center; gap: ${gap}px; }
  .check { width: ${checkW}px; flex: none; }
  .check svg { display: block; width: 100%; height: auto; }
  .words { display: flex; flex-direction: column; align-items: flex-end; }
  .elite {
    font-family: 'Liberation Serif', 'DejaVu Serif', serif;
    font-size: ${eliteSize}px;
    line-height: 0.96;
    letter-spacing: ${eliteSize * 0.17}px;
    /* The tracking adds space after the final letter too; pull it back so the
       lockup is optically centred rather than sitting left of its box. */
    margin-right: -${eliteSize * 0.17}px;
    color: ${ink};
  }
  .jets {
    font-family: Inter, 'DejaVu Sans', sans-serif;
    font-weight: 300;
    font-size: ${jetsSize}px;
    line-height: 1;
    letter-spacing: ${jetsSize * 0.06}px;
    margin-top: ${jetsSize * 0.22}px;
    margin-right: ${jetsSize * 0.08}px;
    color: ${ink};
  }
</style></head>
<body>
  <div class="lockup">
    <div class="check">${CHECK}</div>
    <div class="words">
      <div class="elite">ELITE</div>
      <div class="jets">jets</div>
    </div>
  </div>
</body></html>`;
}

const VARIANTS = [
  { file: 'elite-logo', ink: '#111315', compact: false },
  { file: 'elite-logo-reverse', ink: '#F2F3F4', compact: false },
  { file: 'elite-logo-nav', ink: '#111315', compact: true },
  { file: 'elite-logo-nav-reverse', ink: '#F2F3F4', compact: true },
];

const browser = await chromium.launch();

for (const variant of VARIANTS) {
  for (const density of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 900, height: 320 },
      deviceScaleFactor: density,
    });
    const page = await context.newPage();
    await page.setContent(lockup(variant), { waitUntil: 'load' });
    await page.waitForTimeout(200);

    const target = page.locator('.lockup');
    const suffix = density === 2 ? '@2x' : '';
    const file = path.join(outDir, `${variant.file}${suffix}.png`);
    await target.screenshot({ path: file, omitBackground: true });
    console.log(`  ${path.relative(root, file)}`);
    await context.close();
  }
}

await browser.close();
console.log('\nElite Jets wordmark assets written to public/.');
