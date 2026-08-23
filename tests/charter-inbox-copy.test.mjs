import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CHARTER_INBOX, REPLY_TO_CONTACT } from '../api/_email-signature.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('the charter inbox constant is a lower-cased comparison form', () => {
  assert.equal(CHARTER_INBOX, REPLY_TO_CONTACT.toLowerCase());
});

test('the charter copy is written into the mailbox, not emailed', async () => {
  const text = await source('api/_charter-copy.js');
  // A direct mailbox write is the whole point: nothing filters it, unlike
  // inbound mail from a subdomain of the tenant's own domain.
  assert.match(text, /mailFolders\/inbox\/messages/);
  assert.match(text, /method: 'POST'/);
  assert.match(text, /isRead: false/);
  // Messages created through Graph are drafts unless the unsent flag is cleared.
  assert.match(text, /Integer 0x0E07/);
  assert.match(text, /isSharedMailConfigured/);
});

test('filing a copy never breaks the send it is copying', async () => {
  const text = await source('api/_charter-copy.js');
  // Must resolve, never throw: the broker's message has already gone out.
  assert.match(text, /return \{ ok: false, skipped:/);
  assert.match(text, /catch \(err\)/);
  assert.match(text, /return \{ ok: false, error:/);
  assert.doesNotMatch(text, /throw new Error/);
});

test('the notification path files a copy whenever the charter inbox is a recipient', async () => {
  const text = await source('api/email-enqueue.js');
  assert.match(text, /fileCharterInboxCopy\(\{/);
  assert.match(text, /CHARTER_INBOX/);
  // Recorded on the audit row so the panel can report whether it worked.
  assert.match(text, /charterCopy,/);
  // Filed after the real send, so a Graph problem cannot delay the broker.
  const sendIndex = text.indexOf('sendViaResendInline({');
  const copyIndex = text.indexOf('fileCharterInboxCopy({');
  assert.ok(sendIndex > 0 && copyIndex > sendIndex, 'copy must be filed after the send');
});

test('diagnostics report the provider outcome and the mailbox copy', async () => {
  const text = await source('api/email-diagnostics.js');
  // Per-message outcome distinguishes "provider never delivered" from
  // "delivered, then filtered at the receiving end".
  assert.match(text, /api\.resend\.com\/emails\//);
  assert.match(text, /last_event/);
  assert.match(text, /charterInbox:/);
  assert.match(text, /mailboxWriteConfigured/);
  assert.match(text, /sameTenantAsSender/);

  const panel = await source('src/EmailDiagnosticsPanel.jsx');
  assert.match(panel, /CHARTER INBOX COPY/);
  assert.match(panel, /PROVIDER DELIVERY OUTCOME/);
  assert.match(panel, /recentDeliveries/);
});
