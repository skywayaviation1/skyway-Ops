import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DUTY_TRACKER_ENABLED } from '../src/duty-feature.js';

const root = path.resolve(import.meta.dirname, '..');

test('duty tracker is a permanent core feature', () => {
  assert.equal(DUTY_TRACKER_ENABLED, true);
});

test('server settings cannot persist duty tracking as disabled', async () => {
  const source = await readFile(path.join(root, 'api/admin-settings.js'), 'utf8');
  assert.match(source, /dutyTrackerEnabled:\s*DUTY_TRACKER_ENABLED/);
  assert.doesNotMatch(source, /dutyTrackerEnabled:\s*dutyTrackerEnabled\s*===\s*true/);
});

test('pilot and admin duty surfaces have no feature-flag gate', async () => {
  const source = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.doesNotMatch(source, /if\s*\(!config\?\.dutyTrackerEnabled\)\s*return null/);
  assert.doesNotMatch(source, /section === 'duty'.*config\?\.dutyTrackerEnabled/);
});
