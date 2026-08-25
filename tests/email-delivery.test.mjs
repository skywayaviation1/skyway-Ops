import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  explainSendFailure,
  isPermanentSendFailure,
  STALE_SENDING_MS,
} from '../api/_email-delivery.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('configuration faults are permanent, transient faults are retried', () => {
  for (const permanent of [
    'RESEND_API_KEY missing on server',
    'Resend 401: API key is invalid',
    'Resend 403: forbidden',
    'Resend 422: The domain is not verified',
    'Resend 400: from address is malformed',
  ]) {
    assert.equal(isPermanentSendFailure(permanent), true, permanent);
  }

  for (const transient of [
    'Resend 429: too many requests',
    'Resend 500: internal error',
    'Resend 503: unavailable',
    'Network: fetch failed',
    'Network: The operation was aborted',
    '',
    null,
  ]) {
    assert.equal(isPermanentSendFailure(transient), false, String(transient));
  }
});

test('failure explanations name the thing an operator must fix', () => {
  assert.match(explainSendFailure('RESEND_API_KEY missing on server'), /RESEND_API_KEY/);
  assert.match(explainSendFailure('Resend 401: bad key'), /API key/i);
  assert.match(explainSendFailure('Resend 422: domain not verified'), /domain/i);
  assert.match(explainSendFailure('Resend 429: slow down'), /retry/i);
  assert.match(explainSendFailure('Network: fetch failed'), /retry/i);
  assert.equal(explainSendFailure('something odd'), 'something odd');
});

test('enqueue reports whether the message actually reached the provider', async () => {
  const text = await source('api/email-enqueue.js');
  // Success path and failure path must both state delivery explicitly.
  assert.match(text, /delivered: true/);
  assert.match(text, /delivered: false/);
  // A standing configuration fault must not be parked in the retry queue.
  assert.match(text, /isPermanentSendFailure\(sendResult\.error\)/);
  assert.match(text, /status: permanent \? 'dead' : 'failed'/);
  assert.match(text, /explanation: explainSendFailure\(sendResult\.error\)/);
});

test('the app treats a provider rejection as a failed notification', async () => {
  const text = await source('src/App.jsx');
  assert.match(text, /const delivered = data\.delivered !== false;/);
  assert.match(text, /status: delivered \? 200 : 502/);
  // `notified` may only be set once delivery succeeded, so the timeline keeps
  // showing the retry affordance for anything that did not go out.
  assert.match(text, /notified: false, \/\/ set to true only after email actually sends/);
});

test('queue drain pages the queue so a backlog cannot starve new mail', async () => {
  const text = await source('api/email-queue-drain.js');
  assert.match(text, /startAfter\(cursor\)/);
  assert.match(text, /MAX_PAGES/);
  // The single unordered fixed-size read is what caused the starvation.
  assert.doesNotMatch(text, /\.where\('status', 'in', \['pending', 'failed'\]\)\s*\n\s*\.limit\(100\)/);
});

test('queue drain reclaims locks abandoned by an interrupted run', async () => {
  const text = await source('api/email-queue-drain.js');
  assert.match(text, /'pending', 'failed', 'sending'/);
  assert.match(text, /STALE_SENDING_MS/);
  assert.ok(STALE_SENDING_MS >= 60_000, 'stale window must exceed a normal send');
  // Permanent faults should not burn all five attempts before anyone is told.
  assert.match(text, /attempts >= maxAttempts \|\| isPermanentSendFailure\(send\.error\)/);
});

test('diagnostics are admin-only and never return key material', async () => {
  const text = await source('api/email-diagnostics.js');
  assert.match(text, /profile\.role !== 'admin'/);
  assert.match(text, /verifyIdToken\(idToken, true\)/);
  // Presence booleans only.
  assert.match(text, /resendApiKey: hasKey/);
  assert.doesNotMatch(text, /resendApiKey: process\.env\.RESEND_API_KEY/);
  assert.doesNotMatch(text, /apiKey: process\.env\.RESEND_API_KEY/);
  // Surfaces the provider's own error rather than a generic failure.
  assert.match(text, /lastError: d\.lastError/);
  assert.match(text, /sendingDomainVerified/);
});

test('the email delivery panel is reachable from settings', async () => {
  const app = await source('src/App.jsx');
  assert.match(app, /EmailDiagnosticsPanelLazy/);
  assert.match(app, /import\('\.\/EmailDiagnosticsPanel\.jsx'\)/);
  const panel = await source('src/EmailDiagnosticsPanel.jsx');
  assert.match(panel, /\/api\/email-diagnostics/);
  assert.match(panel, /action: 'test'/);
  assert.match(panel, /action: 'retry'/);
});
