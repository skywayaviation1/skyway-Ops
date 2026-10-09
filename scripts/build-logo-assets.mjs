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
 * Square icons are concept A: the SKYWAY + jet word (no AVIATION line),
 * scaled as large as the padding allows on the same dark plate. Maskable
 * icons and the Android adaptive foreground stay inside their safe zones.
 * Launch images use the full lockup. Re-run after replacing the master.
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
 * SKYWAY plus the jet, cut above the white AVIATION line. This is the
 * square-icon artwork: the full word, not a crop of one letter.
 */
function skywayJet(src) {
  const { width, height, data } = src;
  const rowInk = new Array(height).fill(0);
  const rowWhite = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 40) continue;
      if (Math.max(data[i], data[i + 1], data[i + 2]) < 20) continue;
      rowInk[y]++;
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) rowWhite[y]++;
    }
  }
  let cut = height;
  for (let y = Math.floor(height * 0.55); y < height; y++) {
    if (rowWhite[y] > 20) {
      cut = y;
      break;
    }
  }
  let y0 = 0;
  while (y0 < cut && rowInk[y0] === 0) y0++;
  let y1 = cut - 1;
  while (y1 > y0 && rowInk[y1] === 0) y1--;
  let x0 = width;
  let x1 = -1;
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
  }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y + y0) * width + (x + x0)) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = data[si];
      out.data[di + 1] = data[si + 1];
      out.data[di + 2] = data[si + 2];
      out.data[di + 3] = data[si + 3];
    }
  }
  return out;
}

/**
 * Largest width ratio whose artwork stays inside a centered circle of
 * `safeDiameter` (fraction of the canvas) and clear of `edgePad` on each side.
 */
function fitRatio(word, canvasSize, { safeDiameter = 1, edgePad = 0.03 } = {}) {
  const aspect = word.width / word.height;
  const circleMax = safeDiameter / Math.sqrt(1 + 1 / (aspect * aspect));
  const padded = 1 - edgePad * 2;
  const pxGuard = 1 / canvasSize;
  return Math.max(0.2, Math.min(circleMax - pxGuard, padded));
}

/** PNG images packed in a .ico (Vista-style). Widths of 256 are stored as 0. */
function writeIco(file, images) {
  const count = images.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  const blobs = [header];
  images.forEach((img, index) => {
    const bytes = PNG.sync.write(img);
    const entry = 6 + index * 16;
    header.writeUInt8(img.width >= 256 ? 0 : img.width, entry);
    header.writeUInt8(img.height >= 256 ? 0 : img.height, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
    blobs.push(bytes);
  });
  writeFileSync(file, Buffer.concat(blobs));
  console.log(`  ${path.relative(root, file)}  ${images.map((img) => img.width).join(',')}`);
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
const word = skywayJet(transparent);

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
// Ordinary squares: 3% plate showing on each side, which is as large as the
// word can sit without touching the edge. Maskable art stays inside the
// center 80% safe circle.
const squareIcon = (size, opts) => centeredMark(size, size, word, {
  widthRatio: fitRatio(word, size, opts),
  bg: PLATE,
});
for (const [rel, size] of [
  ['public/favicon.png', 32],
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
  ['public/apple-touch-icon.png', 180],
  ['public/apple-touch-icon-167.png', 167],
]) {
  writePng(path.join(root, rel), squareIcon(size));
}
writePng(
  path.join(root, 'public/icon-512-maskable.png'),
  squareIcon(512, { safeDiameter: 0.8, edgePad: 0.1 }),
);
const ico = [16, 32, 48, 64].map((size) => squareIcon(size));
writeIco(path.join(root, 'public/favicon.ico'), ico);

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
    // Adaptive safe zone is the center 66dp of the 108dp foreground.
    const ratio = fitRatio(word, current.width, { safeDiameter: 66 / 108, edgePad: 0 });
    writePng(file, centeredMark(current.width, current.height, word, { widthRatio: ratio, bg: null }));
    continue;
  }
  // Round masks are full-bleed circles; the short word still fits at the
  // same size as the square launcher tiles.
  const tile = squareIcon(current.width);
  if (base === 'ic_launcher_round.png') maskCircle(tile);
  else maskRounded(tile, Math.round(current.width * 0.22));
  writePng(file, tile);
}

console.log('iOS');
const iosIcon = path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
writePng(iosIcon, squareIcon(1024));
for (const file of walkPngs(path.join(root, 'ios/App/App/Assets.xcassets/Splash.imageset'))) {
  const current = readPng(file);
  writePng(file, centeredMark(current.width, current.height, transparent, { widthRatio: 0.62, bg: PLATE }));
}

console.log('\nSkyway mark written. Square icons are the SKYWAY + jet word on the dark plate.');
