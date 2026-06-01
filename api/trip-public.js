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
function sanitizeTrip(tripId, data, legs, liveStatuses = {}) {
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

  // Merge each leg's snapshot status with its LIVE counterpart. Per status
  // key, live wins if present. This lets us pick up landed/wheels_up events
  // that fired after the link was shared without requiring ops to rotate
  // or re-open the share dialog.
  const mergeStatusForLeg = (legTripId, snapshotStatus) => {
    const snap = snapshotStatus && typeof snapshotStatus === 'object' ? snapshotStatus : {};
    const live = (legTripId && liveStatuses[legTripId]) || {};
    const merged = {};
    const allKeys = new Set([...Object.keys(snap), ...Object.keys(live)]);
    for (const k of allKeys) {
      // Live takes priority if it has a valid timestamp. Otherwise fall
      // back to the snapshot value.
      if (live[k] && Number.isFinite(live[k].at)) {
        merged[k] = { at: live[k].at, completed: true };
      } else if (snap[k] && Number.isFinite(snap[k].at)) {
        merged[k] = { at: snap[k].at, completed: true };
      }
    }
    return merged;
  };

  // If publicTripData has per-leg status, that's the AUTHORITATIVE source —
  // each leg's trip-state doc contributed its own status timeline at share
  // time. We overlay LIVE statuses on top so brokers see post-share-time
  // events (e.g. landed) automatically.
  let outStatuses = cleanStatuses;
  if (data.publicTripData && Array.isArray(data.publicTripData.legs)) {
    const byLeg = {};
    data.publicTripData.legs.forEach((leg) => {
      if (!leg || !Number.isFinite(leg.legNumber)) return;
      const merged = mergeStatusForLeg(leg.tripId, leg.status);
      byLeg[leg.legNumber] = merged;
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
      // Per-leg status timeline — MERGED snapshot + live. Live wins where
      // present so brokers see post-share-time events (landed, etc.).
      status: mergeStatusForLeg(leg.tripId, leg.status),
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

// On-demand actual-flight-path lookup for the airborne leg. Uses the
// ident-based track-log endpoint which auto-picks the current/most-recent
// flight for the tail — exactly what we want for the live leg. For
// LANDED legs the same endpoint returns the most recent completed flight,
// which is usually still the right leg if the broker opens the page
// shortly after landing; for older completed legs the result may not
// match. Future improvement: persist faFlightId per leg at upload time
// and look up by flightId for historical accuracy.
async function fetchActualPath(tail) {
  if (!tail) return null;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!internalSecret) return null;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ||
               process.env.VERCEL_URL ||
               'skyway-ops.vercel.app';
  try {
    const r = await fetch(
      `https://${host}/api/flightaware-track-log?ident=${encodeURIComponent(tail)}`,
      { method: 'GET', headers: { 'x-internal-secret': internalSecret } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const pts = Array.isArray(data.points) ? data.points : [];
    // Reduce to just [lat, lon] tuples in chronological order. Drop any
    // points missing coordinates (FA sometimes emits placeholder records).
    return pts
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => [p.lat, p.lon]);
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

// Fetch live statuses from each leg's own trip-state doc. The publicTripData
// snapshot persisted at share-time is structurally authoritative (which legs
// exist, route, FBO, crew, pax assignments) but its `status` field is a
// FROZEN COPY of statuses-at-share-time. If status changes after the link
// is shared (typically: landed event fires while broker is watching), the
// snapshot never updates — the broker keeps seeing "in flight" forever.
//
// This helper batch-reads each leg's trip-state doc and returns a map of
// `{ legTripId: { wheels_up: {at: ...}, landed: {at: ...}, ... } }` so the
// sanitizer can overlay live data on top of the snapshot.
//
// Defensive on failures: any doc that can't be read (deleted, permission
// error, network blip) just returns no live data for that leg and we fall
// back to the snapshot. Never throw — broker page should still render.
async function fetchLiveStatuses(legs) {
  if (!Array.isArray(legs) || legs.length === 0) return {};
  const tripIds = legs.map((l) => l?.tripId).filter(Boolean);
  if (tripIds.length === 0) return {};
  const out = {};
  // Whitelist of status keys we forward to the broker. Same list the
  // sanitizer uses; keeping them in sync is critical for the overlay to
  // do anything useful.
  const KEYS = ['crew_onsite', 'aircraft_ready', 'catering_aboard', 'pax_arrived', 'pax_boarded', 'taxi_dep', 'wheels_up', 'landed'];
  await Promise.all(tripIds.map(async (tid) => {
    try {
      const snap = await db().collection('trip-state').doc(tid).get();
      if (!snap.exists) return;
      const sd = snap.data() || {};
      const bag = (sd.statuses && typeof sd.statuses === 'object') ? sd.statuses : {};
      // Each leg's trip-state doc has statuses as a flat map keyed by
      // step id, e.g. { crew_onsite: { timestamp, author, ... }, ... }.
      // We normalize to { key: { at: ms } } so the broker side can read
      // a single shape.
      const clean = {};
      for (const key of KEYS) {
        const v = bag[key];
        if (v && typeof v === 'object') {
          const at = Number.isFinite(v.timestamp) ? v.timestamp
                    : Number.isFinite(v.at) ? v.at
                    : null;
          if (at !== null) clean[key] = { at };
        }
      }
      if (Object.keys(clean).length > 0) out[tid] = clean;
    } catch (e) {
      // Swallow — broker page renders fine without live overlay for this leg.
      console.warn('[trip-public] fetchLiveStatuses failed for', tid, e?.message);
    }
  }));
  return out;
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

  // Re-read per-leg trip-state docs to overlay LIVE statuses on top of the
  // share-time snapshot. Without this overlay, a landed event that fires
  // AFTER the link was shared never reaches the broker — they see "in flight"
  // forever. This is one of two places the data flows from ops → broker;
  // the other is the share dialog which only fires on explicit ROTATE /
  // share open. Brokers can't depend on ops re-opening the dialog every
  // time a status changes.
  const liveStatuses = await fetchLiveStatuses(legs);

  const sanitized = sanitizeTrip(tripId, data, legs, liveStatuses);

  // Re-check the 24h post-landing expiry against the live data we just
  // pulled. The earlier check used the anchor's stale `data.statuses` —
  // if a leg's `landed` event has fired more than 24h ago but the snapshot
  // doesn't know about it, we'd be serving a "completed" trip indefinitely.
  // Pull the latest landed timestamp across all legs from the LIVE data and
  // bounce the request if past grace.
  let lastLanded = landedAt;
  for (const tid of Object.keys(liveStatuses)) {
    const lt = liveStatuses[tid]?.landed?.at;
    if (Number.isFinite(lt) && (!lastLanded || lt > lastLanded)) lastLanded = lt;
  }
  if (lastLanded && (Date.now() - lastLanded) > GRACE_HOURS_AFTER_LAST_LEG * 3600 * 1000) {
    return res.status(410).json({ ok: false, reason: 'link expired after trip completion' });
  }

  // Default: live position + actual flight path + sanitized trip.
  const position = await fetchPosition(sanitized.tail);
  // Fetch the actual flown breadcrumb only when there's an airborne leg
  // (otherwise the call wastes a FlightAware AeroAPI billing unit for a
  // straight line on a completed flight). The endpoint is cached for 60s
  // server-side so repeated polls don't burn the quota.
  let trail = null;
  const hasAirborneLeg = sanitized.legs.some((l) => l.status?.wheels_up && !l.status?.landed);
  if (hasAirborneLeg && sanitized.tail) {
    trail = await fetchActualPath(sanitized.tail);
  }
  return res.status(200).json({
    ok: true,
    trip: sanitized,
    position,
    trail,
    // DIAGNOSTIC: tells us what's actually in the trip-state doc.
    // Remove once the issue is identified.
    _diag: {
      docFields: Object.keys(data || {}).sort(),
      hasPublicTripData: !!data.publicTripData,
      publicTripDataLegs: Array.isArray(data.publicTripData?.legs) ? data.publicTripData.legs.length : 0,
      publicTripDataTail: data.publicTripData?.tail || null,
      trailPoints: Array.isArray(trail) ? trail.length : 0,
    },
  });
}
