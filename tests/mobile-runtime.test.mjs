import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCTION_API_BASE,
  resolveApiBase,
  rewriteApiRequest,
} from '../src/mobile-runtime.js';

test('native API default is the current production host', () => {
  assert.equal(PRODUCTION_API_BASE, 'https://www.skyway.app');
  assert.equal(resolveApiBase(), 'https://www.skyway.app');
  assert.equal(resolveApiBase('https://www.skyway.app/'), 'https://www.skyway.app');
  assert.equal(resolveApiBase('https://preview.example/'), 'https://preview.example');
});

test('only relative /api/ paths are rewritten onto the production origin', () => {
  const base = 'https://www.skyway.app';
  assert.equal(rewriteApiRequest('/api/mobile-auth-token', base), 'https://www.skyway.app/api/mobile-auth-token');
  assert.equal(rewriteApiRequest('/api/auth-profile-bootstrap?x=1', base), 'https://www.skyway.app/api/auth-profile-bootstrap?x=1');
  assert.equal(rewriteApiRequest('/manifest.json', base), '/manifest.json');
  assert.equal(rewriteApiRequest('https://other.example/api/x', base), 'https://other.example/api/x');

  const rewritten = rewriteApiRequest(new URL('https://capacitor.local/api/dev-auth-bypass?q=1'), base);
  assert.equal(String(rewritten), 'https://www.skyway.app/api/dev-auth-bypass?q=1');
  const leftAlone = rewriteApiRequest(new URL('https://capacitor.local/trips'), base);
  assert.equal(String(leftAlone), 'https://capacitor.local/trips');
});
