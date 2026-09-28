import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FEATURES } from '../lib/control-plane/catalog.js';
import { splitSql } from '../lib/control-plane/migrate.js';
import { requireFeature } from '../lib/control-plane/require-feature.js';
import { mapFirestoreUser } from '../lib/control-plane/shadow-users.js';
import { SKYWAY_BRAND } from '../lib/control-plane/skyway-brand.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

async function walkJs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkJs(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

test('the feature catalog matches the SQL seed, including parent keys', async () => {
  const seed = await read('supabase/migrations/20260928120300_seed_skyway.sql');
  for (const feature of FEATURES) {
    const line = seed.split('\n').find((row) => row.includes(`('${feature.key}',`));
    assert.ok(line, `seed is missing ${feature.key}`);
    if (feature.parentKey) {
      assert.ok(line.includes(`'${feature.parentKey}'`), `${feature.key} parent`);
    }
    assert.ok(
      line.includes(feature.alwaysOn ? 'true' : 'false'),
      `${feature.key} always_on flag`,
    );
  }
  assert.equal(
    FEATURES.filter((feature) => feature.parentKey).map((feature) => `${feature.key}->${feature.parentKey}`).sort().join(','),
    'crew.safety_rating->crew.currency,dispatch.broker_report->dispatch,integrations.foreflight->dispatch',
  );
});

test('Skyway branding in code and SQL matches src/brand.js', async () => {
  const { brand } = await import('../src/brand.js');
  const skyway = brand('skyway');
  assert.equal(SKYWAY_BRAND.name, skyway.name);
  assert.equal(SKYWAY_BRAND.legalName, skyway.legalName);
  assert.equal(SKYWAY_BRAND.tagline, skyway.tagline);
  assert.equal(SKYWAY_BRAND.contactEmail, skyway.contactEmail);
  assert.equal(SKYWAY_BRAND.contactPhone, skyway.contactPhone);
  assert.equal(SKYWAY_BRAND.logoUrl, skyway.wordmark.full.light);
  assert.equal(SKYWAY_BRAND.logoDarkUrl, skyway.wordmark.full.dark);
  assert.equal(SKYWAY_BRAND.logoMarkUrl, skyway.wordmark.compact.light);
  assert.equal(SKYWAY_BRAND.logoMarkDarkUrl, skyway.wordmark.compact.dark);
  assert.equal(SKYWAY_BRAND.accentDark, skyway.accent.dark.base);
  assert.equal(SKYWAY_BRAND.accentLight, skyway.accent.light.base);
  assert.deepEqual(SKYWAY_BRAND.accent.dark, skyway.accent.dark);
  assert.deepEqual(SKYWAY_BRAND.accent.light, skyway.accent.light);

  const seed = await read('supabase/migrations/20260928120300_seed_skyway.sql');
  for (const value of [
    skyway.legalName,
    skyway.contactEmail,
    skyway.contactPhone,
    skyway.tagline,
    skyway.accent.dark.base,
    skyway.accent.light.base,
    'www.skyway.app',
    'skyway.app',
    '135ops.app',
    "'internal'",
    "'none'",
    'noreply@send.flyskyway.com',
  ]) {
    assert.ok(seed.includes(value), `seed is missing ${value}`);
  }
});

test('migration SQL stays one function body per statement', async () => {
  const resolver = await read('supabase/migrations/20260928120200_resolver_and_rls.sql');
  const statements = splitSql(resolver);
  const functions = statements.filter((statement) => /create\s+or\s+replace\s+function/i.test(statement));
  assert.equal(functions.length, 5);
  const resolve = functions.find((statement) => statement.includes('FUNCTION resolve_feature'));
  assert.ok(resolve.includes('force_off'));
  assert.ok(resolve.includes('RETURN NEXT'));
  assert.equal(splitSql(await read('supabase/migrations/20260928120300_seed_skyway.sql'))
    .some((statement) => statement.includes('#3FA9CC') && statement.includes('#12708C')), true);
});

test('the migration role is not used by any api handler', async () => {
  const files = await walkJs(path.join(root, 'api'));
  const forbidden = ['skyway_migration', 'DATABASE_MIGRATION_URL', 'BYPASSRLS'];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const relative = path.relative(root, file);
    for (const token of forbidden) {
      assert.equal(text.includes(token), false, `${relative} mentions ${token}`);
    }
    if (path.basename(file) === 'tenant-context.js') {
      assert.equal(text.includes('require-feature'), false);
      assert.equal(text.includes('pg'), false);
      assert.equal(text.includes('firebase'), false);
      continue;
    }
    assert.equal(text.includes('control-plane'), false, relative);
    assert.equal(text.includes('withTenant'), false, relative);
    assert.equal(text.includes('requireFeature'), false, relative);
  }
});

test('the shadow copy never writes to Firestore', async () => {
  const files = [
    'scripts/shadow-copy-users.mjs',
    'lib/control-plane/shadow-users.js',
  ];
  const banned = [
    '.set(', '.update(', '.delete(', '.create(',
    'writeBatch', 'bulkWriter', 'setDoc', 'updateDoc', 'deleteDoc', 'addDoc',
  ];
  for (const file of files) {
    const text = await read(file);
    for (const token of banned) {
      assert.equal(text.includes(token), false, `${file} contains ${token}`);
    }
  }
  const script = await read('scripts/shadow-copy-users.mjs');
  assert.ok(script.includes(".collection('users').get()"));
  assert.ok(script.includes("'appusers'"));
  assert.ok(script.includes('DATABASE_MIGRATION_URL'));
  assert.equal((await read('lib/control-plane/shadow-users.js')).includes('firebase-admin'), false);
  assert.equal((await read('lib/control-plane/shadow-users.js')).includes("from 'firebase"), false);
  const crons = JSON.parse(await read('vercel.json')).crons.map((cron) => cron.path);
  assert.equal(crons.includes('/api/shadow-copy-users'), false);
  assert.equal(crons.some((cron) => cron.includes('shadow')), false);
});

test('the UI does not call tenant context', async () => {
  const app = await read('src/App.jsx');
  const html = await read('index.html');
  assert.equal(app.includes('tenant-context'), false);
  assert.equal(html.includes('tenant-context'), false);
});

test('Firestore user mapping', () => {
  assert.deepEqual(
    mapFirestoreUser('uid-1', {
      email: 'Pilot@FlySkyway.com',
      name: 'Pat Pilot',
      role: 'pilot',
      approved: true,
      active: true,
    }),
    {
      firebaseUid: 'uid-1',
      email: 'pilot@flyskyway.com',
      name: 'Pat Pilot',
      role: 'crew',
      status: 'active',
      remappedFrom: 'pilot',
      skipReason: null,
    },
  );
  assert.equal(mapFirestoreUser('uid-2', { email: 'a@flyskyway.com', role: 'admin', approved: false }).status, 'invited');
  assert.equal(mapFirestoreUser('uid-3', { email: 'a@flyskyway.com', role: 'ops', approved: true, active: false }).status, 'disabled');
  assert.equal(mapFirestoreUser('uid-4', { role: 'crew' }).skipReason, 'missing email');
  assert.equal(mapFirestoreUser('uid-5', { email: 'a@flyskyway.com', role: 'dispatch-god' }).skipReason, 'unmapped role dispatch-god');
});

test('requireFeature without a tenant or key does not touch the database', async () => {
  const missingKey = await requireFeature({ tenantId: '00000000-0000-4000-8000-000000000001' }, '');
  const missingTenant = await requireFeature({}, 'dispatch');
  assert.deepEqual(missingKey, { ok: false, status: 404, body: { error: 'Not found' } });
  assert.deepEqual(missingTenant, { ok: false, status: 404, body: { error: 'Not found' } });
});
