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
import { applySkywaySignature, ensureCharterCc, textToHtml } from './_email-signature.js';

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
  // Auto-CC charters@flyskyway.com on every outgoing email so any broker
  // replies land in the monitored inbox (despite the do-not-reply notice).
  // The helper handles the "to is charter@" case internally (no self-CC).
  const finalCc = ensureCharterCc(validCc, validTo);

  // Build the final HTML body. Either:
  //   - caller passed html → we wrap it with Skyway header/footer
  //   - caller passed text → convert to a basic html wrapper, THEN wrap
  // Both paths end up running through the same signature wrapper so every
  // email leaving Skyway carries the brand + do-not-reply notice.
  const rawHtml = html
    ? String(html).slice(0, 200000)
    : textToHtml(text).slice(0, 200000);
  const wrappedHtml = applySkywaySignature(rawHtml);

  try {
    getAdmin();
    const db = getDb();
    const id = genId();
    const now = Date.now();

    // ATTEMPT 1: Send immediately via Resend. This is the fast path that
    // 99% of emails take. The dispatcher tapped the status; they want the
    // email out NOW, not in 60 seconds when the queue cron next runs.
    const sendResult = await sendViaResendInline({
      to: validTo,
      cc: finalCc,
      subject: String(subject).slice(0, 200),
      html: wrappedHtml,
      from: from || null,
    });

    // Write the record either way — sent or pending. This gives us a full
    // audit trail of every email that should have gone out, regardless of
    // delivery success.
    const baseRecord = {
      to: validTo,
      cc: finalCc,
      subject: String(subject).slice(0, 200),
      html: wrappedHtml,
      from: from || null,
      attempts: 1,
      maxAttempts: body.maxAttempts || 5,
      queuedAt: now,
      lastAttemptAt: now,
      source: source || null,
      tripId: tripId || null,
      statusKey: statusKey || null,
      queuedBy: authedAs,
    };

    if (sendResult.ok) {
      // FAST PATH: delivered to Resend on the first try.
      await db.collection('email-queue').doc(id).set({
        ...baseRecord,
        status: 'sent',
        sentAt: Date.now(),
        resendId: sendResult.id || null,
        lastError: null,
        nextAttemptAt: null,
        deadAt: null,
      });
      console.log('[email-enqueue] SENT inline', id, '→', validTo.join(','),
        '· resend id:', sendResult.id, '· source:', source || '-');
      return res.status(200).json({
        ok: true,
        queueId: id,
        resendId: sendResult.id,
        delivery: 'inline',
      });
    }

    // SLOW PATH: Resend failed (transient or otherwise). Queue for retry.
    await db.collection('email-queue').doc(id).set({
      ...baseRecord,
      status: 'failed',
      sentAt: null,
      resendId: null,
      lastError: sendResult.error || 'unknown error',
      nextAttemptAt: now + 10 * 1000,    // retry in 10 seconds
      deadAt: null,
    });
    console.warn('[email-enqueue] inline send failed for', id, '· error:', sendResult.error,
      '· queued for retry');
    return res.status(200).json({
      ok: true,
      queueId: id,
      delivery: 'queued',
      reason: sendResult.error,
    });
  } catch (err) {
    console.error('[email-enqueue] error:', err);
    return res.status(500).json({ error: err.message || 'enqueue failed' });
  }
}

// Send via Resend directly, return { ok, id?, error? }
async function sendViaResendInline({ to, cc, subject, html, from }) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY missing on server' };
  }
  const DEFAULT_FROM = process.env.OPS_FROM_EMAIL || 'Skyway Ops <noreply@send.flyskyway.com>';
  const body = {
    from: from || DEFAULT_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (Array.isArray(cc) && cc.length > 0) body.cc = cc;

  try {
    // 8-second timeout so we don't hang the user's request
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: `Resend ${r.status}: ${data.message || data.error || 'unknown'}` };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: `Network: ${e.message || String(e)}` };
  }
}
