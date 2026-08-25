import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

// A component used in JSX but never imported throws only when that branch
// renders, so the build stays green and the screen goes blank in production.
// Every component file is checked, because any conditional panel can hide one.
const FILES = (await readdir(path.join(root, 'src')))
  .filter((name) => name.endsWith('.jsx'))
  .map((name) => `src/${name}`)
  .sort();

/**
 * Blank out comment prose so text like "<U+F178>" is not mistaken for JSX.
 *
 * Only block comments that begin a line are removed. A `/*` sitting inside a
 * string or regex is always mid-line, and treating one as a comment would
 * delete real code through to the next `*​/` — which silently hid declarations
 * and produced phantom "missing component" failures. The `//` rule skips `://`
 * so URLs survive.
 */
function stripComments(source) {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importedNames(source) {
  const names = new Set();
  // The negative lookahead skips side-effect imports (`import './x.css';`).
  // Without it the match runs on to the next statement's `from` and swallows
  // that statement's default import, which reads as a missing component.
  for (const match of source.matchAll(/import\s+(?!['"])([^;]*?)\s+from\s*['"][^'"]+['"]/g)) {
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
  // Components arriving as props, e.g. ({ icon: Icon }) or ({ Wrapper }).
  for (const match of source.matchAll(/[:,{]\s*([A-Z][\w$]*)\s*[,}=]/g)) {
    names.add(match[1]);
  }
  return names;
}

for (const file of FILES) {
  test(`${file} imports every component it renders`, async () => {
    const raw = await readFile(path.join(root, file), 'utf8');
    const stripped = stripComments(raw);
    // Names are collected from both the raw and comment-free source and
    // unioned. Prose containing the word "import" can hijack the match in the
    // raw pass, and stripping can in principle drop a line in the other, so
    // either quirk only ever costs detection — never a phantom failure.
    const available = new Set([
      ...importedNames(raw), ...importedNames(stripped),
      ...declaredNames(raw), ...declaredNames(stripped),
    ]);
    const missing = new Set();
    for (const match of stripped.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) {
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
