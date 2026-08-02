import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  isInQuietHours,
  shouldNotify,
  validSignature,
} from '../api/stream-webhook.js';

test('validSignature accepts only the exact signed raw body', () => {
  const body = Buffer.from('{"type":"message.new"}');
  const secret = 'test-secret';
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(validSignature(body, signature, secret), true);
  assert.equal(validSignature(Buffer.from('{"type":"message.updated"}'), signature, secret), false);
  assert.equal(validSignature(body, '', secret), false);
});

test('quiet hours handle same-day and overnight windows', () => {
  const at23Utc = new Date('2026-08-02T23:30:00.000Z');
  const at12Utc = new Date('2026-08-02T12:30:00.000Z');

  assert.equal(isInQuietHours({
    quietHours: { enabled: true, startHour: 22, endHour: 6, tz: 'UTC' },
  }, at23Utc), true);
  assert.equal(isInQuietHours({
    quietHours: { enabled: true, startHour: 22, endHour: 6, tz: 'UTC' },
  }, at12Utc), false);
  assert.equal(isInQuietHours({
    quietHours: { enabled: true, startHour: 9, endHour: 17, tz: 'UTC' },
  }, at12Utc), true);
});

test('notification policy enforces approval, mute, quiet hours and AOG override', () => {
  assert.equal(shouldNotify(null), false);
  assert.equal(shouldNotify({ approved: false }), false);
  assert.equal(shouldNotify({ approved: true }, { muted: true }), false);

  const nowHour = new Date().getUTCHours();
  const quietProfile = {
    approved: true,
    quietHours: { enabled: true, startHour: nowHour, endHour: (nowHour + 1) % 24, tz: 'UTC' },
  };
  assert.equal(shouldNotify(quietProfile), false);
  assert.equal(shouldNotify(quietProfile, { isAog: true }), true);
  assert.equal(shouldNotify({ ...quietProfile, aogOverridesQuietHours: false }, { isAog: true }), false);
});
