// /api/_email-signature.js
//
// Shared helpers that apply the Skyway brand wrapper + DO NOT REPLY notice
// to every outgoing email, and auto-CC charters@flyskyway.com so any reply
// (despite the do-not-reply notice) lands in the monitored inbox.
//
// Imported by:
//   - api/email-enqueue.js              (queue-based sends, no attachments)
//   - api/send-aog-references.js        (PDF attachments)
//   - api/send-service-references.js    (PDF attachments)
//   - api/send-aog-email.js             (HTML AOG status emails)
//   - api/send-aog-logbook-email.js     (HTML + PDF logbook)
//   - api/aog-public.js                 (status notifications to externals)
//   - api/service-public.js             (status notifications to externals)
//   - api/aog-chat-nudge.js             (cron, internal nudges)
//   - api/service-chat-nudge.js         (cron, internal nudges)
//   - api/generate-manifest.js          (PDF attachment, internal address)
//   - api/generate-report.js            (PDF attachment, internal address)
//   - api/send-email.js                 (legacy generic sender)
//
// Idempotent — re-wrapping an already-wrapped HTML body is a no-op via the
// SIGNATURE_MARK sentinel. CC dedup is case-insensitive.

export const LOGO_URL = 'https://www.skyway.app/skyway-logo.png';
export const REPLY_TO_CONTACT = 'charters@flyskyway.com';
export const REPLY_TO_PHONE = '727-605-5000';
export const NO_REPLY_NOTICE = 'This is an automated message from Skyway Ops. Please do not reply to this email.';

const SIGNATURE_MARK = '<!-- skyway-signature-applied -->';

/**
 * Wrap an HTML body with the Skyway brand header (logo on black band) and
 * footer (DO NOT REPLY notice + contact info). Idempotent — calling twice
 * doesn't double-wrap.
 *
 * @param {string} rawHtml the body content (will be embedded in a styled cell)
 * @returns {string} the wrapped HTML
 */
export function applySkywaySignature(rawHtml) {
  const html = String(rawHtml || '');
  if (html.includes(SIGNATURE_MARK)) return html;

  const header = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a0a0a; padding:20px 0;">
      <tr>
        <td align="center">
          <img src="${LOGO_URL}" alt="Skyway Aviation Services"
               width="220" style="display:block; max-width:220px; height:auto; border:0;" />
        </td>
      </tr>
    </table>`;

  const footer = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:32px; border-top:1px solid #d1d5db; padding-top:16px;">
      <tr>
        <td align="center" style="font-family:-apple-system, Segoe UI, sans-serif; font-size:12px; color:#6b7280; line-height:1.6;">
          <p style="margin:0 0 8px 0; font-weight:600; color:#374151;">${NO_REPLY_NOTICE}</p>
          <p style="margin:0 0 8px 0;">
            For any questions or replies, contact us at
            <a href="mailto:${REPLY_TO_CONTACT}" style="color:#1ec0e9; text-decoration:none;">${REPLY_TO_CONTACT}</a>
            or call <a href="tel:+1${REPLY_TO_PHONE.replace(/-/g, '')}" style="color:#1ec0e9; text-decoration:none;">${REPLY_TO_PHONE}</a>.
          </p>
          <p style="margin:8px 0 0 0; color:#9ca3af;">
            Skyway Aviation Services &middot; Part 135 Private Jet &amp; Helicopter Charter
          </p>
        </td>
      </tr>
    </table>`;

  return `${SIGNATURE_MARK}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
      <tr><td>${header}</td></tr>
      <tr><td style="padding:24px 20px;">${html}</td></tr>
      <tr><td style="padding:0 20px 20px 20px;">${footer}</td></tr>
    </table>`;
}

/**
 * Ensure charters@flyskyway.com is on the CC list of an outgoing email,
 * UNLESS the primary recipient already IS charters@flyskyway.com (no point
 * CC'ing yourself).
 *
 * @param {string[] | undefined} ccList existing CC list (may be missing)
 * @param {string[] | string | undefined} toList primary recipients (skip CC if already there)
 * @returns {string[]} the final CC list
 */
export function ensureCharterCc(ccList, toList) {
  const list = Array.isArray(ccList) ? ccList.slice() : [];
  // Normalize to[] for the "already addressed to charter?" check.
  const tos = Array.isArray(toList)
    ? toList.map((s) => String(s).trim().toLowerCase())
    : (toList ? [String(toList).trim().toLowerCase()] : []);
  const charterLower = REPLY_TO_CONTACT.toLowerCase();
  // If the email is itself addressed to charters@, don't CC it on its own message.
  if (tos.some((t) => t === charterLower)) return list;
  const hasCharter = list.some((e) => String(e).trim().toLowerCase() === charterLower);
  if (!hasCharter) list.push(REPLY_TO_CONTACT);
  return list;
}

/**
 * Convert plain text to a minimal HTML body, with proper escaping. Used by
 * callers that only have text content but need the signature wrapper (which
 * requires HTML).
 *
 * @param {string} text plain text
 * @returns {string} a basic HTML body, NOT yet wrapped with signature
 */
export function textToHtml(text) {
  const safe = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:-apple-system, Segoe UI, sans-serif; font-size:14px; line-height:1.5; color:#1f2937; white-space:pre-wrap;">${safe}</div>`;
}
