// Shared helper: sign and verify SERVICE-REQUEST external-access tokens.
//
// Mirror of _aog-token.js but for routine/scheduled service requests. Uses a
// SEPARATE secret (SERVICE_LINK_SECRET) so a service token can never be used
// against the AOG portal and vice-versa.
//
// Token format (URL-safe):  base64url(srId).base64url(issuedAtMs).hexHmac
//
// The signature is an HMAC-SHA256 over `${srId}.${issuedAt}` using
// SERVICE_LINK_SECRET. No expiry is baked into the token — validity is
// decided at request time by the calling endpoint:
//   - token signature must verify
//   - the service request must still exist and NOT be completed
//   - the request's linkRevoked flag must be falsy
//   - issuedAt must not predate linkTokenIssuedAt (rotation kills old links)

import crypto from 'crypto';

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
  const s = process.env.SERVICE_LINK_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SERVICE_LINK_SECRET not configured (min 16 chars)');
  }
  return s;
}

export function signServiceToken(srId, issuedAtMs) {
  if (!srId) throw new Error('srId required');
  const issued = String(issuedAtMs || Date.now());
  const payload = `${srId}.${issued}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${b64url(srId)}.${b64url(issued)}.${sig}`;
}

// Returns { ok, srId, issuedAt } or { ok:false, reason }
export function verifyServiceToken(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'missing token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed token' };
  }
  let srId, issuedRaw;
  try {
    srId = b64urlDecode(parts[0]);
    issuedRaw = b64urlDecode(parts[1]);
  } catch {
    return { ok: false, reason: 'token decode failed' };
  }
  const issuedAt = parseInt(issuedRaw, 10);
  if (!srId || !Number.isFinite(issuedAt)) {
    return { ok: false, reason: 'bad token payload' };
  }
  const expected = crypto
    .createHmac('sha256', getSecret())
    .update(`${srId}.${issuedAt}`)
    .digest('hex');
  const got = parts[2];
  // constant-time compare
  if (
    expected.length !== got.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))
  ) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true, srId, issuedAt };
}
