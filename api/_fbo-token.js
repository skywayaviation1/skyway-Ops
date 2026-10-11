// HMAC links for the public FBO arrival page. No login.
// Format: base64url(legUid).base64url(issuedAtMs).hexHmac
// Payload signed: `${legUid}.${issuedAtMs}` with FBO_LINK_SECRET.

import crypto from 'node:crypto';
import { TOKEN_TTL_MS } from '../src/fbo-notify.js';

function b64url(value) {
  return Buffer.from(String(value)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value) {
  let str = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

export function fboLinkSecret(env = process.env) {
  const secret = String(env.FBO_LINK_SECRET || '');
  if (secret.length < 24) {
    const error = new Error('FBO_LINK_SECRET is not configured (min 24 chars)');
    error.status = 503;
    error.code = 'fbo_link_secret_missing';
    throw error;
  }
  return secret;
}

export function signFboToken(legUid, issuedAtMs = Date.now(), env = process.env) {
  if (!legUid) throw new Error('legUid required');
  const payload = `${legUid}.${issuedAtMs}`;
  const hmac = crypto.createHmac('sha256', fboLinkSecret(env)).update(payload).digest('hex');
  return `${b64url(legUid)}.${b64url(String(issuedAtMs))}.${hmac}`;
}

export function verifyFboToken(token, now = Date.now(), env = process.env) {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  let legUid;
  let issuedAtMs;
  try {
    legUid = b64urlDecode(parts[0]);
    issuedAtMs = parseInt(b64urlDecode(parts[1]), 10);
  } catch {
    return { ok: false, reason: 'unparseable token' };
  }
  if (!legUid || !Number.isFinite(issuedAtMs)) return { ok: false, reason: 'invalid payload' };
  let expected;
  try {
    expected = crypto.createHmac('sha256', fboLinkSecret(env))
      .update(`${legUid}.${issuedAtMs}`).digest('hex');
  } catch (error) {
    return { ok: false, reason: error.code || 'secret' };
  }
  const given = parts[2];
  if (expected.length !== given.length) return { ok: false, reason: 'bad signature' };
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(given, 'hex');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, reason: 'bad signature' };
  }
  const age = now - issuedAtMs;
  if (age < -60_000) return { ok: false, reason: 'issued in future' };
  if (age > TOKEN_TTL_MS) return { ok: false, reason: 'expired' };
  return { ok: true, legUid, issuedAtMs };
}
