// /api/trip-public.js
//
// PUBLIC token-gated trip tracking for brokers.
//
// GET ?token=...&action=get      → returns sanitized trip + live position(s)
//
// Validation order:
//   1. HMAC token verify (api/_trip-token.js)
//   2. Trip must exist in Firestore (trip-state/{tripId})
//   3. trip.linkRevoked must be falsy
//   4. token.issuedAt must be >= trip.linkTokenIssuedAt (rotation invalidates)
//   5. If the trip's last leg landed >24h ago, deny
//
// Returns ONLY whitelisted fields. No crew contacts, no pricing, no pax
// names, no internal notes.
//
// Live position is fetched via the existing FlightAware infrastructure.
// Post-flight track logs are NOT included in this response (too heavy);
// the front-end can request them with action=track&legNumber=N.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyTripToken } from './_trip-token.js';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let _db = null;
function getAdmin() {
  if (adminApp) return adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}
function db() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

// Hours of grace after the last leg's actual landing before the link dies.
// Per product spec: 24h.
const GRACE_HOURS_AFTER_LAST_LEG = 24;

async function loadValidTrip(token) {
  const v = verifyTripToken(token);
  if (!v.ok) return { error: { code: 401, body: { ok: false, reason: v.reason } } };
  const ref = db().collection('trip-state').doc(v.tripId);
  const snap = await ref.get();
  if (!snap.exists) return { error: { code: 404, body: { ok: false, reason: 'trip not found' } } };
  const data = snap.data() || {};
  if (data.linkRevoked === true) {
    return { error: { code: 403, body: { ok: false, reason: 'link revoked' } } };
  }
  if (typeof data.linkTokenIssuedAt === 'number' && v.issuedAt < data.linkTokenIssuedAt) {
    return { error: { code: 403, body: { ok: false, reason: 'link rotated' } } };
  }
  return { tripId: v.tripId, data };
}

// Strip PII / internal info from trip-state for public consumption.
// What's kept: route, times, FBO, PIC NAME (no contact), aircraft tail/type,
// status timeline, completion state.
// What's stripped: passenger names, pricing, internal notes, broker email
// (the broker knows their own email), crew contact info, fees/fuel, anything
// not explicitly whitelisted.
function sanitizeTrip(tripId, data, legs) {
  // Status timeline — we want the broker to see the high-level events but
  // not internal ops notes. Keep timestamps and labels only.
  const statuses = data.statuses && typeof data.statuses === 'object' ? data.statuses : {};
  const cleanStatuses = {};
  for (const [legNum, byEvent] of Object.entries(statuses)) {
    if (!byEvent || typeof byEvent !== 'object') continue;
    cleanStatuses[legNum] = {};
    for (const [event, payload] of Object.entries(byEvent)) {
      if (!payload || typeof payload !== 'object') continue;
      // Only forward { at, ts, completed } shape. Drop sender names/emails/notes.
      cleanStatuses[legNum][event] = {
        at: payload.at || payload.ts || null,
        completed: payload.completed === true || !!payload.at,
      };
    }
  }
  // If publicTripData has per-leg status, that's the AUTHORITATIVE source —
  // each leg's trip-state doc contributed its own status timeline at share
  // time. Rebuild a statuses map keyed by the broker-facing legNumber.
  // Fall back to the anchor's cleanStatuses (legacy single-doc behavior).
  let outStatuses = cleanStatuses;
  if (data.publicTripData && Array.isArray(data.publicTripData.legs)) {
    const byLeg = {};
    data.publicTripData.legs.forEach((leg) => {
      if (!leg || !Number.isFinite(leg.legNumber)) return;
      const s = leg.status && typeof leg.status === 'object' ? leg.status : {};
      const clean = {};
      for (const key of ['crewArrived', 'ready', 'taxiing', 'airborne', 'departed', 'landed', 'arrived']) {
        const v = s[key];
        if (v && typeof v === 'object' && typeof v.at === 'number') {
          clean[key] = { at: v.at, completed: true };
        }
      }
      byLeg[leg.legNumber] = clean;
    });
    outStatuses = byLeg;
  }
  return {
    tripId,
    tripCode: data.tripCode || null,
    tail: (data.publicTripData?.tail) || data.tail || (legs[0] && legs[0].tail) || null,
    aircraftType: (data.publicTripData?.aircraftType) || data.aircraftType || null,
    legs: legs.map((leg) => ({
      legNumber: leg.legNumber,
      from: leg.from || null,
      to: leg.to || null,
      fromFbo: leg.fromFbo || data.fromFbo || null,
      toFbo: leg.toFbo || data.toFbo || null,
      departure: leg.departure || null,    // ISO
      arrival: leg.arrival || null,        // ISO
      category: leg.category || 'REVENUE', // REVENUE/REPO/FERRY
      pic: leg.picName || null,            // NAME ONLY — no contact info
      sic: leg.sicName || null,            // NAME ONLY — no contact info
      // Pax visibility enforced HERE as the last line of defense — even if
      // somehow a leg got persisted with showPax:false but a pax array
      // attached (or vice versa), we honor showPax strictly.
      pax: leg.showPax === true && Array.isArray(leg.pax) ? leg.pax : [],
      showPax: leg.showPax === true,
    })),
    statuses: outStatuses,
    completed: data.completed === true,
    completedAt: data.completedAt || null,
  };
}

// Compute "last leg actual landing time" from the statuses timeline so we
// can apply the 24h grace expiry.
function lastLegLandedAt(statuses) {
  if (!statuses || typeof statuses !== 'object') return null;
  let latestTs = null;
  for (const byEvent of Object.values(statuses)) {
    if (!byEvent || typeof byEvent !== 'object') continue;
    // 'landed' / 'arrived' / 'completed' — accept any "land" event flavor
    for (const [name, payload] of Object.entries(byEvent)) {
      if (!payload || typeof payload !== 'object') continue;
      if (!/land|arriv|complete/i.test(name)) continue;
      const at = payload.at || payload.ts;
      if (typeof at === 'number' && (!latestTs || at > latestTs)) latestTs = at;
    }
  }
  return latestTs;
}

// Live position for the trip's aircraft tail — best-effort, via FlightAware.
// We hit our own positions endpoint with an internal secret so it doesn't
// need a Firebase idToken.
async function fetchPosition(tail) {
  if (!tail) return null;
  try {
    // Read from the same collection the FlightBoard subscribes to. The
    // FA cron at /api/flightaware-cron-poll.js writes here every 2 minutes
    // for every fleet tail. Reading from Firestore is faster, more reliable,
    // and free of the self-HTTP-call awkwardness of the previous version.
    const safeTail = String(tail).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!safeTail) return null;
    const snap = await db().collection('flightaware-state').doc(safeTail).get();
    if (!snap.exists) return null;
    const pos = snap.data() || {};
    // Whitelist what we return to the broker. The Firestore doc may have
    // many fields (polledAt, raw FA payload bits, etc.); brokers only need
    // these.
    return {
      ident: pos.ident || safeTail,
      airborne: pos.airborne === true,
      latitude: Number.isFinite(pos.latitude) ? pos.latitude : null,
      longitude: Number.isFinite(pos.longitude) ? pos.longitude : null,
      heading: Number.isFinite(pos.heading) ? pos.heading : null,
      altitude: Number.isFinite(pos.altitude) ? pos.altitude : null,
      groundspeed: Number.isFinite(pos.groundspeed) ? pos.groundspeed : null,
      origin: pos.origin || null,
      destination: pos.destination || null,
      destinationCity: pos.destinationCity || null,
      estimatedOn: pos.estimatedOn || null,
      actualOff: pos.actualOff || null,
      faFlightId: pos.faFlightId || null,
      polledAt: pos.polledAt || null,
    };
  } catch (e) {
    console.error('[trip-public] fetchPosition failed:', e?.message || e);
    return null;
  }
}

// On-demand post-flight track log for a given leg's FA flight id.
async function fetchTrackLog(faFlightId) {
  if (!faFlightId) return null;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!internalSecret) return null;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ||
               process.env.VERCEL_URL ||
               'skyway-ops.vercel.app';
  try {
    const r = await fetch(`https://${host}/api/flightaware-track-log?faFlightId=${encodeURIComponent(faFlightId)}`, {
      method: 'GET',
      headers: { 'x-internal-secret': internalSecret },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data.positions) ? data.positions : null;
  } catch (e) {
    return null;
  }
}

// Derive legs from the trip-state doc. trip-state stores the upload result
// with tripMeta containing per-leg info; we reconstruct a clean leg list.
function legsFromTrip(data) {
  // The publicTripData snapshot persisted by the share endpoint is the
  // authoritative source — it's gathered from the client which has the full
  // multi-leg context. The trip-state doc itself doesn't carry legs.
  if (data.publicTripData && Array.isArray(data.publicTripData.legs) && data.publicTripData.legs.length) {
    return data.publicTripData.legs;
  }
  if (Array.isArray(data.legs) && data.legs.length) return data.legs;
  if (data.tripMeta && Array.isArray(data.tripMeta.legs)) return data.tripMeta.legs;
  return [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Allow cross-origin GETs from anywhere (broker email clients, etc.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, reason: 'GET only' });

  const token = (req.query?.token || '').toString();
  const action = (req.query?.action || 'get').toString();

  const r = await loadValidTrip(token);
  if (r.error) return res.status(r.error.code).json(r.error.body);
  const { tripId, data } = r;

  // 24-hour grace expiry after last-leg landing.
  const landedAt = lastLegLandedAt(data.statuses);
  if (landedAt && (Date.now() - landedAt) > GRACE_HOURS_AFTER_LAST_LEG * 3600 * 1000) {
    return res.status(410).json({ ok: false, reason: 'link expired after trip completion' });
  }

  const legs = legsFromTrip(data);
  const sanitized = sanitizeTrip(tripId, data, legs);

  if (action === 'track') {
    // Per-leg post-flight track log lookup.
    const legNumber = parseInt(req.query.legNumber || '1', 10);
    const leg = legs.find((l) => l.legNumber === legNumber);
    if (!leg) return res.status(404).json({ ok: false, reason: 'leg not found' });
    const log = await fetchTrackLog(leg.faFlightId);
    return res.status(200).json({ ok: true, legNumber, track: log });
  }

  // Default: live position + sanitized trip
  const position = await fetchPosition(sanitized.tail);
  return res.status(200).json({
    ok: true,
    trip: sanitized,
    position,
    // DIAGNOSTIC: tells us what's actually in the trip-state doc.
    // Remove once the issue is identified.
    _diag: {
      docFields: Object.keys(data || {}).sort(),
      hasPublicTripData: !!data.publicTripData,
      publicTripDataLegs: Array.isArray(data.publicTripData?.legs) ? data.publicTripData.legs.length : 0,
      publicTripDataTail: data.publicTripData?.tail || null,
    },
  });
}
