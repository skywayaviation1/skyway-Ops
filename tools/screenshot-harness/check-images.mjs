/* Verifies every image on the marketing site renders at its natural aspect
 * ratio, and that the width/height attributes match the real file dimensions.
 * A mismatch here is what shows up as a "skewed" screenshot.
 *
 * Usage: node check-images.mjs [url]
 */

import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://localhost:8088/';
const TOLERANCE_PCT = 0.5;

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 180000,
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await page.evaluate(() => {
  document.querySelectorAll('[data-reveal]').forEach((n) => n.classList.add('is-visible'));
  // Force the lazy images to fetch so all of them can be measured.
  document.querySelectorAll('img[loading="lazy"]').forEach((n) => n.setAttribute('loading', 'eager'));
});

// Walk the page so anything viewport-gated settles, then let decoding finish.
const height = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < height; y += 800) {
  await page.evaluate((top) => window.scrollTo(0, top), y);
  await new Promise((r) => setTimeout(r, 120));
}
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 2500));

const rows = await page.evaluate(() => Array.from(document.querySelectorAll('img'))
  .filter((img) => img.naturalWidth > 0 && img.getBoundingClientRect().width > 0)
  .map((img) => {
    const rect = img.getBoundingClientRect();
    const declaredW = Number(img.getAttribute('width')) || null;
    const declaredH = Number(img.getAttribute('height')) || null;
    return {
      file: img.currentSrc.split('/').pop(),
      natural: `${img.naturalWidth}x${img.naturalHeight}`,
      declared: declaredW ? `${declaredW}x${declaredH}` : '—',
      declaredMatches: declaredW ? (declaredW === img.naturalWidth && declaredH === img.naturalHeight) : true,
      skewPct: Number(((((rect.width / rect.height) / (img.naturalWidth / img.naturalHeight)) - 1) * 100).toFixed(2)),
    };
  }));

const skewed = rows.filter((r) => Math.abs(r.skewPct) > TOLERANCE_PCT);
const mismatched = rows.filter((r) => !r.declaredMatches);

console.log(`checked ${rows.length} images at ${url}`);
console.log(`  skewed (rendered ratio ≠ natural): ${skewed.length}`);
console.log(`  attribute/file size mismatches:    ${mismatched.length}`);
if (skewed.length || mismatched.length) {
  console.table([...new Set([...skewed, ...mismatched])]);
} else {
  console.log('OK — every image renders undistorted with accurate dimensions.');
}

await browser.close();
process.exit(skewed.length || mismatched.length ? 1 : 0);
