import { reviewerSessionBlock } from '../src/reviewer-account.js';
// api/airport-coords-refresh.js
//
// Fetches the OurAirports CSV, parses it, filters to operational airports,
// and writes to Firestore. Prefixes that fit stay one document per letter.
// Larger prefixes are split into smaller shard docs so a write stays under
// Firestore's per-document index-entry cap. This is the ONLY place we hit
// OurAirports — the lookup endpoint just reads what this wrote.
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
import {
  AIRPORT_CACHE_COLLECTION,
  AIRPORT_CACHE_META_ID,
  UNKNOWN_DELETE_TRANSACTION_BYTES,
  buildAirportCachePlan,
  chunkCacheOperations,
  estimateTransactionBytes,
} from './_airport-cache.js';

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

// A delete counts the stored document and its index entries, which the plan
// does not carry. Read those docs so two large letter docs are not committed
// together. A miss is free. A read that fails falls back to the largest
// letter doc Firestore could still be holding.
const DELETE_READ_BATCH = 5;

async function measureDeletedDocuments(db, operations) {
  const ids = operations.filter((op) => op.type === 'delete').map((op) => op.id);
  const measured = new Map();
  if (!ids.length) return measured;
  const collRef = db.collection(AIRPORT_CACHE_COLLECTION);
  for (let i = 0; i < ids.length; i += DELETE_READ_BATCH) {
    const slice = ids.slice(i, i + DELETE_READ_BATCH);
    try {
      const snaps = await db.getAll(...slice.map((id) => collRef.doc(id)));
      for (const snap of snaps) {
        measured.set(
          snap.id,
          snap.exists ? estimateTransactionBytes(snap.id, snap.data()) : 0,
        );
      }
    } catch (error) {
      console.error('[airport-coords-refresh] Could not size documents to delete:', error);
      for (const id of slice) {
        if (!measured.has(id)) measured.set(id, UNKNOWN_DELETE_TRANSACTION_BYTES);
      }
    }
  }
  return measured;
}

async function commitCacheOperations(db, operations) {
  const deleteBytes = await measureDeletedDocuments(db, operations);
  const commits = chunkCacheOperations(operations, { deleteBytes });
  const collRef = db.collection(AIRPORT_CACHE_COLLECTION);
  console.log(`[airport-coords-refresh] Committing ${operations.length} ops in ${commits.length} batches`);
  for (const commit of commits) {
    const batch = db.batch();
    for (const op of commit) {
      const ref = collRef.doc(op.id);
      if (op.type === 'delete') batch.delete(ref);
      else batch.set(ref, op.data);
    }
    await batch.commit();
  }
}

async function refreshFirestoreCache(db) {
  const map = await fetchAndParseOurAirports();
  const collRef = db.collection(AIRPORT_CACHE_COLLECTION);
  const metaSnap = await collRef.doc(AIRPORT_CACHE_META_ID).get();
  const previousMeta = metaSnap.exists ? metaSnap.data() : null;
  // Letter docs that fit stay one doc. Larger letters are sliced so each
  // document stays under the 40,000 index-entry cap (and under 1 MiB).
  const plan = buildAirportCachePlan(map, previousMeta);
  await commitCacheOperations(db, plan.operations);
  return map.size;
}

async function verifyOpsOrAdmin(idToken, db) {
  // Matches the pattern used by flightaware-positions.js and other
  // admin endpoints. Caller must be signed in AND have role ops/admin.
  const decoded = reviewerSessionBlock(await admin.auth(getAdmin()).verifyIdToken(idToken));
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
