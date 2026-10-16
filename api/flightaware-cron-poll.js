// api/flightaware-cron-poll.js
//
// Triggered every 2 minutes by Vercel Cron (see vercel.json).
//
// Polls FlightAware for the current state of all subscribed tails, compares
// each tail's state to its previous poll, and on detected transitions:
//   - Grounded → Airborne     → fire WHEELS UP status + email broker + trip-status push
//   - Airborne → Grounded     → fire LANDED status + email + archive trip + trip-status push
//
// State is persisted in Firestore at flightaware-state/{tail} between polls.
//
// Idempotent: if a status was already fired (manually or by webhook), this
// will detect that and not double-fire/double-email.
//
// Cost: 8 tails × 1 query × 720 polls/day = ~5,760 API calls/day at $0.005 ≈
// $29/day. Costs even when no flights happen — be aware.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { lookupAirport } from './_airports-data.js';
import { DEFAULT_MANAGED_TAILS, normalizeFleetTails } from '../src/fleet-config.js';
import { selectActiveFlight } from '../src/flightaware-active.js';
import { readTripId } from '../src/fleet-tracking.js';
import { statusEventAt } from '../src/trip-status.js';
import { dispatchToRecipients, resolveTripPushRecipients } from './send-push.js';

const FA_API_BASE = 'https://aeroapi.flightaware.com/aeroapi';
export const MAX_BROKERED_TAILS_PER_POLL = 20;
export function resolveCronFleetTails(config, brokeredTracking = [], now = Date.now()) {
  const managed = config?.configured === true
    ? normalizeFleetTails(config.managedTails || [])
    : [...DEFAULT_MANAGED_TAILS];
  const temporary = (Array.isArray(brokeredTracking) ? brokeredTracking : [])
    .filter((entry) => entry?.active === true)
    .filter((entry) => !entry.expiresAt || Number(entry.expiresAt) > now)
    // Soonest-expiring trips first if more links are active than the cost cap.
    .sort((a, b) => Number(a.expiresAt || Infinity) - Number(b.expiresAt || Infinity))
    .map((entry) => entry.tail)
    .filter((value, index, list) => (
      list.findIndex((other) => String(other).toUpperCase() === String(value).toUpperCase()) === index
    ))
    .slice(0, MAX_BROKERED_TAILS_PER_POLL);
  return normalizeFleetTails([...managed, ...temporary]);
}

/**
 * Filed/upcoming movements for operator awareness.
 *
 * FlightAware does not know whether a flight carries passengers, so these are
 * never labeled or exposed to a broker as repositioning automatically. The
 * operating crew can explicitly file a reposition through their scoped portal.
 */
export function normalizeFiledFlights(flights, now = Date.now()) {
  const min = now - 6 * 60 * 60 * 1000;
  const max = now + 72 * 60 * 60 * 1000;
  return (Array.isArray(flights) ? flights : [])
    .filter((flight) => !flight?.actual_on)
    .map((flight) => {
      const scheduledOut = flight.scheduled_out || flight.estimated_out || flight.actual_off || null;
      const outMs = new Date(scheduledOut).getTime();
      return {
        id: flight.fa_flight_id || '',
        origin: flight.origin?.code_icao || flight.origin?.code || flight.origin?.code_iata || '',
        destination: flight.destination?.code_icao || flight.destination?.code || flight.destination?.code_iata || '',
        scheduledOut,
        scheduledIn: flight.scheduled_in || flight.scheduled_on || flight.estimated_in || flight.estimated_on || null,
        outMs,
      };
    })
    .filter((flight) => (
      flight.id
      && flight.origin
      && flight.destination
      && Number.isFinite(flight.outMs)
      && flight.outMs >= min
      && flight.outMs <= max
    ))
    .sort((a, b) => a.outMs - b.outMs)
    .slice(0, 10)
    .map(({ outMs, ...flight }) => flight);
}

/**
 * Preserve the last usable coordinate through FlightAware gaps and failures.
 * The API occasionally returns no completed flight, or a transient error,
 * which must not make a parked aircraft disappear from every map.
 */
export function mergeFlightAwareState(previous, current, polledAt = Date.now()) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const next = current && typeof current === 'object' ? current : {};
  if (next.error) {
    return {
      ...prior,
      ident: next.ident || prior.ident || '',
      error: next.error,
      dataFresh: false,
      polledAt,
    };
  }

  const airbornePosition = next.airborne === true
    && Number.isFinite(next.latitude) && Number.isFinite(next.longitude);
  const groundPosition = next.airborne === false
    && Number.isFinite(next.groundedLat) && Number.isFinite(next.groundedLon);
  const lastKnown = airbornePosition
    ? {
      lastKnownLatitude: next.latitude,
      lastKnownLongitude: next.longitude,
      lastKnownAt: polledAt,
      lastKnownAirport: null,
    }
    : groundPosition
      ? {
        lastKnownLatitude: next.groundedLat,
        lastKnownLongitude: next.groundedLon,
        lastKnownAt: next.groundedSince || polledAt,
        lastKnownAirport: next.groundedAt || null,
      }
      : {
        lastKnownLatitude: prior.lastKnownLatitude
          ?? prior.groundedLat ?? prior.latitude ?? null,
        lastKnownLongitude: prior.lastKnownLongitude
          ?? prior.groundedLon ?? prior.longitude ?? null,
        lastKnownAt: prior.lastKnownAt || prior.groundedSince || prior.polledAt || null,
        lastKnownAirport: prior.lastKnownAirport || prior.groundedAt || null,
      };

  return {
    ...prior,
    ...next,
    // Never erase a previously known parking location with an empty response.
    groundedAt: next.groundedAt || (next.airborne === false ? prior.groundedAt : null) || null,
    groundedLat: Number.isFinite(next.groundedLat)
      ? next.groundedLat : (next.airborne === false ? prior.groundedLat : null),
    groundedLon: Number.isFinite(next.groundedLon)
      ? next.groundedLon : (next.airborne === false ? prior.groundedLon : null),
    groundedSince: next.groundedSince
      || (next.airborne === false ? prior.groundedSince : null) || null,
    ...lastKnown,
    error: null,
    dataFresh: true,
    polledAt,
  };
}

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

// === Airport code helpers (shared with webhook) ===
function normCode(code) {
  if (!code) return '';
  return String(code).toUpperCase().trim();
}

function airportsMatch(a, b) {
  const A = normCode(a);
  const B = normCode(b);
  if (!A || !B) return false;
  if (A === B) return true;
  const A_noK = A.replace(/^K/, '');
  const B_noK = B.replace(/^K/, '');
  if (A_noK && A_noK === B_noK) return true;
  return false;
}

function fmtTime(iso, timezone) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (timezone) {
      const tf = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
        hour12: true,
      });
      return tf.format(d);
    }
    console.warn(`[fmtTime] no timezone for iso=${iso}, falling back to Zulu`);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}Z`;
  } catch {
    return '';
  }
}

// === Fetch current FA position for one tail ===
// Returns { airborne, origin, destination, originLat/Lon, destLat/Lon,
//          actualOff, actualOn, estimatedOn, faFlightId, latitude, longitude }
async function fetchTailState(ident, apiKey) {
  const url = `${FA_API_BASE}/flights/${encodeURIComponent(ident)}`;
  const r = await fetch(url, {
    headers: { 'x-apikey': apiKey, Accept: 'application/json' },
  });
  if (!r.ok) {
    return { ident, airborne: false, error: `FA ${r.status}` };
  }
  const data = await r.json();
  const flights = Array.isArray(data.flights) ? data.flights : [];
  const filedFlights = normalizeFiledFlights(flights);

  // Off-block (actual_out) and enroute progress count as airborne. Waiting
  // for actual_off left early departures looking parked on the TV.
  const active = selectActiveFlight(flights);
  if (active) {
    // Fetch the latest position for richer data
    let position = null;
    if (active.fa_flight_id) {
      try {
        const pr = await fetch(
          `${FA_API_BASE}/flights/${encodeURIComponent(active.fa_flight_id)}/position`,
          { headers: { 'x-apikey': apiKey, Accept: 'application/json' } }
        );
        if (pr.ok) {
          const pd = await pr.json();
          position = pd?.last_position || null;
        }
      } catch (e) {
        // Non-fatal — we use whatever data we have on the active flight
      }
    }
    return {
      ident,
      airborne: true,
      faFlightId: active.fa_flight_id,
      origin: active.origin?.code_icao || active.origin?.code || null,
      originLat: active.origin?.latitude ?? null,
      originLon: active.origin?.longitude ?? null,
      originTz: active.origin?.timezone || null,
      destination: active.destination?.code_icao || active.destination?.code || null,
      destinationLat: active.destination?.latitude ?? null,
      destinationLon: active.destination?.longitude ?? null,
      destinationCity: active.destination?.city || null,
      destinationTz: active.destination?.timezone || null,
      actualOff: active.actual_off || active.actual_out || null,
      actualOut: active.actual_out || null,
      actualOn: null,
      estimatedOn: active.estimated_on || null,
      scheduledOn: active.scheduled_on || null,
      scheduledIn: active.scheduled_in || null,
      // Position-derived (from active.last_position or the secondary fetch)
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
      heading: position?.heading ?? null,
      // FA returns altitude in hundreds of feet — normalize to feet here
      // so consumers don't have to remember.
      altitude: position?.altitude != null ? position.altitude * 100 : null,
      groundspeed: position?.groundspeed ?? null,
      // Progress + flight phase info
      progressPercent: active.progress_percent ?? null,
      filedFlights,
    };
  }

  // Not airborne — find the most recent completed flight (for landed detection)
  const completed = flights
    .filter(f => f.actual_on)
    .sort((a, b) => new Date(b.actual_on) - new Date(a.actual_on));
  const lastLanded = completed[0];
  if (lastLanded) {
    const dest = lastLanded.destination || {};
    const destCode = dest.code_icao || dest.code || dest.code_iata || null;
    const knownDest = destCode ? lookupAirport(destCode) : null;
    const origin = lastLanded.origin || {};
    const originCode = origin.code_icao || origin.code || origin.code_iata || null;
    const knownOrigin = originCode ? lookupAirport(originCode) : null;
    return {
      ident,
      airborne: false,
      faFlightId: lastLanded.fa_flight_id,
      origin: originCode,
      originLat: knownOrigin?.latitude ?? origin.latitude ?? null,
      originLon: knownOrigin?.longitude ?? origin.longitude ?? null,
      originTz: origin.timezone || null,
      destination: destCode,
      destinationCity: dest.city || null,
      destinationTz: dest.timezone || null,
      actualOff: lastLanded.actual_off || null,
      actualOn: lastLanded.actual_on,
      estimatedOn: null,
      scheduledOn: lastLanded.scheduled_on || null,
      scheduledIn: lastLanded.scheduled_in || null,
      // For grounded tails, FA gives us the destination of the last
      // completed flight — that's where the plane is sitting now.
      // Both fleet board and TRACKING tab use these to draw the
      // parked-aircraft marker on the map.
      groundedAt: destCode,
      groundedLat: knownDest?.latitude ?? dest.latitude ?? null,
      groundedLon: knownDest?.longitude ?? dest.longitude ?? null,
      groundedSince: lastLanded.actual_on,
      lastOrigin: originCode,
      lastOriginLat: knownOrigin?.latitude ?? origin.latitude ?? null,
      lastOriginLon: knownOrigin?.longitude ?? origin.longitude ?? null,
      filedFlights,
    };
  }

  return { ident, airborne: false, filedFlights };
}

// === Find a matching trip-state doc for an event ===
//
// Window: -2h (early take-offs are rare) to +12h (delays push events later
// than scheduled — common for charter). Asymmetric on purpose; the old
// symmetric ±4h window dropped any flight delayed >4h.
//
// Tiebreaker (the OLD bug): when multiple trips for the same tail+from are
// in the window, the old code picked the one with smallest |startMs -
// eventTimeMs|. That picked the WRONG trip when today's was delayed and
// tomorrow's was scheduled soon. We now use a scoring system:
//   +10000  trip has the matching PRIOR step already fired (sequential)
//   +5000   trip's scheduled start is in the past (it's actually in progress)
//   -minutes between start and event time (closest-in-time as a final tiebreak)
async function findMatchingTrip(db, ident, originCode, eventTimeMs, stepId) {
  if (!ident) return null;

  const WINDOW_EARLY_MS = 2 * 60 * 60 * 1000;
  const WINDOW_LATE_MS = 12 * 60 * 60 * 1000;
  const windowStart = eventTimeMs - WINDOW_LATE_MS;
  const windowEnd = eventTimeMs + WINDOW_EARLY_MS;

  console.log(`[matcher] looking for ${ident} from=${originCode} eventAt=${new Date(eventTimeMs).toISOString()} for step=${stepId}`);

  const snap = await db.collection('trip-state').get();
  const candidates = [];
  let tailMatchCount = 0;
  let originRejectCount = 0;
  let timeRejectCount = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.archived === true) continue;

    const meta = data.tripMeta;
    if (!meta || !meta.tail || !meta.from || !meta.start) continue;

    if (String(meta.tail).toUpperCase() !== ident.toUpperCase()) continue;
    tailMatchCount++;

    if (originCode && !airportsMatch(meta.from, originCode)) {
      console.log(`[matcher]   rejecting ${doc.id}: meta.from=${meta.from} vs origin=${originCode}`);
      originRejectCount++;
      continue;
    }

    const startMs = new Date(meta.start).getTime();
    if (isNaN(startMs)) continue;
    if (startMs < windowStart || startMs > windowEnd) {
      console.log(`[matcher]   rejecting ${doc.id}: start=${meta.start} outside window`);
      timeRejectCount++;
      continue;
    }

    candidates.push({ uid: doc.id, data, startMs });
  }

  console.log(`[matcher] tailMatches=${tailMatchCount} originRejected=${originRejectCount} timeRejected=${timeRejectCount} candidates=${candidates.length}`);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    console.log(`[matcher] PICKED ${candidates[0].uid} (only candidate)`);
    return candidates[0];
  }

  function scoreCandidate(c) {
    const statuses = c.data.statuses || {};
    let score = 0;
    if (stepId === 'wheels_up' && statuses.taxi_dep) score += 10000;
    if (stepId === 'landed' && statuses.wheels_up) score += 10000;
    if (stepId === 'landed' && statuses.taxi_dep) score += 5000;
    if (c.startMs <= eventTimeMs) score += 5000;
    score -= Math.abs(c.startMs - eventTimeMs) / 60000;
    return score;
  }

  const scored = candidates.map(c => ({ ...c, score: scoreCandidate(c) }));
  scored.sort((a, b) => b.score - a.score);

  for (const c of scored) {
    console.log(`[matcher]   candidate ${c.uid}: score=${c.score.toFixed(0)} start=${new Date(c.startMs).toISOString()} diff=${((c.startMs - eventTimeMs) / 60000).toFixed(0)}min`);
  }
  console.log(`[matcher] PICKED ${scored[0].uid} (score ${scored[0].score.toFixed(0)} vs runner-up ${scored[1]?.score?.toFixed(0) ?? 'n/a'})`);

  return scored[0];
}

// === Send email via internal /api/email-enqueue (reliable queue) ===
// Falls back to /api/send-email if the queue endpoint is unavailable.
async function sendEmail(host, to, subject, text, meta) {
  try {
    const proto = host.includes('localhost') ? 'http' : 'https';
    const headers = { 'Content-Type': 'application/json' };
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (internalSecret) headers['x-internal-secret'] = internalSecret;
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypassSecret) headers['x-vercel-protection-bypass'] = bypassSecret;

    const body = JSON.stringify({
      to, subject, text,
      source: meta?.source || 'fa-cron',
      tripId: meta?.tripId || null,
      statusKey: meta?.statusKey || null,
    });

    // Try queue first
    const r = await fetch(`${proto}://${host}/api/email-enqueue`, {
      method: 'POST', headers, body,
    });
    if (r.ok) {
      console.log('[cron-poll] email queued to', Array.isArray(to) ? to.join(',') : to);
      return true;
    }
    const t = await r.text().catch(() => '');
    console.warn('[cron-poll] queue endpoint returned', r.status, t.slice(0, 200), '— falling back to direct send');

    // Fallback: direct send-email
    const r2 = await fetch(`${proto}://${host}/api/send-email`, {
      method: 'POST', headers,
      body: JSON.stringify({ to, subject, text }),
    });
    if (!r2.ok) {
      const t2 = await r2.text().catch(() => '');
      console.error('[cron-poll] fallback send-email failed:', r2.status, t2.slice(0, 200));
      return false;
    }
    console.log('[cron-poll] fallback send-email OK to', Array.isArray(to) ? to.join(',') : to);
    return true;
  } catch (err) {
    console.error('[cron-poll] sendEmail exception:', err.message);
    return false;
  }
}

function buildBrokerEmail({ tail, eventType, originCode, destCode, originTz, destTz, estimatedOn, actualOff, actualOn, scheduledArrivalIso }) {
  const signature = '\n\n— Skyway Aviation\nPrivate Jet & Helicopter Charter Services';
  let subject, body;
  if (eventType === 'wheels_up') {
    subject = `Wheels Up — ${tail} ${originCode || ''}-${destCode || ''}`;
    const lines = [
      'Hello,',
      '',
      `${tail} is wheels up from ${originCode || 'origin'} and en route to ${destCode || 'destination'}.`,
      // actualOff is at the ORIGIN airport.
      `Departed: ${fmtTime(actualOff, originTz)}`,
    ];
    if (estimatedOn) {
      // ETA is at the DESTINATION airport.
      let etaLine = `ETA: ${fmtTime(estimatedOn, destTz)}`;
      if (scheduledArrivalIso) {
        const predMs = new Date(estimatedOn).getTime();
        const schedMs = new Date(scheduledArrivalIso).getTime();
        if (Math.abs(predMs - schedMs) > 10 * 60 * 1000) {
          etaLine += ` (sched ${fmtTime(scheduledArrivalIso, destTz)})`;
        }
      }
      lines.push(etaLine);
    }
    lines.push('', 'We will notify you upon landing.');
    body = lines.join('\n') + signature;
  } else if (eventType === 'landed') {
    subject = `Landed — ${tail} ${originCode || ''}-${destCode || ''}`;
    body = [
      'Hello,',
      '',
      `${tail} has landed at ${destCode || 'destination'}.`,
      // Touchdown is at the DESTINATION airport.
      `Touchdown: ${fmtTime(actualOn, destTz)}`,
      '',
      'Thank you for choosing Skyway Aviation.',
    ].join('\n') + signature;
  }
  return { subject, body };
}

// === Crew / dispatcher push for wheels-up and landed ===
//
// Same recipients as a status-step push (PIC and SIC by name, plus
// dispatchers). Broker email and FBO notices are unchanged. Each leg is
// claimed in Firestore before a send so overlapping polls cannot double-notify.

export const CREW_STATUS_PUSH_WINDOW_MS = 10 * 60 * 1000;
export const FLIGHT_STATUS_PUSH_COLLECTION = 'flight-status-pushes';

const PUSH_ZONE_LABEL = {
  EDT: 'ET', EST: 'ET',
  CDT: 'CT', CST: 'CT',
  MDT: 'MT', MST: 'MT',
  PDT: 'PT', PST: 'PT',
  AKDT: 'AKT', AKST: 'AKT',
  HDT: 'HT', HST: 'HT',
  GMT: 'Z', UTC: 'Z',
};

export function formatPushClock(iso, timeZone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (!timeZone) {
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}Z`;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || '';
    let hour = pick('hour');
    if (hour === '24') hour = '00';
    hour = hour.padStart(2, '0');
    const minute = pick('minute').padStart(2, '0');
    const zone = PUSH_ZONE_LABEL[pick('timeZoneName')] || pick('timeZoneName');
    if (!hour || minute === '') return '';
    return zone ? `${hour}:${minute} ${zone}` : `${hour}:${minute}`;
  } catch {
    return '';
  }
}

/** Display copy. Trip identity is the 6–7 character trip ID, never a trip number. */
export function buildFlightStatusPushText({
  tail,
  stepId,
  from,
  to,
  tripId,
  etaIso,
  eventIso,
  timeZone,
} = {}) {
  const verb = stepId === 'landed' ? 'landed' : 'wheels up';
  const ident = String(tail || '').trim().toUpperCase();
  const origin = String(from || '').trim().toUpperCase();
  const dest = String(to || '').trim().toUpperCase();
  const route = origin && dest ? `${origin} → ${dest}` : (origin || dest);
  const parts = [[ident, verb, route].filter(Boolean).join(' ')];
  const code = readTripId(tripId);
  if (code) parts.push(`Trip ${code}`);
  if (stepId === 'landed') {
    const clock = formatPushClock(eventIso, timeZone);
    if (clock) parts.push(clock);
  } else {
    const eta = formatPushClock(etaIso, timeZone);
    if (eta) parts.push(`ETA ${eta}`);
  }
  return parts.join(' · ').slice(0, 220);
}

export function resolveFlightPushContext({ tripState, leg, tripDoc, eventState, stepId } = {}) {
  const contacts = tripState?.tripSheetData?.crewContacts || {};
  const info = (tripDoc && tripDoc.info) || {};
  const nameOf = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    return String(value.name || '').trim();
  };
  const tripId = readTripId(
    tripState?.tripSheetData?.tripCode,
    tripState?.tripCode,
    tripState?.tripMeta?.tripCode,
    leg?.tripCode,
    info.tripCode,
    info.tripId,
    tripState,
    leg,
    tripDoc,
  );
  return {
    picName: nameOf(leg?.pic) || nameOf(contacts.pic) || nameOf(info.pic) || nameOf(tripState?.tripMeta?.pic),
    sicName: nameOf(leg?.sic) || nameOf(contacts.sic) || nameOf(info.sic) || nameOf(tripState?.tripMeta?.sic),
    tripId,
    tail: eventState?.ident || tripState?.tripMeta?.tail || leg?.tail || info.tail || '',
    from: eventState?.origin || tripState?.tripMeta?.from || leg?.from || info.from || '',
    to: eventState?.destination || tripState?.tripMeta?.to || leg?.to || info.to || '',
    timeZone: eventState?.destinationTz || null,
    stepId,
  };
}

/** A crew tap already pushed this step. FlightAware's own write does not count. */
export function recentCrewStatusTap(status, now = Date.now(), windowMs = CREW_STATUS_PUSH_WINDOW_MS) {
  if (!status || typeof status !== 'object') return false;
  if (status.autoFired === true) return false;
  const author = String(status.author || '').trim();
  if (!author || author === 'FlightAware Tracking') return false;
  const at = statusEventAt(status);
  if (at == null) return false;
  const age = now - at;
  return age >= 0 && age <= windowMs;
}

export function flightStatusPushClaimId(tripUid, stepId) {
  const safe = String(tripUid || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160);
  const step = stepId === 'landed' ? 'landed' : 'wheels_up';
  return `${safe}__${step}`;
}

export function isAlreadyExistsError(err) {
  const code = err?.code;
  return code === 6 || code === '6' || code === 'already-exists' || code === 'ALREADY_EXISTS'
    || /ALREADY_EXISTS|already exists/i.test(String(err?.message || ''));
}

export async function claimFlightStatusPush(db, { tripUid, stepId, now = Date.now() } = {}) {
  const id = flightStatusPushClaimId(tripUid, stepId);
  const ref = db.collection(FLIGHT_STATUS_PUSH_COLLECTION).doc(id);
  try {
    await ref.create({
      tripUid: String(tripUid || ''),
      stepId,
      claimedAt: now,
      state: 'claimed',
    });
    return { claimed: true, id, ref };
  } catch (err) {
    if (isAlreadyExistsError(err)) return { claimed: false, id, reason: 'already-claimed' };
    throw err;
  }
}

function safeDocId(uid) {
  return String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

async function readOptionalDoc(db, collectionName, id) {
  if (!db || !id) return null;
  try {
    const snap = await db.collection(collectionName).doc(id).get();
    if (!snap?.exists) return null;
    return typeof snap.data === 'function' ? (snap.data() || null) : null;
  } catch (err) {
    console.warn(`[cron-poll] ${collectionName}/${id} read failed:`, err.message);
    return null;
  }
}

async function loadPushUsers(db) {
  const snap = await db.collection('users').get();
  const users = [];
  snap?.forEach?.((doc) => {
    const data = typeof doc.data === 'function' ? (doc.data() || {}) : {};
    users.push({ uid: doc.id, ...data });
  });
  return users;
}

/**
 * One wheels-up or landed push per leg. Claims first. A crew member who
 * already tapped the same step in the last ~10 minutes does not get a
 * second banner, and that decision is claimed so a later poll cannot send it.
 */
export async function notifyFlightStatusPush({
  db,
  messaging,
  tripUid,
  tripState,
  stepId,
  eventState,
  now = Date.now(),
  users,
  leg,
  tripDoc,
} = {}) {
  if (stepId !== 'wheels_up' && stepId !== 'landed') return { skipped: 'unsupported-step' };
  const status = tripState?.statuses?.[stepId];
  const recentTap = recentCrewStatusTap(status, now);
  const claim = await claimFlightStatusPush(db, { tripUid, stepId, now });
  if (!claim.claimed) return { skipped: claim.reason || 'already-claimed' };
  if (recentTap) {
    await claim.ref.set({ state: 'suppressed', reason: 'recent-crew-tap' }, { merge: true }).catch(() => {});
    return { skipped: 'recent-crew-tap' };
  }

  const loadedLeg = leg !== undefined ? leg : await readOptionalDoc(db, 'legs', safeDocId(tripUid));
  const loadedTrip = tripDoc !== undefined ? tripDoc : await readOptionalDoc(db, 'trips', tripUid);
  const ctx = resolveFlightPushContext({
    tripState, leg: loadedLeg, tripDoc: loadedTrip, eventState, stepId,
  });
  const title = stepId === 'landed' ? 'Landed' : 'Wheels up';
  const body = buildFlightStatusPushText({
    tail: ctx.tail,
    stepId,
    from: ctx.from,
    to: ctx.to,
    tripId: ctx.tripId,
    etaIso: eventState?.estimatedOn,
    eventIso: eventState?.actualOn,
    timeZone: ctx.timeZone,
  });
  const url = `/?trip=${encodeURIComponent(tripUid)}#status`;
  const allUsers = users || await loadPushUsers(db);
  const { recipients, why } = resolveTripPushRecipients({
    users: allUsers,
    picName: ctx.picName,
    sicName: ctx.sicName,
    dispatcherUids: Array.isArray(loadedTrip?.dispatcherUids) ? loadedTrip.dispatcherUids : null,
  });
  if (recipients.length === 0) {
    await claim.ref.set({ state: 'skipped', reason: 'no-recipients', body }, { merge: true }).catch(() => {});
    return { skipped: 'no-recipients', why, body };
  }

  const summary = await dispatchToRecipients({
    db,
    messaging,
    recipients,
    title,
    body,
    data: {
      url,
      conversationId: '',
      tripId: String(tripUid || ''),
      senderUid: 'flightaware',
      senderName: 'FlightAware Tracking',
      kind: 'trip-status',
    },
    isAog: false,
    muteKey: `trip:${tripUid}`,
  });
  await claim.ref.set({
    state: 'sent',
    sentAt: Date.now(),
    title,
    body,
    dispatched: summary.dispatched,
    suppressed: summary.suppressed,
  }, { merge: true }).catch(() => {});
  return { ...summary, title, body, why, recipients: recipients.length };
}

async function attachFlightPush(db, args, result) {
  try {
    const { getMessaging } = await import('firebase-admin/messaging');
    result.push = await notifyFlightStatusPush({
      db,
      messaging: getMessaging(getAdmin()),
      tripUid: args.tripUid,
      tripState: args.tripState,
      stepId: args.stepId,
      eventState: args.eventState,
    });
  } catch (err) {
    console.warn('[cron-poll] flight status push failed:', err?.message || err);
    result.push = { error: err?.message || 'push-failed' };
  }
  return result;
}

// === Fire a status update on a trip ===
async function fireStatus({ db, host, tripUid, tripState, stepId, eventTimeMs, eventState, eventType }) {
  const existingStatuses = tripState.statuses || {};
  const autoFiredEvents = tripState.autoFiredEvents || {};

  // Idempotent: if this step was auto-fired before, skip the status write
  // and the broker email. The push claim from the run that handled the
  // transition already covers a retry, so this path does not send again.
  if (autoFiredEvents[stepId]) {
    return { skipped: 'already-auto-fired' };
  }

  const existingStatus = existingStatuses[stepId];
  const alreadyFired = !!existingStatus;
  const alreadyNotified = !!existingStatus?.notified;
  const isRecovery = alreadyFired && !alreadyNotified;

  // Manual fire path: if already fired by a human AND already notified,
  // nothing to do. If already fired but notified=false, the manual
  // path's email failed silently — recover by sending the email even
  // though we don't re-fire the step.
  if (alreadyFired && !isRecovery) {
    // Track so we don't try again
    await db.collection('trip-state').doc(tripUid).update({
      autoFiredEvents: { ...autoFiredEvents, [stepId]: `tracked-manual-${Date.now()}` },
    });
    return attachFlightPush(db, { tripUid, tripState, stepId, eventState }, {
      skipped: 'manual-already-fired-and-notified',
    });
  }

  // Build the new status (only if we're auto-firing for the first time)
  if (!alreadyFired) {
    const newStatus = {
      timestamp: eventTimeMs,
      author: 'FlightAware Tracking',
      coords: null,
      autoFired: true,
      eventType,
    };
    const newStatuses = { ...existingStatuses, [stepId]: newStatus };
    const update = {
      statuses: newStatuses,
      autoFiredEvents: { ...autoFiredEvents, [stepId]: `tracked-${Date.now()}` },
      updatedAt: Date.now(),
    };
    if (eventType === 'on') {
      update.archived = true;
      update.archivedAt = Date.now();
    }
    await db.collection('trip-state').doc(tripUid).update(update);
  }

  // Send broker email — same path whether new auto-fire or recovery
  const brokerEmails = (tripState.brokerEmail || '')
    .split(/[,;\s]+/)
    .map(e => e.trim())
    .filter(e => e.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  if (brokerEmails.length === 0 || tripState.autoNotify !== true) {
    return attachFlightPush(db, { tripUid, tripState, stepId, eventState }, {
      fired: !alreadyFired, isRecovery, emailed: false, reason: 'no-broker-or-autonotify-off',
    });
  }

  const { subject, body } = buildBrokerEmail({
    tail: eventState.ident,
    eventType: stepId,
    originCode: eventState.origin,
    destCode: eventState.destination,
    originTz: eventState.originTz,
    destTz: eventState.destinationTz,
    estimatedOn: eventState.estimatedOn,
    actualOff: eventState.actualOff,
    actualOn: eventState.actualOn,
    scheduledArrivalIso: eventState.scheduledIn || eventState.scheduledOn,
  });
  const sent = await sendEmail(host, brokerEmails, subject, body);

  // Recovery: mark the manual status notified=true so the App.jsx
  // "EMAIL FAILED" pill clears and the next poll skips this step.
  if (sent && isRecovery) {
    try {
      const recoveredStatus = {
        ...existingStatus,
        notified: true,
        notifiedAt: Date.now(),
        notifiedBy: 'fa-cron-recovery',
      };
      await db.collection('trip-state').doc(tripUid).update({
        [`statuses.${stepId}`]: recoveredStatus,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.warn('[fa-cron-poll] could not update notified flag:', err.message);
    }
  }

  return attachFlightPush(db, { tripUid, tripState, stepId, eventState }, {
    fired: !alreadyFired, isRecovery, emailed: sent,
  });
}

// === Main handler ===
export default async function handler(req, res) {
  // Vercel Cron sends GET requests. Also allow POST for manual testing.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Verify cron secret (Vercel auto-injects this header for cron jobs)
  const cronSecret = req.headers['authorization'] || '';
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && cronSecret !== `Bearer ${expectedSecret}`) {
    // If CRON_SECRET is set, require it. Otherwise allow (for dev/testing).
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const apiKey = process.env.FLIGHTAWARE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'FLIGHTAWARE_API_KEY not configured' });
    return;
  }

  try {
    const db = getDb();
    const host = req.headers.host || 'skyway-ops.vercel.app';

    // Check kill switch — if tracking is disabled, skip the poll entirely
    const cfgSnap = await db.collection('flightaware').doc('config').get();
    if (cfgSnap.exists && cfgSnap.data()?.trackingEnabled === false) {
      res.status(200).json({ ok: true, skipped: 'tracking disabled' });
      return;
    }

    const [fleetSnap, brokeredSnap] = await Promise.all([
      db.collection('app-config').doc('fleet').get(),
      db.collection('brokered-tail-tracking').get(),
    ]);
    const brokeredTracking = brokeredSnap.docs.map((doc) => doc.data());
    const fleetTails = resolveCronFleetTails(
      fleetSnap.exists ? fleetSnap.data() : null,
      brokeredTracking,
    );
    if (fleetTails.length === 0) {
      res.status(200).json({ ok: true, skipped: 'no managed or active brokered tails', results: [] });
      return;
    }

    const results = [];

    // Poll each tail in parallel
    await Promise.all(fleetTails.map(async (ident) => {
      try {
        const observed = await fetchTailState(ident, apiKey);

        // Load previous state from flightaware-state/{tail}
        const stateRef = db.collection('flightaware-state').doc(ident);
        const prevSnap = await stateRef.get();
        const previous = prevSnap.exists ? prevSnap.data() : null;
        const current = mergeFlightAwareState(previous, observed);

        // Always persist current state for next poll
        await stateRef.set(current);

        // OPPORTUNISTIC AIRPORT CACHE
        //
        // FA returns lat/lng for every origin/destination in its response.
        // We dump those into `flightaware-airports/{code}` so the FlightBoard
        // has accurate coords for any airport the fleet has ever flown to —
        // no manual bundling of static airport databases needed. Cache fills
        // naturally as the cron runs.
        //
        // We only write if (a) we have a code, (b) we have valid coords,
        // and (c) the doc doesn't already exist OR coords have changed
        // (rare; airports don't move, but FA can correct earlier wrong
        // data). The exists check costs one read per cron tick per airport
        // — cheap vs. constantly overwriting.
        const airportWrites = [];
        const seen = [
          { code: current.origin, lat: current.originLat, lon: current.originLon, city: null },
          { code: current.destination, lat: current.destinationLat, lon: current.destinationLon, city: current.destinationCity },
          { code: current.groundedAt, lat: current.groundedLat, lon: current.groundedLon, city: null },
        ];
        for (const { code, lat, lon, city } of seen) {
          if (!code) continue;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          // Normalize code so cache key is consistent (some FA fields have
          // ICAO prefix, others don't — we keep what FA gave us).
          const key = String(code).toUpperCase().trim();
          if (!key) continue;
          airportWrites.push(
            db.collection('flightaware-airports').doc(key).set(
              {
                code: key,
                lat,
                lon,
                city: city || null,
                source: 'flightaware-cron',
                updatedAt: Date.now(),
              },
              { merge: true } // never wipe city if a previous write had it
            )
          );
        }
        // Best-effort writes; if any fail, log and move on. We don't want
        // a Firestore hiccup to block the actual cron work.
        if (airportWrites.length > 0) {
          await Promise.allSettled(airportWrites);
        }

        // Detect transitions
        if (previous && !observed.error) {
          // Transition 1: grounded → airborne (wheels up)
          if (previous.airborne === false && current.airborne === true) {
            const eventTimeMs = current.actualOff
              ? new Date(current.actualOff).getTime()
              : Date.now();
            const match = await findMatchingTrip(db, ident, current.origin, eventTimeMs, 'wheels_up');
            if (match) {
              const result = await fireStatus({
                db, host,
                tripUid: match.uid,
                tripState: match.data,
                stepId: 'wheels_up',
                eventTimeMs,
                eventState: current,
                eventType: 'off',
              });
              results.push({ tail: ident, event: 'wheels_up', tripUid: match.uid, ...result });
            } else {
              results.push({ tail: ident, event: 'wheels_up', match: 'none' });
            }
          }

          // Transition 2: airborne → grounded (landed)
          // We look at whether the faFlightId changed AND current shows actualOn
          else if (previous.airborne === true && current.airborne === false && current.actualOn) {
            const eventTimeMs = new Date(current.actualOn).getTime();
            // For landed, match by the trip's origin (which is current.origin
            // since we're looking at the flight that just landed)
            const match = await findMatchingTrip(db, ident, current.origin, eventTimeMs, 'landed');
            if (match) {
              const result = await fireStatus({
                db, host,
                tripUid: match.uid,
                tripState: match.data,
                stepId: 'landed',
                eventTimeMs,
                eventState: current,
                eventType: 'on',
              });
              results.push({ tail: ident, event: 'landed', tripUid: match.uid, ...result });
            } else {
              results.push({ tail: ident, event: 'landed', match: 'none' });
            }
          }
        }
        // First poll for this tail — just record state, no transitions to detect
      } catch (err) {
        console.error(`[cron-poll] error for ${ident}:`, err.message);
        results.push({ tail: ident, error: err.message });
      }
    }));

    console.log('[cron-poll]', JSON.stringify(results));
    res.status(200).json({ ok: true, polled: fleetTails.length, results });
  } catch (err) {
    console.error('[cron-poll] fatal:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
