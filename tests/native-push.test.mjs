import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nativePushFailureMessage,
  waitForApnsToken,
} from '../src/native-push.js';

test('waitForApnsToken resolves with the token the native plugin retained', async () => {
  let listener = null;
  const messaging = {
    async addListener(name, cb) {
      assert.equal(name, 'apnsTokenReceived');
      listener = cb;
      return { async remove() { listener = null; } };
    },
  };
  const pending = waitForApnsToken(messaging, { timeoutMs: 1000 });
  listener({ token: 'ABCDEF' });
  assert.equal(await pending, 'ABCDEF');
});

test('waitForApnsToken rejects when Apple never returns a device token', async () => {
  const messaging = {
    async addListener() {
      return { async remove() {} };
    },
  };
  await assert.rejects(
    () => waitForApnsToken(messaging, { timeoutMs: 20 }),
    (err) => err.code === 'apns-token-timeout',
  );
});

test('the APNs race is explained instead of the raw FCM sentence', () => {
  const raw = new Error("The operation couldn't be completed. No APNS token specified before fetching FCM Token");
  const text = nativePushFailureMessage(raw);
  assert.match(text, /APNs/);
  assert.doesNotMatch(text, /No APNS token specified/);
  assert.match(nativePushFailureMessage({ code: 'apns-token-timeout', message: 'x' }), /entitlement/);
});
