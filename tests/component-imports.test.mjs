import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

// A component used in JSX but never imported throws only when that branch
// renders, so the build stays green and the screen goes blank in production.
// These are the screens whose panels render conditionally.
const FILES = [
  'src/CharterInbox.jsx',
  'src/TeamsHub.jsx',
  'src/UserMailbox.jsx',
  'src/MailboxSettingsPanel.jsx',
  'src/QuickBooksWorkspace.jsx',
  'src/Accounting.jsx',
  'src/TripTrack.jsx',
];

function importedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = match[1];
    const defaultMatch = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (defaultMatch) names.add(defaultMatch[1]);
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const alias = part.split(/\s+as\s+/);
        const name = (alias[1] || alias[0] || '').trim();
        if (name) names.add(name);
      }
    }
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) names.add(namespace[1]);
  }
  return names;
}

function declaredNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:function|const|let|class)\s+([A-Z][\w$]*)/g)) {
    names.add(match[1]);
  }
  // Components destructured from props, e.g. ({ icon: Icon }).
  for (const match of source.matchAll(/[:,{]\s*([A-Z][\w$]*)\s*[,}=]/g)) {
    names.add(match[1]);
  }
  return names;
}

for (const file of FILES) {
  test(`${file} imports every component it renders`, async () => {
    const source = await readFile(path.join(root, file), 'utf8');
    const available = new Set([...importedNames(source), ...declaredNames(source)]);
    const missing = new Set();
    for (const match of source.matchAll(/<([A-Z][\w$]*)/g)) {
      const name = match[1];
      if (!available.has(name)) missing.add(name);
    }
    assert.deepEqual(
      [...missing],
      [],
      `${file} renders ${[...missing].join(', ')} without importing or defining it`,
    );
  });
}
