// Shared Expedia Rapid helpers for lodging serverless routes.
//
// Env (Vercel):
//   EXPEDIA_RAPID_API_KEY     — Rapid API key
//   EXPEDIA_RAPID_SHARED_SECRET — shared secret for signature auth
//   EXPEDIA_RAPID_BASE_URL    — optional, default https://test.ean.com
//                              (use https://api.ean.com in production)
//
// When credentials are missing, callers should fall back to demo inventory.

import crypto from 'crypto';

export function rapidConfigured() {
  return Boolean(process.env.EXPEDIA_RAPID_API_KEY && process.env.EXPEDIA_RAPID_SHARED_SECRET);
}

export function rapidBaseUrl() {
  return (process.env.EXPEDIA_RAPID_BASE_URL || 'https://test.ean.com').replace(/\/+$/, '');
}

/** Authorization: EAN APIKey=…,Signature=sha512(key+secret+ts),timestamp=… */
export function rapidAuthHeader() {
  const apiKey = process.env.EXPEDIA_RAPID_API_KEY;
  const secret = process.env.EXPEDIA_RAPID_SHARED_SECRET;
  if (!apiKey || !secret) {
    throw new Error('Expedia Rapid credentials are not configured');
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHash('sha512')
    .update(apiKey + secret + timestamp)
    .digest('hex');
  return `EAN APIKey=${apiKey},Signature=${signature},timestamp=${timestamp}`;
}

export async function rapidFetch(path, { method = 'GET', query, body, headers } = {}) {
  const url = new URL(path.startsWith('http') ? path : `${rapidBaseUrl()}${path}`);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v == null || v === '') return;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    });
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'SkywayOps/1.0',
      Authorization: rapidAuthHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.error?.message || data?.raw || `Rapid HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// Seed property IDs near airports Skyway visits. Expand as Rapid catalog
// access lands. Availability is requested for these IDs when live.
export const AIRPORT_PROPERTY_SEED = {
  FXE: ['11775754', '13213875', '16412267'],
  FLL: ['11775754', '13213875', '16412267', '42566'],
  MIA: ['42566', '8785', '16412'],
  TEB: ['12369', '22135', '8785'],
  EWR: ['12369', '22135'],
  CYYZ: ['8785', '22135'],
  TPA: ['42566', '8785'],
  PBI: ['42566', '11775754'],
};

export function propertyIdsForAirport(code) {
  const raw = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const variants = [raw, raw.replace(/^K/, ''), raw.length === 3 ? `K${raw}` : null].filter(Boolean);
  for (const v of variants) {
    if (AIRPORT_PROPERTY_SEED[v]) return AIRPORT_PROPERTY_SEED[v];
  }
  return [];
}

/** Normalize a Rapid availability rate into the UI rate shape. */
export function normalizeRate(rate, { defaultCommissionPct = 10, nights = 1 } = {}) {
  const total = Number(
    rate?.occupancy_pricing?.['2']?.totals?.inclusive?.request_currency?.value
    ?? rate?.occupancy_pricing?.['1']?.totals?.inclusive?.request_currency?.value
    ?? rate?.total_in_request_currency?.request_currency?.value
    ?? 0,
  );
  const currency =
    rate?.occupancy_pricing?.['1']?.totals?.inclusive?.request_currency?.currency
    || rate?.total_in_request_currency?.request_currency?.currency
    || 'USD';
  const marketingFee = Number(
    rate?.occupancy_pricing?.['1']?.totals?.marketing_fee?.request_currency?.value
    ?? rate?.marketing_fee?.request_currency?.value
    ?? NaN,
  );
  const commissionAmount = Number.isFinite(marketingFee)
    ? marketingFee
    : Math.round(total * (defaultCommissionPct / 100) * 100) / 100;
  const nightly = nights > 0 ? Math.round((total / nights) * 100) / 100 : total;
  return {
    rate_id: rate?.id || rate?.rate_id,
    status: rate?.status || 'available',
    merchant_of_record: rate?.merchant_of_record || 'expedia',
    refundable: rate?.refundable === true,
    cancel_penalties: rate?.cancel_penalties || [],
    meal_plan: rate?.amenities?.find?.((a) => /breakfast|meal/i.test(a?.name || a))?.name || rate?.meal_plan || 'Room only',
    total_in_request_currency: { request_currency: { value: total, currency } },
    nightly_rate: { request_currency: { value: nightly, currency } },
    marketing_fee: { request_currency: { value: commissionAmount, currency } },
    commission_pct: total > 0 ? Math.round((commissionAmount / total) * 1000) / 10 : defaultCommissionPct,
    bed_group_id: rate?.bed_groups ? Object.keys(rate.bed_groups)[0] : null,
    price_check_href: rate?.links?.['price_check']?.href || null,
    raw_incentives: rate?.marketing_fee_incentives || null,
  };
}

// Firebase Admin verify — same pattern as other gated APIs.
let cachedAdmin = null;
export async function getAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const admin = await import('firebase-admin');
  if (!admin.apps || admin.apps.length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured on server');
    admin.default.initializeApp({
      credential: admin.default.credential.cert(JSON.parse(raw)),
    });
  }
  cachedAdmin = admin.default;
  return cachedAdmin;
}

export async function requireUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const idToken = bearer || req.body?.idToken || req.query?.idToken;
  if (!idToken) {
    const err = new Error('Authentication required');
    err.status = 401;
    throw err;
  }
  const admin = await getAdmin();
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch {
    const err = new Error('Invalid or expired session');
    err.status = 401;
    throw err;
  }
}

export function nightsBetween(checkIn, checkOut) {
  const a = new Date(`${checkIn}T00:00:00Z`).getTime();
  const b = new Date(`${checkOut}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86400000));
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
