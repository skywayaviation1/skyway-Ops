// /api/flightaware-flight-detail.js
//
// Returns full flight details for a tail's active or most-recent flight:
// scheduled vs actual times, taxi, runways, ETA, distance, etc.
// Used by the Tracking detail page's Flight Times grid.
//
// Query: GET /api/flightaware-flight-detail?ident=N286N
//
// Caching: result cached in Firestore flightaware-cache/{ident}_detail for 60s.
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

const CACHE_TTL_MS = 60 * 1000;

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!(await authorize(req))) return res.status(401).json({ error: 'unauthorized' });

  const ident = String(req.query?.ident || '').toUpperCase().trim();
  if (!ident) return res.status(400).json({ error: 'ident query param required' });

  try {
    const db = getDb();
    const cacheKey = `${ident}_detail`;
    const cacheRef = db.collection('flightaware-cache').doc(cacheKey);

    // Try cache first
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const c = cacheSnap.data();
      if (c.cachedAt && (Date.now() - c.cachedAt < CACHE_TTL_MS)) {
        return res.status(200).json({ ok: true, ...c.payload, cached: true, cachedAt: c.cachedAt });
      }
    }

    const apiKey = process.env.FLIGHTAWARE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'FLIGHTAWARE_API_KEY missing' });

    const flightsResp = await fetch(
      `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}?max_pages=1`,
      { headers: { 'x-apikey': apiKey } }
    );
    if (!flightsResp.ok) {
      return res.status(502).json({ error: `FlightAware ${flightsResp.status}` });
    }
    const flightsData = await flightsResp.json();
    const flights = Array.isArray(flightsData.flights) ? flightsData.flights : [];
    if (flights.length === 0) {
      return res.status(200).json({ ok: true, ident, flight: null, cached: false });
    }

    // Pick the most relevant flight. Order of preference:
    //   1. In-progress: has actual_off AND no actual_on (airborne right now)
    //   2. Upcoming scheduled: no actual_off AND scheduled_off in the future
    //   3. Most recent completed: has actual_on
    function flightPriority(f) {
      const hasOff = !!f.actual_off;
      const hasOn = !!f.actual_on;
      if (hasOff && !hasOn) return 1;          // in-progress (most preferred)
      if (!hasOff && !hasOn) {
        const sched = f.scheduled_off ? new Date(f.scheduled_off).getTime() : 0;
        return sched >= Date.now() - 30 * 60 * 1000 ? 2 : 4;  // upcoming or stale
      }
      return 3;                                 // completed
    }
    const sorted = [...flights].sort((a, b) => {
      const pa = flightPriority(a), pb = flightPriority(b);
      if (pa !== pb) return pa - pb;
      // Same priority — break ties by recency
      const aT = new Date(a.actual_off || a.scheduled_off || a.actual_on || 0).getTime();
      const bT = new Date(b.actual_off || b.scheduled_off || b.actual_on || 0).getTime();
      // For in-progress + completed: most recent first
      // For upcoming: soonest first
      if (pa === 2) return aT - bT;
      return bT - aT;
    });
    const f = sorted[0];

    // Clean up the data for our UI (the raw response has a lot of noise)
    const flight = {
      flightId: f.fa_flight_id,
      ident: f.ident,
      registration: f.registration,
      aircraftType: f.aircraft_type,
      origin: {
        code: f.origin?.code_icao || f.origin?.code,
        code_iata: f.origin?.code_iata,
        name: f.origin?.name,
        city: f.origin?.city,
        timezone: f.origin?.timezone,
        latitude: null,                              // populated below
        longitude: null,
      },
      destination: {
        code: f.destination?.code_icao || f.destination?.code,
        code_iata: f.destination?.code_iata,
        name: f.destination?.name,
        city: f.destination?.city,
        timezone: f.destination?.timezone,
        latitude: null,
        longitude: null,
      },
      // Scheduled times (when filed)
      scheduledOff: f.scheduled_off || null,
      scheduledOn: f.scheduled_on || null,
      scheduledOut: f.scheduled_out || null,
      scheduledIn: f.scheduled_in || null,
      // Actual times (when reported)
      actualOff: f.actual_off || null,
      actualOn: f.actual_on || null,
      actualOut: f.actual_out || null,
      actualIn: f.actual_in || null,
      // Estimated times (predicted)
      estimatedOff: f.estimated_off || null,
      estimatedOn: f.estimated_on || null,
      estimatedOut: f.estimated_out || null,
      estimatedIn: f.estimated_in || null,
      // Runways
      gateOrigin: f.gate_origin,
      gateDestination: f.gate_destination,
      runwayOrigin: f.actual_runway_off || f.predicted_runway_off || null,
      runwayDestination: f.predicted_runway_on || null,
      // Geometry
      routeDistance: f.route_distance,
      filedAirspeed: f.filed_airspeed,
      filedAltitude: f.filed_altitude,
      // Progress
      progressPercent: f.progress_percent,
      // State flags
      status: f.status,                          // 'En Route / On Time' etc
      cancelled: f.cancelled || false,
      diverted: f.diverted || false,
    };

    // ====== Fetch airport coordinates (with cache) ======
    // FlightAware's /flights/{ident} doesn't include lat/lon. Fetch each
    // airport from /airports/{code} and cache permanently — airport coords
    // don't change. Errors are non-fatal; map just won't show the markers.
    async function getAirportCoords(code) {
      if (!code) return null;
      try {
        const cRef = db.collection('flightaware-cache').doc(`airport_${code}`);
        const cSnap = await cRef.get();
        if (cSnap.exists) {
          const c = cSnap.data();
          if (c.coords) return c.coords;
        }
        const r = await fetch(
          `https://aeroapi.flightaware.com/aeroapi/airports/${encodeURIComponent(code)}`,
          { headers: { 'x-apikey': apiKey } }
        );
        if (!r.ok) return null;
        const a = await r.json();
        const coords = (a.latitude != null && a.longitude != null)
          ? { latitude: a.latitude, longitude: a.longitude }
          : null;
        if (coords) await cRef.set({ coords, cachedAt: Date.now() });
        return coords;
      } catch (_) {
        return null;
      }
    }

    const [oCoords, dCoords] = await Promise.all([
      getAirportCoords(flight.origin.code),
      getAirportCoords(flight.destination.code),
    ]);
    if (oCoords) { flight.origin.latitude = oCoords.latitude; flight.origin.longitude = oCoords.longitude; }
    if (dCoords) { flight.destination.latitude = dCoords.latitude; flight.destination.longitude = dCoords.longitude; }

    const payload = { ident, flight };
    await cacheRef.set({ payload, cachedAt: Date.now() });

    return res.status(200).json({ ok: true, ...payload, cached: false });
  } catch (err) {
    console.error('[flightaware-flight-detail] error:', err);
    return res.status(500).json({ error: err.message || 'flight detail failed' });
  }
}
