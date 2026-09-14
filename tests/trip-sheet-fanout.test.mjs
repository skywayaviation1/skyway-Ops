import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('broker share fetch includes trip code, broker, and sheet metadata', async () => {
  const firebase = await source('src/firebase-data.js');
  const shareFunction = firebase.slice(
    firebase.indexOf('export async function fetchTripStateForShare'),
    firebase.indexOf('export function subscribeToTripState'),
  );
  assert.match(shareFunction, /brokerEmail: data\.brokerEmail/);
  assert.match(shareFunction, /tripSheetData:/);
  assert.match(shareFunction, /tripSheetUrl:/);
});

test('full-sheet upload attaches unique parsed legs and reconciles trip-code siblings', async () => {
  const app = await source('src/App.jsx');
  assert.match(app, /const attachedUids = new Set/);
  assert.match(app, /m\.candidates\.find\(\(candidate\) => !attachedUids\.has/);
  assert.match(app, /const tagged = sameTail\.filter/);
  assert.match(app, /existing\.tripSheetData/);
  assert.match(app, /relatedBrokerLegs/);
});

test('trip code is stored top-level and inside per-leg sheet data', async () => {
  const firebase = await source('src/firebase-data.js');
  assert.match(firebase, /tripCode: legUpdate\.tripCode \|\| legUpdate\.tripSheetData\?\.tripCode/);
  assert.match(firebase, /tripSheetData: null,\s+tripCode: null,/);
});

