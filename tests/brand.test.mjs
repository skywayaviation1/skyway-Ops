// The platform is deployed per operator, so the branding layer has to hold two
// guarantees: every tenant declares the full set of fields components read, and
// no component reintroduces a hard-coded operator name on a customer-facing
// surface.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const brandSource = read('src/brand.js');

/** Field names every brand entry must define, because components read them. */
const REQUIRED_FIELDS = [
  'id', 'name', 'shortName', 'legalName', 'domain',
  'contactEmail', 'contactPhone', 'tagline', 'wordmark', 'accent',
];

const TENANT_IDS = ['skyway', 'elite'];

test('every tenant declares the fields components read', async () => {
  const { brand, brandIds } = await import('../src/brand.js');
  assert.deepEqual(brandIds().sort(), [...TENANT_IDS].sort());

  for (const id of brandIds()) {
    const entry = brand(id);
    for (const field of REQUIRED_FIELDS) {
      assert.ok(entry[field], `${id} is missing ${field}`);
    }
    for (const variant of ['full', 'compact']) {
      assert.ok(entry.wordmark[variant]?.light, `${id} has no ${variant} light wordmark`);
      assert.ok(entry.wordmark[variant]?.dark, `${id} has no ${variant} dark wordmark`);
    }
    for (const mode of ['dark', 'light']) {
      const ink = entry.accent[mode];
      assert.match(ink.base, /^#[0-9A-Fa-f]{6}$/, `${id} ${mode} accent is not a hex colour`);
      assert.ok(ink.soft && ink.border && ink.contrast, `${id} ${mode} accent is incomplete`);
    }
  }
});

test('an unknown tenant falls back rather than throwing', async () => {
  const { brand, DEFAULT_BRAND_ID } = await import('../src/brand.js');
  assert.equal(brand('not-a-tenant').id, DEFAULT_BRAND_ID);
});

test('the accent is written as the variables index.css defines', () => {
  const css = read('src/index.css');
  for (const token of ['--sw-accent', '--sw-accent-soft', '--sw-accent-border', '--sw-accent-contrast']) {
    assert.ok(css.includes(token), `index.css no longer defines ${token}`);
    assert.ok(brandSource.includes(token), `brand.js no longer sets ${token}`);
  }
});

test('wordmark artwork is resolved from the brand, not hard-coded', () => {
  const ui = read('src/ui.jsx');
  assert.ok(ui.includes('brand().wordmark'), 'ui.jsx should take artwork from the brand');
  assert.ok(
    !/['"]\/skyway-logo/.test(ui),
    'ui.jsx still points at a specific operator\'s logo file',
  );
});

/**
 * Surfaces a customer or another operator's crew actually sees. A hard-coded
 * operator name here ships the wrong company's identity to a tenant, which the
 * branded preview exists to demonstrate is not the case.
 */
const CUSTOMER_FACING = [
  'src/TripTrack.jsx',
  'src/TeamsHub.jsx',
  'src/UserMailbox.jsx',
  'src/AdminDutyReport.jsx',
  'src/OpsDashboard.jsx',
  'src/DutyV2.jsx',
  'src/ExpenseAccounting.jsx',
  'src/FlightBoard.jsx',
];

test('customer-facing surfaces carry no hard-coded operator name', () => {
  const offenders = [];
  for (const file of CUSTOMER_FACING) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*[*/]/.test(line)) return;           // comment block
      if (/skyway[-_.:]/i.test(code)) return;      // storage keys and asset paths
      if (/Skyway/.test(code)) offenders.push(`${file}:${i + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], `hard-coded operator name:\n${offenders.join('\n')}`);
});
