import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => readFile(path.join(root, relative));

test('manifest has complete install identity, icons, and rich screenshots', async () => {
  const manifest = JSON.parse(await read('public/manifest.json'));
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  assert.ok(manifest.icons.some((icon) => String(icon.purpose).includes('maskable')));
  assert.ok(manifest.screenshots.some((shot) => shot.form_factor === 'narrow'));
  assert.ok(manifest.screenshots.some((shot) => shot.form_factor === 'wide'));
});

test('iOS touch icons are exact and fully opaque', async () => {
  for (const [file, expected] of [
    ['public/apple-touch-icon.png', [180, 180]],
    ['public/apple-touch-icon-167.png', [167, 167]],
  ]) {
    const png = PNG.sync.read(await read(file));
    assert.deepEqual([png.width, png.height], expected, file);
    for (let index = 3; index < png.data.length; index += 4) {
      assert.equal(png.data[index], 255, `${file} contains alpha at pixel ${Math.floor(index / 4)}`);
    }
  }
});

test('every startup-image filename matches its physical PNG dimensions', async () => {
  const html = await read('index.html').then((buffer) => buffer.toString('utf8'));
  const files = [...html.matchAll(/href="(\/splashes\/splash-(\d+)x(\d+)\.png)"/g)];
  assert.ok(files.length >= 10, 'expected iPhone launch image set');
  for (const [, url, width, height] of files) {
    const png = PNG.sync.read(await read(`public${url}`));
    assert.deepEqual([png.width, png.height], [Number(width), Number(height)], url);
  }
});

test('service worker handles navigation fetches without caching app chunks', async () => {
  const sw = await read('public/firebase-messaging-sw.js').then((buffer) => buffer.toString('utf8'));
  assert.match(sw, /addEventListener\('fetch'/);
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /caches\.match\('\/offline\.html'\)/);
  assert.match(sw, /Promise\.allSettled/);
  assert.doesNotMatch(sw, /cache\.addAll\([^)]*index\.html/s);
});

