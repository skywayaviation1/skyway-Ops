// Shared outbound-email safety switch.
//
// Another feature (AOG coverage mail) uses this same module and the same
// env vars. Keep it dependency-free.
//
// NOTIFY_TEST_MODE defaults to ON. Unset, empty, or any value other than
// the string "false" is test mode. Only NOTIFY_TEST_MODE=false leaves the
// real recipients in place.
//
// In test mode every to/cc/bcc address is replaced with NOTIFY_TEST_RECIPIENT
// (default jake@flyskyway.com), the subject is prefixed with [TEST], and the
// intended recipients are written at the top of the body.

export const DEFAULT_TEST_RECIPIENT = 'jake@flyskyway.com';

const list = (value) => {
  const source = Array.isArray(value) ? value : (value ? [value] : []);
  return source.map((entry) => String(entry || '').trim()).filter(Boolean);
};

export function isNotifyTestMode(env = process.env) {
  const raw = env?.NOTIFY_TEST_MODE;
  if (raw == null) return true;
  const value = String(raw).trim().toLowerCase();
  if (!value) return true;
  return value !== 'false';
}

export function notifyTestRecipient(env = process.env) {
  const raw = String(env?.NOTIFY_TEST_RECIPIENT || '').trim();
  return raw || DEFAULT_TEST_RECIPIENT;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rewrite one outbound message according to the safety switch.
 *
 * @param {{to?: string[]|string, cc?: string[]|string, bcc?: string[]|string, subject?: string, text?: string|null, html?: string|null}} message
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{to: string[], cc: string[], bcc: string[], subject: string, text: string|null, html: string|null, testMode: boolean, intended: {to: string[], cc: string[], bcc: string[]}}}
 */
export function applyNotifySafety(message = {}, env = process.env) {
  const intended = {
    to: list(message.to),
    cc: list(message.cc),
    bcc: list(message.bcc),
  };
  const subject = String(message.subject || '');
  const text = message.text == null ? null : String(message.text);
  const html = message.html == null ? null : String(message.html);

  if (!isNotifyTestMode(env)) {
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
  const banner = [
    '[TEST MODE] This message was not delivered to the intended recipients.',
    `Intended To: ${intended.to.join(', ') || '(none)'}`,
    `Intended Cc: ${intended.cc.join(', ') || '(none)'}`,
    `Intended Bcc: ${intended.bcc.join(', ') || '(none)'}`,
    '',
  ].join('\n');
  const safeSubject = subject.startsWith('[TEST]') ? subject : `[TEST] ${subject}`.trim();

  return {
    to: [recipient],
    cc: [],
    bcc: [],
    subject: safeSubject,
    text: text == null ? null : `${banner}${text}`,
    html: html == null
      ? null
      : `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:13px;line-height:1.45;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;padding:10px 12px;margin:0 0 16px 0;white-space:pre-wrap;">${escapeHtml(banner).trim()}</div>${html}`,
    testMode: true,
    intended,
  };
}
