// /api/airport-weather.js
//
// Returns current METAR + parsed weather for an airport. Uses NOAA's free
// AviationWeather.gov API (no key required).
//
// Query: GET /api/airport-weather?icao=KDAL
//
// Caching: 10 minute TTL in Firestore flightaware-cache/wx_{icao}.
// Auth: requires Firebase idToken OR INTERNAL_API_SECRET header.

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

const CACHE_TTL_MS = 10 * 60 * 1000;

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

// Quick flight-rules computer from visibility (sm) + ceiling (ft)
function flightCategory(visibility, ceiling) {
  if (visibility == null && ceiling == null) return null;
  const v = visibility ?? 99;
  const c = ceiling ?? 99999;
  if (v < 1 || c < 500) return 'LIFR';
  if (v < 3 || c < 1000) return 'IFR';
  if (v < 5 || c < 3000) return 'MVFR';
  return 'VFR';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!(await authorize(req))) return res.status(401).json({ error: 'unauthorized' });

  let icao = String(req.query?.icao || '').toUpperCase().trim();
  if (!icao) return res.status(400).json({ error: 'icao query param required' });

  // Normalize: most US airports are reported as Kxxx in METAR even though
  // they're called xxx in everyday usage (TPA → KTPA, OPF → KOPF). FlightAware
  // sometimes gives us the 3-letter form.
  if (icao.length === 3 && /^[A-Z]{3}$/.test(icao)) icao = 'K' + icao;

  try {
    const db = getDb();
    const cacheRef = db.collection('flightaware-cache').doc(`wx_${icao}`);

    // Try cache
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const c = cacheSnap.data();
      if (c.cachedAt && (Date.now() - c.cachedAt < CACHE_TTL_MS)) {
        return res.status(200).json({ ok: true, ...c.payload, cached: true, cachedAt: c.cachedAt });
      }
    }

    // NOAA AviationWeather.gov - free, no key
    const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&taf=false&hours=2`;
    const r = await fetch(url, { headers: { 'User-Agent': 'SkywayOps/1.0' } });
    if (!r.ok) {
      return res.status(502).json({ error: `AviationWeather ${r.status}` });
    }
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) {
      const empty = { icao, metar: null, parsed: null };
      await cacheRef.set({ payload: empty, cachedAt: Date.now() });
      return res.status(200).json({ ok: true, ...empty, cached: false });
    }

    // Most recent observation
    const m = arr[0];
    const ceiling = (m.clouds || []).reduce((min, c) => {
      if (['BKN', 'OVC'].includes(c.cover) && c.base != null) {
        return min == null ? c.base : Math.min(min, c.base);
      }
      return min;
    }, null);
    const parsed = {
      observedTime: m.reportTime || m.obsTime || null,
      rawMetar: m.rawOb,
      tempC: m.temp,
      dewpointC: m.dewp,
      windDir: m.wdir,
      windKt: m.wspd,
      windGustKt: m.wgst,
      visibilitySm: m.visib,
      altimeterInHg: m.altim,
      ceilingFt: ceiling,
      flightCategory: m.fltCat || flightCategory(m.visib, ceiling),
      clouds: m.clouds,
    };

    const payload = { icao, metar: m.rawOb, parsed };
    await cacheRef.set({ payload, cachedAt: Date.now() });

    return res.status(200).json({ ok: true, ...payload, cached: false });
  } catch (err) {
    console.error('[airport-weather] error:', err);
    return res.status(500).json({ error: err.message || 'weather fetch failed' });
  }
}
