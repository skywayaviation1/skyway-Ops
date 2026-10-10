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

test('native detection is strictly Capacitor.isNativePlatform()', () => {
  const bridgeWindow = { webkit: { messageHandlers: { bridge: {} } } };
  const androidWindow = { androidBridge: {} };
  const capacitorWindow = { location: { protocol: 'capacitor:' } };
  const ionicWindow = { location: { protocol: 'ionic:' } };

  assert.equal(readNativePlatform(undefined, () => false), false);
  assert.equal(readNativePlatform({ location: { protocol: 'https:' } }, () => false), false);
  // These signals used to force the shell path on the website. They must not.
  assert.equal(readNativePlatform(bridgeWindow, () => false), false);
  assert.equal(readNativePlatform(androidWindow, () => false), false);
  assert.equal(readNativePlatform(capacitorWindow, () => false), false);
  assert.equal(readNativePlatform(ionicWindow, () => false), false);
  assert.equal(readNativePlatform(bridgeWindow, undefined), false);
  assert.equal(readNativePlatform({}, () => true), true);
  assert.equal(readNativePlatform(capacitorWindow, () => true), true);
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

function nativeHttpWindow(extra = {}) {
  function OriginalXHR() {}
  OriginalXHR.prototype.open = function open() {};
  OriginalXHR.prototype.send = function send() {};
  OriginalXHR.prototype.abort = function abort() {};
  return {
    XMLHttpRequest: function PatchedXHR() {},
    CapacitorWebXMLHttpRequest: {
      fullObject: OriginalXHR,
      prototype: OriginalXHR.prototype,
      open: OriginalXHR.prototype.open,
      send: OriginalXHR.prototype.send,
      abort: OriginalXHR.prototype.abort,
    },
    ...extra,
  };
}

test('Firebase Auth hosts bypass CapacitorHttp only inside the native shell', async () => {
  const calls = [];
  const win = nativeHttpWindow({
    CapacitorWebFetch(input) {
      calls.push(['web', String(input)]);
      return Promise.resolve('web');
    },
    fetch(input) {
      calls.push(['proxy', String(input)]);
      return Promise.resolve('proxy');
    },
  });

  assert.equal(installNativeNetworkBypass(win, true), true);
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
  const win = nativeHttpWindow({
    location: { protocol: 'capacitor:' },
    fetch() { return Promise.resolve('proxy'); },
  });
  delete win.CapacitorWebFetch;
  const original = win.fetch;
  assert.equal(installNativeNetworkBypass(win, true), false);
  assert.equal(win.fetch, original);
  assert.equal(win.__skywayNativeFetch, undefined);
});

test('the website does not patch fetch or XHR even when shell signals are present', async () => {
  const calls = [];
  const win = nativeHttpWindow({
    location: { protocol: 'capacitor:' },
    androidBridge: {},
    webkit: { messageHandlers: { bridge: {} } },
    CapacitorWebFetch(input) {
      calls.push(['web', String(input)]);
      return Promise.resolve('web');
    },
    fetch(input) {
      calls.push(['page', String(input)]);
      return Promise.resolve('page');
    },
  });
  const originalFetch = win.fetch;
  const originalXhr = win.XMLHttpRequest;

  assert.equal(installNativeNetworkBypass(win), false);
  assert.equal(installNativeNetworkBypass(win, false), false);
  assert.equal(win.fetch, originalFetch);
  assert.equal(win.XMLHttpRequest, originalXhr);
  assert.equal(win.__skywayNativeFetch, undefined);

  await win.fetch('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel');
  assert.deepEqual(calls, [
    ['page', 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel'],
  ]);
});

test('a normal browser window does not get the native fetch bypass', () => {
  const win = {
    location: { protocol: 'https:' },
    fetch() { return Promise.resolve('site'); },
  };
  const original = win.fetch;
  assert.equal(installNativeNetworkBypass(win), false);
  assert.equal(installNativeNetworkBypass(win, false), false);
  assert.equal(win.fetch, original);
  assert.equal(win.__skywayNativeFetch, undefined);
});

test('login and home-screen install UI consult native detection', async () => {
  const pwa = await readFile(new URL('../src/PwaInstall.jsx', import.meta.url), 'utf8');
  assert.match(pwa, /shouldOfferPwaInstall/);
  assert.match(pwa, /native: isNativeApp\(\)/);
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /function IosInstallBanner\(\) \{[\s\S]*?if \(isNativeApp\(\)\) return;/);
  const firebase = await readFile(new URL('../src/firebase.js', import.meta.url), 'utf8');
  assert.match(firebase, /Capacitor\.isNativePlatform\(\) === true/);
  assert.match(firebase, /initializeAuth\(app, \{ persistence: indexedDBLocalPersistence \}\)/);
  assert.match(firebase, /return getAuth\(app\)/);
  const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /if \(!isNativeApp\(\) && typeof window !== 'undefined' && 'serviceWorker' in navigator/);
  assert.doesNotMatch(main, /if \(isNativeApp\(\)\) return;/);
  const delegate = await readFile(new URL('../ios/App/App/AppDelegate.swift', import.meta.url), 'utf8');
  assert.match(delegate, /Auth\.auth\(\)\.customAuthDomain = "www\.skyway\.app"/);
});
