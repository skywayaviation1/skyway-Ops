// Shared helper: sign and verify TRIP public-tracking tokens.
//
// Token format (URL-safe):  base64url(tripId).base64url(issuedAtMs).hexHmac
//
// HMAC over `${tripId}.${issuedAt}` with TRIP_LINK_SECRET. Validity is
// decided per request by the caller:
//   - signature must verify
//   - the trip must exist
//   - the trip.linkRevoked flag must be falsy
//   - issuedAt must be >= trip.linkTokenIssuedAt (rotation kills old links)
//   - if the trip's last leg has actuallyOn (landed) AND it was >24h ago,
//     access denied (auto-expiry per product spec)

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
  const s = process.env.TRIP_LINK_SECRET;
  if (!s || s.length < 16) {
    throw new Error('TRIP_LINK_SECRET not configured (min 16 chars)');
  }
  return s;
}

export function signTripToken(tripId, issuedAtMs) {
  if (!tripId) throw new Error('tripId required');
  const issued = String(issuedAtMs || Date.now());
  const payload = `${tripId}.${issued}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${b64url(tripId)}.${b64url(issued)}.${sig}`;
}

// Returns { ok, tripId, issuedAt } or { ok:false, reason }
export function verifyTripToken(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'missing token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed token' };
  }
  let tripId, issuedRaw;
  try {
    tripId = b64urlDecode(parts[0]);
    issuedRaw = b64urlDecode(parts[1]);
  } catch {
    return { ok: false, reason: 'token decode failed' };
  }
  const issuedAt = parseInt(issuedRaw, 10);
  if (!tripId || !Number.isFinite(issuedAt)) {
    return { ok: false, reason: 'bad token payload' };
  }
  const expected = crypto
    .createHmac('sha256', getSecret())
    .update(`${tripId}.${issuedAt}`)
    .digest('hex');
  const got = parts[2];
  if (
    expected.length !== got.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))
  ) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true, tripId, issuedAt };
}
