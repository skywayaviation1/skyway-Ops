// Verifies each preview stub implements the full public surface of the module it
// stands in for.
//
// A stub that omits a name the real module exports is a hard ES module error at
// runtime ("does not provide an export named ..."), which blanks the screen.
// Comparing against the real module's export list — rather than trying to infer
// which names consumers use — is exact, so a green run guarantees no surface can
// fail to load for a missing binding.
//
// Usage: node scripts/check-preview-stubs.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// Mirrors the table in vite.preview.config.js: real module -> stub file.
const STUBS = {
  'firebase.js': 'firebase.js',
  'firebase-auth.js': 'firebase-auth.js',
  'firebase-data.js': 'firebase-data.js',
  'firebase-maint.js': 'firebase-ops.js',
  'firebase-aog.js': 'firebase-ops.js',
  'firebase-duty-v2.js': 'firebase-ops.js',
  'firebase-user-mail.js': 'firebase-ops.js',
  'firebase-pilotdocs.js': 'firebase-misc.js',
  'firebase-expenses.js': 'firebase-misc.js',
  'firebase-comms.js': 'firebase-misc.js',
  'firebase-manifests.js': 'firebase-misc.js',
  'firebase-mel.js': 'firebase-misc.js',
  'firebase-mx.js': 'firebase-misc.js',
  'firebase-quickbooks.js': 'firebase-misc.js',
  'firebase-reports.js': 'firebase-misc.js',
  'firebase-service.js': 'firebase-misc.js',
  'firebase-storage.js': 'firebase-misc.js',
  'firebase-travel.js': 'firebase-misc.js',
  'firebase-wallet.js': 'firebase-misc.js',
  'firebase-push.js': 'firebase-misc.js',
};

function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.split(/\s+as\s+/);
      const name = (alias[1] || alias[0] || '').trim();
      if (name && name !== 'default') names.add(name);
    }
  }
  return names;
}

const missing = new Map();
const stubCache = new Map();

for (const [realFile, stubFile] of Object.entries(STUBS)) {
  if (!stubCache.has(stubFile)) {
    stubCache.set(
      stubFile,
      exportedNames(await readFile(path.join(root, 'preview/stubs', stubFile), 'utf8')),
    );
  }
  const provided = stubCache.get(stubFile);
  const required = exportedNames(await readFile(path.join(root, 'src', realFile), 'utf8'));
  const gaps = [...required].filter((name) => !provided.has(name)).sort();
  if (gaps.length) missing.set(`${realFile}  ->  preview/stubs/${stubFile}`, gaps);
}

if (missing.size === 0) {
  console.log('Every preview stub covers the full export surface of its real module.');
  process.exit(0);
}

console.error('Preview stubs are missing exports their real module provides:\n');
for (const [pair, gaps] of missing) {
  console.error(`  ${pair}`);
  console.error(`    ${gaps.join(', ')}\n`);
}
process.exit(1);
