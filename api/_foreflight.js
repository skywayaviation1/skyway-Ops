/**
 * Server-only ForeFlight Dispatch client.
 *
 * Auth: x-api-key (+ optional x-vendorId). Keys live in Firestore
 * `foreflight/config` so each tenant can bring their own Dispatch subscription.
 * Spec: https://public-api.foreflight.com/swagger/v1/swagger.json
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { publicForeFlightConfig } from '../src/foreflight.js';
import {
  randomWebhookSecret,
  verifyForeFlightWebhook,
} from './_foreflight-crypto.js';

export { publicForeFlightConfig, randomWebhookSecret, verifyForeFlightWebhook };

const BASE_URL = 'https://public-api.foreflight.com';
const CONFIG_DOC = ['foreflight', 'config'];

let app = null;

export function getAdminApp() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return app;
}

export function getDb() {
  return getFirestore(getAdminApp(), 'appusers');
}

export async function authorizeForeFlightCaller(idToken, roles = ['admin', 'ops']) {
  if (!idToken) {
    const error = new Error('idToken required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = await admin.auth(getAdminApp()).verifyIdToken(idToken, true);
  } catch {
    const error = new Error('Invalid or revoked session');
    error.status = 401;
    throw error;
  }
  const snap = await getDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (
    !snap.exists
    || !roles.includes(profile.role)
    || profile.active === false
    || profile.approved !== true
  ) {
    const error = new Error(`${roles.join(' or ')} role required`);
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    email: decoded.email || profile.email || '',
    name: profile.name || decoded.name || decoded.email || 'User',
    role: profile.role,
    profile,
  };
}

export async function readConfig() {
  const snap = await getDb().doc(CONFIG_DOC.join('/')).get();
  return snap.exists ? snap.data() : null;
}

export async function writeConfig(patch) {
  const ref = getDb().doc(CONFIG_DOC.join('/'));
  await ref.set({ ...patch, updatedAt: Date.now() }, { merge: true });
  const snap = await ref.get();
  return snap.data();
}

export function appBaseUrl(req) {
  const fromEnv = String(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL.replace(/\/$/, '')}`;
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  if (host) return `${proto}://${host}`;
  return 'https://skyway-ops.vercel.app';
}

export function defaultWebhookUrl(req) {
  return `${appBaseUrl(req)}/api/foreflight-webhook`;
}

export function defaultVendorId() {
  return String(process.env.FOREFLIGHT_VENDOR_ID || '').trim() || null;
}

/**
 * Low-level Dispatch request. Never logs the API key.
 */
export async function dispatchRequest(config, {
  method = 'GET',
  path,
  query,
  body,
  rawBody,
  contentType = 'application/json',
  accept = 'application/json',
}) {
  if (!config?.apiKey) {
    const error = new Error('ForeFlight Dispatch is not connected — add an API key in Settings');
    error.status = 400;
    throw error;
  }
  if (config.enabled === false) {
    const error = new Error('ForeFlight Dispatch integration is disabled');
    error.status = 400;
    throw error;
  }

  const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    Accept: accept,
    'x-api-key': config.apiKey,
  };
  const vendorId = config.vendorId || defaultVendorId();
  if (vendorId) headers['x-vendorId'] = vendorId;

  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = contentType;
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  } else if (rawBody !== undefined) {
    headers['Content-Type'] = contentType;
    init.body = rawBody;
  }

  const response = await fetch(url, init);
  const rateLimit = {
    limit: response.headers.get('x-ratelimit-limit')
      || response.headers.get('RateLimit-Limit'),
    remaining: response.headers.get('x-ratelimit-remaining')
      || response.headers.get('RateLimit-Remaining'),
    reset: response.headers.get('x-ratelimit-reset')
      || response.headers.get('RateLimit-Reset'),
  };

  const ctype = response.headers.get('content-type') || '';
  let data = null;
  let text = '';
  if (ctype.includes('application/json')) {
    data = await response.json().catch(() => null);
  } else {
    const buf = Buffer.from(await response.arrayBuffer());
    if (ctype.startsWith('text/') || ctype.includes('json')) {
      text = buf.toString('utf8');
      try { data = JSON.parse(text); } catch { /* keep text */ }
    } else {
      data = {
        binary: true,
        contentType: ctype,
        base64: buf.toString('base64'),
        byteLength: buf.length,
      };
    }
  }

  if (!response.ok) {
    const message = (data && (data.message || data.error || data.title))
      || text
      || `ForeFlight API ${response.status}`;
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    error.foreflight = data;
    error.rateLimit = rateLimit;
    throw error;
  }

  return { data, status: response.status, rateLimit, contentType: ctype };
}

export async function getApiKeyInfo(config) {
  const { data } = await dispatchRequest(config, {
    method: 'GET',
    path: '/public/api/apiKeyInfo',
  });
  // Endpoint returns an array of key records; prefer the one matching ours.
  const list = Array.isArray(data) ? data : (data ? [data] : []);
  return list[0] || null;
}

export async function registerWebhook(config, { url, secret }) {
  return dispatchRequest(config, {
    method: 'PUT',
    path: '/public/api/apiKeyInfo/WebHook',
    query: { url, ...(secret ? { secret } : {}) },
  });
}

export async function webhookSample(config) {
  return dispatchRequest(config, {
    method: 'GET',
    path: '/public/api/apiKeyInfo/WebHook',
  });
}

/**
 * Run a named Dispatch action. Used by the authenticated action proxy so the
 * browser never holds the API key.
 */
export async function runForeFlightAction(config, action, params = {}) {
  switch (action) {
    case 'test': {
      const info = await getApiKeyInfo(config);
      return { ok: true, info };
    }
    case 'getApiKeyInfo':
      return getApiKeyInfo(config);
    case 'webhookSample': {
      const { data } = await webhookSample(config);
      return data;
    }
    case 'registerWebhook': {
      const url = params.url;
      const secret = params.secret || config.webhookSecret || randomWebhookSecret();
      if (!url) throw Object.assign(new Error('url required'), { status: 400 });
      await registerWebhook(config, { url, secret });
      return { ok: true, url, secretSet: true };
    }
    case 'getAircraft': {
      const { data } = await dispatchRequest(config, { path: '/public/api/aircraft' });
      return data;
    }
    case 'getCrew': {
      const { data } = await dispatchRequest(config, { path: '/public/api/crew' });
      return data;
    }
    case 'getContacts': {
      const { data } = await dispatchRequest(config, {
        path: '/public/api/contacts',
        query: { id: params.id, role: params.role },
      });
      return data;
    }
    case 'getSavedRoutes': {
      const { data } = await dispatchRequest(config, { path: '/public/api/savedroutes' });
      return data;
    }
    case 'listFlights': {
      const { data } = await dispatchRequest(config, {
        path: '/public/api/Flights/flights',
        query: {
          fromDate: params.fromDate,
          toDate: params.toDate,
          tags: params.tags,
          search: params.search,
        },
      });
      return data;
    }
    case 'listModified': {
      const { data } = await dispatchRequest(config, {
        path: '/public/api/Flights/modified',
        query: { sinceDate: params.sinceDate },
      });
      return data;
    }
    case 'getFlight': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}`,
      });
      return data;
    }
    case 'createFlight': {
      if (!params.flight) throw Object.assign(new Error('flight required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        method: 'POST',
        path: '/public/api/Flights',
        body: { flight: params.flight },
      });
      return data;
    }
    case 'updateFlight': {
      if (!params.flightId || !params.flight) {
        throw Object.assign(new Error('flightId and flight required'), { status: 400 });
      }
      const { data } = await dispatchRequest(config, {
        method: 'POST',
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}`,
        query: { forceUpdate: params.forceUpdate },
        body: { flight: params.flight },
      });
      return data;
    }
    case 'deleteFlight': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        method: 'DELETE',
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}`,
      });
      return data;
    }
    case 'releaseFlight': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        method: 'POST',
        path: '/public/api/Flights/release',
        body: {
          flightId: params.flightId,
          releaseAsEditable: params.releaseAsEditable !== false,
        },
      });
      return data;
    }
    case 'updateOooi': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        method: 'POST',
        path: `/public/api/Flights/oooi/${encodeURIComponent(params.flightId)}`,
        body: params.oooi || {},
      });
      return data;
    }
    case 'getPerformance': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}/performance`,
      });
      return data;
    }
    case 'calculatePerformance': {
      if (!params.request) throw Object.assign(new Error('request required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        method: 'POST',
        path: '/public/api/Flights/performance',
        body: params.request,
      });
      return data;
    }
    case 'getBriefing': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}/briefing`,
        accept: '*/*',
      });
      return data;
    }
    case 'getNavlog': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}/navlog`,
        query: { format: params.format || 'pdf' },
        accept: '*/*',
      });
      return data;
    }
    case 'getIcao': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}/icao`,
      });
      return data;
    }
    case 'getOverflight': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}/overflight`,
      });
      return data;
    }
    case 'getWb': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}/wb`,
        accept: '*/*',
      });
      return data;
    }
    case 'getRwa': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: `/public/api/Flights/${encodeURIComponent(params.flightId)}/rwa`,
      });
      return data;
    }
    case 'listFiles': {
      if (!params.flightId) throw Object.assign(new Error('flightId required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        path: '/public/api/flights/files',
        query: { flightId: params.flightId },
      });
      return data;
    }
    case 'uploadSchedule': {
      if (!params.flights) throw Object.assign(new Error('flights required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        method: 'POST',
        path: '/public/api/schedule/flights',
        body: { flights: params.flights },
      });
      return data;
    }
    case 'uploadScheduleBatch': {
      if (!params.schedule) throw Object.assign(new Error('schedule required'), { status: 400 });
      const { data } = await dispatchRequest(config, {
        method: 'POST',
        path: '/public/api/scheduleflights/upload',
        body: { schedule: params.schedule },
      });
      return data;
    }
    default: {
      const error = new Error(`Unknown ForeFlight action: ${action}`);
      error.status = 400;
      throw error;
    }
  }
}
