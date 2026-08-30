// Where an outgoing notification is actually handed off for delivery.
//
// Notifications are sent by Resend as noreply@send.flyskyway.com, a subdomain
// of the operator's own domain. External recipients receive those normally, but
// Exchange Online Protection treats inbound internet mail claiming to come from
// its own organisation as spoofing, so the copies addressed to flyskyway.com
// mailboxes are junked, quarantined, or dropped outright. That is the whole
// shape of the complaint: brokers get the notification and the people running
// the flight do not.
//
// A message submitted through Microsoft Graph as the charter mailbox never
// enters inbound mail flow at all. Exchange originates it inside the tenant, so
// it is authenticated internal mail and lands in the inbox. The application
// grant this needs (Application Mail.Send, scoped to charters@flyskyway.com) is
// already required by the shared inbox feature — see
// docs/charter-shared-inbox-setup.md.
//
// So: tenant mailboxes are delivered by Exchange, everyone else by Resend. When
// Graph is unconfigured or refuses, internal recipients fall back onto the
// provider, which is exactly the behaviour that existed before this split — no
// notification is ever dropped in order to route it more cleanly.

import { fileCharterInboxCopy } from './_charter-copy.js';
import { graphRequest, isSharedMailConfigured, mailboxUpn } from './_charter-mail.js';
import { CHARTER_INBOX } from './_email-signature.js';

/** Provider calls get a hard ceiling so a hung socket cannot hold a request open. */
const PROVIDER_TIMEOUT_MS = 8_000;

const lower = (value) => String(value || '').trim().toLowerCase();
const list = (value) => (Array.isArray(value) ? value : (value ? [value] : []))
  .map((entry) => String(entry || '').trim())
  .filter(Boolean);

/**
 * The mail domain Exchange delivers internally.
 *
 * Derived from the charter mailbox so a tenant rename cannot leave this pointing
 * at the wrong domain, and overridable for operators whose notification
 * recipients sit on a different accepted domain than the charter mailbox.
 */
export function internalMailDomain() {
  const configured = lower(process.env.INTERNAL_MAIL_DOMAIN);
  if (configured) return configured.replace(/^@/, '');
  return lower(mailboxUpn()).split('@')[1] || '';
}

/** Whether Exchange treats this address as one of its own mailboxes. */
export function isInternalAddress(address, domain = internalMailDomain()) {
  if (!domain) return false;
  const value = lower(address);
  const at = value.lastIndexOf('@');
  if (at < 0) return false;
  const host = value.slice(at + 1);
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Split an envelope into the recipients Exchange can deliver and the rest.
 *
 * @param {{to?: string[]|string, cc?: string[]|string}} envelope
 * @param {string} [domain]
 * @returns {{internal: {to: string[], cc: string[]}, external: {to: string[], cc: string[]}}}
 */
export function splitTenantRecipients({ to, cc } = {}, domain = internalMailDomain()) {
  const inside = (entry) => isInternalAddress(entry, domain);
  const toList = list(to);
  const ccList = list(cc);
  return {
    internal: { to: toList.filter(inside), cc: ccList.filter(inside) },
    external: { to: toList.filter((e) => !inside(e)), cc: ccList.filter((e) => !inside(e)) },
  };
}

const graphRecipients = (values) => list(values).map((address) => ({ emailAddress: { address } }));

/**
 * Note, at the top of the internal copy, who else received the notification.
 * Without it the recipient cannot tell whether the broker was already told.
 */
function alsoSentBanner(externalTo, externalCc) {
  const others = [...list(externalTo), ...list(externalCc)];
  if (others.length === 0) return '';
  return '<div style="font-family:-apple-system, Segoe UI, sans-serif;font-size:12px;'
    + 'color:#6b7280;border-bottom:1px solid #d1d5db;padding-bottom:8px;margin-bottom:16px;">'
    + `Also sent to ${others.join(', ')}.`
    + '</div>';
}

/**
 * Have Exchange send the notification as the charter mailbox.
 *
 * @returns {Promise<{ok: boolean, skipped?: string, error?: string, delivered: string[]}>}
 */
export async function sendAsCharterMailbox({ subject, html, to, cc, externalTo, externalCc }) {
  const toRecipients = graphRecipients(to);
  if (toRecipients.length === 0) {
    return { ok: false, skipped: 'no tenant recipients', delivered: [] };
  }
  if (!isSharedMailConfigured()) {
    return { ok: false, skipped: 'Microsoft Graph mail credentials not configured', delivered: [] };
  }
  try {
    await graphRequest(`/users/${encodeURIComponent(mailboxUpn())}/sendMail`, {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: String(subject || '(no subject)').slice(0, 255),
          body: {
            contentType: 'HTML',
            content: alsoSentBanner(externalTo, externalCc) + String(html || ''),
          },
          toRecipients,
          ccRecipients: graphRecipients(cc),
        },
        // Notifications are machine-generated; keeping every one in the charter
        // mailbox's Sent Items would bury the team's own correspondence.
        saveToSentItems: false,
      }),
    });
    return { ok: true, delivered: [...list(to), ...list(cc)].map(lower) };
  } catch (err) {
    console.warn('[email-transport] Exchange send failed ·', err.message);
    return { ok: false, error: err.message || 'Graph sendMail failed', delivered: [] };
  }
}

/** Hand a message to Resend. Returns { ok, id?, error? }. */
export async function sendViaProvider({ to, cc, subject, html, from, replyTo, headers }) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY missing on server' };
  }
  const body = {
    from: from || process.env.OPS_FROM_EMAIL || 'Skyway Ops <noreply@send.flyskyway.com>',
    reply_to: replyTo || process.env.OPS_REPLY_TO || 'charters@flyskyway.com',
    to: list(to),
    subject,
    html,
  };
  const ccList = list(cc);
  if (ccList.length > 0) body.cc = ccList;
  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    body.headers = headers;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error: `Resend ${response.status}: ${data.message || data.error || 'unknown'}`,
      };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: `Network: ${e.message || String(e)}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Deliver one notification, routing each recipient through the path that
 * actually reaches them.
 *
 * The result reports both legs so the queue row records what happened, and is
 * `ok` when every recipient was delivered by one of them. `skipInternal` is set
 * by the retry cron for a row whose internal leg already succeeded, so a
 * provider retry cannot mail the operator's own team a second time.
 *
 * @returns {Promise<{ok: boolean, error: string|null, internal: object, provider: object}>}
 */
export async function deliverNotification({
  to,
  cc,
  subject,
  html,
  from,
  replyTo,
  headers,
  skipInternal = false,
  skipProvider = false,
}, deps = {}) {
  const {
    sendInternal = sendAsCharterMailbox,
    fileCopy = fileCharterInboxCopy,
    sendProvider = sendViaProvider,
    domain = internalMailDomain(),
  } = deps;

  const { internal, external } = splitTenantRecipients({ to, cc }, domain);
  const hasInternal = internal.to.length > 0 || internal.cc.length > 0;

  let internalResult = { ok: true, skipped: 'no tenant recipients', delivered: [] };
  if (hasInternal && skipInternal) {
    internalResult = { ok: true, skipped: 'already delivered on an earlier attempt', delivered: [] };
  } else if (hasInternal) {
    const allInternal = [...internal.to, ...internal.cc];
    const charterAddressed = allInternal.some((entry) => lower(entry) === CHARTER_INBOX);
    const otherTo = internal.to.filter((entry) => lower(entry) !== CHARTER_INBOX);
    const otherCc = internal.cc.filter((entry) => lower(entry) !== CHARTER_INBOX);
    const delivered = [];
    let charterCopy = null;
    let exchange = null;

    // A sendMail request from charters@ to itself can return 202 while Exchange
    // transport rules still suppress the message. A direct Inbox write has no
    // mail-flow hop, so it is the primary path for the charter copy, not merely
    // an error fallback.
    if (charterAddressed) {
      charterCopy = await fileCopy({
        subject, html, to: list(to), cc: list(cc), from,
      });
      if (charterCopy.ok) delivered.push(CHARTER_INBOX);
    }

    if (otherTo.length > 0 || otherCc.length > 0) {
      exchange = await sendInternal({
        subject,
        html,
        to: otherTo.length ? otherTo : otherCc,
        cc: otherTo.length ? otherCc : [],
        externalTo: external.to,
        externalCc: external.cc,
      });
      delivered.push(...(exchange.delivered || []));
    }

    const covered = new Set(delivered.map(lower));
    const missing = allInternal.filter((entry) => !covered.has(lower(entry)));
    internalResult = {
      ok: missing.length === 0,
      delivered: [...covered],
      filedCopy: charterCopy?.ok === true,
      charterCopy,
      exchange,
      missing,
      error: [
        charterCopy && !charterCopy.ok
          ? (charterCopy.error || charterCopy.skipped || 'charter Inbox write failed')
          : '',
        exchange && !exchange.ok
          ? (exchange.error || exchange.skipped || 'Exchange send failed')
          : '',
      ].filter(Boolean).join('; ') || null,
    };
  }

  // Anyone Exchange did not take still has to go out through the provider,
  // filtering risk and all — a filtered notification beats none.
  const covered = new Set((internalResult.delivered || []).map(lower));
  const undelivered = (entries) => entries.filter((entry) => !covered.has(lower(entry)));
  const providerTo = skipProvider
    ? []
    : [...external.to, ...(skipInternal ? [] : undelivered(internal.to))];
  const providerCc = skipProvider
    ? []
    : [...external.cc, ...(skipInternal ? [] : undelivered(internal.cc))];

  if (providerTo.length === 0 && providerCc.length === 0) {
    const providerSatisfied = skipProvider || (external.to.length === 0 && external.cc.length === 0);
    return {
      ok: internalResult.ok && providerSatisfied,
      error: internalResult.ok && providerSatisfied
        ? null
        : (internalResult.error || internalResult.skipped || 'provider delivery incomplete'),
      internal: internalResult,
      provider: {
        ok: providerSatisfied,
        skipped: skipProvider
          ? 'already delivered on an earlier attempt'
          : 'every recipient delivered inside the tenant',
      },
      providerDelivered: skipProvider,
      internalOnly: true,
    };
  }

  // A message needs at least one To; promote a CC when the provider is only
  // left with copied recipients.
  const providerResult = await sendProvider({
    to: providerTo.length ? providerTo : providerCc,
    cc: providerTo.length ? providerCc : [],
    subject,
    html,
    from,
    replyTo,
    headers,
  });

  return {
    // Provider acceptance cannot hide a failed charter Inbox write. Keeping
    // this false leaves the queue retryable, while providerDelivered lets the
    // retry skip the broker leg and avoid a duplicate external email.
    ok: internalResult.ok && providerResult.ok,
    error: !internalResult.ok
      ? (internalResult.error || 'tenant mailbox delivery failed')
      : (providerResult.ok ? null : (providerResult.error || 'unknown error')),
    internal: internalResult,
    provider: providerResult,
    providerDelivered: providerResult.ok,
    internalOnly: false,
  };
}
