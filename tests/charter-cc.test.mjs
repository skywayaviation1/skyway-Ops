import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  REPLY_TO_CONTACT,
  ensureCharterCc,
  withCharterCopy,
} from '../api/_email-signature.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

const CHARTER = REPLY_TO_CONTACT;

test('the charter inbox is CC\'d even when the caller put it in To', () => {
  // This is the regression: the ops recipient constant IS the charter inbox,
  // so it arrived as a direct recipient and the CC line came out empty.
  const { to, cc } = withCharterCopy({ to: [CHARTER, 'broker@example.com'] });
  assert.deepEqual(to, ['broker@example.com']);
  assert.deepEqual(cc, [CHARTER]);
});

test('a plain broker send gains the charter CC', () => {
  const { to, cc } = withCharterCopy({ to: ['broker@example.com'] });
  assert.deepEqual(to, ['broker@example.com']);
  assert.deepEqual(cc, [CHARTER]);
});

test('an existing CC list is preserved and not duplicated', () => {
  const { to, cc } = withCharterCopy({
    to: ['broker@example.com'],
    cc: ['ops@example.com', CHARTER.toUpperCase()],
  });
  assert.deepEqual(to, ['broker@example.com']);
  assert.deepEqual(cc, ['ops@example.com', CHARTER.toUpperCase()]);
  assert.equal(cc.filter((e) => e.toLowerCase() === CHARTER).length, 1);
});

test('the charter inbox stays addressable when it is the only recipient', () => {
  // A message with an empty To is not deliverable, so it may not be moved to CC.
  const { to, cc } = withCharterCopy({ to: [CHARTER] });
  assert.deepEqual(to, [CHARTER]);
  assert.deepEqual(cc, []);
});

test('recipients are de-duplicated case-insensitively', () => {
  const { to, cc } = withCharterCopy({
    to: ['Broker@Example.com', 'broker@example.com', CHARTER],
  });
  assert.deepEqual(to, ['Broker@Example.com']);
  assert.deepEqual(cc, [CHARTER]);
});

test('a direct recipient is never also CC\'d', () => {
  const { cc } = withCharterCopy({
    to: ['broker@example.com'],
    cc: ['broker@example.com'],
  });
  assert.deepEqual(cc, [CHARTER]);
});

test('string arguments are accepted, not just arrays', () => {
  const { to, cc } = withCharterCopy({ to: 'broker@example.com' });
  assert.deepEqual(to, ['broker@example.com']);
  assert.deepEqual(cc, [CHARTER]);
});

test('ensureCharterCc keeps its original contract for existing callers', () => {
  assert.deepEqual(ensureCharterCc([], ['broker@example.com']), [CHARTER]);
  // Still declines to CC an address that is already a direct recipient.
  assert.deepEqual(ensureCharterCc([], [CHARTER]), []);
});

test('the queued and direct send paths both place the charter copy on CC', async () => {
  const enqueue = await source('api/email-enqueue.js');
  assert.match(enqueue, /withCharterCopy\(\{ to: validTo, cc: validCc \}\)/);
  // The rewritten To must be what is actually sent and recorded, otherwise the
  // address stays on the To line and the CC never appears.
  assert.match(enqueue, /to: finalTo,\n\s+cc: finalCc,/);
  assert.doesNotMatch(enqueue, /to: validTo,\n\s+cc: finalCc,/);

  const direct = await source('api/send-email.js');
  assert.match(direct, /withCharterCopy\(\{ to: validRecipients \}\)/);
  assert.match(direct, /to: finalTo,\n\s+cc: ccList,/);
});

test('every notification sender copies the charter inbox', async () => {
  // Senders that email brokers, customers, or ops about trip and AOG activity.
  const senders = [
    'api/email-enqueue.js',
    'api/send-email.js',
    'api/aog-offer-send.js',
    'api/aog-offer-respond.js',
    'api/aog-public.js',
    'api/aog-chat-nudge.js',
    'api/send-aog-email.js',
    'api/send-aog-references.js',
    'api/send-aog-logbook-email.js',
    'api/service-public.js',
    'api/service-chat-nudge.js',
    'api/send-service-references.js',
    'api/generate-manifest.js',
    'api/generate-report.js',
    'api/currency-alerts.js',
  ];
  for (const file of senders) {
    const text = await source(file);
    assert.match(
      text,
      /withCharterCopy|ensureCharterCc/,
      `${file} sends email without copying ${CHARTER}`,
    );
  }
});

test('the retry cron delivers the CC recorded on the queue row', async () => {
  const drain = await source('api/email-queue-drain.js');
  assert.match(drain, /cc: item\.cc/);
  const transport = await source('api/_email-transport.js');
  assert.match(transport, /if \(ccList\.length > 0\) body\.cc = ccList;/);
});
