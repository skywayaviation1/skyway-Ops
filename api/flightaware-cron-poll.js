// api/flightaware-cron-poll.js
//
// Triggered every 2 minutes by Vercel Cron (see vercel.json).
//
// Polls FlightAware for the current state of all subscribed tails, compares
// each tail's state to its previous poll, and on detected transitions:
//   - Grounded → Airborne     → fire WHEELS UP status + email broker
//   - Airborne → Grounded     → fire LANDED status + email + archive trip
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

const FA_API_BASE = 'https://aeroapi.flightaware.com/aeroapi';
const FLEET_TAILS = ['N20UF', 'N168ZZ', 'N286N', 'N444AM', 'N651TW', 'N551FP', 'N85AH', 'N525CR'];

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

function fmtTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
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

  // Active flight has actual_off but no actual_on
  const active = flights.find(f => f.actual_off && !f.actual_on);
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
      destination: active.destination?.code_icao || active.destination?.code || null,
      actualOff: active.actual_off,
      actualOn: null,
      estimatedOn: active.estimated_on || null,
      scheduledOn: active.scheduled_on || null,
      scheduledIn: active.scheduled_in || null,
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
    };
  }

  // Not airborne — find the most recent completed flight (for landed detection)
  const completed = flights
    .filter(f => f.actual_on)
    .sort((a, b) => new Date(b.actual_on) - new Date(a.actual_on));
  const lastLanded = completed[0];
  if (lastLanded) {
    return {
      ident,
      airborne: false,
      faFlightId: lastLanded.fa_flight_id,
      origin: lastLanded.origin?.code_icao || lastLanded.origin?.code || null,
      destination: lastLanded.destination?.code_icao || lastLanded.destination?.code || null,
      actualOff: lastLanded.actual_off || null,
      actualOn: lastLanded.actual_on,
      estimatedOn: null,
      scheduledOn: lastLanded.scheduled_on || null,
      scheduledIn: lastLanded.scheduled_in || null,
    };
  }

  return { ident, airborne: false };
}

// === Find a matching trip-state doc for an event ===
async function findMatchingTrip(db, ident, originCode, eventTimeMs) {
  if (!ident) return null;

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const windowStart = eventTimeMs - FOUR_HOURS_MS;
  const windowEnd = eventTimeMs + FOUR_HOURS_MS;

  console.log(`[matcher] looking for ${ident} from=${originCode} eventAt=${new Date(eventTimeMs).toISOString()}`);

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

    console.log(`[matcher]   candidate: ${doc.id} from=${meta.from} start=${meta.start} diff=${Math.abs(startMs - eventTimeMs)}ms`);
    candidates.push({ uid: doc.id, data, startMs });
  }

  console.log(`[matcher] tailMatches=${tailMatchCount} originRejected=${originRejectCount} timeRejected=${timeRejectCount} candidates=${candidates.length}`);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    Math.abs(a.startMs - eventTimeMs) - Math.abs(b.startMs - eventTimeMs)
  );
  console.log(`[matcher] PICKED ${candidates[0].uid} (closest in time)`);
  return candidates[0];
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

function buildBrokerEmail({ tail, eventType, originCode, destCode, estimatedOn, actualOff, actualOn, scheduledArrivalIso }) {
  const signature = '\n\n— Skyway Aviation\nPrivate Jet & Helicopter Charter Services';
  let subject, body;
  if (eventType === 'wheels_up') {
    subject = `Wheels Up — ${tail} ${originCode || ''}-${destCode || ''}`;
    const lines = [
      'Hello,',
      '',
      `${tail} is wheels up from ${originCode || 'origin'} and en route to ${destCode || 'destination'}.`,
      `Departed: ${fmtTime(actualOff)}`,
    ];
    if (estimatedOn) {
      let etaLine = `ETA: ${fmtTime(estimatedOn)}`;
      if (scheduledArrivalIso) {
        const predMs = new Date(estimatedOn).getTime();
        const schedMs = new Date(scheduledArrivalIso).getTime();
        if (Math.abs(predMs - schedMs) > 10 * 60 * 1000) {
          etaLine += ` (sched ${fmtTime(scheduledArrivalIso)})`;
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
      `Touchdown: ${fmtTime(actualOn)}`,
      '',
      'Thank you for choosing Skyway Aviation.',
    ].join('\n') + signature;
  }
  return { subject, body };
}

// === Fire a status update on a trip ===
async function fireStatus({ db, host, tripUid, tripState, stepId, eventTimeMs, eventState, eventType }) {
  const existingStatuses = tripState.statuses || {};
  const autoFiredEvents = tripState.autoFiredEvents || {};

  // Idempotent: if this step was auto-fired before, skip
  if (autoFiredEvents[stepId]) {
    return { skipped: 'already-auto-fired' };
  }

  // Manual wins: if already fired by a human, skip
  if (existingStatuses[stepId]) {
    // Still mark autoFiredEvents so we don't email later
    await db.collection('trip-state').doc(tripUid).update({
      autoFiredEvents: { ...autoFiredEvents, [stepId]: `tracked-manual-${Date.now()}` },
    });
    return { skipped: 'manual-already-fired' };
  }

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

  // Send broker email
  const brokerEmails = (tripState.brokerEmail || '')
    .split(/[,;\s]+/)
    .map(e => e.trim())
    .filter(e => e.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  if (brokerEmails.length === 0 || tripState.autoNotify !== true) {
    return { fired: true, emailed: false, reason: 'no-broker-or-autonotify-off' };
  }

  const { subject, body } = buildBrokerEmail({
    tail: eventState.ident,
    eventType: stepId,
    originCode: eventState.origin,
    destCode: eventState.destination,
    estimatedOn: eventState.estimatedOn,
    actualOff: eventState.actualOff,
    actualOn: eventState.actualOn,
    scheduledArrivalIso: eventState.scheduledIn || eventState.scheduledOn,
  });
  const sent = await sendEmail(host, brokerEmails, subject, body);
  return { fired: true, emailed: sent };
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

    const results = [];

    // Poll each tail in parallel
    await Promise.all(FLEET_TAILS.map(async (ident) => {
      try {
        const current = await fetchTailState(ident, apiKey);

        // Load previous state from flightaware-state/{tail}
        const stateRef = db.collection('flightaware-state').doc(ident);
        const prevSnap = await stateRef.get();
        const previous = prevSnap.exists ? prevSnap.data() : null;

        // Always persist current state for next poll
        await stateRef.set({
          ...current,
          polledAt: Date.now(),
        });

        // Detect transitions
        if (previous) {
          // Transition 1: grounded → airborne (wheels up)
          if (previous.airborne === false && current.airborne === true) {
            const eventTimeMs = current.actualOff
              ? new Date(current.actualOff).getTime()
              : Date.now();
            const match = await findMatchingTrip(db, ident, current.origin, eventTimeMs);
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
            const match = await findMatchingTrip(db, ident, current.origin, eventTimeMs);
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
    res.status(200).json({ ok: true, polled: FLEET_TAILS.length, results });
  } catch (err) {
    console.error('[cron-poll] fatal:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
