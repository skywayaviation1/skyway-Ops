// Shared outbound-mail safety switch.
//
// Every AOG recovery email passes through applyNotifyTestMode before it is
// handed to a transport. Tail-change mail uses the same env names
// (NOTIFY_TEST_MODE, NOTIFY_TEST_RECIPIENT) — import this module instead of
// reimplementing the switch, and keep this file free of feature imports.
//
// NOTIFY_TEST_MODE is ON when unset. Only false / 0 / no / off sends to the
// real recipients. In test mode every to/cc/bcc is replaced with
// NOTIFY_TEST_RECIPIENT (default jake@flyskyway.com), the subject is prefixed
// with [TEST], and the intended recipients are listed at the top of the body.

const LIVE_VALUES = new Set(['false', '0', 'no', 'off']);
const DEFAULT_RECIPIENT = 'jake@flyskyway.com';

function asList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {NodeJS.ProcessEnv} [env] */
export function notifyTestModeEnabled(env = process.env) {
  const raw = env.NOTIFY_TEST_MODE;
  if (raw == null || String(raw).trim() === '') return true;
  return !LIVE_VALUES.has(String(raw).trim().toLowerCase());
}

/** @param {NodeJS.ProcessEnv} [env] */
export function notifyTestRecipient(env = process.env) {
  const value = String(env.NOTIFY_TEST_RECIPIENT || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value;
  return DEFAULT_RECIPIENT;
}

/**
 * Rewrite an envelope so a test deployment cannot reach brokers or CFS.
 *
 * @param {{to?: string[]|string, cc?: string[]|string, bcc?: string[]|string, subject?: string, text?: string, html?: string}} envelope
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyNotifyTestMode(envelope = {}, env = process.env) {
  const intended = {
    to: asList(envelope.to),
    cc: asList(envelope.cc),
    bcc: asList(envelope.bcc),
  };
  const subject = String(envelope.subject || '');
  const text = envelope.text || '';
  const html = envelope.html || '';

  if (!notifyTestModeEnabled(env)) {
    return {
      to: intended.to,
      cc: intended.cc,
      bcc: intended.bcc,
      subject,
      text,
      html,
      testMode: false,
      intended,
    };
  }

  const recipient = notifyTestRecipient(env);
  const toLine = intended.to.join(', ') || '(none)';
  const ccLine = intended.cc.join(', ') || '(none)';
  const bccLine = intended.bcc.join(', ') || '(none)';
  const bannerText = [
    'TEST MODE — this message was not sent to the intended recipients.',
    `To: ${toLine}`,
    `Cc: ${ccLine}`,
    `Bcc: ${bccLine}`,
    '',
  ].join('\n');
  const bannerHtml = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:13px;line-height:1.5;color:#78350f;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 14px;margin:0 0 16px">`
    + `<strong>TEST MODE</strong> — this message was not sent to the intended recipients.`
    + `<div>To: ${escapeHtml(toLine)}</div>`
    + `<div>Cc: ${escapeHtml(ccLine)}</div>`
    + `<div>Bcc: ${escapeHtml(bccLine)}</div>`
    + `</div>`;
  const realSubject = subject.replace(/^\[TEST\]\s*/i, '');

  return {
    to: [recipient],
    cc: [],
    bcc: [],
    subject: `[TEST] ${realSubject}`,
    text: text ? `${bannerText}${text}` : bannerText,
    html: `${bannerHtml}${html}`,
    testMode: true,
    intended,
  };
}
