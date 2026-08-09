#!/usr/bin/env node
/**
 * Builds the Skyway wordmark assets from the supplied artwork.
 *
 * Two problems are solved here.
 *
 * 1. BLACK MATTE
 *    The source art is drawn on an opaque black rectangle, so the logo showed a
 *    visible black box on every surface that was not pure black. Alpha is keyed
 *    from the pixel's brightest channel with a narrow ramp, so anti-aliased
 *    glyph edges stay smooth. The band is picked from the artwork's palette:
 *
 *      background  rgb(0,0,0)      max channel   0  -> transparent
 *      aircraft    rgb(25,61,109)  max channel 109  -> opaque
 *      brand cyan  rgb(9,176,220)  max channel 220  -> opaque
 *
 *    Counters enclosed by letters are removed with the background, which is
 *    correct — they should show whatever the logo is placed on.
 *
 * 2. NAVY INK ON DARK CHROME
 *    "AVIATION", the speed lines and the aircraft are drawn in a dark navy that
 *    only worked because it sat on black. On the graphite app shell it is
 *    effectively invisible. The `-reverse` variants lift that navy to a cool
 *    platinum while leaving the brand cyan untouched, which is the usual
 *    reversed-logo treatment.
 *
 *    Both sets ship: PDF output prints on white and needs the original navy
 *    ink, while the app chrome is dark and needs the reversed set.
 *
 * The pass is idempotent — pixels that already carry partial alpha are treated
 * as processed and left alone — so it is safe to re-run over its own output.
 *
 * Usage: node scripts/build-logo-assets.mjs [--check]
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';

const LO = 12;   // max channel at or below this -> background
const HI = 64;   // max channel at or above this -> artwork

// Green separates the two inks cleanly: cyan sits at 176, navy at 61.
const NAVY_G = 110;  // at or below -> navy ink
const CYAN_G = 150;  // at or above -> brand cyan, never recoloured

// Observed navy luminance range, remapped so the ink reads on dark graphite
// without flattening the aircraft's internal shading.
const NAVY_LUM_MIN = 17;
const NAVY_LUM_MAX = 110;
const LIFT_MIN = 140;
const LIFT_MAX = 226;

const SOURCES = [
  ['public/skyway-logo.png',        'public/skyway-logo-reverse.png'],
  ['public/skyway-logo@2x.png',     'public/skyway-logo-reverse@2x.png'],
  ['public/skyway-logo-nav.png',    'public/skyway-logo-nav-reverse.png'],
  ['public/skyway-logo-nav@2x.png', 'public/skyway-logo-nav-reverse@2x.png'],
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Strips the black matte in place. Returns the parsed PNG. */
function keyOutBlack(buf) {
  const png = PNG.sync.read(buf);
  const { data } = png;
  let cleared = 0;
  let feathered = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a > 0 && a < 255) continue; // already keyed on a previous run

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const m = Math.max(r, g, b);

    if (m <= LO) {
      data[i + 3] = 0;
      cleared += 1;
      continue;
    }
    if (m >= HI) continue;

    const t = (m - LO) / (HI - LO);
    data[i] = Math.min(255, Math.round(r / t));
    data[i + 1] = Math.min(255, Math.round(g / t));
    data[i + 2] = Math.min(255, Math.round(b / t));
    data[i + 3] = Math.round(255 * t);
    feathered += 1;
  }
  return { png, cleared, feathered };
}

/** Lifts navy ink to platinum, leaving cyan alone. Returns a new PNG. */
function reverseNavy(png) {
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  const { data } = out;
  let lifted = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // 0 = navy, 1 = cyan. The ramp between avoids banding on the soft edge
    // where the speed lines fade from cyan into navy.
    const t = clamp((g - NAVY_G) / (CYAN_G - NAVY_G), 0, 1);
    if (t >= 1) continue;

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const scaled = clamp(
      LIFT_MIN + ((lum - NAVY_LUM_MIN) * (LIFT_MAX - LIFT_MIN)) / (NAVY_LUM_MAX - NAVY_LUM_MIN),
      0,
      255,
    );
    // Very slightly cool, to sit with the graphite shell rather than look warm.
    const pr = scaled * 0.97;
    const pg = scaled * 0.985;
    const pb = scaled;

    data[i] = Math.round(pr + (r - pr) * t);
    data[i + 1] = Math.round(pg + (g - pg) * t);
    data[i + 2] = Math.round(pb + (b - pb) * t);
    lifted += 1;
  }
  return { out, lifted };
}

const check = process.argv.includes('--check');
for (const [src, dst] of SOURCES) {
  const { png, cleared, feathered } = keyOutBlack(readFileSync(src));
  const { out, lifted } = reverseNavy(png);
  const total = png.width * png.height;
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
  console.log(
    `${src.replace('public/', '').padEnd(24)} ${String(png.width).padStart(4)}x${String(png.height).padEnd(4)}`
    + ` transparent ${pct(cleared).padStart(6)}`
    + ` feathered ${pct(feathered).padStart(5)}`
    + ` navy-lifted ${pct(lifted).padStart(6)}`,
  );
  if (!check) {
    writeFileSync(src, PNG.sync.write(png));
    writeFileSync(dst, PNG.sync.write(out));
  }
}
console.log(check ? '\n(dry run — nothing written)' : '\nWrote base and -reverse logo assets.');
