/**
 * Public, origin-bound MapKit JS token endpoint.
 *
 * MapKit JS tokens are intentionally delivered to browsers; the private key
 * that signs them must never be. Web tokens are restricted to the requesting
 * origin and expire after 15 minutes. Native WebView origins
 * (capacitor://localhost, https://localhost) cannot be registered on an Apple
 * Maps identifier, so those callers receive a short-lived dynamically signed
 * token with no origin claim. APPLE_MAPKIT_ORIGIN is only a fallback when the
 * request itself has no allowlisted origin — it must not stamp every caller.
 *
 * Required server environment:
 *   APPLE_MAPKIT_TOKEN       (preferred for website domains)
 *
 * Or, for dynamic signing (required for the native app):
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

const WEB_ORIGINS = new Set([
  'https://skyway.app',
  'https://www.skyway.app',
  'https://135ops.app',
  'https://www.135ops.app',
]);

const base64url = (input) => Buffer.from(input)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

export function mapKitConfigured() {
  return Boolean(process.env.APPLE_MAPKIT_TOKEN) || Boolean(
    process.env.APPLE_MAPKIT_TEAM_ID
    && process.env.APPLE_MAPKIT_KEY_ID
    && process.env.APPLE_MAPKIT_PRIVATE_KEY,
  );
}

export function canSignMapKitToken() {
  return Boolean(
    process.env.APPLE_MAPKIT_TEAM_ID
    && process.env.APPLE_MAPKIT_KEY_ID
    && process.env.APPLE_MAPKIT_PRIVATE_KEY,
  );
}

export function decodeMapKitToken(token) {
  try {
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 3) return null;
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    };
  } catch {
    return null;
  }
}

export function normalizeMapKitOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    if (!protocol || !hostname && protocol !== 'capacitor:') return '';
    const port = url.port ? `:${url.port}` : '';
    if (protocol === 'capacitor:') return `capacitor://${hostname}${port}`;
    return `${protocol}//${hostname}${port}`;
  } catch {
    return '';
  }
}

function hostForOrigin(origin) {
  const normalized = normalizeMapKitOrigin(origin);
  if (!normalized) return '';
  try { return new URL(normalized).hostname; }
  catch { return ''; }
}

export function configuredMapKitOrigins() {
  const configured = normalizeMapKitOrigin(process.env.APPLE_MAPKIT_ORIGIN || '');
  return configured ? [configured] : [];
}

/**
 * Website origins Skyway actually serves, plus the native WebView origins and
 * any single extra origin from APPLE_MAPKIT_ORIGIN (a staging host, for example).
 */
export function isAllowedMapKitOrigin(origin, { extraOrigins = configuredMapKitOrigins() } = {}) {
  const normalized = normalizeMapKitOrigin(origin);
  if (!normalized) return false;
  if (WEB_ORIGINS.has(normalized) || isNativeMapKitOrigin(normalized)) return true;
  if (extraOrigins.some((extra) => normalizeMapKitOrigin(extra) === normalized)) return true;
  try {
    const url = new URL(normalized);
    if (url.protocol === 'https:' && (url.hostname === 'vercel.app' || url.hostname.endsWith('.vercel.app'))) {
      return true;
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Capacitor iOS is capacitor://localhost. Capacitor Android is https://localhost
 * with no port. A dev server on localhost:5173 is a website, not the native shell.
 */
export function isNativeMapKitOrigin(origin) {
  const normalized = normalizeMapKitOrigin(origin);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    if (url.protocol === 'capacitor:' && url.hostname === 'localhost') return true;
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname === 'localhost' && !url.port) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Apple portal-generated tokens are domain restricted. Reject a token on a
 * different deployment instead of handing it to MapKit and producing a blank
 * map with an opaque SDK error.
 */
export function tokenAllowsOrigin(token, origin) {
  const decoded = decodeMapKitToken(token);
  if (!decoded || decoded.header?.alg !== 'ES256') return false;
  if (decoded.payload?.scope && decoded.payload.scope !== 'mapkit_js') return false;
  const allowed = String(decoded.payload?.origin || '')
    .split(',')
    .map((entry) => {
      const raw = String(entry || '').trim().toLowerCase();
      if (!raw) return '';
      if (raw.includes('*')) return raw.replace(/^https?:\/\//, '').split('/')[0];
      return hostForOrigin(raw);
    })
    .filter(Boolean);
  if (allowed.length === 0) return true;
  const requested = hostForOrigin(origin);
  if (!requested) return false;
  return allowed.some((host) => (
    requested === host
    || (host.startsWith('*.') && (requested === host.slice(2) || requested.endsWith(host.slice(1))))
  ));
}

function header(req, name) {
  const headers = req?.headers || {};
  const direct = headers[name];
  if (Array.isArray(direct)) return direct[0] || '';
  if (typeof direct === 'string') return direct;
  return '';
}

function queryValue(req, name) {
  const fromQuery = req?.query?.[name];
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();
  if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string') return fromQuery[0].trim();
  try {
    const url = new URL(req?.url || '', 'https://localhost');
    return url.searchParams.get(name) || '';
  } catch {
    return '';
  }
}

function originFromReferer(referer) {
  const normalized = normalizeMapKitOrigin(referer);
  if (!normalized) return '';
  try { return new URL(normalized).origin; }
  catch { return normalized; }
}

function originFromForwarded(req) {
  const host = header(req, 'x-forwarded-host') || header(req, 'host');
  if (!host) return '';
  const firstHost = String(host).split(',')[0].trim();
  const protoHeader = header(req, 'x-forwarded-proto');
  const proto = (protoHeader ? String(protoHeader).split(',')[0].trim() : '')
    || (firstHost.includes('localhost') || firstHost.startsWith('127.0.0.1') ? 'http' : 'https');
  return normalizeMapKitOrigin(`${proto}://${firstHost}`);
}

/**
 * The caller's origin. An explicit native `origin` query wins over the
 * production Host header CapacitorHttp presents. APPLE_MAPKIT_ORIGIN is used
 * only when every request-derived candidate is missing or not allowlisted.
 */
export function requestOrigin(req) {
  const candidates = [
    queryValue(req, 'origin'),
    header(req, 'origin'),
    originFromReferer(header(req, 'referer') || header(req, 'referrer')),
    originFromForwarded(req),
    process.env.APPLE_MAPKIT_ORIGIN,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeMapKitOrigin(candidate);
    if (normalized && isAllowedMapKitOrigin(normalized)) return normalized;
  }
  return null;
}

export function corsAllowOrigin(req) {
  const headerOrigin = normalizeMapKitOrigin(header(req, 'origin'));
  if (headerOrigin && isAllowedMapKitOrigin(headerOrigin)) return headerOrigin;
  return requestOrigin(req) || 'null';
}

/**
 * Decide which credential to hand back. Native origins never receive a
 * website-locked portal token: that mismatch is the blank cream grid.
 */
export function planMapKitToken({ origin, suppliedToken = '', canSign = false } = {}) {
  const normalized = normalizeMapKitOrigin(origin);
  if (!normalized || !isAllowedMapKitOrigin(normalized)) {
    return {
      ok: false,
      status: 403,
      error: 'This origin is not allowed to use Apple Maps.',
    };
  }
  if (isNativeMapKitOrigin(normalized)) {
    if (canSign) return { ok: true, mode: 'dynamic-native', signOrigin: null };
    if (suppliedToken && tokenAllowsOrigin(suppliedToken, normalized)) {
      return { ok: true, mode: 'static' };
    }
    return {
      ok: false,
      status: 403,
      error: 'Native Apple Maps needs a dynamically signed token. Using the standard map.',
      code: 'native_requires_signing',
    };
  }
  if (suppliedToken && tokenAllowsOrigin(suppliedToken, normalized)) {
    return { ok: true, mode: 'static' };
  }
  if (canSign) return { ok: true, mode: 'dynamic', signOrigin: normalized };
  if (suppliedToken) {
    const decoded = decodeMapKitToken(suppliedToken);
    return {
      ok: false,
      status: 403,
      error: `Apple Maps token is not valid for ${hostForOrigin(normalized)}. `
        + `Its allowed domain is ${decoded?.payload?.origin || 'not specified'}.`,
    };
  }
  return {
    ok: false,
    status: 503,
    error: 'Apple Maps is not configured; using the standard map.',
  };
}

export function createMapKitToken({ teamId, keyId, privateKey, origin = '', now = Date.now() }) {
  if (!teamId || !keyId || !privateKey) throw new Error('MapKit signing credentials are incomplete');
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const claims = {
    iss: teamId,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
    scope: 'mapkit_js',
  };
  if (origin) claims.origin = origin;
  const payload = base64url(JSON.stringify(claims));
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
  res.setHeader('Access-Control-Allow-Origin', corsAllowOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin, Host');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!mapKitConfigured()) {
    return res.status(503).json({
      configured: false,
      error: 'Apple Maps is not configured; using the standard map.',
      missing: [
        !process.env.APPLE_MAPKIT_TOKEN ? 'APPLE_MAPKIT_TOKEN (or all three signing variables below)' : null,
        !process.env.APPLE_MAPKIT_TEAM_ID ? 'APPLE_MAPKIT_TEAM_ID' : null,
        !process.env.APPLE_MAPKIT_KEY_ID ? 'APPLE_MAPKIT_KEY_ID' : null,
        !process.env.APPLE_MAPKIT_PRIVATE_KEY ? 'APPLE_MAPKIT_PRIVATE_KEY' : null,
      ].filter(Boolean),
    });
  }
  try {
    let suppliedToken = String(process.env.APPLE_MAPKIT_TOKEN || '').trim();
    if (suppliedToken) {
      const decoded = decodeMapKitToken(suppliedToken);
      const broken = !decoded
        ? 'APPLE_MAPKIT_TOKEN is not a valid three-part JWT'
        : decoded.payload?.scope !== 'mapkit_js'
          ? 'APPLE_MAPKIT_TOKEN does not have the required mapkit_js scope'
          : '';
      if (broken && !canSignMapKitToken()) {
        return res.status(500).json({ configured: true, error: broken });
      }
      if (broken) suppliedToken = '';
    }
    const origin = requestOrigin(req);
    const plan = planMapKitToken({
      origin,
      suppliedToken,
      canSign: canSignMapKitToken(),
    });
    if (!plan.ok) {
      return res.status(plan.status).json({
        configured: true,
        error: plan.error,
        ...(plan.code ? { code: plan.code } : {}),
      });
    }
    if (plan.mode === 'static') {
      const decoded = decodeMapKitToken(suppliedToken);
      return res.status(200).json({
        configured: true,
        token: suppliedToken,
        source: 'apple-maps-token',
        allowedOrigin: decoded?.payload?.origin || null,
        expiresAt: decoded?.payload?.exp || null,
      });
    }
    const token = createMapKitToken({
      teamId: process.env.APPLE_MAPKIT_TEAM_ID,
      keyId: process.env.APPLE_MAPKIT_KEY_ID,
      privateKey: process.env.APPLE_MAPKIT_PRIVATE_KEY,
      origin: plan.signOrigin || '',
    });
    return res.status(200).json({
      configured: true,
      token,
      source: plan.mode === 'dynamic-native' ? 'dynamic-signing-native' : 'dynamic-signing',
      originRestricted: plan.mode !== 'dynamic-native',
      expiresIn: TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    console.error('[apple-mapkit-token]', error.message);
    return res.status(500).json({ configured: true, error: 'Apple Maps token could not be signed' });
  }
}
