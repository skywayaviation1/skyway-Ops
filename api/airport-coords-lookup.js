// api/airport-coords-lookup.js
//
// Reads airport coordinates from a Firestore-backed cache (populated by
// api/airport-coords-refresh.js, which is the only thing that hits
// OurAirports). This endpoint is fast — never fetches anything external,
// never times out.
//
// The FlightBoard calls this whenever the bundled coord DB and the
// FA-populated cache both miss for a given airport code.
//
// HONEST DATA QUALITY NOTE: OurAirports is community-maintained. Coords
// are accurate enough for displaying routes at airline-route scale but
// must NOT be used for navigation, fuel planning, or any safety-critical
// purpose. The FlightBoard uses them only for visual rendering.
//
// USAGE
//   POST /api/airport-coords-lookup
//   Body: { codes: ["KGSO", "KCLT", "MMUN"] }
//   Returns: {
//     coords: { KGSO: {lat, lng, name}, KCLT: {...}, MMUN: null },
//     cacheReady: true,
//     cacheSize: 50000
//   }
//
// If `cacheReady` is false, the refresh cron hasn't populated the cache
// yet — callers should not keep retrying as if it's a transient failure.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

let adminApp = null;
let _db = null;
function getAdmin() {
  if (adminApp) return adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return adminApp;
}
function getDb() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

// In-process cache, populated on first lookup of a Vercel function
// instance from Firestore. Lasts for the lifetime of the instance.
let memCache = null;     // Map<CODE, {lat,lng,name}>

/**
 * Load the full cache from Firestore. ~30 doc reads, ~3 MB total.
 * Cached in-memory after first call.
 */
async function loadCacheFromFirestore(db) {
  const snap = await db.collection('airport-cache-ourairports').get();
  const map = new Map();
  snap.forEach((d) => {
    if (d.id === '_meta') return;
    const data = d.data();
    if (!data?.entries) return;
    for (const [code, entry] of Object.entries(data.entries)) {
      map.set(code, entry);
    }
  });
  return map;
}

async function ensureCache() {
  if (memCache && memCache.size > 0) return memCache;
  const db = getDb();
  memCache = await loadCacheFromFirestore(db);
  console.log(`[airport-coords] In-memory cache loaded: ${memCache.size} airports`);
  return memCache;
}

/**
 * Look up coords for a code, with K-prefix tolerance.
 *
 * IMPORTANT priority: for 3-letter codes, the US ICAO form (K + code)
 * takes precedence over a bare-code match. This is because OurAirports
 * has some non-US airports whose 4-letter ICAO is a 3-letter code like
 * "AGS" (rare but real). When a US operator types "AGS" they mean
 * Augusta Regional (KAGS), not whatever foreign airport happens to use
 * AGS as its ident.
 */
function lookupInCache(cache, rawCode) {
  if (!rawCode) return null;
  const code = String(rawCode).toUpperCase().trim();
  // 3-letter: try K-prefix first (US FAA semantics), then bare
  if (code.length === 3) {
    if (cache.has('K' + code)) return cache.get('K' + code);
    if (cache.has(code)) return cache.get(code);
    return null;
  }
  // 4-letter K-prefix: try as-is, then strip K
  if (code.length === 4 && code.startsWith('K')) {
    if (cache.has(code)) return cache.get(code);
    if (cache.has(code.slice(1))) return cache.get(code.slice(1));
    return null;
  }
  // Other lengths/forms: just exact match
  return cache.has(code) ? cache.get(code) : null;
}

// ============================================================
// HTTP HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const codes = Array.isArray(body.codes) ? body.codes : [];
    if (codes.length === 0) {
      res.status(400).json({ error: 'codes array required' });
      return;
    }
    if (codes.length > 200) {
      res.status(400).json({ error: 'too many codes (max 200)' });
      return;
    }
    const cache = await ensureCache();
    const coords = {};
    for (const code of codes) {
      const hit = lookupInCache(cache, code);
      coords[String(code).toUpperCase()] = hit ? {
        lat: hit.lat, lng: hit.lng, name: hit.name || null,
      } : null;
    }
    res.status(200).json({
      coords,
      cacheSize: cache.size,
      cacheReady: cache.size > 0,
      source: 'ourairports.com',
      note: cache.size === 0
        ? 'Airport cache not yet populated. POST /api/airport-coords-refresh to populate it.'
        : null,
    });
  } catch (e) {
    console.error('[airport-coords] handler error:', e);
    res.status(500).json({ error: e?.message || 'internal error' });
  }
}
