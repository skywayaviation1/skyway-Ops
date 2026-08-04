import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isIosDevice,
  isSameOriginAuthDomain,
  isStandaloneApp,
  microsoftAuthMethod,
  resolveMicrosoftTenant,
} from '../src/auth-environment.js';

const ios = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  maxTouchPoints: 5,
  standalone: true,
};
const desktop = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 Safari/605.1.15',
  maxTouchPoints: 0,
  standalone: false,
};

test('detects iPhone and touch-reporting iPad, not desktop Safari', () => {
  assert.equal(isIosDevice(ios), true);
  assert.equal(isIosDevice({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    maxTouchPoints: 5,
  }), true);
  assert.equal(isIosDevice(desktop), false);
});

test('standalone detection accepts navigator and display-mode signals', () => {
  assert.equal(isStandaloneApp({ matchMedia: () => ({ matches: false }) }, ios), true);
  assert.equal(isStandaloneApp({ matchMedia: () => ({ matches: true }) }, desktop), true);
  assert.equal(isStandaloneApp({ matchMedia: () => ({ matches: false }) }, desktop), false);
});

test('auth domain compares hostnames case-insensitively', () => {
  assert.equal(isSameOriginAuthDomain('ops.flyskyway.com', { hostname: 'ops.flyskyway.com' }), true);
  assert.equal(isSameOriginAuthDomain('OPS.FLYSKYWAY.COM', { hostname: 'ops.flyskyway.com' }), true);
  assert.equal(isSameOriginAuthDomain('skyway-ops-app.firebaseapp.com', { hostname: 'ops.flyskyway.com' }), false);
});

test('installed iOS uses popup only when auth helper is cross-origin', () => {
  const win = { matchMedia: () => ({ matches: true }) };
  const location = { hostname: 'skyway-ops.vercel.app' };
  assert.equal(microsoftAuthMethod({
    authDomain: 'skyway-ops-app.firebaseapp.com', win, nav: ios, location,
  }), 'popup');
  assert.equal(microsoftAuthMethod({
    authDomain: 'skyway-ops.vercel.app', win, nav: ios, location,
  }), 'redirect');
});

test('a directory is always targeted, never Microsoft /common', () => {
  // /common is what a single-tenant Entra app rejects with AADSTS50194, so the
  // company domain must be used when no tenant GUID is deployed.
  assert.equal(resolveMicrosoftTenant('', 'flyskyway.com'), 'flyskyway.com');
  assert.equal(resolveMicrosoftTenant(undefined, 'flyskyway.com'), 'flyskyway.com');
  assert.equal(resolveMicrosoftTenant('   ', 'flyskyway.com'), 'flyskyway.com');
  assert.notEqual(resolveMicrosoftTenant('', 'flyskyway.com'), 'common');
});

test('an explicit tenant GUID overrides the domain default', () => {
  const guid = '8eaef023-2b34-4da1-9baa-8bc8c9d6a490';
  assert.equal(resolveMicrosoftTenant(guid, 'flyskyway.com'), guid);
  assert.equal(resolveMicrosoftTenant(` ${guid} `, 'flyskyway.com'), guid);
});

test('normal browser sessions continue to use redirect', () => {
  const win = { matchMedia: () => ({ matches: false }) };
  assert.equal(microsoftAuthMethod({
    authDomain: 'skyway-ops-app.firebaseapp.com',
    win,
    nav: desktop,
    location: { hostname: 'skyway-ops.vercel.app' },
  }), 'redirect');
});

