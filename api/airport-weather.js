// /api/airport-weather.js
//
// Returns current METAR + TAF + parsed weather for an airport. Uses NOAA's
// free AviationWeather.gov API (no key required).
//
// Query: GET /api/airport-weather?icao=KDAL
//
// Response:
//   {
//     ok: true,
//     icao: 'KDAL',
//     metar: { observedTime, rawMetar, parsed fields, flightCategory },
//     taf:   { issuedTime, rawTaf, periods: [...] },
//     cached: boolean
//   }
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

function parseMetar(m) {
  if (!m) return null;
  const cloudsArr = Array.isArray(m.clouds) ? m.clouds : [];
  const ceiling = cloudsArr.reduce((min, c) => {
    if (c && ['BKN', 'OVC'].includes(c.cover) && c.base != null) {
      return min == null ? c.base : Math.min(min, c.base);
    }
    return min;
  }, null);
  return {
    observedTime: m.reportTime || m.obsTime || null,
    rawMetar: m.rawOb || null,
    tempC: m.temp ?? null,
    dewpointC: m.dewp ?? null,
    windDir: m.wdir ?? null,
    windKt: m.wspd ?? null,
    windGustKt: m.wgst ?? null,
    visibilitySm: m.visib ?? null,
    altimeterInHg: m.altim ?? null,
    ceilingFt: ceiling,
    flightCategory: m.fltCat || flightCategory(m.visib, ceiling),
    clouds: cloudsArr,
  };
}

function parseTaf(t) {
  if (!t) return null;
  const forecasts = Array.isArray(t.fcsts) ? t.fcsts : (Array.isArray(t.forecast) ? t.forecast : []);
  const periods = forecasts.map(p => {
    const cloudsArr = Array.isArray(p.clouds) ? p.clouds : [];
    const ceiling = cloudsArr.reduce((min, c) => {
      if (c && ['BKN', 'OVC'].includes(c.cover) && c.base != null) {
        return min == null ? c.base : Math.min(min, c.base);
      }
      return min;
    }, null);
    return {
      timeFrom: p.timeFrom || p.fcstTime || null,
      timeTo:   p.timeTo   || null,
      changeIndicator: p.fcstChange || p.changeIndicator || null,
      windDir: p.wdir ?? null,
      windKt:  p.wspd ?? null,
      windGustKt: p.wgst ?? null,
      visibilitySm: p.visib ?? null,
      ceilingFt: ceiling,
      flightCategory: flightCategory(p.visib, ceiling),
      clouds: cloudsArr,
      weather: Array.isArray(p.wxString) ? p.wxString : null,
    };
  });
  return {
    issuedTime: t.issueTime || null,
    validFrom:  t.validTimeFrom || null,
    validTo:    t.validTimeTo || null,
    rawTaf:     t.rawTAF || null,
    periods,
  };
}

async function fetchNoaa(endpoint, ids) {
  const url = `https://aviationweather.gov/api/data/${endpoint}?ids=${encodeURIComponent(ids)}&format=json&hours=2`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'SkywayOps/1.0 (charter ops)' } });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0];
  } catch (_) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!(await authorize(req))) return res.status(401).json({ error: 'unauthorized' });

  let icao = String(req.query?.icao || '').toUpperCase().trim();
  if (!icao) return res.status(400).json({ error: 'icao query param required' });

  // Normalize: most US airports are reported as Kxxx in METAR even though
  // they're called xxx in everyday usage.
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

    // Fetch METAR + TAF in parallel
    const [metarRaw, tafRaw] = await Promise.all([
      fetchNoaa('metar', icao),
      fetchNoaa('taf', icao),
    ]);

    const metar = metarRaw ? parseMetar(metarRaw) : null;
    const taf = tafRaw ? parseTaf(tafRaw) : null;

    const payload = {
      icao,
      metar,
      taf,
      // Backwards-compat for existing tracking screen usage
      parsed: metar,
    };

    try { await cacheRef.set({ payload, cachedAt: Date.now() }); } catch (_) {}

    return res.status(200).json({ ok: true, ...payload, cached: false });
  } catch (err) {
    console.error('[airport-weather] error:', err);
    return res.status(200).json({
      ok: true, icao, metar: null, taf: null, parsed: null,
      error: err.message || 'weather fetch failed'
    });
  }
}
