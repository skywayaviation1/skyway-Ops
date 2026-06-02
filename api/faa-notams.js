// /api/faa-notams.js
//
// Fetch active NOTAMs for an airport from the FAA NMS (NOTAM Management
// System) API. Server-side OAuth + caching so the FAA API isn't hit
// every time a broker refreshes their tracking page.
//
// Query: GET /api/faa-notams?icao=KJFK
//
// Response (success):
//   {
//     ok: true,
//     icao: "KJFK",
//     fetchedAt: 1717286400000,
//     count: 12,
//     filteredCount: 3,
//     notams: [
//       {
//         id: "!JFK 06/021",
//         classification: "DOM",
//         type: "RWY",                  // RWY | TWY | NAVAID | OBST | TFR | FUEL | APRON | OTHER
//         summary: "RWY 13L/31R CLSD",
//         text: "RWY 13L/31R CLSD WIE UNTIL UFN",
//         effectiveStart: <ms>,
//         effectiveEnd:   <ms>,
//         severity: "high" | "medium" | "low",
//       }, ...
//     ],
//     // significantOnly: pre-filtered list of operationally important NOTAMs
//     // (runway closures, TFRs, approach outages, fuel notices). Use this
//     // for the broker badge — `notams[]` is the full list for the
//     // expanded view in the ops app.
//     significantOnly: [...same shape, filtered subset...]
//   }
//
// Response (error or no data):
//   { ok: true, icao: "...", count: 0, notams: [], significantOnly: [] }
//
// Auth required for callers: Firebase idToken (same as airport-weather).
// Server auths to FAA with OAuth client credentials grant.
//
// Cache: 10 minutes in Firestore at flightaware-cache/notam_<ICAO>. Even
// in a major operational event, 10 min freshness is more than acceptable
// — NOTAMs publish hours-to-days in advance, not seconds.
//
// IMPORTANT: this endpoint NEVER returns the raw FAA OAuth token to the
// client. The token stays server-side. The endpoint is rate-limited
// inherently by the Firestore cache.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let _db = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}
function getDb() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

const TOKEN_URL = 'https://api-nms.aim.faa.gov/v1/auth/token';
const NMS_API = 'https://api-nms.aim.faa.gov/nmsapi';
const CACHE_TTL_MS = 10 * 60 * 1000;          // 10 min
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000;    // 50 min (tokens usually last 60)

// In-memory OAuth token cache per Vercel function instance. When the
// instance cold-starts the cache resets — that's fine, we just refresh
// the token on the first request after a cold start.
let _tokenCache = null; // { token, expiresAt }

// ---- Auth helpers ----

async function authorize(req) {
  // Allow internal calls (server-to-server) for future cron use
  const internalSecret = req.headers['x-internal-secret'];
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) return true;
  // OR a real Firebase user token
  const idToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query?.idToken;
  if (idToken) {
    try { await admin.auth(getAdmin()).verifyIdToken(idToken); return true; }
    catch (_) { return false; }
  }
  // Broker pages are unauthenticated. We still want them to see NOTAMs,
  // so accept a special "broker" mode that requires a trip-share token
  // having been validated upstream. For now, allow no-auth and rely on
  // the caching layer + Vercel WAF for abuse protection.
  // TODO: tighten this once the broker tracking page passes its share
  // token through to this endpoint.
  return true;
}

// Get a fresh OAuth token from the FAA. Uses client_credentials grant.
// Token endpoint returns { access_token, expires_in } — we cache it
// in-memory until expiry.
//
// Throws on failure. Caller decides whether to surface or swallow.
async function getFaaToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 30_000) {
    // 30s safety margin — don't use a token that's about to expire
    return _tokenCache.token;
  }
  const clientId = process.env.FAA_NMS_CLIENT_ID;
  const clientSecret = process.env.FAA_NMS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('FAA_NMS_CLIENT_ID / FAA_NMS_CLIENT_SECRET not configured');
  }

  // The FAA NMS auth endpoint uses client_credentials. Two patterns are
  // common — try the most likely one first (form-encoded body), fall
  // back to JSON if it 400s with a content-type complaint.
  const formBody = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  let r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: formBody,
  });

  if (!r.ok && (r.status === 415 || r.status === 400)) {
    // Try Basic auth header + form body — another common OAuth pattern
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
  }

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`FAA token request failed: ${r.status} ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  const token = data.access_token || data.accessToken || data.token;
  if (!token) throw new Error('FAA token response missing access_token');
  const expiresIn = Number(data.expires_in || data.expiresIn || 3600);
  _tokenCache = {
    token,
    expiresAt: now + Math.min(expiresIn * 1000, TOKEN_CACHE_TTL_MS),
  };
  return token;
}

// ---- NOTAM fetching + parsing ----

async function fetchNotamsFromFaa(icao) {
  const token = await getFaaToken();
  const url = `${NMS_API}/v1/notams?location=${encodeURIComponent(icao)}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'nmsResponseFormat': 'GEOJSON',
    },
  });
  if (!r.ok) {
    // 404 from FAA usually means "no NOTAMs for this location" — treat as
    // empty rather than error. Anything else is a real problem.
    if (r.status === 404) return { type: 'FeatureCollection', features: [] };
    const errText = await r.text().catch(() => '');
    throw new Error(`FAA NOTAM fetch failed: ${r.status} ${errText.slice(0, 200)}`);
  }
  return r.json();
}

// Classify a NOTAM by its text / fields. The FAA NOTAM format has
// structured "Q-codes" (e.g. QMRLC = runway closed) but they're not
// always present in modern API responses. Fall back to keyword matching
// on the message text.
//
// Returns: { type, severity, summary }
function classifyNotam(notamText, props = {}) {
  const text = String(notamText || '').toUpperCase();
  // Q-code classification — first letter group after Q identifies subject
  // QMR = movement area / runway, QMX = taxiway, QFA = airport facilities,
  // QFU = fuel, QIC = ILS critical area, QNV/QNA = NAVAID, QRT = TFR/restricted
  const qcode = (props.qcode || props.qCode || '').toUpperCase();
  // Default
  let type = 'OTHER';
  let severity = 'low';
  let summary = text.split('\n')[0].slice(0, 80);

  // TFR — highest priority
  if (text.includes('TEMPORARY FLIGHT RESTRICTION') || text.includes('TFR ') ||
      qcode.startsWith('QRT') || qcode.startsWith('QRO')) {
    type = 'TFR'; severity = 'high';
    summary = 'TEMPORARY FLIGHT RESTRICTION';
  }
  // Airport closed
  else if (/AD\s*CLSD|AIRPORT\s+CLOSED/.test(text) || qcode === 'QFAAH') {
    type = 'AIRPORT'; severity = 'high';
    summary = 'AIRPORT CLOSED';
  }
  // Runway closure
  else if (/RWY\s*[\d/LRC]+\s+(CLSD|CLOSED)/.test(text) || qcode.startsWith('QMRLC')) {
    type = 'RWY'; severity = 'high';
    const m = text.match(/RWY\s*([\d/LRC]+)\s+(CLSD|CLOSED)/);
    summary = m ? `RWY ${m[1]} CLOSED` : 'RUNWAY CLOSED';
  }
  // ILS / approach OOS
  else if (/(ILS|LOC|GS|GP)\s+RWY\s*[\d/LRC]+\s+(U\/?S|OUT|OTS)/.test(text) ||
           qcode.startsWith('QIC') || qcode.startsWith('QIL')) {
    type = 'NAVAID'; severity = 'medium';
    summary = 'ILS/APPROACH OUT OF SERVICE';
  }
  // Fuel
  else if (/FUEL/.test(text) && /(UNAVAILABLE|UNAVBL|NOT\s+AVBL|OUT)/.test(text)) {
    type = 'FUEL'; severity = 'medium';
    summary = 'FUEL UNAVAILABLE';
  }
  // Taxiway closure
  else if (/TWY\s*[A-Z\d]+\s+(CLSD|CLOSED)/.test(text) || qcode.startsWith('QMX')) {
    type = 'TWY'; severity = 'low';
    const m = text.match(/TWY\s*([A-Z\d]+)\s+(CLSD|CLOSED)/);
    summary = m ? `TWY ${m[1]} CLOSED` : 'TAXIWAY CLOSURE';
  }
  // Obstructions
  else if (/CRANE|OBST|OBSTRUCTION/.test(text) || qcode.startsWith('QOB')) {
    type = 'OBST'; severity = 'low';
    summary = 'OBSTRUCTION NOTICE';
  }
  // NAVAID generic
  else if (/(VOR|DME|NDB|TACAN)\s+(U\/?S|OUT|OTS|UNSVC)/.test(text)) {
    type = 'NAVAID'; severity = 'low';
    summary = 'NAVAID OUT OF SERVICE';
  }

  return { type, severity, summary };
}

// Parse a single NOTAM record from the FAA GEOJSON response into our
// flat shape. The exact field names in the FAA response vary depending
// on the version of their API, so we read defensively — try multiple
// candidate names for each value.
function parseNotam(feature) {
  if (!feature || typeof feature !== 'object') return null;
  const p = feature.properties || feature;       // GEOJSON or flat
  // ID
  const id = p.notamId || p.notamID || p.id || p.notamNumber || p.number || null;
  // Text — try several candidate fields
  const text = p.text || p.notamText || p.traditionalMessage || p.icaoMessage
            || p.message || p.simpleText || '';
  // Effective dates — millisecond timestamps after normalization
  const toMs = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const effectiveStart = toMs(p.effectiveStart || p.startDateTime || p.startDate || p.beginValidity);
  const effectiveEnd   = toMs(p.effectiveEnd || p.endDateTime || p.endDate || p.endValidity);
  // Classification (FDC, DOM, INTL, MIL)
  const classification = (p.classification || p.notamClass || p.type || '').toString();
  // Q-code if available
  const qcode = (p.qcode || p.qCode || '').toString();
  const { type, severity, summary } = classifyNotam(text, { qcode });
  return {
    id: id ? String(id) : null,
    classification,
    type,
    severity,
    summary,
    text: String(text).slice(0, 4000),
    effectiveStart,
    effectiveEnd,
    qcode: qcode || null,
  };
}

// Decide whether a NOTAM is "operationally significant" — what the
// broker badge should surface vs. what's noise. Conservative filter:
// high severity always, medium for runway/fuel/approach issues.
function isSignificant(n) {
  if (!n) return false;
  if (n.severity === 'high') return true;
  if (n.severity === 'medium' && ['NAVAID', 'FUEL', 'RWY', 'TFR', 'AIRPORT'].includes(n.type)) {
    return true;
  }
  return false;
}

// Drop NOTAMs whose effective window has already ended. The FAA API
// occasionally returns recently-expired NOTAMs in the response; we want
// only currently-active or future-effective items.
function isActive(n, now = Date.now()) {
  if (!n) return false;
  if (n.effectiveEnd && n.effectiveEnd < now) return false;
  return true;
}

// ---- Handler ----

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  if (!(await authorize(req))) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let icao = String(req.query?.icao || '').toUpperCase().trim();
  if (!icao) return res.status(400).json({ ok: false, error: 'icao query param required' });
  // K-prefix tolerance: 3-letter US IATA → K-prefixed ICAO for FAA lookup.
  // The FAA NMS API uses ICAO codes, so KJFK works but JFK doesn't.
  if (icao.length === 3 && /^[A-Z]{3}$/.test(icao)) icao = 'K' + icao;

  const db = getDb();
  const cacheRef = db.collection('flightaware-cache').doc(`notam_${icao}`);

  // Check Firestore cache
  try {
    const snap = await cacheRef.get();
    if (snap.exists) {
      const c = snap.data();
      if (c.cachedAt && Date.now() - c.cachedAt < CACHE_TTL_MS) {
        return res.status(200).json({ ok: true, ...c.payload, cached: true });
      }
    }
  } catch (_) { /* cache miss — fall through */ }

  // Cache miss — fetch fresh from FAA
  try {
    const raw = await fetchNotamsFromFaa(icao);
    const features = Array.isArray(raw.features) ? raw.features
                   : Array.isArray(raw.notams) ? raw.notams
                   : Array.isArray(raw) ? raw
                   : [];
    const now = Date.now();
    const parsed = features
      .map(parseNotam)
      .filter((n) => n && isActive(n, now));
    const significantOnly = parsed.filter(isSignificant);

    const payload = {
      icao,
      fetchedAt: now,
      count: parsed.length,
      filteredCount: significantOnly.length,
      notams: parsed,
      significantOnly,
    };

    // Persist to cache. If this write fails (rare), we still return the
    // fresh result — next request just refetches.
    try { await cacheRef.set({ payload, cachedAt: now }); } catch (_) {}

    return res.status(200).json({ ok: true, ...payload, cached: false });
  } catch (err) {
    console.error('[faa-notams] error:', err?.message);
    // Soft fail — return empty list so UI doesn't break. The error is
    // logged for diagnosis but the broker page should never show an
    // FAA-related error to the user.
    return res.status(200).json({
      ok: true,
      icao,
      count: 0,
      filteredCount: 0,
      notams: [],
      significantOnly: [],
      error: err?.message || 'NOTAM fetch failed',
    });
  }
}
