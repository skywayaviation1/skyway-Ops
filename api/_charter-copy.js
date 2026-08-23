// Deliver the charter inbox its copy of an outgoing notification by writing
// straight into the mailbox with Microsoft Graph.
//
// Why this exists: charters@flyskyway.com lives in the operator's own Microsoft
// 365 tenant, while notifications are sent by an external provider using a
// subdomain of that same domain (noreply@send.flyskyway.com). External
// recipients receive those messages normally, but Exchange Online Protection
// treats inbound mail claiming to be from its own domain as spoofing, so the
// copy addressed to charters@ is filtered before it reaches the inbox. That is
// why brokers get the notification and the charter inbox does not, no matter
// whether the address sits on the To line or the CC line.
//
// Writing the copy directly into the mailbox does not traverse mail flow at
// all, so nothing can filter it. The Graph application grant this uses
// (Application Mail.ReadWrite, scoped to charters@) is already required by the
// Shared Inbox feature — see docs/charter-shared-inbox-setup.md.

import { graphRequest, isSharedMailConfigured, mailboxUpn } from './_charter-mail.js';

/**
 * PR_MESSAGE_FLAGS. Messages created through Graph are drafts by default;
 * writing this property clears the unsent bit so the copy reads as received
 * mail rather than as something half-composed. 0 leaves it unread.
 */
const MESSAGE_FLAGS_PROPERTY = 'Integer 0x0E07';

const address = (value) => ({ emailAddress: { address: String(value).trim() } });

const recipientList = (list) => (Array.isArray(list) ? list : (list ? [list] : []))
  .map((entry) => String(entry || '').trim())
  .filter(Boolean)
  .map(address);

/**
 * File a copy of an outgoing notification in the charter mailbox's Inbox.
 *
 * Best-effort by contract: the caller has already delivered the real message to
 * its recipients, so a failure here is reported but never thrown. Returns a
 * small result object suitable for storing on the audit row.
 *
 * @param {object} message
 * @param {string} message.subject
 * @param {string} message.html      already-wrapped HTML body
 * @param {string[]} message.to      the real recipients, for the copy's header
 * @param {string[]} [message.cc]
 * @param {string} [message.from]    the envelope sender used for the real send
 * @returns {Promise<{ok: boolean, skipped?: string, id?: string, error?: string}>}
 */
export async function fileCharterInboxCopy({ subject, html, to, cc, from }) {
  if (!isSharedMailConfigured()) {
    return { ok: false, skipped: 'shared mailbox Graph credentials not configured' };
  }

  const upn = mailboxUpn();
  const toRecipients = recipientList(to);
  if (toRecipients.length === 0) {
    return { ok: false, skipped: 'no recipients to record' };
  }

  // The banner states plainly why this copy exists, so nobody reading the
  // mailbox mistakes it for the broker's own message or wonders why it is not
  // threaded with the provider-delivered mail.
  const banner = '<div style="font-family:-apple-system, Segoe UI, sans-serif;'
    + 'font-size:12px;color:#6b7280;border-bottom:1px solid #d1d5db;'
    + 'padding-bottom:8px;margin-bottom:16px;">'
    + `Copy filed by Skyway Ops. Sent to ${toRecipients.map((r) => r.emailAddress.address).join(', ')}`
    + (from ? ` from ${String(from)}` : '')
    + '.</div>';

  try {
    const created = await graphRequest(`/users/${encodeURIComponent(upn)}/mailFolders/inbox/messages`, {
      method: 'POST',
      body: JSON.stringify({
        subject: String(subject || '(no subject)').slice(0, 255),
        body: { contentType: 'HTML', content: banner + String(html || '') },
        toRecipients,
        ccRecipients: recipientList(cc),
        isRead: false,
        singleValueExtendedProperties: [
          { id: MESSAGE_FLAGS_PROPERTY, value: '0' },
        ],
      }),
    });
    return { ok: true, id: created?.id || null };
  } catch (err) {
    // A missing Exchange application-scope grant is the likely cause and is
    // worth naming, because the message from Graph reads like a Skyway fault.
    console.warn('[charter-copy] could not file copy in', upn, '·', err.message);
    return { ok: false, error: err.message || 'Graph write failed' };
  }
}
