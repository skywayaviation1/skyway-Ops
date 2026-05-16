// Shared helper: sign and verify AOG external-access tokens.
//
// Token format (URL-safe):  base64url(aogId).base64url(issuedAtMs).hexHmac
//
// The signature is an HMAC-SHA256 over `${aogId}.${issuedAt}` using
// AOG_LINK_SECRET. We do NOT bake an expiry into the token itself —
// validity is decided at request time by the calling endpoint:
//   - token signature must verify
//   - the AOG must still exist and NOT be resolved
//   - the AOG.linkRevoked flag must be falsy
//   - issuedAt must not predate AOG.linkTokenIssuedAt (rotation kills old links)
//
// This means "valid until the AOG is resolved" + instant revocation, without
// needing to store the token anywhere.

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
  const s = process.env.AOG_LINK_SECRET;
  if (!s || s.length < 16) {
    throw new Error('AOG_LINK_SECRET not configured (min 16 chars)');
  }
  return s;
}

export function signAogToken(aogId, issuedAtMs) {
  if (!aogId) throw new Error('aogId required');
  const issued = String(issuedAtMs || Date.now());
  const payload = `${aogId}.${issued}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${b64url(aogId)}.${b64url(issued)}.${sig}`;
}

// Returns { ok, aogId, issuedAt } or { ok:false, reason }
export function verifyAogToken(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'missing token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed token' };
  }
  let aogId, issuedRaw;
  try {
    aogId = b64urlDecode(parts[0]);
    issuedRaw = b64urlDecode(parts[1]);
  } catch {
    return { ok: false, reason: 'token decode failed' };
  }
  const issuedAt = parseInt(issuedRaw, 10);
  if (!aogId || !Number.isFinite(issuedAt)) {
    return { ok: false, reason: 'bad token payload' };
  }
  const expected = crypto
    .createHmac('sha256', getSecret())
    .update(`${aogId}.${issuedAt}`)
    .digest('hex');
  const got = parts[2];
  // constant-time compare
  if (
    expected.length !== got.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))
  ) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true, aogId, issuedAt };
}
