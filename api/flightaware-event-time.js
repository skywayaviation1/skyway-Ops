import admin from 'firebase-admin';
import { selectFlightAwareEvent } from '../src/flightaware-event-utils.js';

export const config = { runtime: 'nodejs' };

let adminApp = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return adminApp;
}

async function authorize(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    || req.body?.idToken;
  if (!token) return false;
  try {
    await admin.auth(getAdmin()).verifyIdToken(token);
    return true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!(await authorize(req))) return res.status(401).json({ error: 'unauthorized' });

  const {
    ident,
    stepId,
    from,
    to,
    scheduledStart,
  } = req.body || {};
  if (!ident || !['taxi_dep', 'wheels_up', 'landed'].includes(stepId)) {
    return res.status(400).json({ error: 'ident and a supported stepId are required' });
  }

  const apiKey = process.env.FLIGHTAWARE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FLIGHTAWARE_API_KEY missing' });

  try {
    const response = await fetch(
      `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}?max_pages=1`,
      { headers: { 'x-apikey': apiKey, Accept: 'application/json' } },
    );
    if (!response.ok) {
      return res.status(502).json({ error: `FlightAware lookup failed (${response.status})` });
    }
    const data = await response.json();
    const match = selectFlightAwareEvent(data.flights, {
      ident,
      stepId,
      from,
      to,
      scheduledStartMs: scheduledStart ? new Date(scheduledStart).getTime() : NaN,
    });
    return res.status(200).json({
      ok: true,
      matched: !!match,
      event: match,
    });
  } catch (error) {
    console.error('[flightaware-event-time]', error);
    return res.status(500).json({ error: error.message || 'FlightAware lookup failed' });
  }
}
