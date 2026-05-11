// api/flightaware-webhook.js
//
// Receives event POSTs from FlightAware AeroAPI's alert system. PR 2c version
// — does everything end-to-end:
//
//   1. Verify shared secret
//   2. Parse alert payload
//   3. Persist raw event to flight-events/{generatedId} for audit
//   4. Match the event to a Skyway trip (strict: tail + from-airport + ±4h window)
//   5. If matched, auto-fire the corresponding status step — UNLESS already
//      manually fired (manual wins)
//   6. Send broker email for the step (only if auto-fired AND autoNotify on)
//   7. For `on` (landing): also archive the trip
//   8. For `diverted`: email ops only, never broker
//   9. Idempotent: dedupe duplicate webhook deliveries
//
// Event → Status mapping:
//   out → taxi_dep         (TAXI FOR DEPARTURE)
//   off → wheels_up        (WHEELS UP)
//   on  → landed           (LANDED, also archives)
//
// Diversions email ops via OPS_ALERT_EMAILS env var (comma-separated).

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
    : admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
  return adminApp;
}

function getDb() {
  if (_db) return _db;
  const app = getAdmin();
  _db = getFirestore(app, 'appusers');
  return _db;
}

// === Event → Step mapping ===
const EVENT_TO_STEP = {
  out: 'taxi_dep',
  off: 'wheels_up',
  on: 'landed',
};

const EVENT_LABELS = {
  out: 'taxiing for departure',
  off: 'wheels up',
  on: 'landed',
};

// === Airport code helpers ===

function normCode(code) {
  if (!code) return '';
  const c = String(code).toUpperCase().trim();
  // US ICAO codes start with K. If 3 chars (likely IATA), prepend K.
  if (c.length === 3 && /^[A-Z]{3}$/.test(c)) return 'K' + c;
  return c;
}

function airportsMatch(a, b) {
  const A = normCode(a);
  const B = normCode(b);
  if (A === B) return true;
  const A3 = A.replace(/^K/, '');
  const B3 = B.replace(/^K/, '');
  return A3 === B3 && A3.length === 3;
}

// Format an ISO timestamp as UTC HH:MM. Brokers will know which timezone
// based on the airport.
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

// Find a Skyway trip that matches a FlightAware event.
// Strict: tail + origin airport + ±4h window around trip start.
//
// Trip-state docs use opaque hash UIDs that contain no route info, so we
// read tripMeta (written by App.jsx persist()) which has the routing data:
//   { tail, from, to, start (ISO), legType }
async function findMatchingTrip(db, ident, originCode, eventTimeMs) {
  if (!ident) return null;

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const windowStart = eventTimeMs - FOUR_HOURS_MS;
  const windowEnd = eventTimeMs + FOUR_HOURS_MS;

  const snap = await db.collection('trip-state').get();
  const candidates = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.archived === true) continue;

    const meta = data.tripMeta;
    if (!meta || !meta.tail || !meta.from || !meta.start) {
      // Trip doesn't yet have routing metadata — was saved before PR 2c.
      // Skip — auto-fire only applies to trips persisted with tripMeta.
      continue;
    }

    // Tail must match exactly
    if (String(meta.tail).toUpperCase() !== ident.toUpperCase()) continue;

    // Origin must match
    if (originCode && !airportsMatch(meta.from, originCode)) continue;

    // Scheduled start must fall within ±4h of the event
    const startMs = new Date(meta.start).getTime();
    if (isNaN(startMs)) continue;
    if (startMs < windowStart || startMs > windowEnd) continue;

    candidates.push({ uid: doc.id, data, startMs });
  }

  if (candidates.length === 0) return null;

  // Pick the candidate closest to the event time
  candidates.sort((a, b) =>
    Math.abs(a.startMs - eventTimeMs) - Math.abs(b.startMs - eventTimeMs)
  );
  return candidates[0];
}

// Internal call to /api/send-email
async function sendEmail(req, to, subject, text) {
  try {
    const host = req.headers.host || 'skyway-ops.vercel.app';
    const proto = host.includes('localhost') ? 'http' : 'https';
    const url = `${proto}://${host}/api/send-email`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, text }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('[fa-webhook] send-email failed:', r.status, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[fa-webhook] send-email exception:', err.message);
    return false;
  }
}

function buildBrokerEmail({ tail, eventType, originCode, destCode, estimatedOn, actualOff, actualOn, scheduledArrivalIso }) {
  const action = EVENT_LABELS[eventType] || eventType;
  const subject = `Skyway ${tail} — ${action.toUpperCase()}`;

  const lines = [];
  if (eventType === 'out') {
    lines.push(`Skyway flight ${tail} has begun taxi for departure from ${originCode || 'origin'}.`);
    lines.push(`Destination: ${destCode || 'unknown'}`);
  } else if (eventType === 'off') {
    lines.push(`Skyway flight ${tail} is wheels up.`);
    lines.push(`Departed: ${originCode || ''} at ${fmtTime(actualOff)}`);
    lines.push(`Destination: ${destCode || 'unknown'}`);
    if (estimatedOn) {
      const predicted = fmtTime(estimatedOn);
      let line = `ETA: ${predicted}`;
      if (scheduledArrivalIso) {
        const predMs = new Date(estimatedOn).getTime();
        const schedMs = new Date(scheduledArrivalIso).getTime();
        if (Math.abs(predMs - schedMs) > 10 * 60 * 1000) {
          line += ` (sched ${fmtTime(scheduledArrivalIso)})`;
        }
      }
      lines.push(line);
    }
  } else if (eventType === 'on') {
    lines.push(`Skyway flight ${tail} has landed at ${destCode || 'destination'}.`);
    lines.push(`Touchdown: ${fmtTime(actualOn)}`);
  }
  lines.push('');
  lines.push('— Skyway Aviation Operations');
  return { subject, body: lines.join('\n') };
}

function buildOpsDivertEmail({ tail, originCode, destCode, divertedTo }) {
  const subject = `[ALERT] Skyway ${tail} DIVERTED`;
  const body = [
    `${tail} has been diverted.`,
    `Filed route: ${originCode || '?'} → ${destCode || '?'}`,
    `Now going to: ${divertedTo || 'unknown (check FlightAware)'}`,
    '',
    'Please contact crew and broker as appropriate.',
    '',
    '— Skyway Aviation Operations',
  ].join('\n');
  return { subject, body };
}

// === Main handler ===
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // === 1. Validate shared secret ===
    const expectedSecret = process.env.FLIGHTAWARE_WEBHOOK_SECRET;
    if (!expectedSecret) {
      console.error('[fa-webhook] FLIGHTAWARE_WEBHOOK_SECRET not configured');
      res.status(500).json({ error: 'Webhook not configured on server' });
      return;
    }

    const providedSecret = req.headers['x-flightaware-signature']
                       || req.headers['x-fa-signature']
                       || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (providedSecret !== expectedSecret) {
      console.warn('[fa-webhook] invalid signature header — rejected');
      res.status(200).json({ received: false, error: 'invalid signature' });
      return;
    }

    // === 2. Parse payload ===
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
      }
    }
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Empty or invalid body' });
      return;
    }

    // === 3. Extract key fields ===
    const flight = body.flight || {};
    const ident = (flight.ident || flight.registration || '').toUpperCase();
    const eventType = body.event || body['@type'] || 'unknown';
    const faFlightId = flight.fa_flight_id || null;
    const diverted = !!flight.diverted;

    const originCode = flight.origin?.code_icao
                    || flight.origin?.code
                    || flight.origin?.code_iata
                    || null;
    const destCode = flight.destination?.code_icao
                  || flight.destination?.code
                  || flight.destination?.code_iata
                  || null;
    const divertedToCode = flight.diverted_to?.code_icao
                        || flight.diverted_to?.code
                        || flight.diverted_to?.code_iata
                        || null;

    const actualOff = flight.actual_off || null;
    const actualOn = flight.actual_on || null;
    const actualIn = flight.actual_in || null;
    const actualOut = flight.actual_out || null;
    const estimatedOn = flight.estimated_on || null;
    const estimatedIn = flight.estimated_in || null;
    const scheduledIn = flight.scheduled_in || null;
    const scheduledOn = flight.scheduled_on || null;

    const eventTimeIso = actualOff || actualOn || actualOut || actualIn
                      || estimatedOn || estimatedIn || null;
    const eventTimeMs = eventTimeIso ? new Date(eventTimeIso).getTime() : Date.now();

    // === 4. Persist raw event ===
    const db = getDb();
    const eventRef = db.collection('flight-events').doc();
    await eventRef.set({
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      eventType,
      ident,
      faFlightId,
      originCode,
      destCode,
      diverted,
      divertedToCode,
      actualOff, actualOn, actualIn, actualOut,
      estimatedOn, estimatedIn, scheduledIn, scheduledOn,
      rawPayload: body,
      matchedTripUid: null,
      processed: false,
      autoFired: false,
      emailSent: false,
    });

    console.log('[fa-webhook]', { eventType, ident, faFlightId, originCode, destCode, diverted });

    // === 5. DIVERSION HANDLING — ops only, never broker ===
    if (diverted) {
      const opsEmails = (process.env.OPS_ALERT_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (opsEmails.length > 0) {
        const { subject, body: emailBody } = buildOpsDivertEmail({
          tail: ident, originCode, destCode, divertedTo: divertedToCode,
        });
        const sent = await sendEmail(req, opsEmails, subject, emailBody);
        await eventRef.update({ processed: true, emailSent: sent });
        console.log(`[fa-webhook] diversion alert ${sent ? 'sent' : 'failed'} to ops:`, opsEmails);
      } else {
        console.warn('[fa-webhook] diversion detected but OPS_ALERT_EMAILS not set');
        await eventRef.update({ processed: true });
      }
      res.status(200).json({ received: true, eventId: eventRef.id, diversion: true });
      return;
    }

    // === 6. Skip event types we don't auto-handle ===
    const stepId = EVENT_TO_STEP[eventType];
    if (!stepId) {
      await eventRef.update({ processed: true });
      res.status(200).json({ received: true, eventId: eventRef.id, action: 'stored-only' });
      return;
    }

    // === 7. Find matching trip ===
    const match = await findMatchingTrip(db, ident, originCode, eventTimeMs);
    if (!match) {
      console.log(`[fa-webhook] no matching trip for ${ident} from ${originCode}`);
      await eventRef.update({ processed: true });
      res.status(200).json({ received: true, eventId: eventRef.id, action: 'no-match' });
      return;
    }

    const { uid: tripUid, data: tripState } = match;
    await eventRef.update({ matchedTripUid: tripUid });

    // === 8. Check if status already fired (manual wins) ===
    const existingStatuses = tripState.statuses || {};
    const existingStatus = existingStatuses[stepId];
    const alreadyFired = !!existingStatus;

    // Idempotent: if we've already auto-fired this step, skip (webhook retry)
    const autoFiredEvents = tripState.autoFiredEvents || {};
    if (autoFiredEvents[stepId]) {
      console.log(`[fa-webhook] step ${stepId} already auto-fired for ${tripUid} — skipping`);
      await eventRef.update({ processed: true });
      res.status(200).json({ received: true, eventId: eventRef.id, action: 'duplicate' });
      return;
    }

    // === 9. Fire status (only if not manually set) ===
    let firedAuto = false;
    if (!alreadyFired) {
      const newStatus = {
        timestamp: eventTimeMs,
        author: 'FlightAware Auto',
        coords: null,
        autoFired: true,
        eventType,
        eventId: eventRef.id,
      };
      const newStatuses = { ...existingStatuses, [stepId]: newStatus };

      const tripUpdate = {
        statuses: newStatuses,
        autoFiredEvents: { ...autoFiredEvents, [stepId]: eventRef.id },
        updatedAt: Date.now(),
      };

      // For 'on' (landing): also archive
      if (eventType === 'on') {
        tripUpdate.archived = true;
        tripUpdate.archivedAt = Date.now();
      }

      await db.collection('trip-state').doc(tripUid).update(tripUpdate);
      firedAuto = true;
      console.log(`[fa-webhook] auto-fired ${stepId} for ${tripUid}`);
    } else {
      console.log(`[fa-webhook] ${stepId} already manually fired for ${tripUid} — skipping email`);
    }

    // === 10. Send broker email (only if auto-fired AND autoNotify on AND brokerEmail set) ===
    let emailSent = false;
    if (firedAuto) {
      const brokerEmail = tripState.brokerEmail;
      const autoNotify = tripState.autoNotify === true;
      if (brokerEmail && autoNotify) {
        const { subject, body: emailBody } = buildBrokerEmail({
          tail: ident,
          eventType,
          originCode,
          destCode,
          estimatedOn,
          actualOff,
          actualOn,
          scheduledArrivalIso: scheduledIn || scheduledOn,
        });
        emailSent = await sendEmail(req, brokerEmail, subject, emailBody);
        console.log(`[fa-webhook] broker email ${emailSent ? 'sent' : 'failed'} → ${brokerEmail}`);
      } else {
        console.log(`[fa-webhook] no broker email or autoNotify off for ${tripUid}`);
      }
    }

    await eventRef.update({
      processed: true,
      autoFired: firedAuto,
      emailSent,
    });

    res.status(200).json({
      received: true,
      eventId: eventRef.id,
      tripUid,
      stepId,
      autoFired: firedAuto,
      emailSent,
    });
  } catch (err) {
    console.error('[fa-webhook] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
