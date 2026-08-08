/* Converts captured PNGs to web-sized WebP and drops the PNG originals.
 * Only the WebP files are committed; re-run capture.mjs to regenerate.
 *
 * Usage: node optimize.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../marketing/assets/screens');

const PHONE_WIDTH = 900;
const DESKTOP_WIDTH = 2200;
const QUALITY = '80';

const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png'));

for (const file of files) {
  const source = path.join(dir, file);
  const target = source.replace(/\.png$/, '.webp');
  const width = file.startsWith('phone-') ? PHONE_WIDTH : DESKTOP_WIDTH;
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-vf', `scale='min(${width},iw)':-1:flags=lanczos`,
    '-q:v', QUALITY,
    target,
  ]);
  await fs.unlink(source);
  const { size } = await fs.stat(target);
  console.log(`${path.basename(target)} — ${Math.round(size / 1024)} kB`);
}
