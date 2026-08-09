import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const css = await readFile(resolve(root, 'styles.css'), 'utf8');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('production canonical points at 135ops.app', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/135ops\.app\/"\s*\/>/);
});

check('all image elements reserve intrinsic layout space', () => {
  const tags = (html.match(/<img\b[^>]*>/g) || [])
    .filter((tag) => !/id="lightboxImg"/.test(tag));
  assert.ok(tags.length >= 20, `expected at least 20 images, found ${tags.length}`);
  for (const tag of tags) {
    assert.match(tag, /\bwidth="\d+"/, `missing width: ${tag}`);
    assert.match(tag, /\bheight="\d+"/, `missing height: ${tag}`);
  }
});

check('responsive images preserve their intrinsic aspect ratio', () => {
  assert.match(css, /img\s*\{[^}]*height:\s*auto;/s);
});

check('every local image exists', async () => {
  const sources = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((source) => !/^https?:/.test(source));
  for (const source of sources) {
    await access(resolve(root, source));
  }
});

check('the pilot phone experience is present', () => {
  assert.match(html, /id="cockpit"/);
  const cockpit = html.match(/id="cockpit"[\s\S]*?<!-- =+ FEATURES -->/)?.[0] || '';
  const phoneScreens = cockpit.match(/assets\/screens\/phone-[^"]+\.webp/g) || [];
  assert.ok(phoneScreens.length >= 8, `expected 8 pilot screens, found ${phoneScreens.length}`);
});

check('deployment metadata is present', async () => {
  for (const path of ['vercel.json', 'robots.txt', 'sitemap.xml', 'site.webmanifest']) {
    await access(resolve(root, path));
  }
});

let failures = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : `\nall ${checks.length} checks passed`);
process.exit(failures ? 1 : 0);
