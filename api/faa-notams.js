import { reviewerSessionBlock } from '../src/reviewer-account.js';
// /api/faa-notams.js
//
// Fetch active NOTAMs for an airport. Primary source is the FAA NMS
// (NOTAM Management System) API. When FAA credentials are missing or the
// FAA request fails — including the current client-credentials 401
// invalid_client — the handler falls back to AVWX
// (GET https://avwx.rest/api/notam/{icao}).
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
//     cached: false,
//     source: "faa" | "avwx",
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
//         qcode: "QMRLC",
//       }, ...
//     ],
//     // significantOnly: pre-filtered list of operationally important NOTAMs
//     // (runway closures, TFRs, approach outages, fuel notices). Use this
//     // for the broker badge — `notams[]` is the full list for the
//     // expanded view in the ops app.
//     significantOnly: [...same shape, filtered subset...]
//   }
//
// Response (error or no data from both sources):
//   { ok: true, icao, fetchedAt, count: 0, filteredCount: 0, notams: [],
//     significantOnly: [], source: null, cached: false, error }
//
// Auth required for callers: Firebase idToken (same as airport-weather).
// Server auths to FAA with OAuth client credentials grant.
// AVWX auth is the raw AVWX_API_KEY in the Authorization header. AVWX
// accepts that value alone or with a TOKEN/BEARER prefix.
//
// FAA endpoints default to production and can be overridden:
//   FAA_NMS_TOKEN_URL  (default https://api-nms.aim.faa.gov/v1/auth/token)
//   FAA_NMS_API_BASE   (default https://api-nms.aim.faa.gov/nmsapi)
//
// Cache: 10 minutes in Firestore at flightaware-cache/notam_<ICAO>. The
// cached payload includes `source`, so a fallback result is not refetched
// on every broker refresh. Even in a major operational event, 10 min
// freshness is more than acceptable — NOTAMs publish hours-to-days in
// advance, not seconds.
//
// If FAA answers 401 repeatedly (invalid_client does not recover on its
// own), this instance skips FAA for a cooldown and goes straight to AVWX.
// The breaker is in-memory, same scope as the OAuth token cache.
//
// IMPORTANT: this endpoint NEVER returns the raw FAA OAuth token or the
// AVWX key to the client. Tokens stay server-side.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

export const config = { runtime: 'nodejs' };

export const DEFAULT_FAA_TOKEN_URL = 'https://api-nms.aim.faa.gov/v1/auth/token';
export const DEFAULT_FAA_API_BASE = 'https://api-nms.aim.faa.gov/nmsapi';
export const AVWX_NOTAM_URL = 'https://avwx.rest/api/notam';
export const CACHE_TTL_MS = 10 * 60 * 1000;          // 10 min
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000;           // 50 min (tokens usually last 60)
// Two consecutive 401s means the client is rejected, not a one-off blip.
// Skip FAA for 15 minutes so later airports don't repeat the dead call.
export const FAA_AUTH_FAILURE_THRESHOLD = 2;
export const FAA_AUTH_COOLDOWN_MS = 15 * 60 * 1000;

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

// In-memory OAuth token cache per Vercel function instance. When the
// instance cold-starts the cache resets — that's fine, we just refresh
// the token on the first request after a cold start.
const defaultTokenCache = { token: null, expiresAt: 0 };

export function createFaaAuthCircuit({
  threshold = FAA_AUTH_FAILURE_THRESHOLD,
  cooldownMs = FAA_AUTH_COOLDOWN_MS,
} = {}) {
  let streak = 0;
  let bypassUntil = 0;
  return {
    bypassed(now = Date.now()) {
      return bypassUntil > now;
    },
    record401(now = Date.now()) {
      streak += 1;
      if (streak >= threshold) {
        const opening = bypassUntil <= now;
        bypassUntil = now + cooldownMs;
        if (opening) {
          console.warn(
            `[faa-notams] FAA returned 401 ${streak} time(s); skipping FAA for ${Math.round(cooldownMs / 60000)} min`,
          );
        }
      }
      return streak;
    },
    recordSuccess() {
      streak = 0;
      bypassUntil = 0;
    },
    reset() {
      streak = 0;
      bypassUntil = 0;
    },
  };
}

const defaultCircuit = createFaaAuthCircuit();

// Test seams. Production leaves these unset and uses process.env, global
// fetch, and Firestore.
let testHooks = null;
export function setNotamTestHooks(hooks) {
  testHooks = hooks || null;
}
export function resetNotamTestHooks() {
  testHooks = null;
  defaultTokenCache.token = null;
  defaultTokenCache.expiresAt = 0;
  defaultCircuit.reset();
}

function activeEnv() {
  return testHooks?.env || process.env;
}
function activeFetch() {
  return testHooks?.fetchImpl || fetch;
}
function activeNow() {
  return typeof testHooks?.now === 'function' ? testHooks.now() : Date.now();
}
function activeDb() {
  return testHooks?.db || getDb();
}

export function faaEndpoints(env = process.env) {
  const tokenUrl = String(env.FAA_NMS_TOKEN_URL || DEFAULT_FAA_TOKEN_URL).trim();
  const apiBase = String(env.FAA_NMS_API_BASE || DEFAULT_FAA_API_BASE).trim().replace(/\/$/, '');
  return { tokenUrl, apiBase };
}

function faaConfigured(env) {
  return Boolean(env.FAA_NMS_CLIENT_ID && env.FAA_NMS_CLIENT_SECRET);
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function isFaa401(err) {
  if (!err) return false;
  if (err.status === 401) return true;
  return /\b401\b/.test(String(err.message || ''));
}

// ---- Auth helpers ----

async function authorize(req) {
  // Allow internal calls (server-to-server) for future cron use
  const internalSecret = req.headers['x-internal-secret'];
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) return true;
  // OR a real Firebase user token
  const idToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query?.idToken;
  if (idToken) {
    try { reviewerSessionBlock(await admin.auth(getAdmin()).verifyIdToken(idToken)); return true; }
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
async function getFaaToken(ctx) {
  const now = ctx.now;
  const tokenCache = ctx.tokenCache;
  if (tokenCache?.token && tokenCache.expiresAt > now + 30_000) {
    // 30s safety margin — don't use a token that's about to expire
    return tokenCache.token;
  }
  const clientId = ctx.env.FAA_NMS_CLIENT_ID;
  const clientSecret = ctx.env.FAA_NMS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('FAA_NMS_CLIENT_ID / FAA_NMS_CLIENT_SECRET not configured');
  }

  const { tokenUrl } = faaEndpoints(ctx.env);

  // The FAA NMS auth endpoint uses client_credentials. Two patterns are
  // common — try the most likely one first (form-encoded body), fall
  // back to JSON if it 400s with a content-type complaint.
  const formBody = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  let r = await ctx.fetchImpl(tokenUrl, {
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
    r = await ctx.fetchImpl(tokenUrl, {
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
    throw httpError(`FAA token request failed: ${r.status} ${errText.slice(0, 200)}`, r.status);
  }
  const data = await r.json();
  const token = data.access_token || data.accessToken || data.token;
  if (!token) throw new Error('FAA token response missing access_token');
  const expiresIn = Number(data.expires_in || data.expiresIn || 3600);
  tokenCache.token = token;
  tokenCache.expiresAt = now + Math.min(expiresIn * 1000, TOKEN_CACHE_TTL_MS);
  return token;
}

// ---- NOTAM fetching + parsing ----

async function fetchNotamsFromFaa(icao, ctx) {
  const token = await getFaaToken(ctx);
  const { apiBase } = faaEndpoints(ctx.env);
  const url = `${apiBase}/v1/notams?location=${encodeURIComponent(icao)}`;
  const r = await ctx.fetchImpl(url, {
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
    throw httpError(`FAA NOTAM fetch failed: ${r.status} ${errText.slice(0, 200)}`, r.status);
  }
  return r.json();
}

// AVWX documents the token in the Authorization header. The value may be
// the raw token (what AVWX_API_KEY stores) or a TOKEN/BEARER prefixed
// string — AVWX accepts either, so the header is the key unchanged.
export async function fetchNotamsFromAvwx(icao, ctx = {}) {
  const env = ctx.env || activeEnv();
  const fetchImpl = ctx.fetchImpl || activeFetch();
  const key = String(env.AVWX_API_KEY || '').trim();
  if (!key) throw new Error('AVWX_API_KEY not configured');
  const url = `${AVWX_NOTAM_URL}/${encodeURIComponent(icao)}`;
  const r = await fetchImpl(url, {
    method: 'GET',
    headers: {
      'Authorization': key,
      'Accept': 'application/json',
    },
  });
  if (r.status === 404) return [];
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw httpError(`AVWX NOTAM fetch failed: ${r.status} ${errText.slice(0, 200)}`, r.status);
  }
  const text = await r.text();
  if (!text || !text.trim()) return [];
  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error('AVWX NOTAM response was not JSON'); }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.notams)) return data.notams;
  if (data?.error) throw new Error(`AVWX NOTAM fetch failed: ${String(data.error).slice(0, 200)}`);
  return [];
}

// Classify a NOTAM by its text / fields. The FAA NOTAM format has
// structured "Q-codes" (e.g. QMRLC = runway closed) but they're not
// always present in modern API responses. Fall back to keyword matching
// on the message text.
//
// Returns: { type, severity, summary }
export function classifyNotam(notamText, props = {}) {
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

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'object') {
    if (v.dt != null && v.dt !== '') return toMs(v.dt);
    return null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// Parse a single NOTAM record from the FAA GEOJSON response into our
// flat shape. The exact field names in the FAA response vary depending
// on the version of their API, so we read defensively — try multiple
// candidate names for each value.
export function parseNotam(feature) {
  if (!feature || typeof feature !== 'object') return null;
  const p = feature.properties || feature;       // GEOJSON or flat
  // ID
  const id = p.notamId || p.notamID || p.id || p.notamNumber || p.number || null;
  // Text — try several candidate fields
  const text = p.text || p.notamText || p.traditionalMessage || p.icaoMessage
            || p.message || p.simpleText || '';
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

// AVWX NotamData uses `number` as a string. Some payloads wrap it like
// the shared Number type (`{ repr, value }`). Qualifiers in the published
// schema have subject + condition codes rather than a single `code`
// field; accept `qualifiers.code` when a feed includes it, otherwise
// rebuild the ICAO Q-code (Q + subject + condition) so classifyNotam
// still sees QMRLC / QMXLT / etc.
function avwxNotamId(number) {
  if (number == null || number === '') return null;
  if (typeof number === 'string' || typeof number === 'number') return String(number);
  if (typeof number === 'object') {
    const repr = number.repr ?? number.value;
    if (repr == null || repr === '') return null;
    return String(repr);
  }
  return null;
}

function avwxQcode(qualifiers) {
  if (!qualifiers) return '';
  if (typeof qualifiers === 'string') {
    const fromLine = qualifiers.toUpperCase().match(/\b(Q[A-Z0-9]{4})\b/);
    return fromLine ? fromLine[1] : qualifiers.toUpperCase();
  }
  const code = qualifiers.code ?? qualifiers.qcode ?? qualifiers.qCode;
  if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
  if (code && typeof code === 'object') {
    const repr = code.repr || code.value || '';
    if (String(repr).trim()) return String(repr).trim().toUpperCase();
  }
  const subject = String(qualifiers.subject?.repr || '').toUpperCase();
  const condition = String(qualifiers.condition?.repr || '').toUpperCase();
  if (/^[A-Z0-9]{2}$/.test(subject) && /^[A-Z0-9]{2}$/.test(condition)) {
    return `Q${subject}${condition}`;
  }
  const fromRepr = String(qualifiers.repr || '').toUpperCase().match(/\b(Q[A-Z0-9]{4})\b/);
  return fromRepr ? fromRepr[1] : '';
}

function avwxClassification(type) {
  if (type == null || type === '') return '';
  if (typeof type === 'string' || typeof type === 'number') return String(type);
  if (typeof type === 'object') return String(type.repr || type.value || '');
  return '';
}

export function mapAvwxNotam(item) {
  if (!item || typeof item !== 'object') return null;
  const text = (typeof item.raw === 'string' && item.raw.trim())
    ? item.raw
    : (typeof item.sanitized === 'string' ? item.sanitized : '');
  const qcode = avwxQcode(item.qualifiers);
  const { type, severity, summary } = classifyNotam(text, { qcode });
  return {
    id: avwxNotamId(item.number),
    classification: avwxClassification(item.type),
    type,
    severity,
    summary,
    text: String(text).slice(0, 4000),
    effectiveStart: toMs(item.start_time),
    effectiveEnd: toMs(item.end_time),
    qcode: qcode || null,
  };
}

// Decide whether a NOTAM is "operationally significant" — what the
// broker badge should surface vs. what's noise. Conservative filter:
// high severity always, medium for runway/fuel/approach issues.
export function isSignificant(n) {
  if (!n) return false;
  if (n.severity === 'high') return true;
  if (n.severity === 'medium' && ['NAVAID', 'FUEL', 'RWY', 'TFR', 'AIRPORT'].includes(n.type)) {
    return true;
  }
  return false;
}

// Drop NOTAMs whose effective window has already ended. The FAA API
// occasionally returns recently-expired NOTAMs in the response; we want
// only currently-active or future-effective items. AVWX may serve reports
// for up to 10 days after the end date — same filter applies.
export function isActive(n, now = Date.now()) {
  if (!n) return false;
  if (n.effectiveEnd && n.effectiveEnd < now) return false;
  return true;
}

function faaFeatureList(raw) {
  if (Array.isArray(raw?.features)) return raw.features;
  if (Array.isArray(raw?.notams)) return raw.notams;
  if (Array.isArray(raw)) return raw;
  return [];
}

export function buildNotamPayload(icao, parsed, source, now) {
  const active = (parsed || []).filter((n) => n && isActive(n, now));
  const significantOnly = active.filter(isSignificant);
  return {
    icao,
    fetchedAt: now,
    count: active.length,
    filteredCount: significantOnly.length,
    notams: active,
    significantOnly,
    source,
  };
}

function requestContext(options = {}) {
  return {
    env: options.env || activeEnv(),
    fetchImpl: options.fetchImpl || activeFetch(),
    now: options.now ?? activeNow(),
    tokenCache: options.tokenCache || defaultTokenCache,
    circuit: options.circuit || defaultCircuit,
  };
}

// Try FAA, then AVWX. Throws only when both sources fail.
export async function resolveNotams(icao, options = {}) {
  const ctx = requestContext(options);
  const { env, circuit, now, tokenCache } = ctx;
  let faaError = null;

  if (!faaConfigured(env)) {
    faaError = new Error('FAA_NMS_CLIENT_ID / FAA_NMS_CLIENT_SECRET not configured');
    console.warn('[faa-notams] FAA credentials missing, using AVWX');
  } else if (circuit.bypassed(now)) {
    faaError = new Error('FAA auth skipped after repeated 401 responses');
  } else {
    try {
      const raw = await fetchNotamsFromFaa(icao, ctx);
      circuit.recordSuccess();
      const parsed = faaFeatureList(raw).map(parseNotam);
      return buildNotamPayload(icao, parsed, 'faa', now);
    } catch (err) {
      if (isFaa401(err)) {
        tokenCache.token = null;
        tokenCache.expiresAt = 0;
        circuit.record401(now);
      }
      faaError = err;
      console.warn('[faa-notams] FAA failed, falling back to AVWX:', err?.message);
    }
  }

  try {
    const items = await fetchNotamsFromAvwx(icao, ctx);
    const parsed = items.map(mapAvwxNotam);
    return buildNotamPayload(icao, parsed, 'avwx', now);
  } catch (avwxErr) {
    const error = new Error(
      `FAA: ${faaError?.message || 'unavailable'}; AVWX: ${avwxErr?.message || 'unavailable'}`,
    );
    error.faaError = faaError;
    error.avwxError = avwxErr;
    throw error;
  }
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

  const db = activeDb();
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

  // Cache miss — FAA first, AVWX if FAA cannot answer.
  try {
    const payload = await resolveNotams(icao);

    // Persist to cache. If this write fails (rare), we still return the
    // fresh result — next request just refetches.
    try { await cacheRef.set({ payload, cachedAt: payload.fetchedAt }); } catch (_) {}

    return res.status(200).json({ ok: true, ...payload, cached: false });
  } catch (err) {
    console.error('[faa-notams] error:', err?.message);
    // Soft fail — return empty list so UI doesn't break. The error is
    // logged for diagnosis but the broker page should never show an
    // FAA-related error to the user.
    return res.status(200).json({
      ok: true,
      icao,
      fetchedAt: Date.now(),
      count: 0,
      filteredCount: 0,
      notams: [],
      significantOnly: [],
      source: null,
      cached: false,
      error: err?.message || 'NOTAM fetch failed',
    });
  }
}
