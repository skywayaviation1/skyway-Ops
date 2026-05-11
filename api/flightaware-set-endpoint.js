// api/flightaware-set-endpoint.js
//
// One-time setup: register our webhook URL with FlightAware. After this,
// all alerts created on this AeroAPI account will deliver to our endpoint
// unless overridden per-alert.
//
// Mirrors FlightAware's:
//   PUT https://aeroapi.flightaware.com/aeroapi/alerts/endpoint
//   Headers: x-apikey: <FLIGHTAWARE_API_KEY>
//   Body: { url: "https://skyway-ops.vercel.app/api/flightaware-webhook" }
//
// Called from the admin Settings panel via fetch. Admin-only.

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
    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return adminApp;
}
function getDb() {
  if (_db) return _db;
  const app = getAdmin();
  _db = getFirestore(app, 'appusers');
  return _db;
}

const FA_API_BASE = 'https://aeroapi.flightaware.com/aeroapi';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    getAdmin();

    const { idToken } = req.body || {};
    if (!idToken) {
      res.status(400).json({ error: 'idToken required' });
      return;
    }

    // Verify caller is admin
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      res.status(401).json({ error: 'Invalid token: ' + err.message });
      return;
    }

    // Look up profile in the named 'appusers' database
    const db = getDb();
    const profileSnap = await db.collection('users').doc(decoded.uid).get();
    if (!profileSnap.exists || profileSnap.data().role !== 'admin') {
      res.status(403).json({ error: 'Admin role required' });
      return;
    }

    const apiKey = process.env.FLIGHTAWARE_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'FLIGHTAWARE_API_KEY not configured' });
      return;
    }

    // Our webhook endpoint. Picks up the deployed Vercel URL — must be
    // the SAME url FlightAware will POST to.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://skyway-ops.vercel.app';
    const webhookUrl = `${appUrl}/api/flightaware-webhook`;

    // Call FlightAware
    const r = await fetch(`${FA_API_BASE}/alerts/endpoint`, {
      method: 'PUT',
      headers: {
        'x-apikey': apiKey,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[fa-set-endpoint] FA returned error:', r.status, data);
      res.status(502).json({
        error: `FlightAware returned ${r.status}: ${data.title || data.detail || JSON.stringify(data)}`,
      });
      return;
    }

    // Record the registration in Firestore so admin UI can show "registered"
    await db.collection('flightaware').doc('config').set({
      endpointUrl: webhookUrl,
      endpointRegisteredAt: Date.now(),
      endpointRegisteredBy: decoded.uid,
    }, { merge: true });

    res.status(200).json({ ok: true, webhookUrl, faResponse: data });
  } catch (err) {
    console.error('[fa-set-endpoint] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
