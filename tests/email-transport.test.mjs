import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  deliverNotification,
  isInternalAddress,
  splitTenantRecipients,
} from '../api/_email-transport.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

const DOMAIN = 'flyskyway.com';

/** Records what each leg was asked to deliver. */
function recorder({ internalOk = true, providerOk = true, fileOk = true } = {}) {
  const calls = { internal: [], provider: [], filed: [] };
  return {
    calls,
    deps: {
      domain: DOMAIN,
      sendInternal: async (message) => {
        calls.internal.push(message);
        return internalOk
          ? { ok: true, delivered: [...message.to, ...(message.cc || [])].map((e) => e.toLowerCase()) }
          : { ok: false, error: 'Graph refused', delivered: [] };
      },
      sendProvider: async (message) => {
        calls.provider.push(message);
        return providerOk ? { ok: true, id: 'resend-1' } : { ok: false, error: 'Resend 422: nope' };
      },
      fileCopy: async (message) => {
        calls.filed.push(message);
        return fileOk ? { ok: true, id: 'graph-1' } : { ok: false, error: 'no mailbox write' };
      },
    },
  };
}

const message = (to, cc = []) => ({
  to, cc, subject: 'Trip update', html: '<p>update</p>',
});

test('addresses in the tenant domain are recognised, including subdomains', () => {
  assert.equal(isInternalAddress('charters@flyskyway.com', DOMAIN), true);
  assert.equal(isInternalAddress('Ops@FlySkyway.com ', DOMAIN), true);
  assert.equal(isInternalAddress('crew@mail.flyskyway.com', DOMAIN), true);
  assert.equal(isInternalAddress('broker@jets.com', DOMAIN), false);
  // A lookalike domain must not be mistaken for the tenant's own.
  assert.equal(isInternalAddress('spoof@notflyskyway.com', DOMAIN), false);
  assert.equal(isInternalAddress('charters@flyskyway.com', ''), false);
  assert.equal(isInternalAddress('not-an-address', DOMAIN), false);
});

test('an envelope splits into tenant mailboxes and everyone else', () => {
  const split = splitTenantRecipients({
    to: ['broker@jets.com', 'ops@flyskyway.com'],
    cc: ['charters@flyskyway.com', 'agent@brokerage.com'],
  }, DOMAIN);
  assert.deepEqual(split.internal, { to: ['ops@flyskyway.com'], cc: ['charters@flyskyway.com'] });
  assert.deepEqual(split.external, { to: ['broker@jets.com'], cc: ['agent@brokerage.com'] });
});

test('the charter copy is filed directly and kept off the provider envelope', async () => {
  const { calls, deps } = recorder();
  const result = await deliverNotification(
    message(['broker@jets.com'], ['charters@flyskyway.com']),
    deps,
  );

  assert.equal(result.ok, true);
  assert.equal(result.internal.ok, true);
  // The mailbox copy bypasses mail flow entirely.
  assert.equal(calls.filed.length, 1);
  assert.equal(calls.internal.length, 0);
  // It is not on the provider message, which would only be filtered
  // and would arrive twice when it was not.
  assert.deepEqual(calls.provider[0].to, ['broker@jets.com']);
  assert.deepEqual(calls.provider[0].cc, []);
});

test('a notice addressed only to our own people never touches the provider', async () => {
  const { calls, deps } = recorder();
  const result = await deliverNotification(
    message(['charters@flyskyway.com', 'ops@flyskyway.com']),
    deps,
  );

  assert.equal(result.ok, true);
  assert.equal(result.internalOnly, true);
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.filed.length, 1);
  assert.deepEqual(calls.internal[0].to, ['ops@flyskyway.com']);
});

test('the charter inbox is filed even when Exchange is unavailable', async () => {
  const { calls, deps } = recorder({ internalOk: false });
  const result = await deliverNotification(
    message(['broker@jets.com'], ['charters@flyskyway.com']),
    deps,
  );

  assert.equal(calls.filed.length, 1);
  assert.equal(result.internal.filedCopy, true);
  assert.equal(result.ok, true);
  // Covered by the direct write, so it stays off the provider envelope.
  assert.deepEqual(calls.provider[0].to, ['broker@jets.com']);
});

test('a tenant recipient Exchange cannot reach still goes out through the provider', async () => {
  const { calls, deps } = recorder({ internalOk: false, fileOk: false });
  const result = await deliverNotification(message(['ops@flyskyway.com']), deps);

  // Falling back to a filtered path beats not sending the notification at all.
  assert.equal(result.ok, true);
  assert.deepEqual(calls.provider[0].to, ['ops@flyskyway.com']);
  // The fallback is still reported, because that copy can be filtered on arrival.
  assert.equal(result.tenantMailDegraded, true);
  assert.match(result.tenantMailError, /Graph refused|mailbox write/);
});

test('a broken Graph credential never reports the broker email as failed', async () => {
  const { calls, deps } = recorder({ internalOk: false, fileOk: false });
  const result = await deliverNotification(
    message(['broker@jets.com'], ['charters@flyskyway.com']),
    deps,
  );

  // The dispatcher-facing contract: the broker was notified, so the status
  // must not claim otherwise or offer a retry that would send it twice.
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.deepEqual(calls.provider[0].to, ['broker@jets.com']);
  assert.ok(calls.provider[0].cc.includes('charters@flyskyway.com'));
  // The charter copy problem is still surfaced for repair.
  assert.equal(result.tenantMailDegraded, true);
});

test('a retry does not mail our own team a second time', async () => {
  const { calls, deps } = recorder();
  const result = await deliverNotification(
    { ...message(['broker@jets.com'], ['charters@flyskyway.com']), skipInternal: true },
    deps,
  );

  assert.equal(calls.internal.length, 0);
  assert.deepEqual(calls.provider[0].to, ['broker@jets.com']);
  assert.equal(result.ok, true);
});

test('a failed charter copy falls back to the provider instead of being dropped', async () => {
  const { calls, deps } = recorder({ fileOk: false });
  const result = await deliverNotification(
    message(['broker@jets.com'], ['charters@flyskyway.com']),
    deps,
  );

  assert.equal(calls.filed.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.tenantMailDegraded, true);
  // charters@ is not silently abandoned: it rides along on the provider copy.
  assert.ok(calls.provider[0].cc.includes('charters@flyskyway.com'));
});

test('an invalid_client Graph failure is explained in Entra terms', async () => {
  const { explainGraphTokenFailure, mailCredential } = await import('../api/_charter-mail.js');

  const message = explainGraphTokenFailure('invalid_client');
  assert.match(message, /MICROSOFT_MAIL_CLIENT_SECRET/);
  assert.match(message, /Value \(not the Secret ID\)/);
  assert.match(explainGraphTokenFailure('', 'AADSTS7000215: bad secret'), /AADSTS7000215/);

  // A pasted secret with a trailing newline or wrapping quotes is the most
  // common cause of invalid_client and must not reach Microsoft that way.
  process.env.SKYWAY_TEST_SECRET = '"abc123"\n';
  assert.equal(mailCredential('SKYWAY_TEST_SECRET'), 'abc123');
  delete process.env.SKYWAY_TEST_SECRET;
});

test('a provider rejection is reported even when the tenant leg succeeded', async () => {
  const { deps } = recorder({ providerOk: false });
  const result = await deliverNotification(
    message(['broker@jets.com'], ['charters@flyskyway.com']),
    deps,
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /Resend 422/);
  assert.equal(result.internal.ok, true);
});

test('a copied-only provider envelope promotes a CC so the message is deliverable', async () => {
  const { calls, deps } = recorder();
  await deliverNotification(message(['charters@flyskyway.com'], ['broker@jets.com']), deps);

  assert.deepEqual(calls.provider[0].to, ['broker@jets.com']);
  assert.deepEqual(calls.provider[0].cc, []);
});

test('the internal copy names the outside recipients it was also sent to', async () => {
  const text = await source('api/_email-transport.js');
  assert.match(text, /Also sent to/);
  // Exchange originates the message, so it is not inbound mail and is not
  // filtered as spoofed.
  assert.match(text, /sendMail/);
  assert.match(text, /saveToSentItems: false/);
});

test('both the inline send and the retry cron use one routing decision', async () => {
  const enqueue = await source('api/email-enqueue.js');
  const drain = await source('api/email-queue-drain.js');
  assert.match(enqueue, /deliverNotification\(\{/);
  assert.match(drain, /deliverNotification\(\{/);
  // The retry path must know the tenant leg already happened.
  assert.match(drain, /skipInternal: item\.internalDelivered === true/);
  assert.match(drain, /internalDelivered: item\.internalDelivered === true \|\| send\.internal\?\.ok === true/);
  // A degraded tenant leg is recorded, not converted into a delivery failure.
  assert.match(drain, /tenantMailDegraded/);
  assert.match(enqueue, /tenantMailDegraded/);
  // No second provider implementation to drift out of step.
  assert.doesNotMatch(drain, /api\.resend\.com/);
  assert.doesNotMatch(enqueue, /api\.resend\.com/);

  // The legacy direct sender is the fallback the app uses when the queue
  // endpoint is unreachable, so it cannot keep its own unrouted send.
  const legacy = await source('api/send-email.js');
  assert.match(legacy, /deliverNotification\(\{/);
  assert.doesNotMatch(legacy, /api\.resend\.com/);
});

test('the provider call cannot hang a request open forever', async () => {
  const text = await source('api/_email-transport.js');
  assert.match(text, /PROVIDER_TIMEOUT_MS/);
  assert.match(text, /controller\.abort\(\)/);
  assert.match(text, /signal: controller\.signal/);
});

test('diagnostics test sends prove the path a real notification takes', async () => {
  const text = await source('api/email-diagnostics.js');
  assert.match(text, /deliverNotification\(\{/);
  assert.match(text, /route: internal \? 'tenant-mailbox' : 'provider'/);
  assert.match(text, /tenantMail:/);
  assert.match(text, /graphConfigured/);
  const panel = await source('src/EmailDiagnosticsPanel.jsx');
  assert.match(panel, /YOUR OWN MAILBOXES/);
  assert.match(panel, /Fell back to provider/);
});
