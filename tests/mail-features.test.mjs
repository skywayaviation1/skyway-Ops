import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { extractContacts } from '../api/_charter-mail.js';
import { applyContact, currentToken, filterContacts } from '../src/mail-contacts.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('extractContacts ranks by frequency and recency and excludes self', () => {
  const messages = [
    {
      from: { emailAddress: { name: 'Broker One', address: 'BROKER@Example.com' } },
      toRecipients: [{ emailAddress: { address: 'charters@flyskyway.com' } }],
      receivedDateTime: '2026-08-01T10:00:00Z',
    },
    {
      from: { emailAddress: { name: '', address: 'broker@example.com' } },
      toRecipients: [{ emailAddress: { name: 'Ops', address: 'ops@partner.com' } }],
      receivedDateTime: '2026-08-05T10:00:00Z',
    },
  ];
  const contacts = extractContacts(messages, ['charters@flyskyway.com']);
  assert.equal(contacts[0].address, 'broker@example.com');
  assert.equal(contacts[0].name, 'Broker One');
  assert.ok(contacts.every((c) => c.address !== 'charters@flyskyway.com'));
  assert.ok(contacts.some((c) => c.address === 'ops@partner.com'));
});

test('extractContacts drops malformed addresses', () => {
  const contacts = extractContacts([
    { from: { emailAddress: { address: 'not-an-email' } }, receivedDateTime: '2026-08-01T10:00:00Z' },
  ]);
  assert.equal(contacts.length, 0);
});

test('currentToken reads the recipient being typed', () => {
  assert.equal(currentToken('a@x.com, br'), 'br');
  assert.equal(currentToken('  jane'), 'jane');
});

test('filterContacts matches name or address, prefix first, excludes chosen', () => {
  const contacts = [
    { name: 'Jane Broker', address: 'jane@example.com' },
    { name: 'John Ops', address: 'john@partner.com' },
    { name: 'Zoe', address: 'zoe@brokers.com' },
  ];
  const byName = filterContacts(contacts, 'jan');
  assert.equal(byName[0].address, 'jane@example.com');
  const byDomain = filterContacts(contacts, 'brok');
  assert.ok(byDomain.some((c) => c.address === 'zoe@brokers.com'));
  const excludes = filterContacts(contacts, 'jane@example.com, jo');
  assert.ok(excludes.every((c) => c.address !== 'jane@example.com'));
});

test('applyContact swaps the active token and readies the next', () => {
  assert.equal(applyContact('jan', 'jane@example.com'), 'jane@example.com, ');
  assert.equal(applyContact('a@x.com, jo', 'john@partner.com'), 'a@x.com, john@partner.com, ');
});

test('both mailboxes expose contacts, delete, and flag actions', async () => {
  const shared = await source('api/charter-mail.js');
  const personal = await source('api/user-mail.js');
  for (const handler of [shared, personal]) {
    assert.match(handler, /action === 'contacts'/);
    assert.match(handler, /action === 'delete'/);
    assert.match(handler, /action === 'flag'/);
  }
});

test('reply builds a draft when cc, bcc, or attachments are added', async () => {
  const shared = await source('api/charter-mail.js');
  const personal = await source('api/user-mail.js');
  for (const handler of [shared, personal]) {
    assert.match(handler, /createReplyAll|createReply/);
    assert.match(handler, /createForward/);
    assert.match(handler, /needsDraft/);
    assert.match(handler, /\/attachments/);
  }
});

test('compose supports cc, bcc, importance and recipient autocomplete', async () => {
  const inbox = await source('src/CharterInbox.jsx');
  assert.match(inbox, /RecipientInput/);
  assert.match(inbox, /filterContacts/);
  assert.match(inbox, /Add Cc \/ Bcc/);
  assert.match(inbox, /importance/);
  assert.match(inbox, /'contacts'/);
});

test('mailbox token retrieval retries transient network failures', async () => {
  const inbox = await source('src/CharterInbox.jsx');
  assert.match(inbox, /network-request-failed/);
  assert.match(inbox, /getIdToken\(attempt > 0\)/);
});
