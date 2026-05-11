// api/flightaware-alerts.js
//
// Admin-only management endpoint for FlightAware alerts. Handles three actions:
//
//   GET  ?action=list           → list all alerts on the account
//   POST { action: 'create',
//          ident: 'N168ZZ',
//          events: { out: true, off: true, on: true, in: false } }
//   POST { action: 'delete', alertId: 12345 }
//
// All three return JSON. The admin UI in App.jsx calls this.

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

async function verifyAdmin(idToken) {
  const decoded = await admin.auth().verifyIdToken(idToken);
  const db = getDb();
  const profile = await db.collection('users').doc(decoded.uid).get();
  if (!profile.exists || profile.data().role !== 'admin') {
    const err = new Error('Admin role required');
    err.code = 'forbidden';
    throw err;
  }
  return decoded;
}

export default async function handler(req, res) {
  try {
    getAdmin();

    const apiKey = process.env.FLIGHTAWARE_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'FLIGHTAWARE_API_KEY not configured' });
      return;
    }

    // Both GET and POST require an idToken — for GET we accept it as query param
    const idToken = req.method === 'GET' ? req.query.idToken : (req.body || {}).idToken;
    if (!idToken) {
      res.status(400).json({ error: 'idToken required' });
      return;
    }
    try {
      await verifyAdmin(idToken);
    } catch (err) {
      if (err.code === 'forbidden') {
        res.status(403).json({ error: err.message });
      } else {
        res.status(401).json({ error: 'Invalid token: ' + err.message });
      }
      return;
    }

    const action = req.method === 'GET' ? (req.query.action || 'list') : (req.body || {}).action;

    // === LIST ALERTS ===
    if (action === 'list') {
      const r = await fetch(`${FA_API_BASE}/alerts`, {
        headers: { 'x-apikey': apiKey, Accept: 'application/json' },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        res.status(502).json({ error: `FA error ${r.status}: ${JSON.stringify(data)}` });
        return;
      }
      res.status(200).json({ ok: true, alerts: data.alerts || [], numPages: data.num_pages });
      return;
    }

    // === CREATE ALERT ===
    if (action === 'create') {
      const { ident, events } = req.body || {};
      if (!ident) {
        res.status(400).json({ error: 'ident (tail number) required' });
        return;
      }
      // Default events — block-out, wheels-up, wheels-down
      const evts = events || { out: true, off: true, on: true, in: false };

      // Body shape per FlightAware OpenAPI spec
      const alertBody = {
        ident,
        events: {
          arrival: false,
          cancelled: false,
          departure: false,
          diverted: true,            // useful: notify if a flight goes to the wrong airport
          filed: false,
          out: evts.out === true,
          off: evts.off === true,
          on: evts.on === true,
          in: evts.in === true,
          hold_start: false,
          hold_end: false,
        },
        max_weekly: 1000,
        // Webhook URL is implicit (set by /alerts/endpoint), but per their docs
        // we should also set target_url just to be explicit. The shared secret
        // is per-alert, set via a separate field FA calls "target_url_format"
        // — actually no, the secret comes from request headers. We rely on the
        // default endpoint and account-wide signature header config.
      };

      const r = await fetch(`${FA_API_BASE}/alerts`, {
        method: 'POST',
        headers: {
          'x-apikey': apiKey,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(alertBody),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('[fa-alerts] create failed:', r.status, data);
        res.status(502).json({ error: `FA error ${r.status}: ${data.title || data.detail || JSON.stringify(data)}` });
        return;
      }

      res.status(200).json({ ok: true, alert: data });
      return;
    }

    // === DELETE ALERT ===
    if (action === 'delete') {
      const { alertId } = req.body || {};
      if (!alertId) {
        res.status(400).json({ error: 'alertId required' });
        return;
      }
      const r = await fetch(`${FA_API_BASE}/alerts/${alertId}`, {
        method: 'DELETE',
        headers: { 'x-apikey': apiKey },
      });
      if (!r.ok && r.status !== 204) {
        const data = await r.json().catch(() => ({}));
        res.status(502).json({ error: `FA error ${r.status}: ${JSON.stringify(data)}` });
        return;
      }
      res.status(200).json({ ok: true, deleted: alertId });
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[fa-alerts] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
