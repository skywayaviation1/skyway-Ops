import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  JAKE_EMAIL,
  isJakeOwner,
  sanitizeAuditInput,
} from '../api/_super-admin.js';
import { isJakeCambria, isSuperAdmin } from '../src/navigation-config.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('Jake Cambria is the permanent super owner', () => {
  assert.equal(JAKE_EMAIL, 'jake@flyskyway.com');
  assert.equal(isJakeOwner({ email: 'Jake@FlySkyway.com' }), true);
  assert.equal(isJakeCambria({ email: 'jake@flyskyway.com' }), true);
  assert.equal(isSuperAdmin({ email: 'jake@flyskyway.com' }), true);
  assert.equal(isSuperAdmin({ email: 'ops@flyskyway.com', superAdmin: true }), true);
  assert.equal(isSuperAdmin({ email: 'ops@flyskyway.com' }), false);
});

test('global audit input stores action context but not arbitrary values', () => {
  assert.deepEqual(sanitizeAuditInput({
    action: 'ui.click<script>',
    summary: '  Save   passenger manifest  ',
    section: 'schedule<script>',
    targetType: 'trip',
    targetId: 'abc/123',
    secretValue: 'must not survive',
  }), {
    action: 'ui.clickscript',
    summary: 'Save passenger manifest',
    section: 'schedulescript',
    targetType: 'trip',
    targetId: 'abc123',
  });
});

test('only Jake can query all-user audit and assign super admins', async () => {
  const auditApi = await source('api/audit-events.js');
  const superApi = await source('api/super-admin.js');
  assert.match(auditApi, /authorizeJake\(body\.idToken\)/);
  assert.match(superApi, /action === 'grantSuperAdmin'/);
  assert.match(superApi, /authorizeJake\(body\.idToken\)/);
  assert.match(superApi, /superAdmin: enabled/);
});

test('super admins can group tabs and preserve role defaults until publishing', async () => {
  const app = await source('src/App.jsx');
  const panel = await source('src/SuperAdminPanel.jsx');
  const nav = await source('src/navigation-config.js');
  assert.match(app, /id: 'super-admin'/);
  assert.match(app, /roles: navigation\?\.sections/);
  assert.match(panel, /Move each item to a group/);
  assert.match(panel, /Publish access/);
  assert.match(panel, /ROLES\.map/);
  assert.match(nav, /navigation \|\| null/);
});

test('app audit tracker captures user tasks without input field values', async () => {
  const tracker = await source('src/AppAuditTracker.jsx');
  assert.match(tracker, /document\.addEventListener\('click'/);
  assert.match(tracker, /document\.addEventListener\('submit'/);
  assert.match(tracker, /\/api\/audit-events/);
  assert.doesNotMatch(tracker, /\.value/);
});

