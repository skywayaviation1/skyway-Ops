// /api/email-queue-drain.js
//
// Reliable email delivery system. Drains the email-queue Firestore collection
// every 60 seconds via Vercel cron. Retries with exponential backoff. Alerts
// admin after a configurable number of permanent failures.
//
// Architecture:
//   Every email gets written to email-queue/{queueId} BEFORE we try to send it.
//   This cron picks up unsent items, attempts delivery, and updates state.
//
// Document shape (email-queue/{queueId}):
//   {
//     status: 'pending' | 'sending' | 'sent' | 'failed' | 'dead',
//     to: ['a@b.com', ...],                  // array of recipients
//     cc: [...],                              // optional
//     subject: string,
//     html: string,
//     from: string,                           // optional override
//     attempts: number,                       // count of delivery attempts
//     maxAttempts: number,                    // default 5
//     lastError: string | null,               // most recent error message
//     resendId: string | null,                // Resend message id once delivered
//     queuedAt: number,                       // ms epoch
//     lastAttemptAt: number | null,
//     nextAttemptAt: number,                  // ms epoch; cron skips items where this > now
//     sentAt: number | null,
//     deadAt: number | null,                  // set when we give up permanently
//     // Optional metadata for traceability
//     source: 'manual_status' | 'auto_status' | 'aog' | 'logbook' | 'mx' | string,
//     tripId: string | null,
//     statusKey: string | null,
//   }
//
// Status lifecycle:
//   pending → sending → sent              (happy path)
//   pending → sending → failed (retry)    (transient failure; next attempt scheduled)
//   pending → sending → dead              (max attempts reached; admin alerted)

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { isPermanentSendFailure, STALE_SENDING_MS } from './_email-delivery.js';

export const config = { runtime: 'nodejs' };

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
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_DEFAULT = process.env.OPS_FROM_EMAIL || 'Skyway Ops <noreply@send.flyskyway.com>';
const ADMIN_ALERT_EMAILS = (process.env.OPS_ALERT_EMAILS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const MAX_ATTEMPTS_DEFAULT = 5;
const BATCH_SIZE = 25;                    // max items delivered per cron run
const PAGE_SIZE = 100;                    // Firestore reads per page while scanning
const MAX_PAGES = 20;                     // scan cap: 2000 queue rows per tick
const BACKOFF_SECONDS = [10, 30, 120, 600, 1800];  // 10s, 30s, 2min, 10min, 30min

/**
 * Page through queue rows awaiting delivery and return the ones that are due.
 *
 * Ordering is by document name, which is also roughly chronological because
 * queue IDs are `q_<base36 timestamp>_<random>`. That keeps the oldest mail
 * first without needing a composite index on (status, nextAttemptAt).
 *
 * `sending` is included because that flag is an optimistic lock: if a previous
 * run was cut short after taking the lock but before recording the outcome, the
 * row would otherwise sit in `sending` forever and never be retried.
 */
async function collectDueItems(db, now) {
  const due = [];
  let scanned = 0;
  let backlog = 0;
  let reclaimed = 0;
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = db.collection('email-queue')
      .where('status', 'in', ['pending', 'failed', 'sending'])
      .orderBy('__name__')
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned += 1;
      const data = doc.data();

      if (data.status === 'sending') {
        const startedAt = data.lastAttemptAt || 0;
        if (now - startedAt < STALE_SENDING_MS) {
          backlog += 1;              // another run holds the lock right now
          continue;
        }
        reclaimed += 1;              // abandoned lock — take it over
      } else if ((data.nextAttemptAt || 0) > now) {
        backlog += 1;                // still waiting on backoff
        continue;
      }

      if (due.length < BATCH_SIZE) due.push(doc);
    }

    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE_SIZE) break;      // reached the end of the queue
    if (due.length >= BATCH_SIZE) break;   // enough work for this tick
  }

  return { due, scanned, backlog, reclaimed };
}

// Send via Resend. Returns { ok, id?, error? }.
async function sendViaResend({ to, cc, subject, html, from }) {
  if (!RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY missing on server' };
  }
  const body = {
    from: from || FROM_DEFAULT,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (Array.isArray(cc) && cc.length > 0) body.cc = cc;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: `Resend ${r.status}: ${data.message || data.error || 'unknown'}` };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: `Network: ${e.message || String(e)}` };
  }
}

// Send admin alert for a dead message (best-effort; we don't queue this one because
// queueing the alert about a failed send creates an infinite recursion risk).
async function alertAdminDeadMessage(queueId, item) {
  if (ADMIN_ALERT_EMAILS.length === 0) return;
  const html = `
    <p><strong>An email could not be delivered after ${item.attempts} attempts.</strong></p>
    <p>Queue ID: <code>${queueId}</code></p>
    <p>To: ${(item.to || []).join(', ')}</p>
    <p>Subject: ${item.subject}</p>
    <p>Last error: <code>${item.lastError || 'unknown'}</code></p>
    <p>Source: ${item.source || 'unknown'}${item.tripId ? ` · trip ${item.tripId}` : ''}</p>
    <p>To retry manually, open the Email Queue admin tab in Skyway Ops.</p>
  `;
  await sendViaResend({
    to: ADMIN_ALERT_EMAILS,
    subject: `[Skyway Ops] Email delivery failed — ${item.subject}`,
    html,
  });
}

export default async function handler(req, res) {
  // Following the same pattern as flightaware-cron-poll: no auth header check.
  // Vercel cron calls this directly; the endpoint is otherwise harmless
  // (it only sends queued emails, doesn't expose data).

  try {
    const db = getDb();
    const now = Date.now();

    // Collect items whose retry time has arrived.
    //
    // This pages through the queue instead of reading a single fixed slice.
    // A single `.limit(100)` with no ordering returns the 100 lowest document
    // IDs, which are the oldest entries. Once that many not-yet-due failures
    // sat at the head of the queue, every newer email became invisible to this
    // cron and never went out. Paging keeps scanning until enough due items are
    // found, so a backlog can no longer starve new mail.
    const { due, scanned, backlog, reclaimed } = await collectDueItems(db, now);

    console.log('[email-queue-drain] tick: scanned', scanned, 'awaiting delivery ·',
      due.length, 'due now ·', backlog, 'waiting ·', reclaimed, 'stale locks reclaimed');

    if (due.length === 0) {
      res.status(200).json({ ok: true, processed: 0, scanned, waiting: backlog });
      return;
    }

    const results = [];
    for (const doc of due) {
      const id = doc.id;
      const item = doc.data();
      const attempts = (item.attempts || 0) + 1;
      const maxAttempts = item.maxAttempts || MAX_ATTEMPTS_DEFAULT;

      // Optimistic lock: flip to 'sending' so a second concurrent cron skips it
      try {
        await doc.ref.update({
          status: 'sending',
          lastAttemptAt: now,
        });
      } catch (e) {
        results.push({ id, skipped: 'lock failed' });
        continue;
      }

      const send = await sendViaResend({
        to: item.to,
        cc: item.cc,
        subject: item.subject,
        html: item.html,
        from: item.from,
      });

      if (send.ok) {
        await doc.ref.update({
          status: 'sent',
          attempts,
          sentAt: Date.now(),
          resendId: send.id || null,
          lastError: null,
        });
        console.log('[email-queue-drain] SENT', id, '→', (item.to || []).join(','), '· resend id:', send.id);
        results.push({ id, ok: true, resendId: send.id });
        continue;
      }

      console.warn('[email-queue-drain] FAIL', id, '· attempt', attempts, '· error:', send.error);

      // Failed. Decide retry vs dead. A configuration rejection fails
      // identically every time, so it goes straight to dead and raises the
      // admin alert now instead of after five silent retries.
      const dead = attempts >= maxAttempts || isPermanentSendFailure(send.error);
      const backoffIdx = Math.min(attempts - 1, BACKOFF_SECONDS.length - 1);
      const nextAttemptAt = Date.now() + (BACKOFF_SECONDS[backoffIdx] * 1000);

      await doc.ref.update({
        status: dead ? 'dead' : 'failed',
        attempts,
        lastError: send.error || 'unknown error',
        nextAttemptAt: dead ? null : nextAttemptAt,
        deadAt: dead ? Date.now() : null,
      });

      if (dead) {
        // Best-effort admin alert
        try { await alertAdminDeadMessage(id, { ...item, attempts, lastError: send.error }); }
        catch (_) { /* don't crash the cron on alert failure */ }
        results.push({ id, dead: true, error: send.error });
      } else {
        results.push({ id, failed: true, error: send.error, retryInSec: BACKOFF_SECONDS[backoffIdx] });
      }
    }

    res.status(200).json({
      ok: true,
      processed: results.length,
      sent: results.filter(r => r.ok).length,
      failed: results.filter(r => r.failed).length,
      dead: results.filter(r => r.dead).length,
      results,
    });
  } catch (err) {
    console.error('[email-queue-drain] error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
