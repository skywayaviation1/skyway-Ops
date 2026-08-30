/**
 * HMAC token scoped to one brokered flight's external-operator portal.
 *
 * Uses a dedicated secret when configured. TRIP_LINK_SECRET is an acceptable
 * compatibility fallback because the signed message has an `operator:` domain
 * prefix and therefore can never validate as a broker tracking token.
 */

import crypto from 'node:crypto';

function secret() {
  const value = process.env.OPERATOR_LINK_SECRET || process.env.TRIP_LINK_SECRET;
  if (!value || value.length < 16) {
    throw new Error('OPERATOR_LINK_SECRET (or TRIP_LINK_SECRET fallback) is not configured');
  }
  return value;
}

const enc = (value) => Buffer.from(String(value), 'utf8').toString('base64url');
const dec = (value) => Buffer.from(String(value), 'base64url').toString('utf8');

function signature(tripId, issuedAt) {
  return crypto
    .createHmac('sha256', secret())
    .update(`operator:${tripId}:${issuedAt}`)
    .digest('base64url');
}

export function signOperatorToken(tripId, issuedAt) {
  return `${enc(tripId)}.${issuedAt}.${signature(tripId, issuedAt)}`;
}

export function verifyOperatorToken(token) {
  try {
    const [encodedTripId, issuedText, supplied] = String(token || '').split('.');
    const tripId = dec(encodedTripId);
    const issuedAt = Number(issuedText);
    if (!tripId || !Number.isFinite(issuedAt) || !supplied) {
      return { ok: false, reason: 'invalid token' };
    }
    const expected = signature(tripId, issuedAt);
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'invalid signature' };
    }
    return { ok: true, tripId, issuedAt };
  } catch {
    return { ok: false, reason: 'invalid token' };
  }
}

