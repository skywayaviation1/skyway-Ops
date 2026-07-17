// api/_aog-token.js
//
// HMAC-signed tokens for broker accept/decline URLs.
// Format: base64url(coverageId).base64url(issuedAtMs).hexHmac
// Payload: `${coverageId}.${issuedAtMs}` signed with AOG_OFFER_SECRET.
// Validity: 30 days. Broker gets a single URL that stays valid until
// they respond or the window expires.

import crypto from 'crypto';

export const AOG_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function getSecret() {
  const s = process.env.AOG_OFFER_SECRET;
  if (!s || s.length < 24) throw new Error('AOG_OFFER_SECRET not configured (min 24 chars)');
  return s;
}

export function signAogToken(coverageId, issuedAtMs) {
  if (!coverageId) throw new Error('coverageId required');
  const t = issuedAtMs || Date.now();
  const payload = `${coverageId}.${t}`;
  const hmac = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${b64url(coverageId)}.${b64url(String(t))}.${hmac}`;
}

export function verifyAogToken(token) {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  let coverageId, issuedAtMs;
  try {
    coverageId = b64urlDecode(parts[0]);
    issuedAtMs = parseInt(b64urlDecode(parts[1]), 10);
  } catch { return { ok: false, reason: 'unparseable token' }; }
  if (!coverageId || !Number.isFinite(issuedAtMs)) return { ok: false, reason: 'invalid payload' };

  const expected = crypto.createHmac('sha256', getSecret())
    .update(`${coverageId}.${issuedAtMs}`).digest('hex');
  if (expected.length !== parts[2].length) return { ok: false, reason: 'bad signature' };
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts[2], 'hex'))) {
    return { ok: false, reason: 'bad signature' };
  }

  const age = Date.now() - issuedAtMs;
  if (age < 0) return { ok: false, reason: 'issued in future' };
  if (age > AOG_TOKEN_TTL_MS) return { ok: false, reason: 'expired' };

  return { ok: true, coverageId, issuedAtMs };
}
