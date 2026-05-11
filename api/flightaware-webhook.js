// api/flightaware-webhook.js
//
// Receives event POSTs from FlightAware AeroAPI's alert system. This is the
// "data in" side of the integration. It does NOT yet trigger emails or update
// trip status — that's PR 2c. For now this endpoint:
//
//   1. Verifies the request came from FlightAware (shared secret in custom header)
//   2. Parses the alert payload
//   3. Persists the raw event to Firestore at flight-events/{generatedId}
//   4. Returns 200 so FlightAware doesn't retry
//
// Once events are accumulating in Firestore, we'll add the matching logic that
// associates each event with a specific iCal leg, then the auto-status/email
// wiring.
//
// FlightAware alert payload reference:
//   https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml
//
// Headers we expect:
//   x-flightaware-signature  — the shared secret (matches FLIGHTAWARE_WEBHOOK_SECRET)
//   content-type             — application/json
//
// Body (example):
//   {
//     "id": 123456789,
//     "@type": "Alert",
//     "alert_id": 12345,
//     "event": "arrival",                  // or "departure", "out", "off", "on", "in"
//     "summary": "Flight N168ZZ has arrived...",
//     "flight": {
//       "ident": "N168ZZ",
//       "registration": "N168ZZ",
//       "fa_flight_id": "N168ZZ-1715433...",
//       "origin": { "code": "KHPN", "code_iata": "HPN", "code_icao": "KHPN", ... },
//       "destination": { "code": "KPSM", "code_iata": "PSM", "code_icao": "KPSM", ... },
//       "actual_off": "2026-05-10T11:03:00Z",
//       "actual_on": "2026-05-10T17:30:00Z",
//       "estimated_in": "2026-05-10T17:42:00Z",
//       ...
//     }
//   }

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

// Returns Firestore client connected to the NAMED 'appusers' database.
// The default admin.firestore() points to '(default)' which doesn't exist
// in this project. Must use modular getFirestore() with the explicit
// database ID per firebase-admin docs.
function getDb() {
  if (_db) return _db;
  const app = getAdmin();
  _db = getFirestore(app, 'appusers');
  return _db;
}

export default async function handler(req, res) {
  // FlightAware uses POST. Anything else is wrong.
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

    // FlightAware sends the configured signature in the `x-flightaware-signature`
    // header (configurable per-alert when you call POST /alerts). We'll set this
    // to our shared secret in the registration step.
    const providedSecret = req.headers['x-flightaware-signature']
                       || req.headers['x-fa-signature']
                       || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (providedSecret !== expectedSecret) {
      console.warn('[fa-webhook] invalid signature header — rejected');
      // Return 200 anyway so FlightAware doesn't keep retrying — but log it.
      // Returning 401 here causes FlightAware to exponential-backoff retry forever.
      res.status(200).json({ received: false, error: 'invalid signature' });
      return;
    }

    // === 2. Parse payload ===
    // Vercel auto-parses application/json into req.body, but defend against
    // raw-string deliveries too.
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

    // === 3. Extract a few key fields for indexing ===
    const flight = body.flight || {};
    const ident = flight.ident || flight.registration || null;
    const eventType = body.event || body['@type'] || 'unknown';
    const faFlightId = flight.fa_flight_id || null;

    // Origin/destination codes can come in several places. Try ICAO first
    // (matches the iCal data better), fall back to IATA.
    const originCode = flight.origin?.code_icao
                    || flight.origin?.code
                    || flight.origin?.code_iata
                    || null;
    const destCode = flight.destination?.code_icao
                  || flight.destination?.code
                  || flight.destination?.code_iata
                  || null;

    // Actual + estimated times — useful for ETA calculation later
    const actualOff = flight.actual_off || null;
    const actualOn = flight.actual_on || null;
    const actualIn = flight.actual_in || null;
    const actualOut = flight.actual_out || null;
    const estimatedOn = flight.estimated_on || null;
    const estimatedIn = flight.estimated_in || null;

    // === 4. Persist to flight-events collection ===
    const db = getDb();
    const docRef = db.collection('flight-events').doc();
    await docRef.set({
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      eventType,
      ident,
      faFlightId,
      originCode,
      destCode,
      actualOff,
      actualOn,
      actualIn,
      actualOut,
      estimatedOn,
      estimatedIn,
      // Store full raw payload too, in case we need fields we didn't extract
      rawPayload: body,
      // Matching status — populated by a later worker (PR 2c)
      matchedTripUid: null,
      processed: false,
    });

    console.log('[fa-webhook]', {
      eventType, ident, faFlightId, originCode, destCode,
    });

    res.status(200).json({ received: true, eventId: docRef.id });
  } catch (err) {
    console.error('[fa-webhook] error:', err);
    // Returning 500 makes FlightAware retry, which is what we want for
    // transient failures (DB hiccup, cold start, etc.).
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
