import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function readIfPresent(file) {
  try {
    return await readFile(path.join(root, file), 'utf8');
  } catch {
    return '';
  }
}

async function collect(dir, filter) {
  try {
    return (await readdir(path.join(root, dir))).filter(filter).map((name) => `${dir}/${name}`);
  } catch {
    return [];
  }
}

test('components live under src/, not loose at the repo root', async () => {
  const stray = (await readdir(root)).filter((name) => name.endsWith('.jsx'));
  assert.deepEqual(
    stray,
    [],
    `${stray.join(', ')} sits at the repo root. A second copy of a component is edited by mistake and silently diverges from the real one under src/.`,
  );
});

test('every deployed API route is reachable', async () => {
  // Each api/*.js becomes a public serverless endpoint on deploy, so one that
  // nothing can reach is unmaintained code left exposed. Helpers prefixed with
  // an underscore are imported, never routed.
  const handlers = (await collect('api', (name) => name.endsWith('.js') && !name.startsWith('_')));

  // Callers can live anywhere: the app, static pages, other handlers, the
  // Vercel cron/function config, or setup docs for externally-invoked routes
  // such as OAuth callbacks and third-party webhooks.
  const haystack = [
    ...(await collect('src', (n) => n.endsWith('.js') || n.endsWith('.jsx'))),
    ...(await collect('public', (n) => n.endsWith('.html') || n.endsWith('.js'))),
    ...(await collect('api', (n) => n.endsWith('.js'))),
    ...(await collect('docs', (n) => n.endsWith('.md'))),
    'vercel.json',
  ];
  const corpus = new Map();
  for (const file of haystack) corpus.set(file, await readIfPresent(file));

  const orphans = [];
  for (const handler of handlers) {
    const name = path.basename(handler, '.js');
    const referenced = [...corpus].some(([file, text]) => (
      file !== handler && (text.includes(`/api/${name}`) || text.includes(`api/${name}.js`))
    ));
    if (!referenced) orphans.push(name);
  }

  assert.deepEqual(
    orphans,
    [],
    `No caller found for: ${orphans.join(', ')}. Either wire the route up or delete it — it deploys as a live endpoint either way.`,
  );
});
