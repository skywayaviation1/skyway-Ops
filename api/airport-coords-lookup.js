// api/airport-coords-lookup.js
//
// Looks up airport coordinates from a server-side cache populated from
// OurAirports (https://ourairports.com/data/airports.csv). The cache
// lives in Firestore so we only fetch the upstream CSV once a month
// regardless of how many lookups happen.
//
// The FlightBoard calls this whenever the bundled coord DB and the
// FA-populated cache both miss for a given airport code. Coverage is
// every airport in OurAirports (~80K worldwide) filtered to actual
// runway airports (excludes heliports, closed fields).
//
// HONEST DATA QUALITY NOTE: OurAirports is community-maintained. Coords
// are accurate enough for displaying routes at airline-route scale but
// must NOT be used for navigation, fuel planning, or any safety-critical
// purpose. The FlightBoard uses them only for visual rendering.
//
// USAGE
//   POST /api/airport-coords-lookup
//   Body: { codes: ["KGSO", "KCLT", "MMUN"] }
//   Returns: { coords: { KGSO: {lat, lng, name}, KCLT: {...}, MMUN: null } }
//
// If the Firestore cache is missing or stale (>30 days), this endpoint
// will refresh it by re-fetching from OurAirports before responding.
// First call after a 30-day refresh takes ~5-15 seconds; subsequent
// calls are <100ms. Subsequent calls within the same Vercel function
// instance use an in-memory cache for ~instant lookups.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const OURAIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Airport "type" values we DO include. Excludes 'heliport', 'closed' on
// purpose — those aren't operational destinations for our use case.
const INCLUDED_TYPES = new Set([
  'large_airport',
  'medium_airport',
  'small_airport',
  'seaplane_base',
]);

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

// In-process cache. Lives only for the duration of a Vercel function
// instance (typically minutes to hours). Big perf win for repeated
// lookups within the same instance — first lookup populates from
// Firestore, subsequent lookups are O(1) Map access.
let memCache = null;     // Map<CODE, {lat,lng,name}>
let memCacheLoadedAt = 0;

// CSV parser tuned for the OurAirports format. Not a general-purpose
// CSV parser — handles only the quoting style OurAirports uses (RFC
// 4180-ish: quoted fields containing commas, escaped quotes via
// doubled quotes). A few hand-rolled lines are simpler than pulling
// in a CSV library.
function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') { inQuotes = true; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Fetch the OurAirports CSV, parse it, filter to operational airports,
 * and return a Map keyed by ICAO code (uppercase). IATA-only airports
 * are keyed by their IATA code too.
 *
 * This is the network-heavy step (~3 MB download). Only called by the
 * monthly refresh — should never run on a hot path.
 */
async function fetchAndParseOurAirports() {
  const r = await fetch(OURAIRPORTS_CSV_URL, {
    headers: { 'User-Agent': 'SkywayOps/1.0 (operational dashboard; non-commercial use)' },
  });
  if (!r.ok) {
    throw new Error(`OurAirports fetch failed: HTTP ${r.status}`);
  }
  const text = await r.text();
  const lines = text.split('\n');
  if (lines.length < 2) throw new Error('OurAirports CSV unexpectedly short');
  // Header row tells us which column is which. OurAirports is known to
  // change column order rarely but it does happen — finding by name is
  // safer than indexing.
  const header = parseCSVLine(lines[0]);
  const idx = {
    ident: header.indexOf('ident'),
    type: header.indexOf('type'),
    name: header.indexOf('name'),
    latitude_deg: header.indexOf('latitude_deg'),
    longitude_deg: header.indexOf('longitude_deg'),
    iata_code: header.indexOf('iata_code'),
    iso_country: header.indexOf('iso_country'),
  };
  if (idx.ident < 0 || idx.latitude_deg < 0 || idx.longitude_deg < 0) {
    throw new Error('OurAirports CSV missing required columns');
  }

  const out = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    const cols = parseCSVLine(line);
    const type = cols[idx.type];
    if (!INCLUDED_TYPES.has(type)) continue;
    const ident = cols[idx.ident];
    const lat = Number(cols[idx.latitude_deg]);
    const lng = Number(cols[idx.longitude_deg]);
    if (!ident || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = cols[idx.name] || '';
    const iata = cols[idx.iata_code] || null;
    const iso = cols[idx.iso_country] || null;
    const entry = { lat, lng, name, iata, iso };
    // Key by ICAO ident (e.g. "KGSO")
    out.set(ident.toUpperCase(), entry);
    // Also key by IATA if present and different (e.g. "GSO" pointing
    // to the same data). This is what makes "GSO" lookups work even
    // though we received the data keyed by "KGSO".
    if (iata && iata !== ident) {
      // Only set if not already present — avoid IATA collisions
      // overwriting a real ICAO entry.
      const iatakey = iata.toUpperCase();
      if (!out.has(iatakey)) out.set(iatakey, entry);
    }
  }
  return out;
}

/**
 * Refresh the Firestore cache from OurAirports. Chunks the dataset by
 * the first character of the key so each Firestore doc stays under the
 * 1 MB limit. Returns total airport count written.
 */
async function refreshFirestoreCache(db) {
  const map = await fetchAndParseOurAirports();
  // Group entries by first letter for chunking
  const chunks = {};
  for (const [code, entry] of map.entries()) {
    const prefix = code[0] || '_';
    if (!chunks[prefix]) chunks[prefix] = {};
    chunks[prefix][code] = entry;
  }
  // Each chunk is a single Firestore doc at airport-cache-ourairports/{prefix}
  // The whole-dataset metadata is at airport-cache-ourairports/_meta
  const batch = db.batch();
  const collRef = db.collection('airport-cache-ourairports');
  for (const [prefix, codes] of Object.entries(chunks)) {
    batch.set(collRef.doc(prefix), { entries: codes });
  }
  batch.set(collRef.doc('_meta'), {
    refreshedAt: Date.now(),
    totalCodes: map.size,
    chunkPrefixes: Object.keys(chunks).sort(),
    source: 'ourairports.com',
  });
  await batch.commit();
  return map.size;
}

/**
 * Load the cache into memory from Firestore. Loops through every chunk
 * doc and merges. ~80 KB per Firestore read, ~30 reads total — well
 * within Firestore quotas.
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

/**
 * Get the in-memory cache, loading from Firestore (and refreshing from
 * OurAirports if Firestore is stale or empty) as needed.
 */
async function ensureCache() {
  // In-memory cache is valid for the lifetime of this function instance
  if (memCache && memCache.size > 0) {
    return memCache;
  }
  const db = getDb();
  const metaSnap = await db.collection('airport-cache-ourairports').doc('_meta').get();
  const meta = metaSnap.exists ? metaSnap.data() : null;
  const isStale = !meta || (Date.now() - (meta.refreshedAt || 0)) > REFRESH_INTERVAL_MS;
  if (isStale) {
    console.log('[airport-coords] Cache stale or missing; refreshing from OurAirports');
    await refreshFirestoreCache(db);
  }
  memCache = await loadCacheFromFirestore(db);
  memCacheLoadedAt = Date.now();
  console.log(`[airport-coords] In-memory cache loaded: ${memCache.size} airports`);
  return memCache;
}

/**
 * Look up coords for a code, with K-prefix tolerance.
 */
function lookupInCache(cache, rawCode) {
  if (!rawCode) return null;
  const code = String(rawCode).toUpperCase().trim();
  if (cache.has(code)) return cache.get(code);
  // US FAA codes are 3 letters; OurAirports keys them as 4-letter ICAO
  // with K prefix (e.g. FAA "GSO" → ICAO "KGSO"). Try both ways.
  if (code.length === 3 && cache.has('K' + code)) return cache.get('K' + code);
  if (code.length === 4 && code.startsWith('K') && cache.has(code.slice(1))) {
    return cache.get(code.slice(1));
  }
  return null;
}

// ============================================================
// HTTP HANDLER
// ============================================================
export default async function handler(req, res) {
  // CORS — board may be loaded on any origin under the app
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
    // Hard cap to prevent abuse
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
      source: 'ourairports.com',
    });
  } catch (e) {
    console.error('[airport-coords] handler error:', e);
    res.status(500).json({ error: e?.message || 'internal error' });
  }
}
