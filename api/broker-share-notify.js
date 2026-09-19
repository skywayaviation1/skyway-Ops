import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { notifyBrokerShareSubscribers } from './_broker-share-notifications.js';

let adminApp = null;
let database = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON missing');
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return adminApp;
}
function db() {
  if (!database) database = getFirestore(getAdmin(), 'appusers');
  return database;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || body.idToken;
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    await admin.auth(getAdmin()).verifyIdToken(token);
  } catch {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const tripId = String(body.tripId || '').trim();
  const stepId = String(body.stepId || '').trim();
  if (!tripId || !['taxi_dep', 'wheels_up', 'landed'].includes(stepId)) {
    return res.status(400).json({ ok: false, error: 'tripId and movement stepId required' });
  }

  try {
    const snap = await db().collection('trip-state').doc(tripId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Trip not found' });
    const tripState = snap.data() || {};
    const eventTimeMs = tripState.statuses?.[stepId]?.timestamp;
    if (!Number.isFinite(eventTimeMs)) {
      return res.status(409).json({ ok: false, error: 'Status has no saved timestamp' });
    }
    const result = await notifyBrokerShareSubscribers({
      database: db(),
      host: req.headers.host || 'skyway-ops.vercel.app',
      tripUid: tripId,
      tripState,
      stepId,
      eventTimeMs,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('[broker-share-notify]', error);
    return res.status(500).json({ ok: false, error: error.message || 'Notification failed' });
  }
}
