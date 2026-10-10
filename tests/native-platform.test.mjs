import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { installNativeNetworkBypass } from '../src/mobile-runtime.js';
import { readNativePlatform, shouldOfferPwaInstall } from '../src/native-platform.js';

const iphoneWeb = {
  native: false,
  standalone: false,
  ios: true,
  nativePromptAvailable: false,
};

test('native detection follows the bridge and the capacitor origin', () => {
  assert.equal(readNativePlatform(undefined, () => false), false);
  assert.equal(readNativePlatform({ location: { protocol: 'https:' } }, () => false), false);
  assert.equal(
    readNativePlatform({ webkit: { messageHandlers: { bridge: {} } } }, () => false),
    true,
  );
  assert.equal(readNativePlatform({ androidBridge: {} }, () => false), true);
  assert.equal(readNativePlatform({ location: { protocol: 'capacitor:' } }, () => false), true);
  assert.equal(readNativePlatform({ location: { protocol: 'ionic:' } }, () => false), true);
  assert.equal(readNativePlatform({}, () => true), true);
  assert.equal(readNativePlatform({}, () => { throw new Error('stub'); }), false);
});

test('PWA install UI stays on the website and hides inside the native shell', () => {
  assert.equal(shouldOfferPwaInstall(iphoneWeb), true);
  assert.equal(shouldOfferPwaInstall({ ...iphoneWeb, native: true }), false);
  assert.equal(shouldOfferPwaInstall({ ...iphoneWeb, standalone: true }), false);
  assert.equal(shouldOfferPwaInstall({
    native: false,
    standalone: false,
    ios: false,
    nativePromptAvailable: true,
  }), true);
  assert.equal(shouldOfferPwaInstall({
    native: false,
    standalone: false,
    ios: false,
    nativePromptAvailable: false,
  }), false);
});

test('Firebase Auth hosts bypass CapacitorHttp when the bridge patch is present', async () => {
  const calls = [];
  const win = {
    CapacitorWebFetch(input) {
      calls.push(['web', String(input)]);
      return Promise.resolve('web');
    },
    fetch(input) {
      calls.push(['proxy', String(input)]);
      return Promise.resolve('proxy');
    },
  };

  assert.equal(installNativeNetworkBypass(win), true);
  await win.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=x', { method: 'POST' });
  await win.fetch('https://securetoken.googleapis.com/v1/token?key=x', { method: 'POST' });
  await win.fetch('/api/mobile-auth-token', { method: 'POST' });

  assert.deepEqual(calls, [
    ['web', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=x'],
    ['web', 'https://securetoken.googleapis.com/v1/token?key=x'],
    ['proxy', 'https://www.skyway.app/api/mobile-auth-token'],
  ]);
  assert.equal(installNativeNetworkBypass(win), false);
});

test('an incomplete CapacitorHttp patch is not latched', () => {
  const win = {
    location: { protocol: 'capacitor:' },
    CapacitorWebXMLHttpRequest: { open() {} },
    fetch() { return Promise.resolve('proxy'); },
  };
  const original = win.fetch;
  assert.equal(installNativeNetworkBypass(win), false);
  assert.equal(win.fetch, original);
  assert.equal(win.__skywayNativeFetch, undefined);
});

test('a normal browser window does not get the native fetch bypass', () => {
  const win = {
    location: { protocol: 'https:' },
    fetch() { return Promise.resolve('site'); },
  };
  const original = win.fetch;
  assert.equal(installNativeNetworkBypass(win), false);
  assert.equal(win.fetch, original);
});

test('login and home-screen install UI consult native detection', async () => {
  const pwa = await readFile(new URL('../src/PwaInstall.jsx', import.meta.url), 'utf8');
  assert.match(pwa, /shouldOfferPwaInstall/);
  assert.match(pwa, /native: isNativeApp\(\)/);
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /function IosInstallBanner\(\) \{[\s\S]*?if \(isNativeApp\(\)\) return;/);
  const firebase = await readFile(new URL('../src/firebase.js', import.meta.url), 'utf8');
  assert.match(firebase, /isNativeApp\(\)\s*\n\s*\? initializeAuth\(app, \{ persistence: indexedDBLocalPersistence \}\)/);
  const delegate = await readFile(new URL('../ios/App/App/AppDelegate.swift', import.meta.url), 'utf8');
  assert.match(delegate, /Auth\.auth\(\)\.customAuthDomain = "www\.skyway\.app"/);
});
