// /api/email-enqueue.js
//
// Reliable email submission: writes the email into the email-queue Firestore
// collection. The email-queue-drain cron picks it up within ~60 seconds and
// delivers via Resend, retrying on failure.
//
// Frontend should call this INSTEAD OF send-email for any email that should
// be reliably delivered (status notifications, AOG, logbook, MX). Use the old
// send-email.js only when you absolutely need an immediate, in-line send (rare).
//
// Auth: same dual-auth as send-email — Firebase idToken (frontend) OR
// INTERNAL_API_SECRET header (server-to-server).
//
// Body:
//   {
//     to: ['...'],                  // required, array of strings
//     cc: ['...'],                  // optional
//     subject: '...',               // required
//     html: '...',                  // either html OR text required
//     text: '...',                  //   (text is converted to a basic html wrapper)
//     from: '...',                  // optional override
//     source: 'manual_status',      // optional metadata for traceability
//     tripId: '...',                // optional
//     statusKey: '...',             // optional
//     maxAttempts: 5,               // optional, default 5
//     idToken: '...',               // when called from frontend
//   }
// Response:
//   { ok: true, queueId: '...' }   — queued, will deliver within ~60s
//   { error: '...' }                — failed to queue (Firestore down etc)

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let _db = null;

function getAdmin() {
  if (adminApp) return adminApp;
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

function genId() {
  return 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function textToHtml(text) {
  const safe = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family: -apple-system, sans-serif; white-space: pre-wrap; line-height: 1.5;">${safe}</div>`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-internal-secret');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'invalid json body' });
  }

  // Auth: idToken OR internal secret
  let authedAs = null;
  const internalSecret = req.headers['x-internal-secret'];
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) {
    authedAs = 'internal';
  } else if (body.idToken) {
    try {
      const decoded = await admin.auth(getAdmin()).verifyIdToken(body.idToken);
      authedAs = `user:${decoded.uid}`;
    } catch (e) {
      return res.status(401).json({ error: 'invalid idToken', reason: e.message });
    }
  } else {
    return res.status(401).json({ error: 'Unauthorized: provide idToken or x-internal-secret' });
  }

  const { to, cc, subject, html, text, from, source, tripId, statusKey } = body;
  if (!Array.isArray(to) || to.length === 0) {
    return res.status(400).json({ error: 'to[] required' });
  }
  if (!subject || (!html && !text)) {
    return res.status(400).json({ error: 'subject and (html or text) required' });
  }

  // Validate recipients
  const validTo = to.filter(
    (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
  );
  if (validTo.length === 0) {
    return res.status(400).json({ error: 'No valid recipient email addresses' });
  }
  const validCc = Array.isArray(cc)
    ? cc.filter(e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))
    : [];

  try {
    getAdmin();
    const db = getDb();

    const id = genId();
    const now = Date.now();
    const item = {
      status: 'pending',
      to: validTo,
      cc: validCc,
      subject: String(subject).slice(0, 200),
      html: html ? String(html).slice(0, 200000) : textToHtml(text).slice(0, 200000),
      from: from || null,
      attempts: 0,
      maxAttempts: body.maxAttempts || 5,
      lastError: null,
      resendId: null,
      queuedAt: now,
      lastAttemptAt: null,
      nextAttemptAt: now,                  // ready for immediate pickup
      sentAt: null,
      deadAt: null,
      source: source || null,
      tripId: tripId || null,
      statusKey: statusKey || null,
      queuedBy: authedAs,
    };

    await db.collection('email-queue').doc(id).set(item);

    console.log('[email-enqueue] queued', id, 'to', validTo.join(','), 'source=', source || '-');
    return res.status(200).json({ ok: true, queueId: id });
  } catch (err) {
    console.error('[email-enqueue] error:', err);
    return res.status(500).json({ error: err.message || 'enqueue failed' });
  }
}
