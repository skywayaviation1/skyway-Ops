// Shared email delivery classification.
//
// Imported by api/email-enqueue.js (inline first attempt) and
// api/email-queue-drain.js (retry cron) so both agree on what is worth
// retrying and what is a standing configuration fault.

/** Queue rows stuck in `sending` longer than this are reclaimed. */
export const STALE_SENDING_MS = 5 * 60 * 1000;

/**
 * Whether a Resend rejection will fail the same way on every retry.
 *
 * Missing credentials, an unverified sending domain, or a malformed sender are
 * configuration faults — retrying them for thirty minutes only delays the
 * moment somebody finds out email is broken, and leaves the sender believing
 * the message went out. Rate limits and provider 5xx are transient.
 */
export function isPermanentSendFailure(error) {
  const message = String(error || '');
  if (!message) return false;
  if (/RESEND_API_KEY missing/i.test(message)) return true;
  if (/^Network:/i.test(message)) return false;
  const status = Number((message.match(/Resend (\d{3})/) || [])[1]);
  if (!Number.isFinite(status)) return false;
  if (status === 429) return false;          // rate limited — retry
  if (status >= 500) return false;           // provider outage — retry
  return status >= 400;                      // 401/403/422 etc — config fault
}

/**
 * Human-readable cause for a delivery failure, aimed at whoever has to fix it
 * rather than at whoever sent the trip notification.
 */
export function explainSendFailure(error) {
  const message = String(error || '');
  if (/RESEND_API_KEY missing/i.test(message)) {
    return 'The mail provider API key is not configured on the server (RESEND_API_KEY).';
  }
  if (/Resend 401|Resend 403/.test(message)) {
    return 'The mail provider rejected the API key. Rotate RESEND_API_KEY and redeploy.';
  }
  if (/Resend 422/.test(message)) {
    return 'The mail provider rejected the message — usually an unverified sending domain '
      + 'or an invalid from address. Verify the sending domain and check OPS_FROM_EMAIL.';
  }
  if (/Resend 429/.test(message)) {
    return 'Rate limited by the mail provider. Delivery will retry automatically.';
  }
  if (/^Network:/i.test(message)) {
    return 'Could not reach the mail provider. Delivery will retry automatically.';
  }
  return message || 'Unknown delivery failure.';
}
