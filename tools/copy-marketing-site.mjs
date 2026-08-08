import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'marketing');
const destination = resolve(root, 'dist', 'marketing');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const entry of [
  'index.html',
  'styles.css',
  'app.js',
  'assets',
  'robots.txt',
  'sitemap.xml',
  'site.webmanifest',
]) {
  await cp(resolve(source, entry), resolve(destination, entry), {
    recursive: true,
  });
}

console.log('Copied marketing site to dist/marketing');
