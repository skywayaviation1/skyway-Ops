import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  addressList,
  escapeHtml,
  graphRetryDelayMs,
  graphRecipients,
  isMailboxConcurrencyError,
  normalizeMessage,
} from '../api/_charter-mail.js';

const root = path.resolve(import.meta.dirname, '..');

test('normalizes Graph messages without exposing raw attachment bytes', () => {
  const message = normalizeMessage({
    id: 'immutable-id',
    conversationId: 'conversation',
    subject: 'Charter request',
    from: { emailAddress: { name: 'Broker', address: 'BROKER@example.com' } },
    toRecipients: [{ emailAddress: { address: 'charters@flyskyway.com' } }],
    receivedDateTime: '2026-08-06T10:00:00Z',
    isRead: false,
    hasAttachments: true,
    body: { contentType: 'html', content: '<p>Hello</p>' },
    attachments: [{
      id: 'a1',
      name: 'itinerary.pdf',
      contentType: 'application/pdf',
      size: 123,
      contentBytes: 'must-not-leak',
    }],
  }, true);
  assert.equal(message.from.address, 'broker@example.com');
  assert.equal(message.to[0].address, 'charters@flyskyway.com');
  assert.equal(message.body.content, '<p>Hello</p>');
  assert.equal(message.attachments[0].name, 'itinerary.pdf');
  assert.equal('contentBytes' in message.attachments[0], false);
});

test('recipient helpers validate and normalize email addresses', () => {
  assert.deepEqual(graphRecipients([
    ' SALES@EXAMPLE.COM ',
    'bad',
    'broker@example.com',
  ]), [
    { emailAddress: { address: 'sales@example.com' } },
    { emailAddress: { address: 'broker@example.com' } },
  ]);
  assert.deepEqual(addressList([
    { emailAddress: { name: 'A', address: 'A@EXAMPLE.COM' } },
  ]), [{ name: 'A', address: 'a@example.com' }]);
});

test('email signatures are HTML escaped', () => {
  assert.equal(escapeHtml('<script>alert(\"x\")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('mailbox APIs are server-side and role restricted', async () => {
  const helper = await readFile(path.join(root, 'api/_charter-mail.js'), 'utf8');
  const route = await readFile(path.join(root, 'api/charter-mail.js'), 'utf8');
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(helper, /roles = \['admin', 'sales'\]/);
  assert.match(helper, /MICROSOFT_MAIL_CLIENT_SECRET/);
  assert.doesNotMatch(await readFile(path.join(root, 'src/CharterInbox.jsx'), 'utf8'), /MICROSOFT_MAIL_CLIENT_SECRET/);
  assert.match(route, /charter-mail-links/);
  assert.match(route, /charter-mail-conversations/);
  assert.match(app, /id: 'inbox'.*roles: \['sales', 'admin'\]/);
});

test('Graph calls use immutable IDs and the shared mailbox user path', async () => {
  const helper = await readFile(path.join(root, 'api/_charter-mail.js'), 'utf8');
  assert.match(helper, /Prefer: 'IdType=\"ImmutableId\"'/);
  assert.match(helper, /\/users\/\$\{encodeURIComponent\(mailboxUpn\(\)\)\}/);
  assert.match(helper, /scope: 'https:\/\/graph\.microsoft\.com\/\.default'/);
});

test('admin and sales profiles can persist an email signature', async () => {
  const auth = await readFile(path.join(root, 'src/firebase-auth.js'), 'utf8');
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(auth, /'emailSignature'/);
  assert.match(app, /EMAIL SIGNATURE/);
});

test('Graph permission and mailbox errors name the administrator fix', async () => {
  const { sharedMailErrorMessage } = await import('../api/_charter-mail.js');
  const denied = sharedMailErrorMessage(403, 'ErrorAccessDenied', 'Insufficient privileges to complete the operation.');
  assert.match(denied, /Mail\.ReadWrite and Mail\.Send with admin consent/);
  assert.match(denied, /application RBAC/);
  assert.match(denied, /charters@flyskyway\.com/);
  const missing = sharedMailErrorMessage(404, 'ResourceNotFound', 'Resource could not be discovered.');
  assert.match(missing, /CHARTER_MAILBOX_UPN/);
  assert.equal(sharedMailErrorMessage(500, null, 'Backend busy'), 'Backend busy');
});

test('shared mailbox status soft-fails when Graph credentials are missing', async () => {
  const helper = await readFile(path.join(root, 'api/_charter-mail.js'), 'utf8');
  const route = await readFile(path.join(root, 'api/charter-mail.js'), 'utf8');
  assert.match(helper, /export function isSharedMailConfigured/);
  assert.match(route, /isSharedMailConfigured\(\)/);
  assert.match(route, /configured: false/);
  assert.match(route, /setupHint/);
});

test('shared mailbox recognizes Microsoft concurrency throttles and retry delays', () => {
  assert.equal(isMailboxConcurrencyError(
    500,
    'MailboxConcurrency',
    'Application is over its MailboxConcurrency limit.',
  ), true);
  assert.equal(isMailboxConcurrencyError(429, null, ''), true);
  assert.equal(isMailboxConcurrencyError(503, null, ''), true);
  assert.equal(isMailboxConcurrencyError(400, 'BadRequest', 'Invalid field'), false);
  const response = { headers: { get: (name) => name === 'retry-after' ? '4' : null } };
  assert.equal(graphRetryDelayMs(response, 0), 4000);
  assert.equal(graphRetryDelayMs({ headers: { get: () => null } }, 1), 1500);
});

test('shared mailbox Graph requests are serialized and contacts are cached', async () => {
  const helper = await readFile(path.join(root, 'api/_charter-mail.js'), 'utf8');
  const route = await readFile(path.join(root, 'api/charter-mail.js'), 'utf8');
  const client = await readFile(path.join(root, 'src/CharterInbox.jsx'), 'utf8');
  assert.match(helper, /mailboxGraphQueue/);
  assert.match(helper, /enqueueMailboxFetch/);
  assert.match(helper, /attempt < 5/);
  assert.match(route, /contactsCache/);
  assert.doesNotMatch(route, /const \[inbox, sent\] = await Promise\.all/);
  assert.match(client, /setMailReady\(true\)/);
  assert.match(client, /if \(!mailReady/);
});
