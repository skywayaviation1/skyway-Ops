// /api/winds-aloft.js
//
// Returns forecasted winds and temperatures at standard flight altitudes for a
// given lat/lon. Uses NOAA's free GFS-based winds/temps model exposed via
// AviationWeather.gov's "windtemp" API.
//
// Query: GET /api/winds-aloft?lat=26.15&lon=-81.77
//
// Response:
//   {
//     ok: true,
//     lat, lon,
//     levels: [
//       { altitude: 3000,  windDir: 270, windKt: 15, tempC: 22 },
//       { altitude: 6000,  windDir: 280, windKt: 25, tempC: 14 },
//       ...
//     ],
//     issuedTime, validTime,
//     cached: boolean
//   }
//
// Notes:
// - Levels are in feet (3K, 6K, 9K, 12K, 18K, 24K, 30K, 34K, 39K)
// - Coverage is best over the continental US; Caribbean/international less reliable
// - Cache: 60 minute TTL (winds aloft forecasts update every 6 hours)
//
// Auth: Firebase idToken OR INTERNAL_API_SECRET header.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { lookupAirport } from './_airports-data.js';

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

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 min

async function authorize(req) {
  const internalSecret = req.headers['x-internal-secret'];
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) return true;
  const idToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query?.idToken;
  if (idToken) {
    try { await admin.auth(getAdmin()).verifyIdToken(idToken); return true; }
    catch (_) { return false; }
  }
  return false;
}

// Standard altitudes we report at (feet)
const STANDARD_LEVELS_FT = [3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000];

/**
 * Fetch winds aloft from NOAA's GFS-based windtemp service.
 * Documented at https://aviationweather.gov/data/api/
 */
async function fetchWindsAloft(lat, lon) {
  // NOAA's winds/temps API works by FD station codes (~180 stations across US).
  // For simplicity, use the gridded "model data" endpoint that returns
  // wind/temp profile at any lat/lon. The new aviationweather.gov API supports
  // querying GFS via:
  //   https://aviationweather.gov/api/data/mdsforecast?lat=X&lon=Y
  // But that's not stable. Fall back to model_winds_aloft which IS stable.
  const url = `https://aviationweather.gov/api/data/windtemp?region=us&fcst=06&level=low&format=json`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'SkywayOps/1.0 (charter ops)' } });
    if (!r.ok) return null;
    const data = await r.json();
    // Find nearest station to our lat/lon
    if (!Array.isArray(data) || data.length === 0) return null;
    let nearest = null;
    let minDist = Infinity;
    for (const station of data) {
      if (station.lat == null || station.lon == null) continue;
      const dLat = station.lat - lat;
      const dLon = station.lon - lon;
      const dist = dLat * dLat + dLon * dLon; // squared distance, fine for nearest
      if (dist < minDist) { minDist = dist; nearest = station; }
    }
    return nearest;
  } catch (_) {
    return null;
  }
}

/**
 * Parse NOAA's windtemp response into our standard format.
 */
function parseWindsAloft(station) {
  if (!station) return [];
  // NOAA returns levels like: { "3000": "2715+10", "6000": "2820+05", ... }
  // Format: DDFF±TT where DD=direction (tens of deg), FF=speed (kt), TT=temp (C)
  // For winds >100kt, DD>=50 means subtract 50 from DD and add 100 to FF
  const levels = [];
  for (const altFt of STANDARD_LEVELS_FT) {
    const key = String(altFt);
    const raw = station[key] || station[`f${key}`] || null;
    if (!raw) continue;
    const m = String(raw).match(/^(\d{2})(\d{2})([+-]?\d{2})?/);
    if (!m) continue;
    let dir = parseInt(m[1], 10) * 10;
    let kt = parseInt(m[2], 10);
    let temp = m[3] ? parseInt(m[3], 10) : null;
    // High-wind decoding: dir 51-86 means dir-50 and add 100 to speed
    if (dir > 360) {
      dir = (dir - 500);
      kt += 100;
    }
    levels.push({
      altitude: altFt,
      windDir: dir,
      windKt: kt,
      tempC: temp,
    });
  }
  return levels;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!(await authorize(req))) return res.status(401).json({ error: 'unauthorized' });

  const icaoParam = String(req.query?.icao || '').toUpperCase().trim();
  let lat = parseFloat(req.query?.lat);
  let lon = parseFloat(req.query?.lon);
  // Resolve from icao if provided and lat/lon missing
  if (icaoParam && (!isFinite(lat) || !isFinite(lon))) {
    const ap = lookupAirport(icaoParam);
    if (ap) { lat = ap.latitude; lon = ap.longitude; }
  }
  if (!isFinite(lat) || !isFinite(lon)) {
    return res.status(400).json({ error: 'lat+lon or recognized icao required' });
  }

  // Cache key by lat/lon rounded to 1deg (winds aloft don't vary much within
  // a degree of latitude/longitude, and rounding lets us share cache)
  const cacheKey = `winds_${Math.round(lat)}_${Math.round(lon)}`;

  try {
    const db = getDb();
    const cacheRef = db.collection('flightaware-cache').doc(cacheKey);

    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const c = cacheSnap.data();
      if (c.cachedAt && (Date.now() - c.cachedAt < CACHE_TTL_MS)) {
        return res.status(200).json({ ok: true, ...c.payload, cached: true, cachedAt: c.cachedAt });
      }
    }

    const station = await fetchWindsAloft(lat, lon);
    const levels = station ? parseWindsAloft(station) : [];

    const payload = {
      lat, lon,
      stationId: station?.stnid || station?.id || null,
      levels,
      issuedTime: station?.issued_time || station?.issuedTime || null,
      validTime: station?.valid_time || station?.validTime || null,
    };

    try { await cacheRef.set({ payload, cachedAt: Date.now() }); } catch (_) {}

    return res.status(200).json({ ok: true, ...payload, cached: false });
  } catch (err) {
    console.error('[winds-aloft] error:', err);
    return res.status(200).json({
      ok: true, lat, lon, levels: [], error: err.message || 'winds fetch failed'
    });
  }
}
