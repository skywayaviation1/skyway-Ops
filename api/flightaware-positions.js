// api/flightaware-positions.js
//
// Returns current position data for one or more tail numbers from FlightAware
// AeroAPI. The API key never leaves the server — clients call this proxy
// endpoint instead.
//
// Body:
//   POST { idToken: "...", idents: ["N168ZZ", "N20UF", ...] }
//
// Returns:
//   {
//     ok: true,
//     positions: [
//       {
//         ident: "N168ZZ",
//         airborne: true,           // false if on the ground / no flight
//         latitude: 27.85,
//         longitude: -82.51,
//         heading: 045,
//         altitude: 34000,          // feet
//         groundspeed: 460,         // knots
//         origin: "KTPA",
//         destination: "KPSM",
//         destinationCity: "Portsmouth, NH",
//         estimatedOn: "2026-05-10T17:30:00Z",
//         actualOff: "2026-05-10T14:30:00Z",
//         faFlightId: "...",
//       },
//       { ident: "N20UF", airborne: false }
//     ]
//   }
//
// Performance: makes one query per ident in parallel. For 8 tails that's 8
// queries per call. Frontend should poll this at 2-minute intervals max while
// the tracking tab is open, and stop polling when the tab is closed.

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

const FA_API_BASE = 'https://aeroapi.flightaware.com/aeroapi';

async function verifyOpsOrAdmin(idToken) {
  // Ensure admin SDK is initialized BEFORE calling admin.auth()
  getAdmin();
  const decoded = await admin.auth().verifyIdToken(idToken);
  const db = getDb();
  const profile = await db.collection('users').doc(decoded.uid).get();
  if (!profile.exists) throw Object.assign(new Error('User not found'), { code: 'forbidden' });
  const role = profile.data().role;
  if (role !== 'admin' && role !== 'ops') {
    throw Object.assign(new Error('Ops or admin role required'), { code: 'forbidden' });
  }
  return decoded;
}

// Fetch current position for ONE tail. Returns { ident, airborne, ... } or
// { ident, airborne: false } if no active flight.
async function fetchPositionForTail(ident, apiKey) {
  try {
    // Strategy: query /flights/{ident} which returns currently active flights
    // for that tail number. Most operators have at most 1 active flight per
    // tail at a time. Pick the one with the most recent actual_off.
    const r = await fetch(`${FA_API_BASE}/flights/${encodeURIComponent(ident)}?max_pages=1`, {
      headers: { 'x-apikey': apiKey, Accept: 'application/json' },
    });
    if (!r.ok) {
      console.warn(`[fa-positions] ${ident} returned ${r.status}`);
      return { ident, airborne: false, error: `FA ${r.status}` };
    }
    const data = await r.json();
    const flights = Array.isArray(data.flights) ? data.flights : [];
    if (flights.length === 0) {
      return { ident, airborne: false };
    }

    // Find the currently-airborne flight: has actual_off but no actual_on
    const active = flights.find(f => f.actual_off && !f.actual_on);
    if (!active) {
      return { ident, airborne: false };
    }

    // Now fetch position via /flights/{fa_flight_id}/position for richer data
    // (heading, altitude, ground speed). The list endpoint doesn't always
    // include these.
    let position = active.last_position || null;
    if (!position && active.fa_flight_id) {
      try {
        const pr = await fetch(`${FA_API_BASE}/flights/${encodeURIComponent(active.fa_flight_id)}/position`, {
          headers: { 'x-apikey': apiKey, Accept: 'application/json' },
        });
        if (pr.ok) {
          const pd = await pr.json();
          position = pd.last_position || pd || null;
        }
      } catch (e) {
        // Non-fatal — just no position data
      }
    }

    return {
      ident,
      airborne: true,
      faFlightId: active.fa_flight_id,
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
      heading: position?.heading ?? null,
      altitude: position?.altitude ? position.altitude * 100 : null, // FA reports altitude in hundreds of feet (FL340 = 340)
      groundspeed: position?.groundspeed ?? null,
      origin: active.origin?.code_icao || active.origin?.code || null,
      destination: active.destination?.code_icao || active.destination?.code || null,
      destinationCity: active.destination?.city || null,
      actualOff: active.actual_off || null,
      estimatedOn: active.estimated_on || null,
      progressPercent: active.progress_percent ?? null,
    };
  } catch (err) {
    console.error(`[fa-positions] error for ${ident}:`, err);
    return { ident, airborne: false, error: err.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { idToken, idents } = req.body || {};
    if (!idToken) {
      res.status(400).json({ error: 'idToken required' });
      return;
    }
    if (!Array.isArray(idents) || idents.length === 0) {
      res.status(400).json({ error: 'idents must be a non-empty array' });
      return;
    }
    if (idents.length > 20) {
      res.status(400).json({ error: 'Too many idents — max 20 per call' });
      return;
    }

    try {
      await verifyOpsOrAdmin(idToken);
    } catch (err) {
      if (err.code === 'forbidden') {
        res.status(403).json({ error: err.message });
      } else {
        res.status(401).json({ error: 'Invalid token: ' + err.message });
      }
      return;
    }

    const apiKey = process.env.FLIGHTAWARE_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'FLIGHTAWARE_API_KEY not configured' });
      return;
    }

    // Fetch all positions in parallel
    const positions = await Promise.all(
      idents.map(ident => fetchPositionForTail(String(ident).toUpperCase(), apiKey))
    );

    res.status(200).json({ ok: true, positions, fetchedAt: Date.now() });
  } catch (err) {
    console.error('[fa-positions] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
