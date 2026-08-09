import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(appRoot, 'marketing');
const target = resolve(process.argv[2] || resolve(appRoot, '..', '135ops-marketing'));

let existing = [];
try {
  existing = await readdir(target);
} catch {
  // Destination does not exist yet.
}
if (existing.length) {
  throw new Error(`Refusing to overwrite non-empty destination: ${target}`);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const ignored = new Set(['.preview', 'node_modules']);
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (ignored.has(entry.name)) continue;
  await cp(resolve(source, entry.name), resolve(target, entry.name), {
    recursive: true,
  });
}

await exec('git', ['init', '-b', 'main'], { cwd: target });
await exec('git', ['add', '.'], { cwd: target });
await exec('git', [
  '-c', 'user.name=Cursor Agent',
  '-c', 'user.email=agent@cursor.com',
  'commit', '-m', 'Initial 135ops.app marketing website',
], { cwd: target });

console.log(`Standalone marketing repository created at ${target}`);
console.log('Next: create the GitHub repository and push this main branch.');
