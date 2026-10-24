#!/usr/bin/env node
// Mirror https://www.skyway.app into dist/ for the Capacitor iOS webDir.
//
// TestFlight ships this copy of production rather than a local Vite build, so
// the shell matches the bundle that is actually live (including its baked-in
// environment). The crawl originally followed only /assets/ URLs. Root public
// files the page names directly — skyway-logo*.png, favicons, apple-touch
// icons, splashes/*, manifest.json — never reached the app bundle, and the
// in-app marks 404'd.
//
//   node .mirror-prod.mjs
//
// MIRROR_ORIGIN overrides the site (default https://www.skyway.app).
// MIRROR_OUT overrides the destination (default ./dist).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = (process.env.MIRROR_ORIGIN || 'https://www.skyway.app').replace(/\/$/, '');
const OUT = path.resolve(process.env.MIRROR_OUT || 'dist');

const pending = [];
const seen = new Set();

function add(raw) {
  if (raw == null) return;
  let rel = String(raw).trim().replace(/\\/g, '/');
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//')) return;
  rel = rel.split(/[?#]/, 1)[0];
  while (rel.startsWith('/') || rel.startsWith('./')) {
    rel = rel.startsWith('/') ? rel.slice(1) : rel.slice(2);
  }
  if (!rel || rel.split('/').some((part) => part === '' || part === '..')) return;
  if (seen.has(rel)) return;
  seen.add(rel);
  pending.push(rel);
}

// Pull same-origin files out of an HTML, JS, CSS, or JSON body.
// `fromRel` is the file the text came from, so a chunk's ./import resolves
// under assets/ instead of the site root.
function collect(t, fromRel = '') {
  for (const m of t.matchAll(/["']\/?(assets\/[^"'?#\s]+)["']/g)) add(m[1]);
  if (fromRel.startsWith('assets/')) {
    const dir = path.posix.dirname(fromRel);
    for (const m of t.matchAll(/["']\.\/([^"'?#\s]+)["']/g)) add(`${dir}/${m[1]}`);
  }
  // Root public images, plus splashes/ and icons/. These sit next to index.html,
  // not under assets/, so the matcher above never queued them.
  for (const m of t.matchAll(/["'(`\s=]\/((?:splashes\/|icons\/)?[A-Za-z0-9_.@\-]+\.(?:png|jpg|jpeg|svg|webp|gif|ico|webmanifest|json))(?=["'`)\s?#])/g)) add(m[1]);
  // Wordmark src/srcSet are `${base}.png` and `${base}@2x.png`. The bundle only
  // contains the extensionless root ("/skyway-logo-nav"), so the loop above
  // never sees skyway-logo-nav.png.
  for (const m of t.matchAll(/["']\/((?:skyway|elite)-logo(?:-[A-Za-z0-9@]+)?)["']/g)) {
    add(`${m[1]}.png`);
    add(`${m[1]}@2x.png`);
  }
}

function textual(contentType, rel) {
  const type = String(contentType || '').toLowerCase();
  if (
    type.includes('text/')
    || type.includes('javascript')
    || type.includes('json')
    || type.includes('xml')
    || type.includes('svg')
  ) return true;
  return /\.(?:html?|js|mjs|css|json|webmanifest|svg|txt)$/i.test(rel);
}

async function save(rel, bytes) {
  const dest = path.join(OUT, ...rel.split('/'));
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
}

async function mirror() {
  await mkdir(OUT, { recursive: true });
  add('index.html');
  let saved = 0;
  while (pending.length) {
    const rel = pending.shift();
    const urlPath = rel === 'index.html' ? '/' : `/${rel}`;
    let response;
    try {
      response = await fetch(`${ORIGIN}${urlPath}`, { redirect: 'follow' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (rel === 'index.html') throw new Error(`Could not fetch ${ORIGIN}/ (${message})`);
      console.warn(`skip ${urlPath} (${message})`);
      continue;
    }
    if (response.url) {
      const finalOrigin = new URL(response.url).origin;
      if (finalOrigin !== new URL(ORIGIN).origin) {
        console.warn(`skip off-origin ${response.url}`);
        continue;
      }
    }
    if (!response.ok) {
      if (rel === 'index.html') throw new Error(`${ORIGIN}/ returned HTTP ${response.status}`);
      console.warn(`skip ${response.status} ${urlPath}`);
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await save(rel, bytes);
    saved += 1;
    if (textual(response.headers.get('content-type'), rel)) {
      collect(bytes.toString('utf8'), rel);
    }
  }
  console.log(`mirrored ${saved} file${saved === 1 ? '' : 's'} from ${ORIGIN} into ${OUT}`);
}

mirror().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
