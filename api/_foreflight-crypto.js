/**
 * ForeFlight Dispatch webhook crypto helpers (Node-only).
 * Kept separate from firebase so unit tests can import without credentials.
 */

import crypto from 'node:crypto';

/**
 * Verify ForeFlight webhook authenticity.
 *
 * From the OpenAPI description:
 *   x-foreflight-signature = HMAC-SHA256(UTF8(content), UTF8(secret))
 *   x-foreflight-salt      = base64(16 random bytes)
 *   x-foreflight-auth      = base64(HMAC-SHA256(salt, UTF8(secret)))
 */
export function verifyForeFlightWebhook({
  rawBody,
  secret,
  signatureHeader,
  authHeader,
  saltHeader,
}) {
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
  const secretBuf = Buffer.from(String(secret), 'utf8');

  if (saltHeader && authHeader) {
    let salt;
    try {
      salt = Buffer.from(String(saltHeader), 'base64');
    } catch {
      return { ok: false, reason: 'invalid salt' };
    }
    const expectedAuth = crypto
      .createHmac('sha256', secretBuf)
      .update(salt)
      .digest('base64');
    const a = Buffer.from(String(authHeader));
    const b = Buffer.from(expectedAuth);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'auth mismatch' };
    }
  }

  if (signatureHeader) {
    const expectedHex = crypto.createHmac('sha256', secretBuf).update(body).digest('hex');
    const expectedB64 = crypto.createHmac('sha256', secretBuf).update(body).digest('base64');
    const provided = String(signatureHeader).trim();
    const candidates = [expectedHex, expectedB64, `sha256=${expectedHex}`];
    const match = candidates.some((c) => {
      const a = Buffer.from(c);
      const b = Buffer.from(provided);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (!match) return { ok: false, reason: 'signature mismatch' };
    return { ok: true, via: 'signature' };
  }

  if (saltHeader && authHeader) return { ok: true, via: 'auth' };
  return { ok: false, reason: 'missing signature headers' };
}

export function randomWebhookSecret() {
  return crypto.randomBytes(24).toString('base64url');
}
