// Receives ForeFlight Dispatch webhook POSTs and mirrors status onto
// trip-state docs that already know the ForeFlight flightId.
//
// Events (OpenAPI WebHookDTO):
//   changeType: Flight | Filing | FlightCreated | FlightDeleted | FlightReleased | ...
//   changedFields: Departure, Destination, Aircraft, SoulsAboard, DepartureDate,
//     LogTimeOut/Off/On/In, RouteOfFlight, CruiseAltitude, RecallNumber, ...
//
// Signature headers (when a secret was registered):
//   x-foreflight-signature, x-foreflight-auth, x-foreflight-salt

import crypto from 'node:crypto';
import {
  getDb,
  readConfig,
  runForeFlightAction,
  writeConfig,
} from './_foreflight.js';
import { verifyForeFlightWebhook } from './_foreflight-crypto.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function findTripByFlightId(db, flightId) {
  if (!flightId) return null;
  // Prefer an equality query on the nested field; fall back to scan if the
  // composite index is missing in a fresh environment.
  try {
    const snap = await db.collection('trip-state')
      .where('foreflight.flightId', '==', flightId)
      .limit(5)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { id: doc.id, ref: doc.ref, data: doc.data() };
    }
  } catch (err) {
    console.warn('[ff-webhook] indexed lookup failed, scanning:', err.message);
  }
  const all = await db.collection('trip-state').get();
  for (const doc of all.docs) {
    if (doc.data()?.foreflight?.flightId === flightId) {
      return { id: doc.id, ref: doc.ref, data: doc.data() };
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const rawBody = await readRawBody(req);
    const cfg = await readConfig();
    if (!cfg?.apiKey) {
      res.status(503).json({ error: 'ForeFlight not configured' });
      return;
    }

    const verified = verifyForeFlightWebhook({
      rawBody,
      secret: cfg.webhookSecret,
      signatureHeader: req.headers['x-foreflight-signature'],
      authHeader: req.headers['x-foreflight-auth'],
      saltHeader: req.headers['x-foreflight-salt'],
    });

    // If a secret is configured, require a valid signature. If somehow no
    // secret exists yet, accept but log — registerWebhook should have set one.
    if (cfg.webhookSecret && !verified.ok) {
      console.warn('[ff-webhook] rejected:', verified.reason);
      res.status(401).json({ error: 'invalid signature', reason: verified.reason });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8') || '[]');
    } catch {
      res.status(400).json({ error: 'invalid JSON body' });
      return;
    }

    const events = Array.isArray(payload) ? payload : [payload];
    const db = getDb();
    const deliveryId = crypto
      .createHash('sha256')
      .update(rawBody)
      .digest('hex')
      .slice(0, 32);

    // Idempotency — drop exact redeliveries.
    const deliveryRef = db.collection('foreflight-events').doc(deliveryId);
    const prior = await deliveryRef.get();
    if (prior.exists) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    const results = [];
    for (const event of events) {
      const flightId = event?.flightId;
      if (!flightId) {
        results.push({ skipped: true, reason: 'no flightId' });
        continue;
      }

      const trip = await findTripByFlightId(db, flightId);
      let detail = null;
      try {
        detail = await runForeFlightAction(cfg, 'getFlight', { flightId });
      } catch (err) {
        console.warn('[ff-webhook] getFlight failed', flightId, err.message);
      }

      const patch = {
        lastWebhookAt: Date.now(),
        lastChangeType: event.changeType || null,
        lastChangedFields: event.changedFields || [],
        releaseStatus: detail?.releaseStatus || null,
        filing: detail?.filing || null,
        performanceSummary: detail?.performance
          ? {
            ete: detail.performance.ete ?? detail.performance.estimatedTimeEnroute ?? null,
            eta: detail.performance.eta ?? detail.performance.estimatedTimeOfArrival ?? null,
            fuel: detail.performance.fuel ?? null,
          }
          : null,
        flightLogTime: detail?.flightData?.flightLogTime || null,
      };

      if (trip) {
        await trip.ref.set({
          foreflight: {
            ...(trip.data.foreflight || {}),
            flightId,
            ...patch,
          },
          foreflightUpdatedAt: Date.now(),
        }, { merge: true });
      }

      results.push({
        flightId,
        tripUid: trip?.id || null,
        changeType: event.changeType,
        matched: Boolean(trip),
      });
    }

    await deliveryRef.set({
      receivedAt: Date.now(),
      events,
      results,
      verifiedVia: verified.via || null,
    });

    await writeConfig({ lastWebhookAt: Date.now() });

    res.status(200).json({ received: true, count: events.length, results });
  } catch (err) {
    console.error('[ff-webhook] fatal', err);
    res.status(500).json({ error: err.message || 'webhook failed' });
  }
}
