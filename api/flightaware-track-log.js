// /api/flightaware-track-log.js
//
// Returns the FlightAware track log for a tail's active or most recent flight.
// Used by the Tracking detail page for the altitude/speed chart.
//
// Query: GET /api/flightaware-track-log?ident=N286N
//
// Response:
//   {
//     ok: true,
//     ident: 'N286N',
//     flightId: 'N286N-1747218000-airline-0001',
//     points: [
//       { time: 1747218000000, lat, lon, altitude_ft, groundspeed_kt, heading_deg, type },
//       ...
//     ],
//     cached: boolean,
//     cachedAt: ms epoch | null,
//   }
//
// Caching: result cached in Firestore flightaware-cache/{ident}_track for 60s.
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
    const cacheKey = `${ident}_track`;
    const cacheRef = db.collection('flightaware-cache').doc(cacheKey);

    // Try cache first
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const c = cacheSnap.data();
      if (c.cachedAt && (Date.now() - c.cachedAt < CACHE_TTL_MS)) {
        return res.status(200).json({ ok: true, ...c.payload, cached: true, cachedAt: c.cachedAt });
      }
    }

    // 1. Find current/most-recent flight for this tail
    const apiKey = process.env.FLIGHTAWARE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'FLIGHTAWARE_API_KEY missing' });

    const flightsResp = await fetch(
      `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}?max_pages=1`,
      { headers: { 'x-apikey': apiKey } }
    );
    if (!flightsResp.ok) {
      return res.status(502).json({ error: `FlightAware flights lookup ${flightsResp.status}` });
    }
    const flightsData = await flightsResp.json();
    const flights = Array.isArray(flightsData.flights) ? flightsData.flights : [];
    if (flights.length === 0) {
      return res.status(200).json({ ok: true, ident, flightId: null, points: [], cached: false });
    }

    // Pick the most relevant flight. Order of preference:
    //   1. In-progress: has actual_off AND no actual_on (airborne right now)
    //   2. Upcoming scheduled: no actual_off AND scheduled_off in the future
    //   3. Most recent completed: has actual_on
    function flightPriority(f) {
      const hasOff = !!f.actual_off;
      const hasOn = !!f.actual_on;
      if (hasOff && !hasOn) return 1;
      if (!hasOff && !hasOn) {
        const sched = f.scheduled_off ? new Date(f.scheduled_off).getTime() : 0;
        return sched >= Date.now() - 30 * 60 * 1000 ? 2 : 4;
      }
      return 3;
    }
    const sorted = [...flights].sort((a, b) => {
      const pa = flightPriority(a), pb = flightPriority(b);
      if (pa !== pb) return pa - pb;
      const aT = new Date(a.actual_off || a.scheduled_off || a.actual_on || 0).getTime();
      const bT = new Date(b.actual_off || b.scheduled_off || b.actual_on || 0).getTime();
      if (pa === 2) return aT - bT;
      return bT - aT;
    });
    const f = sorted[0];
    const flightId = f.fa_flight_id || null;

    if (!flightId) {
      return res.status(200).json({ ok: true, ident, flightId: null, points: [], cached: false });
    }

    // 2. Fetch track log
    const trackResp = await fetch(
      `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightId)}/track`,
      { headers: { 'x-apikey': apiKey } }
    );
    if (!trackResp.ok) {
      return res.status(502).json({ error: `FlightAware track ${trackResp.status}` });
    }
    const trackData = await trackResp.json();
    const positions = Array.isArray(trackData.positions) ? trackData.positions : [];

    const points = positions.map(p => ({
      time: p.timestamp ? new Date(p.timestamp).getTime() : null,
      lat: p.latitude ?? null,
      lon: p.longitude ?? null,
      altitude_ft: p.altitude != null ? p.altitude * 100 : null,  // FA returns in hundreds of feet
      groundspeed_kt: p.groundspeed ?? null,
      heading_deg: p.heading ?? null,
      type: p.update_type || null,
    })).filter(p => p.time != null);

    const payload = { ident, flightId, points };
    await cacheRef.set({ payload, cachedAt: Date.now() });

    return res.status(200).json({ ok: true, ...payload, cached: false });
  } catch (err) {
    console.error('[flightaware-track-log] error:', err);
    return res.status(500).json({ error: err.message || 'track log failed' });
  }
}
