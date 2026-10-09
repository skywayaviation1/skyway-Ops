#!/usr/bin/env node
/**
 * Builds the Skyway wordmark, icon, and splash assets from the master lockup.
 *
 * The master (brand/skyway-logo-master.png) is the stacked mark Jake sent:
 * cyan SKYWAY, a white jet through the word, white AVIATION, transparent
 * background. No speed lines and no tagline. Pixels are copied through;
 * nothing is recolored.
 *
 * The white ink only reads on a dark surface, so two derivatives ship:
 *
 *   transparent  cyan + white, real alpha. Dark headers, boot splash, email
 *                bands that are already black. These are the `-reverse` files
 *                the app chrome loads.
 *   plated       the same mark composited on the app's dark plate (#0A0B0D).
 *                Light theme, PDFs, and any white page. These are the base
 *                skyway-logo / skyway-logo-nav files.
 *
 * The full lockup is too wide to read inside a square favicon, so app icons
 * use a crop of the jet crossing SKYWAY, on the same dark plate. Launch
 * images use the full lockup. Re-run after replacing the master.
 *
 * Usage: node scripts/build-logo-assets.mjs
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const MASTER = path.join(root, 'brand/skyway-logo-master.png');

// App shell / manifest background. The mark's white ink is drawn for this.
const PLATE = [0x0a, 0x0b, 0x0d];

const readPng = (file) => PNG.sync.read(readFileSync(file));
const writePng = (file, png) => {
  writeFileSync(file, PNG.sync.write(png));
  console.log(`  ${path.relative(root, file)}  ${png.width}x${png.height}`);
};

/**
 * The part of the master that still reads inside a square icon: the white
 * jet where it crosses the cyan SKYWAY letters, stopping above AVIATION.
 * Fractions are of the current master (2222×490).
 */
function iconMark(src) {
  const x0 = Math.round(src.width * 0.655);
  const x1 = Math.round(src.width * 0.905);
  const y1 = Math.round(src.height * 0.71);
  const w = x1 - x0;
  const out = new PNG({ width: w, height: y1 });
  for (let y = 0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * src.width + (x + x0)) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** Opaque dark plate. Partial ink is composited over the plate. */
function plateOf(src, bg = PLATE) {
  const out = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3] / 255;
    out.data[i] = Math.round(src.data[i] * a + bg[0] * (1 - a));
    out.data[i + 1] = Math.round(src.data[i + 1] * a + bg[1] * (1 - a));
    out.data[i + 2] = Math.round(src.data[i + 2] * a + bg[2] * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

/** Area-average downscale. Premultiplied so translucent edges stay clean. */
function resize(src, dw, dh) {
  if (src.width === dw && src.height === dh) return src;
  const out = new PNG({ width: dw, height: dh });
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < dh; y++) {
    const y0 = (y * sh) / dh;
    const y1 = ((y + 1) * sh) / dh;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let x = 0; x < dw; x++) {
      const x0 = (x * sw) / dw;
      const x1 = ((x + 1) * sw) / dw;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw - 1, Math.ceil(x1) - 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let yy = iy0; yy <= iy1; yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = ix0; xx <= ix1; xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          const w = wx * wy;
          const i = (yy * sw + xx) * 4;
          const pa = src.data[i + 3] / 255;
          r += src.data[i] * pa * w;
          g += src.data[i + 1] * pa * w;
          b += src.data[i + 2] * pa * w;
          a += pa * w;
          wsum += w;
        }
      }
      const i = (y * dw + x) * 4;
      const A = wsum > 0 ? a / wsum : 0;
      out.data[i + 3] = Math.round(Math.max(0, Math.min(1, A)) * 255);
      if (A > 0) {
        out.data[i] = Math.round(Math.max(0, Math.min(255, r / wsum / A)));
        out.data[i + 1] = Math.round(Math.max(0, Math.min(255, g / wsum / A)));
        out.data[i + 2] = Math.round(Math.max(0, Math.min(255, b / wsum / A)));
      }
    }
  }
  return out;
}

function newCanvas(w, h, bg) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    if (bg) {
      png.data[i] = bg[0];
      png.data[i + 1] = bg[1];
      png.data[i + 2] = bg[2];
      png.data[i + 3] = 255;
    } else {
      png.data[i + 3] = 0;
    }
  }
  return png;
}

function composite(dst, src, dx, dy) {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(dst.width, dx + src.width);
  const y1 = Math.min(dst.height, dy + src.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const si = ((y - dy) * src.width + (x - dx)) * 4;
      const a = src.data[si + 3] / 255;
      if (a <= 0) continue;
      const di = (y * dst.width + x) * 4;
      const da = dst.data[di + 3] / 255;
      const outA = a + da * (1 - a);
      dst.data[di] = Math.round((src.data[si] * a + dst.data[di] * da * (1 - a)) / outA);
      dst.data[di + 1] = Math.round((src.data[si + 1] * a + dst.data[di + 1] * da * (1 - a)) / outA);
      dst.data[di + 2] = Math.round((src.data[si + 2] * a + dst.data[di + 2] * da * (1 - a)) / outA);
      dst.data[di + 3] = Math.round(outA * 255);
    }
  }
}

/** Fits the lockup in the canvas and centers it. `widthRatio` is of the canvas width. */
function centeredMark(w, h, logo, { widthRatio, bg }) {
  const canvas = newCanvas(w, h, bg);
  const aspect = logo.width / logo.height;
  let lw = Math.round(w * widthRatio);
  let lh = Math.round(lw / aspect);
  const maxH = Math.round(h * 0.72);
  if (lh > maxH) {
    lh = maxH;
    lw = Math.round(lh * aspect);
  }
  lw = Math.max(1, Math.min(lw, w));
  lh = Math.max(1, Math.min(lh, h));
  const scaled = resize(logo, lw, lh);
  composite(canvas, scaled, Math.round((w - lw) / 2), Math.round((h - lh) / 2));
  return canvas;
}

function maskRounded(png, radius) {
  const { width: w, height: h, data } = png;
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx = 0;
      let dy = 0;
      if (x < r) dx = r - x - 0.5;
      else if (x >= w - r) dx = x - (w - r) + 0.5;
      if (y < r) dy = r - y - 0.5;
      else if (y >= h - r) dy = y - (h - r) + 0.5;
      if (dx === 0 && dy === 0) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * w + x) * 4;
      if (dist > r + 0.6) data[i + 3] = 0;
      else if (dist > r - 0.6) data[i + 3] = Math.round(data[i + 3] * Math.max(0, Math.min(1, r + 0.6 - dist)));
    }
  }
  return png;
}

function maskCircle(png) {
  const { width: w, height: h, data } = png;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const rad = Math.min(w, h) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const i = (y * w + x) * 4;
      if (dist > rad + 0.6) data[i + 3] = 0;
      else if (dist > rad - 0.6) data[i + 3] = Math.round(data[i + 3] * Math.max(0, Math.min(1, rad + 0.6 - dist)));
    }
  }
  return png;
}

function walkPngs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkPngs(full, acc);
    else if (name.endsWith('.png')) acc.push(full);
  }
  return acc;
}

const master = readPng(MASTER);
// The master is already cyan + white with real alpha. Do not recolor it.
const transparent = master;
const plated = plateOf(transparent);
const mark = iconMark(transparent);

// Keep the master's aspect (2222×490). The old 600×152 / 250×63 boxes
// belonged to the previous lockup and would squash this one.
const fit = (width) => [width, Math.round(width * transparent.height / transparent.width)];
const [fullW, fullH] = fit(600);
const [navW, navH] = fit(250);
const [nav2W, nav2H] = fit(500);

console.log('Wordmarks');
const full1 = resize(transparent, fullW, fullH);
const full2 = resize(transparent, fullW * 2, fullH * 2);
const fullPlate1 = resize(plated, fullW, fullH);
const fullPlate2 = resize(plated, fullW * 2, fullH * 2);
const nav = resize(transparent, navW, navH);
const nav2 = resize(transparent, nav2W, nav2H);
const navPlate = resize(plated, navW, navH);
const navPlate2 = resize(plated, nav2W, nav2H);

writePng(path.join(root, 'public/skyway-logo-reverse@2x.png'), full2);
writePng(path.join(root, 'public/skyway-logo-reverse.png'), full1);
writePng(path.join(root, 'public/skyway-logo@2x.png'), fullPlate2);
writePng(path.join(root, 'public/skyway-logo.png'), fullPlate1);
writePng(path.join(root, 'public/skyway-logo-nav-reverse.png'), nav);
writePng(path.join(root, 'public/skyway-logo-nav-reverse@2x.png'), nav2);
writePng(path.join(root, 'public/skyway-logo-nav.png'), navPlate);
writePng(path.join(root, 'public/skyway-logo-nav@2x.png'), navPlate2);

// Loose copies at the repo root are the same art. Keep them on the new mark.
writePng(path.join(root, 'skyway-logo.png'), fullPlate1);
writePng(path.join(root, 'skyway-logo-nav.png'), navPlate);
writePng(path.join(root, 'skyway-logo-nav@2x.png'), navPlate2);

console.log('PWA icons');
const icons = [
  ['public/favicon.png', 32, 0.9],
  ['public/icon-192.png', 192, 0.86],
  ['public/icon-512.png', 512, 0.86],
  ['public/icon-512-maskable.png', 512, 0.66],
  ['public/apple-touch-icon.png', 180, 0.84],
  ['public/apple-touch-icon-167.png', 167, 0.84],
];
for (const [rel, size, ratio] of icons) {
  writePng(path.join(root, rel), centeredMark(size, size, mark, { widthRatio: ratio, bg: PLATE }));
}

console.log('Launch images');
for (const file of walkPngs(path.join(root, 'public/splashes'))) {
  const current = readPng(file);
  writePng(file, centeredMark(current.width, current.height, transparent, { widthRatio: 0.72, bg: PLATE }));
}
const splashJpgPng = path.join(root, 'public/.splash-src.png');
writeFileSync(splashJpgPng, PNG.sync.write(centeredMark(682, 1477, transparent, { widthRatio: 0.72, bg: PLATE })));
const jpg = spawnSync('ffmpeg', [
  '-y', '-i', splashJpgPng,
  '-q:v', '3',
  path.join(root, 'public/splash.jpg'),
], { stdio: 'pipe' });
if (jpg.status !== 0) {
  console.error(jpg.stderr.toString());
  process.exit(1);
}
unlinkSync(splashJpgPng);
console.log('  public/splash.jpg  682x1477');

console.log('Android');
for (const file of walkPngs(path.join(root, 'android/app/src/main/res'))) {
  const base = path.basename(file);
  if (!base.startsWith('ic_launcher') && base !== 'splash.png') continue;
  const current = readPng(file);
  if (base === 'splash.png') {
    writePng(file, centeredMark(current.width, current.height, transparent, { widthRatio: current.width > current.height ? 0.46 : 0.72, bg: PLATE }));
    continue;
  }
  if (base === 'ic_launcher_foreground.png') {
    writePng(file, centeredMark(current.width, current.height, mark, { widthRatio: 0.58, bg: null }));
    continue;
  }
  const tile = centeredMark(current.width, current.height, mark, { widthRatio: 0.78, bg: PLATE });
  if (base === 'ic_launcher_round.png') maskCircle(tile);
  else maskRounded(tile, Math.round(current.width * 0.22));
  writePng(file, tile);
}

console.log('iOS');
const iosIcon = path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
writePng(iosIcon, centeredMark(1024, 1024, mark, { widthRatio: 0.84, bg: PLATE }));
for (const file of walkPngs(path.join(root, 'ios/App/App/Assets.xcassets/Splash.imageset'))) {
  const current = readPng(file);
  writePng(file, centeredMark(current.width, current.height, transparent, { widthRatio: 0.62, bg: PLATE }));
}

console.log('\nSkyway mark written from the master. Full lockup on wordmarks and splashes; jet crop on square icons.');
