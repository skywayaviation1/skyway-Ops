// Persist a leg tail and, when it actually changes on a live leg, email the
// broker notify list. Every caller that writes a tail (schedule sync, the
// open-trip save, manual trips) goes through here so the notice is sent once.
//
// POST { idToken, tripId, tail, from, to, start, end, legType, aircraftType,
//        tripCode, summary, cancelled, completed, isFlight, brokerEmail }

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { applyLegTailUpdate, legStateDocId, requestOrigin } from './_tail-change.js';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let database = null;

function getAdmin() {
  if (adminApp) return adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  }
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    });
  return adminApp;
}

function db() {
  if (!database) database = getFirestore(getAdmin(), 'appusers');
  return database;
}

function clip(value, length) {
  return String(value || '').trim().slice(0, length);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-internal-secret');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  body = body || {};

  const internal = process.env.INTERNAL_API_SECRET
    && req.headers['x-internal-secret'] === process.env.INTERNAL_API_SECRET;
  if (!internal) {
    if (!body.idToken) return res.status(401).json({ error: 'Missing idToken' });
    try {
      await admin.auth(getAdmin()).verifyIdToken(body.idToken);
    } catch {
      return res.status(401).json({ error: 'Invalid idToken' });
    }
  }

  const tripId = legStateDocId(body.tripId);
  if (!tripId) return res.status(400).json({ error: 'tripId required' });
  if (!clip(body.tail, 16)) return res.status(400).json({ error: 'tail required' });

  try {
    let aircraftByTail = {};
    try {
      const fleet = await db().collection('app-config').doc('fleet').get();
      if (fleet.exists) aircraftByTail = fleet.data()?.aircraftByTail || {};
    } catch (err) {
      console.warn('[leg-tail] fleet lookup failed:', err?.message || err);
    }

    const result = await applyLegTailUpdate(db(), tripId, {
      tail: clip(body.tail, 16),
      from: clip(body.from, 8),
      to: clip(body.to, 8),
      start: body.start || null,
      end: body.end || null,
      legType: clip(body.legType, 24) || 'REVENUE',
      aircraftType: clip(body.aircraftType, 80),
      tripCode: clip(body.tripCode, 40),
      summary: clip(body.summary, 240),
      cancelled: body.cancelled === true,
      completed: body.completed === true,
      isFlight: body.isFlight === false ? false : (body.isFlight === true ? true : undefined),
      brokerEmail: clip(body.brokerEmail, 500),
    }, {
      origin: requestOrigin(req),
      aircraftByTail,
    });

    return res.status(200).json({
      ok: true,
      sent: result.sent === true,
      reason: result.reason || null,
      testMode: result.testMode === true,
      oldTail: result.oldTail || null,
      newTail: result.newTail || null,
    });
  } catch (err) {
    console.error('[leg-tail]', err);
    return res.status(500).json({ error: err.message || 'Tail update failed' });
  }
}
