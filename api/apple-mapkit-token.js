/**
 * Public, origin-bound MapKit JS token endpoint.
 *
 * MapKit JS tokens are intentionally delivered to browsers; the private key
 * that signs them must never be. Each token is restricted to the requesting
 * origin and expires after 15 minutes.
 *
 * Required server environment:
 *   APPLE_MAPKIT_TEAM_ID
 *   APPLE_MAPKIT_KEY_ID
 *   APPLE_MAPKIT_PRIVATE_KEY   (.p8 contents; escaped \\n accepted)
 *
 * Apple Developer setup must also allow each production/preview domain on the
 * Maps identifier associated with that key.
 */

import { createPrivateKey, sign } from 'node:crypto';

export const config = { runtime: 'nodejs' };

const TOKEN_TTL_SECONDS = 15 * 60;

const base64url = (input) => Buffer.from(input)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

export function mapKitConfigured() {
  return Boolean(
    process.env.APPLE_MAPKIT_TEAM_ID
    && process.env.APPLE_MAPKIT_KEY_ID
    && process.env.APPLE_MAPKIT_PRIVATE_KEY,
  );
}

export function requestOrigin(req) {
  const configured = String(process.env.APPLE_MAPKIT_ORIGIN || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return null;
  const proto = req.headers['x-forwarded-proto']
    || (String(host).includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export function createMapKitToken({ teamId, keyId, privateKey, origin, now = Date.now() }) {
  if (!teamId || !keyId || !privateKey) throw new Error('MapKit signing credentials are incomplete');
  if (!origin) throw new Error('MapKit request origin is unavailable');
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: teamId,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
    origin,
  }));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(String(privateKey).replace(/\\n/g, '\n'));
  // ieee-p1363 produces the 64-byte r||s signature JWT expects. The default
  // DER encoding is not a valid ES256 JWT signature.
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Allow-Origin', requestOrigin(req) || 'null');
  res.setHeader('Vary', 'Origin, Host');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!mapKitConfigured()) {
    return res.status(503).json({
      configured: false,
      error: 'Apple Maps is not configured; using the standard map.',
      missing: [
        !process.env.APPLE_MAPKIT_TEAM_ID ? 'APPLE_MAPKIT_TEAM_ID' : null,
        !process.env.APPLE_MAPKIT_KEY_ID ? 'APPLE_MAPKIT_KEY_ID' : null,
        !process.env.APPLE_MAPKIT_PRIVATE_KEY ? 'APPLE_MAPKIT_PRIVATE_KEY' : null,
      ].filter(Boolean),
    });
  }
  try {
    const origin = requestOrigin(req);
    const token = createMapKitToken({
      teamId: process.env.APPLE_MAPKIT_TEAM_ID,
      keyId: process.env.APPLE_MAPKIT_KEY_ID,
      privateKey: process.env.APPLE_MAPKIT_PRIVATE_KEY,
      origin,
    });
    return res.status(200).json({ configured: true, token, expiresIn: TOKEN_TTL_SECONDS });
  } catch (error) {
    console.error('[apple-mapkit-token]', error.message);
    return res.status(500).json({ configured: true, error: 'Apple Maps token could not be signed' });
  }
}

