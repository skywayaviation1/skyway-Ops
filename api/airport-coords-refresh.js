// api/airport-coords-refresh.js
//
// Fetches the OurAirports CSV, parses it, filters to operational airports,
// chunks by first-letter prefix, and writes to Firestore. This is the ONLY
// place we hit OurAirports — the lookup endpoint just reads what this wrote.
//
// SEPARATE FROM LOOKUP on purpose: the fetch+parse+write is slow (10-20s)
// and would time out the lookup endpoint. By giving the refresh its own
// endpoint with maxDuration=60s in vercel.json, we make the slow path
// explicit and never block user-facing lookups.
//
// TRIGGERS:
//   - Vercel cron (weekly — see vercel.json)
//   - Manual: POST /api/airport-coords-refresh with header
//     `X-Refresh-Token: <REFRESH_SECRET>`
//
// The token check is light auth — this isn't security-critical (the data
// is public anyway) but it prevents random callers from triggering a slow
// expensive refresh.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const OURAIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
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

// Minimal CSV parser — RFC 4180-ish, handles quoted fields with embedded commas
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

async function fetchAndParseOurAirports() {
  const r = await fetch(OURAIRPORTS_CSV_URL, {
    headers: { 'User-Agent': 'SkywayOps/1.0 (operational dashboard; non-commercial use)' },
  });
  if (!r.ok) throw new Error(`OurAirports fetch failed: HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.split('\n');
  if (lines.length < 2) throw new Error('OurAirports CSV unexpectedly short');
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
    out.set(ident.toUpperCase(), entry);
    // Index by IATA too — but only if no ICAO entry already has that key.
    // The lookup endpoint uses K-prefix-first priority for 3-letter codes,
    // so this no longer causes the AGS collision bug.
    if (iata && iata !== ident) {
      const iatakey = iata.toUpperCase();
      if (!out.has(iatakey)) out.set(iatakey, entry);
    }
  }
  return out;
}

async function refreshFirestoreCache(db) {
  const map = await fetchAndParseOurAirports();
  // Chunk by first letter to stay under the 1MB-per-doc limit
  const chunks = {};
  for (const [code, entry] of map.entries()) {
    const prefix = code[0] || '_';
    if (!chunks[prefix]) chunks[prefix] = {};
    chunks[prefix][code] = entry;
  }
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

async function verifyOpsOrAdmin(idToken, db) {
  // Matches the pattern used by flightaware-positions.js and other
  // admin endpoints. Caller must be signed in AND have role ops/admin.
  const decoded = await admin.auth(getAdmin()).verifyIdToken(idToken);
  const profile = await db.collection('users').doc(decoded.uid).get();
  if (!profile.exists) {
    throw Object.assign(new Error('User profile not found'), { code: 'forbidden' });
  }
  const role = profile.data().role;
  if (role !== 'admin' && role !== 'ops') {
    throw Object.assign(new Error('Ops or admin role required'), { code: 'forbidden' });
  }
  return decoded;
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

  // Vercel cron sends a specific user-agent and doesn't need an ID
  // token. For all other callers, require an ops/admin ID token.
  const isCron = req.headers['user-agent']?.includes('vercel-cron');

  const startedAt = Date.now();
  try {
    const db = getDb();
    if (!isCron) {
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'POST with idToken in body' });
        return;
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const idToken = body.idToken;
      if (!idToken) {
        res.status(401).json({ error: 'idToken required in body' });
        return;
      }
      try {
        await verifyOpsOrAdmin(idToken, db);
      } catch (e) {
        const status = e.code === 'forbidden' ? 403 : 401;
        res.status(status).json({ error: e.message || 'Unauthorized' });
        return;
      }
    }
    console.log('[airport-coords-refresh] Fetching OurAirports CSV...');
    const count = await refreshFirestoreCache(db);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[airport-coords-refresh] Wrote ${count} airports in ${elapsedMs}ms`);
    res.status(200).json({
      ok: true,
      airports: count,
      elapsedMs,
      source: 'ourairports.com',
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.error('[airport-coords-refresh] Failed:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || 'internal error',
      elapsedMs,
    });
  }
}
