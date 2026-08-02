// /api/trip-public.js
//
// PUBLIC token-gated trip tracking for brokers.
//
// GET ?token=...   → sanitized trip + live position + flown trail + weather
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
// Live position, the flown track log, and airport weather are all fetched via
// existing internal infrastructure and folded into this one response, so the
// broker page needs exactly one request per poll and never talks to an
// authenticated ops endpoint directly.
//
// The track log is included for a leg that has departed whether or not it is
// still airborne — a broker opening the link after landing should still see the
// path the aircraft actually flew, which is the whole point of the map.

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
function sanitizeTrip(tripId, data, legs, liveLegData = {}) {
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
    const live = (legTripId && liveLegData[legTripId]?.statuses) || {};
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

  // Pick the pax array for a leg. If we have LIVE pax data (the leg's own
  // trip-state doc was successfully read and showPax was true at share
  // time), use that — it reflects up-to-the-second check-in state. Fall
  // back to the snapshot otherwise.
  // showPax is a SHARE-TIME policy decision (ops chose to expose pax or
  // not) so we always honor the snapshot's showPax flag regardless of
  // what's in the live data.
  const paxForLeg = (leg) => {
    if (leg.showPax !== true) return [];
    const live = leg.tripId ? liveLegData[leg.tripId]?.pax : undefined;
    if (Array.isArray(live)) return live;
    return Array.isArray(leg.pax) ? leg.pax : [];
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
      // Pax list — LIVE overlay if available, snapshot fallback. showPax
      // policy from the snapshot is enforced as the last line of defense.
      pax: paxForLeg(leg),
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

function internalHost() {
  return process.env.VERCEL_PROJECT_PRODUCTION_URL ||
         process.env.VERCEL_URL ||
         'skyway-ops.vercel.app';
}

// Actual-flight-path lookup. Uses the ident-based track-log endpoint, which
// auto-picks the current or most-recent flight for the tail — the right answer
// both while airborne and shortly after landing. Because the share link itself
// dies 24h after the last leg lands, "most recent flight for this tail" cannot
// drift far from the leg the broker is looking at.
//
// Altitude is carried through per point so the map can colour the trail by
// altitude the same way the ops screen does. Known limitation: on a multi-leg
// trip this returns the latest leg's path, not one path per leg — fixing that
// needs faFlightId persisted per leg at status-fire time.
async function fetchActualPath(tail) {
  if (!tail) return null;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!internalSecret) return null;
  try {
    const r = await fetch(
      `https://${internalHost()}/api/flightaware-track-log?ident=${encodeURIComponent(tail)}`,
      { method: 'GET', headers: { 'x-internal-secret': internalSecret } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const pts = Array.isArray(data.points) ? data.points : [];
    return pts
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({
        lat: p.lat,
        lon: p.lon,
        altitude_ft: Number.isFinite(p.altitude_ft) ? p.altitude_ft : null,
        groundspeed_kt: Number.isFinite(p.groundspeed_kt) ? p.groundspeed_kt : null,
        time: Number.isFinite(p.time) ? p.time : null,
      }));
  } catch (e) {
    return null;
  }
}

// Current conditions for the trip's airports. METAR/TAF is public aviation
// data, but the ops weather endpoint requires a Firebase token — so we call it
// server-side with the internal secret and hand the broker a whitelisted
// subset. Server-side response caching (10 min) means broker polling adds no
// meaningful upstream load.
const WEATHER_FIELDS = [
  'observedTime', 'rawMetar', 'tempC', 'dewpointC', 'windDir', 'windKt',
  'windGustKt', 'visibilitySm', 'ceilingFt', 'flightCategory', 'altimeterInHg',
];
const MAX_WEATHER_STATIONS = 6;

async function fetchWeather(codes) {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!internalSecret) return {};
  const unique = Array.from(new Set(
    (codes || [])
      .map((c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''))
      .filter(Boolean)
  )).slice(0, MAX_WEATHER_STATIONS);
  if (unique.length === 0) return {};

  const entries = await Promise.all(unique.map(async (code) => {
    try {
      const r = await fetch(
        `https://${internalHost()}/api/airport-weather?icao=${encodeURIComponent(code)}`,
        { method: 'GET', headers: { 'x-internal-secret': internalSecret } }
      );
      if (!r.ok) return null;
      const data = await r.json();
      const metarSource = data.metar || data.parsed;
      if (!metarSource) return null;
      const metar = {};
      for (const f of WEATHER_FIELDS) {
        metar[f] = metarSource[f] ?? null;
      }
      // One TAF period is enough for a broker to see what is forecast at
      // arrival; the full period list is operational detail.
      const tafPeriod = Array.isArray(data.taf?.periods) ? data.taf.periods[0] : null;
      return [code, {
        icao: data.icao || code,
        metar,
        forecast: tafPeriod ? {
          timeFrom: tafPeriod.timeFrom ?? null,
          timeTo: tafPeriod.timeTo ?? null,
          windDir: tafPeriod.windDir ?? null,
          windKt: tafPeriod.windKt ?? null,
          visibilitySm: tafPeriod.visibilitySm ?? null,
          ceilingFt: tafPeriod.ceilingFt ?? null,
          flightCategory: tafPeriod.flightCategory ?? null,
        } : null,
      }];
    } catch {
      return null;
    }
  }));

  return Object.fromEntries(entries.filter(Boolean));
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

// Build broker-facing pax records from a leg's live trip-state doc data.
// This is the same join logic that lives in App.jsx buildPublicTripData,
// but applied SERVER-SIDE on each broker page poll so check-in status
// updates after the share-time snapshot was taken.
//
// Returns the pax array shape the broker page expects:
//   [{ name, status, checkedInAt, walkUp }, ...]
//
// Status mapping (matches client code):
//   matched / manual_override / child_verified  → 'checked_in'
//   skipped                                     → 'skipped'
//   else                                        → 'pending'
//   scanned record with noShow:true             → 'no_show' (overrides above)
function buildPaxRecordsFromLiveData(preloadedPax, scannedPassengers) {
  const preloaded = Array.isArray(preloadedPax) ? preloadedPax : [];
  const scanned = Array.isArray(scannedPassengers) ? scannedPassengers : [];
  const scannedByRef = new Map();
  const walkUps = [];
  for (const sp of scanned) {
    if (sp && sp.preloadedRefId) {
      scannedByRef.set(sp.preloadedRefId, sp);
    } else if (sp) {
      walkUps.push(sp);
    }
  }
  const records = [];
  for (const p of preloaded) {
    const first = String(p?.firstName || '').trim();
    const last = String(p?.lastName || '').trim();
    const name = [first, last].filter(Boolean).join(' ');
    if (!name) continue;
    const scan = p.id ? scannedByRef.get(p.id) : null;
    const cs = p.checkInStatus || '';
    let status = 'pending';
    if (cs === 'matched' || cs === 'manual_override' || cs === 'child_verified') status = 'checked_in';
    else if (cs === 'skipped') status = 'skipped';
    if (scan?.noShow) status = 'no_show';
    records.push({
      name,
      status,
      checkedInAt: scan?.verifiedAt || null,
      walkUp: false,
    });
  }
  for (const sp of walkUps) {
    const first = String(sp?.firstName || '').trim();
    const last = String(sp?.lastName || '').trim();
    const name = [first, last].filter(Boolean).join(' ');
    if (!name) continue;
    records.push({
      name,
      status: sp.noShow ? 'no_show' : 'checked_in',
      checkedInAt: sp.verifiedAt || sp.scannedAt || null,
      walkUp: true,
    });
  }
  return records;
}

// Fetch LIVE data from each leg's own trip-state doc. The publicTripData
// snapshot persisted at share-time is structurally authoritative (which legs
// exist, route, FBO, crew assignments) but two pieces of data CHANGE during
// the trip and need to be re-read on every broker poll:
//   1) statuses — wheels_up, landed, etc. fire after share-time
//   2) pax check-in — crew scans IDs at the gate after share-time
//
// Without this overlay, after a broker is sent the link mid-day, they'd see
// "PASSENGERS 0/2 CHECKED IN" forever even after pax verify at the gate. Ops
// would have to re-rotate the share link constantly to refresh the snapshot.
//
// This helper batch-reads each leg's trip-state doc once and returns a map:
//   { legTripId: {
//       statuses: { wheels_up: {at}, landed: {at}, ... },
//       pax:      [{name, status, checkedInAt, walkUp}, ...],
//       showPax:  true|false  (whether broker should see pax for this leg)
//     }, ... }
//
// `showPax` is preserved from the snapshot since it's a SHARE-TIME policy
// decision (ops chose not to expose pax on certain legs); only the contents
// of the pax array refresh. If the snapshot said showPax=false, we still
// return [] regardless of what we read from the live doc — the broker
// never sees pax for that leg.
//
// Defensive on failures: any doc that can't be read just returns no live
// data for that leg and we fall back to the snapshot. Never throw — broker
// page should still render.
async function fetchLiveLegData(legs) {
  if (!Array.isArray(legs) || legs.length === 0) return {};
  const tripIds = legs.map((l) => l?.tripId).filter(Boolean);
  if (tripIds.length === 0) return {};
  const out = {};
  // Whitelist of status keys we forward to the broker. Same list the
  // sanitizer uses; keeping them in sync is critical for the overlay to
  // do anything useful.
  const STATUS_KEYS = ['crew_onsite', 'aircraft_ready', 'catering_aboard', 'pax_arrived', 'pax_boarded', 'taxi_dep', 'wheels_up', 'landed'];
  // Build a quick lookup of legs by tripId so we can preserve the showPax
  // policy from the snapshot when building pax records.
  const showPaxByTripId = {};
  for (const leg of legs) {
    if (leg?.tripId) showPaxByTripId[leg.tripId] = leg.showPax === true;
  }
  await Promise.all(tripIds.map(async (tid) => {
    try {
      const snap = await db().collection('trip-state').doc(tid).get();
      if (!snap.exists) return;
      const sd = snap.data() || {};

      // ---------- Live statuses ----------
      const bag = (sd.statuses && typeof sd.statuses === 'object') ? sd.statuses : {};
      const liveStatuses = {};
      for (const key of STATUS_KEYS) {
        const v = bag[key];
        if (v && typeof v === 'object') {
          const at = Number.isFinite(v.timestamp) ? v.timestamp
                    : Number.isFinite(v.at) ? v.at
                    : null;
          if (at !== null) liveStatuses[key] = { at };
        }
      }

      // ---------- Live pax ----------
      // Only build pax records if the snapshot said this leg shows pax.
      // Otherwise we leave the field undefined and the sanitizer falls back
      // to the snapshot's (empty) array.
      let livePax = undefined;
      if (showPaxByTripId[tid]) {
        livePax = buildPaxRecordsFromLiveData(sd.preloadedPax, sd.passengers);
      }

      out[tid] = { statuses: liveStatuses, pax: livePax };
    } catch (e) {
      // Swallow — broker page renders fine without live overlay for this leg.
      console.warn('[trip-public] fetchLiveLegData failed for', tid, e?.message);
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

  const r = await loadValidTrip(token);
  if (r.error) return res.status(r.error.code).json(r.error.body);
  const { tripId, data } = r;

  // 24-hour grace expiry after last-leg landing.
  const landedAt = lastLegLandedAt(data.statuses);
  if (landedAt && (Date.now() - landedAt) > GRACE_HOURS_AFTER_LAST_LEG * 3600 * 1000) {
    return res.status(410).json({ ok: false, reason: 'link expired after trip completion' });
  }

  const legs = legsFromTrip(data);

  // Re-read per-leg trip-state docs to overlay LIVE data on top of the
  // share-time snapshot. Without this overlay, post-share events never
  // reach the broker — they'd see frozen status and frozen pax check-in
  // forever. Two things refresh per poll: statuses (wheels_up/landed/etc)
  // and pax check-in records.
  const liveLegData = await fetchLiveLegData(legs);

  const sanitized = sanitizeTrip(tripId, data, legs, liveLegData);

  // Re-check the 24h post-landing expiry against the live data we just
  // pulled. The earlier check used the anchor's stale `data.statuses` —
  // if a leg's `landed` event has fired more than 24h ago but the snapshot
  // doesn't know about it, we'd be serving a "completed" trip indefinitely.
  // Pull the latest landed timestamp across all legs from the LIVE data and
  // bounce the request if past grace.
  let lastLanded = landedAt;
  for (const tid of Object.keys(liveLegData)) {
    const lt = liveLegData[tid]?.statuses?.landed?.at;
    if (Number.isFinite(lt) && (!lastLanded || lt > lastLanded)) lastLanded = lt;
  }
  if (lastLanded && (Date.now() - lastLanded) > GRACE_HOURS_AFTER_LAST_LEG * 3600 * 1000) {
    return res.status(410).json({ ok: false, reason: 'link expired after trip completion' });
  }

  // Weather for every airport on the trip, and the flown path for any leg that
  // has departed. Both are fetched in parallel with the position read.
  const airportCodes = [];
  for (const leg of sanitized.legs) {
    if (leg.from) airportCodes.push(leg.from);
    if (leg.to) airportCodes.push(leg.to);
  }

  // A leg that has departed has a path worth drawing, airborne or not. Only a
  // trip where nothing has left the ground skips the track-log call, so we
  // never spend an AeroAPI unit drawing a line for a flight that hasn't flown.
  const hasDepartedLeg = sanitized.legs.some((l) => l.status?.wheels_up);
  const hasAirborneLeg = sanitized.legs.some((l) => l.status?.wheels_up && !l.status?.landed);

  const [position, trail, weather] = await Promise.all([
    fetchPosition(sanitized.tail),
    hasDepartedLeg && sanitized.tail ? fetchActualPath(sanitized.tail) : Promise.resolve(null),
    fetchWeather(airportCodes),
  ]);

  return res.status(200).json({
    ok: true,
    trip: sanitized,
    position,
    // Track-log points as { lat, lon, altitude_ft, groundspeed_kt, time } so
    // the broker map can colour the trail by altitude.
    trail,
    trailLive: hasAirborneLeg,
    weather,
  });
}
