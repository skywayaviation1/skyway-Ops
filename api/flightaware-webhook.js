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
  return String(code).toUpperCase().trim();
}

// Compare two airport codes, treating IATA/ICAO/local forms as equal.
// Examples that should match:
//   KTPA   === TPA       (US ICAO + IATA)
//   K07FA  === 07FA      (US ICAO prefix + local 4-char strip)
//   KMMU   === MMU
//   FA54   === FA54
// To match, strip an optional leading K from each and compare the remainder.
// Only valid for non-empty remainders.
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

// Format an ISO timestamp in the airport's LOCAL time. timezone is an IANA
// zone string like 'America/New_York' (FlightAware returns this in
// flight.origin.timezone and flight.destination.timezone — we just pass it
// through). Output looks like "10:30 PM EDT" — same format as the manual
// path's emails, which brokers are used to.
//
// If timezone is missing (very rare — some uncommon airports), fall back to
// Zulu so brokers at least get a parseable time rather than blank.
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
    // Fallback for missing timezone — log so we can add the airport
    console.warn(`[fmtTime] no timezone for iso=${iso}, falling back to Zulu`);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}Z`;
  } catch {
    return '';
  }
}

// Find a Skyway trip that matches a FlightAware event.
//
// Window: -2h (early take-offs are rare) to +12h (delays push events later
// than scheduled — common for charter). Asymmetric on purpose; the old
// symmetric ±4h window dropped any flight delayed >4h.
//
// Tiebreaker (the OLD bug): when multiple trips for the same tail+from are
// in the window, the old code picked the one with smallest |startMs -
// eventTimeMs|. If today's trip is 3.5h delayed and tomorrow's is in 30
// minutes, that picked tomorrow's. We now use a scoring system:
//   +10000  trip has the matching PRIOR step already fired (sequential)
//   +5000   trip's scheduled start is in the past (it's actually in progress)
//   -minutes between start and event time (closest-in-time as a final tiebreak)
//
// stepId is passed in so the matcher knows which prior step to weight:
//   wheels_up event → look for trips with taxi_dep already fired
//   landed event    → look for trips with wheels_up already fired
async function findMatchingTrip(db, ident, originCode, eventTimeMs, stepId) {
  if (!ident) return null;

  const WINDOW_EARLY_MS = 2 * 60 * 60 * 1000;   // event up to 2h before scheduled
  const WINDOW_LATE_MS = 12 * 60 * 60 * 1000;   // event up to 12h after scheduled
  const windowStart = eventTimeMs - WINDOW_LATE_MS;
  const windowEnd = eventTimeMs + WINDOW_EARLY_MS;

  console.log(`[matcher] looking for ${ident} from=${originCode} eventAt=${new Date(eventTimeMs).toISOString()} for step=${stepId}`);

  const snap = await db.collection('trip-state').get();
  const candidates = [];
  let tailMatchCount = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.archived === true) continue;

    const meta = data.tripMeta;
    if (!meta || !meta.tail || !meta.from || !meta.start) continue;

    if (String(meta.tail).toUpperCase() !== ident.toUpperCase()) continue;
    tailMatchCount++;

    if (originCode && !airportsMatch(meta.from, originCode)) {
      console.log(`[matcher]   rejecting ${doc.id}: meta.from=${meta.from} vs origin=${originCode}`);
      continue;
    }

    const startMs = new Date(meta.start).getTime();
    if (isNaN(startMs)) continue;
    if (startMs < windowStart || startMs > windowEnd) {
      console.log(`[matcher]   rejecting ${doc.id}: start=${meta.start} outside window (${new Date(windowStart).toISOString()} .. ${new Date(windowEnd).toISOString()})`);
      continue;
    }

    candidates.push({ uid: doc.id, data, startMs });
  }

  console.log(`[matcher] tailMatches=${tailMatchCount} candidates=${candidates.length}`);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    console.log(`[matcher] PICKED ${candidates[0].uid} (only candidate)`);
    return candidates[0];
  }

  // Multiple candidates — score and pick the highest.
  function scoreCandidate(c) {
    const statuses = c.data.statuses || {};
    let score = 0;
    // Heavy: trip has the prior step already fired. This is the strongest
    // signal that THIS trip is the one in progress, not a sibling trip
    // scheduled for later today/tomorrow.
    if (stepId === 'wheels_up' && statuses.taxi_dep) score += 10000;
    if (stepId === 'landed' && statuses.wheels_up) score += 10000;
    if (stepId === 'landed' && statuses.taxi_dep) score += 5000;   // partial credit
    // Strong: scheduled start is in the past — it's actually happening now,
    // not scheduled for later.
    if (c.startMs <= eventTimeMs) score += 5000;
    // Light: closest in time as a final tiebreaker.
    score -= Math.abs(c.startMs - eventTimeMs) / 60000; // minutes diff
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

// Internal call to /api/email-enqueue (reliable queue with retry).
// Falls back to /api/send-email if the queue endpoint is unavailable.
async function sendEmail(req, to, subject, text, meta) {
  try {
    const host = req.headers.host || 'skyway-ops.vercel.app';
    const proto = host.includes('localhost') ? 'http' : 'https';
    const headers = { 'Content-Type': 'application/json' };
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (internalSecret) headers['x-internal-secret'] = internalSecret;
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypassSecret) headers['x-vercel-protection-bypass'] = bypassSecret;

    // Try queue first (reliable + retry)
    const body = JSON.stringify({
      to, subject, text,
      source: meta?.source || 'fa-webhook',
      tripId: meta?.tripId || null,
      statusKey: meta?.statusKey || null,
    });
    const queueUrl = `${proto}://${host}/api/email-enqueue`;
    const r = await fetch(queueUrl, { method: 'POST', headers, body });
    if (r.ok) {
      console.log('[fa-webhook] email queued to', Array.isArray(to) ? to.join(',') : to);
      return true;
    }
    const errText = await r.text().catch(() => '');
    console.warn('[fa-webhook] queue endpoint returned', r.status, errText.slice(0, 200), '— falling back to direct send');

    // Fallback: direct send (so we don't regress reliability)
    const fallbackUrl = `${proto}://${host}/api/send-email`;
    const r2 = await fetch(fallbackUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ to, subject, text }),
    });
    if (!r2.ok) {
      const t2 = await r2.text().catch(() => '');
      console.error('[fa-webhook] direct send-email also failed:', r2.status, t2.slice(0, 200));
      return false;
    }
    console.log('[fa-webhook] fallback send-email OK to', Array.isArray(to) ? to.join(',') : to);
    return true;
  } catch (err) {
    console.error('[fa-webhook] sendEmail exception:', err.message);
    return false;
  }
}

function buildBrokerEmail({ tail, eventType, originCode, destCode, originTz, destTz, estimatedOn, actualOff, actualOn, scheduledArrivalIso }) {
  const action = EVENT_LABELS[eventType] || eventType;
  const subject = `Skyway ${tail} — ${action.toUpperCase()}`;

  const lines = [];
  if (eventType === 'out') {
    lines.push(`Skyway flight ${tail} has begun taxi for departure from ${originCode || 'origin'}.`);
    lines.push(`Destination: ${destCode || 'unknown'}`);
  } else if (eventType === 'off') {
    // actualOff is at the ORIGIN, so format with originTz. ETA / scheduled
    // are at the DESTINATION, so format with destTz.
    lines.push(`Skyway flight ${tail} is wheels up.`);
    lines.push(`Departed: ${originCode || ''} at ${fmtTime(actualOff, originTz)}`);
    lines.push(`Destination: ${destCode || 'unknown'}`);
    if (estimatedOn) {
      const predicted = fmtTime(estimatedOn, destTz);
      let line = `ETA: ${predicted}`;
      if (scheduledArrivalIso) {
        const predMs = new Date(estimatedOn).getTime();
        const schedMs = new Date(scheduledArrivalIso).getTime();
        if (Math.abs(predMs - schedMs) > 10 * 60 * 1000) {
          line += ` (sched ${fmtTime(scheduledArrivalIso, destTz)})`;
        }
      }
      lines.push(line);
    }
  } else if (eventType === 'on') {
    // actualOn is at the DESTINATION.
    lines.push(`Skyway flight ${tail} has landed at ${destCode || 'destination'}.`);
    lines.push(`Touchdown: ${fmtTime(actualOn, destTz)}`);
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

    const providedSig = req.headers['x-flightaware-signature']
                     || req.headers['x-fa-signature']
                     || req.headers['authorization']?.replace(/^Bearer\s+/i, '')
                     || '';

    // Get raw body for HMAC verification (Vercel may have already parsed it).
    // We try both: the raw text (if available) and the stringified parsed body.
    let rawBody = '';
    if (typeof req.body === 'string') {
      rawBody = req.body;
    } else if (req.body && typeof req.body === 'object') {
      try { rawBody = JSON.stringify(req.body); } catch (_) {}
    }

    // Try three validation methods (FlightAware varies by configuration):
    //
    //   (A) shared-secret: provided header === FLIGHTAWARE_WEBHOOK_SECRET
    //   (B) HMAC-SHA256 hex: HMAC(secret, body) === provided header
    //   (C) HMAC-SHA256 base64: base64(HMAC(secret, body)) === provided header
    //
    // If ANY of the three matches, accept. This is safe because the secret is
    // never sent over the wire in clear (in B/C); the only way an attacker
    // gets through (A) is if they already have the secret.
    let crypto;
    try { crypto = await import('crypto'); } catch (_) {}

    function tryHmac(encoding) {
      if (!crypto || !rawBody) return null;
      try {
        return crypto.createHmac('sha256', expectedSecret).update(rawBody).digest(encoding);
      } catch (_) { return null; }
    }

    const hmacHex = tryHmac('hex');
    const hmacB64 = tryHmac('base64');

    // Constant-time comparison helper to avoid timing leaks
    function safeEq(a, b) {
      if (!a || !b) return false;
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      if (a.length !== b.length) return false;
      let result = 0;
      for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return result === 0;
    }

    const sigMatchShared = safeEq(providedSig, expectedSecret);
    const sigMatchHex    = hmacHex && safeEq(providedSig, hmacHex);
    const sigMatchB64    = hmacB64 && safeEq(providedSig, hmacB64);
    // Also allow common "sha256=..." prefix that some webhook senders use
    const providedSigStripped = providedSig.replace(/^sha256=/i, '');
    const sigMatchHexStripped = hmacHex && safeEq(providedSigStripped, hmacHex);
    const sigMatchB64Stripped = hmacB64 && safeEq(providedSigStripped, hmacB64);

    const sigOk = sigMatchShared || sigMatchHex || sigMatchB64
               || sigMatchHexStripped || sigMatchB64Stripped;

    if (!sigOk) {
      // Verbose logging so we can diagnose which auth mode FA is using.
      // Logs only the first 10 chars of any actual hash so we don't leak the
      // secret to anyone who later reads logs.
      const trim = (s) => (s ? String(s).slice(0, 12) + '…' : '(none)');
      console.warn('[fa-webhook] invalid signature header — rejected', {
        receivedHeader: trim(providedSig),
        expectedShared: trim(expectedSecret),
        computedHmacHex: trim(hmacHex),
        computedHmacB64: trim(hmacB64),
        bodyLength: rawBody.length,
        headerNames: Object.keys(req.headers).filter(h => /sig|fa|auth|flight/i.test(h)),
      });
      res.status(200).json({ received: false, error: 'invalid signature' });
      return;
    }

    console.log('[fa-webhook] signature OK via',
      sigMatchShared ? 'shared-secret' :
      sigMatchHex || sigMatchHexStripped ? 'hmac-sha256-hex' :
      'hmac-sha256-base64');

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
    // FlightAware returns IANA timezone strings like 'America/New_York' on
    // origin and destination objects. We pass these through to fmtTime so
    // broker emails show "10:30 PM EDT" (local airport time) instead of
    // "02:30Z" (which brokers had to mentally convert).
    const originTz = flight.origin?.timezone || null;
    const destTz = flight.destination?.timezone || null;
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
    const match = await findMatchingTrip(db, ident, originCode, eventTimeMs, stepId);
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
      console.log(`[fa-webhook] ${stepId} already manually fired for ${tripUid}`);
    }

    // === 10. Send broker email ===
    //
    // Two paths reach this point:
    //   (a) We just auto-fired the step → send the broker email
    //   (b) Step was already manually fired but `notified !== true` → the
    //       manual path tried to email and FAILED (network, missing
    //       recipient, no template, etc.) silently. Recover by sending now.
    //
    // The old code only sent under (a). That's the second half of the
    // "broker never got notified" bug — manual tap with a failed email
    // would never be recovered because the webhook saw alreadyFired=true
    // and stopped.
    const alreadyNotified = !!existingStatus?.notified;
    const isRecovery = alreadyFired && !alreadyNotified;
    const shouldSendEmail = firedAuto || isRecovery;

    let emailSent = false;
    if (shouldSendEmail) {
      const brokerEmail = tripState.brokerEmail;
      const autoNotify = tripState.autoNotify === true;
      if (brokerEmail && autoNotify) {
        const { subject, body: emailBody } = buildBrokerEmail({
          tail: ident,
          eventType,
          originCode,
          destCode,
          originTz,
          destTz,
          estimatedOn,
          actualOff,
          actualOn,
          scheduledArrivalIso: scheduledIn || scheduledOn,
        });
        emailSent = await sendEmail(req, brokerEmail, subject, emailBody, {
          source: isRecovery ? 'fa-webhook-recovery' : 'fa-webhook',
          tripId: tripUid,
          statusKey: stepId,
        });
        console.log(`[fa-webhook] broker email ${emailSent ? 'sent' : 'failed'} → ${brokerEmail} ${isRecovery ? '(RECOVERY)' : ''}`);

        // If recovery succeeded, mark the manual status as notified so the
        // App.jsx "EMAIL FAILED" pill clears and we don't try recovering
        // again on the next webhook event for this step.
        if (emailSent && isRecovery) {
          try {
            const recoveredStatus = {
              ...existingStatus,
              notified: true,
              notifiedAt: Date.now(),
              notifiedBy: 'fa-webhook-recovery',
            };
            await db.collection('trip-state').doc(tripUid).update({
              [`statuses.${stepId}`]: recoveredStatus,
              updatedAt: Date.now(),
            });
            console.log(`[fa-webhook] cleared EMAIL_FAILED on ${tripUid}.${stepId}`);
          } catch (err) {
            console.warn('[fa-webhook] could not update notified flag:', err.message);
          }
        }
      } else {
        console.log(`[fa-webhook] no broker email or autoNotify off for ${tripUid}`);
      }
    } else {
      console.log(`[fa-webhook] step already fired AND notified — no email needed`);
    }

    await eventRef.update({
      processed: true,
      autoFired: firedAuto,
      isRecovery,
      emailSent,
    });

    res.status(200).json({
      received: true,
      eventId: eventRef.id,
      tripUid,
      stepId,
      autoFired: firedAuto,
      isRecovery,
      emailSent,
    });
  } catch (err) {
    console.error('[fa-webhook] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
