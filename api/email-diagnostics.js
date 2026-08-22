// /api/email-diagnostics.js
//
// Answers "why aren't notification emails arriving?" without needing access to
// server logs or the mail provider dashboard.
//
// Reports three things:
//   1. Whether the delivery configuration exists on the server at all
//   2. The state of the email queue, including the verbatim provider error on
//      recent failures
//   3. Optionally, the result of a live test send
//
// Admin only. Never returns key material — only whether a value is present.
//
// POST { idToken, action: 'status' | 'test' | 'retry', to?, queueId? }

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { applySkywaySignature, textToHtml } from './_email-signature.js';
import { explainSendFailure, isPermanentSendFailure } from './_email-delivery.js';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let _db = null;

function getAdmin() {
  if (adminApp) return adminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return adminApp;
}

function getDb() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

async function authorizeAdmin(idToken) {
  if (!idToken) {
    const error = new Error('idToken required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = await admin.auth(getAdmin()).verifyIdToken(idToken, true);
  } catch {
    const error = new Error('Invalid or revoked session');
    error.status = 401;
    throw error;
  }
  const snap = await getDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (!snap.exists || profile.role !== 'admin' || profile.active === false || profile.approved !== true) {
    const error = new Error('Active administrator access required');
    error.status = 403;
    throw error;
  }
  return { uid: decoded.uid, email: decoded.email || profile.email || '', name: profile.name || 'Administrator' };
}

const FROM_DEFAULT = 'Skyway Ops <noreply@send.flyskyway.com>';

function senderAddress() {
  const configured = String(process.env.OPS_FROM_EMAIL || '').trim() || FROM_DEFAULT;
  // "Name <box@domain>" or a bare address.
  const match = configured.match(/<([^>]+)>/);
  return (match ? match[1] : configured).trim();
}

function senderDomain() {
  const address = senderAddress();
  const at = address.lastIndexOf('@');
  return at === -1 ? null : address.slice(at + 1).toLowerCase();
}

/** Server-side delivery configuration, presence only — never values. */
function configReport() {
  const hasKey = Boolean(process.env.RESEND_API_KEY);
  const alertEmails = String(process.env.OPS_ALERT_EMAILS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    resendApiKey: hasKey,
    firebaseServiceAccount: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    internalApiSecret: Boolean(process.env.INTERNAL_API_SECRET),
    fromAddress: senderAddress(),
    fromDomain: senderDomain(),
    fromIsDefault: !String(process.env.OPS_FROM_EMAIL || '').trim(),
    replyTo: String(process.env.OPS_REPLY_TO || '').trim() || 'charters@flyskyway.com',
    deadLetterAlertRecipients: alertEmails.length,
  };
}

/** Ask the provider which sending domains are verified. */
async function domainReport() {
  if (!process.env.RESEND_API_KEY) {
    return { checked: false, reason: 'RESEND_API_KEY not configured' };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return {
        checked: true,
        ok: false,
        status: r.status,
        error: data.message || `Provider returned ${r.status}`,
        explanation: explainSendFailure(`Resend ${r.status}: ${data.message || ''}`),
      };
    }
    const domains = (data.data || data.domains || []).map((d) => ({
      name: d.name,
      status: d.status,
      region: d.region || null,
    }));
    const wanted = senderDomain();
    const match = domains.find((d) => String(d.name).toLowerCase() === wanted);
    return {
      checked: true,
      ok: true,
      domains,
      sendingDomain: wanted,
      sendingDomainStatus: match ? match.status : null,
      sendingDomainVerified: match ? match.status === 'verified' : false,
    };
  } catch (err) {
    return { checked: true, ok: false, error: `Network: ${err.message || String(err)}` };
  }
}

/** Queue health: counts by status plus the most recent failures with cause. */
async function queueReport(db) {
  const snap = await db.collection('email-queue')
    .orderBy('queuedAt', 'desc')
    .limit(300)
    .get();

  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0, other: 0 };
  const failures = [];
  let lastSentAt = null;

  for (const doc of snap.docs) {
    const d = doc.data();
    const status = String(d.status || 'other');
    if (counts[status] === undefined) counts.other += 1;
    else counts[status] += 1;

    if (status === 'sent' && d.sentAt && (!lastSentAt || d.sentAt > lastSentAt)) {
      lastSentAt = d.sentAt;
    }
    if ((status === 'failed' || status === 'dead') && failures.length < 10) {
      failures.push({
        queueId: doc.id,
        status,
        to: d.to || [],
        subject: d.subject || '',
        source: d.source || null,
        tripId: d.tripId || null,
        attempts: d.attempts || 0,
        queuedAt: d.queuedAt || null,
        lastAttemptAt: d.lastAttemptAt || null,
        lastError: d.lastError || null,
        explanation: explainSendFailure(d.lastError),
        permanent: isPermanentSendFailure(d.lastError),
      });
    }
  }

  return { sampled: snap.size, counts, failures, lastSentAt };
}

async function sendTest(to) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY missing on server' };
  }
  const body = {
    from: String(process.env.OPS_FROM_EMAIL || '').trim() || FROM_DEFAULT,
    reply_to: String(process.env.OPS_REPLY_TO || '').trim() || 'charters@flyskyway.com',
    to: [to],
    subject: 'Skyway Ops — email delivery test',
    html: applySkywaySignature(textToHtml(
      'This is a delivery test from Skyway Ops.\n\n'
      + 'If you received it, notification email is working from the server to your inbox.',
    )),
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const error = `Resend ${r.status}: ${data.message || data.error || 'unknown'}`;
      return { ok: false, status: r.status, error, explanation: explainSendFailure(error), details: data };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    const error = `Network: ${err.message || String(err)}`;
    return { ok: false, error, explanation: explainSendFailure(error) };
  }
}

/** Put a dead/failed row back in line for the next drain tick. */
async function retryQueued(db, queueId) {
  const ref = db.collection('email-queue').doc(String(queueId));
  const snap = await ref.get();
  if (!snap.exists) {
    const error = new Error('Queue item not found');
    error.status = 404;
    throw error;
  }
  await ref.update({
    status: 'pending',
    attempts: 0,
    nextAttemptAt: Date.now(),
    deadAt: null,
    lastError: null,
  });
  return { ok: true, queueId };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const caller = await authorizeAdmin(body.idToken);
    const db = getDb();
    const action = body.action || 'status';

    if (action === 'test') {
      const to = String(body.to || caller.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        res.status(400).json({ error: 'A valid recipient address is required for a test send' });
        return;
      }
      const result = await sendTest(to);
      res.status(200).json({ action, to, result, config: configReport() });
      return;
    }

    if (action === 'retry') {
      if (!body.queueId) {
        res.status(400).json({ error: 'queueId is required' });
        return;
      }
      res.status(200).json({ action, ...(await retryQueued(db, body.queueId)) });
      return;
    }

    const [domains, queue] = await Promise.all([domainReport(), queueReport(db)]);
    const config = configReport();

    // Rank the causes an operator can actually act on.
    const problems = [];
    if (!config.resendApiKey) {
      problems.push('RESEND_API_KEY is not set on the server, so no email can be sent.');
    }
    if (domains.checked && domains.ok && domains.sendingDomainStatus == null) {
      problems.push(`The sending domain ${config.fromDomain} is not registered with the mail provider.`);
    }
    if (domains.checked && domains.ok && domains.sendingDomainStatus && !domains.sendingDomainVerified) {
      problems.push(`The sending domain ${config.fromDomain} is "${domains.sendingDomainStatus}", not verified.`);
    }
    if (domains.checked && domains.ok === false) {
      problems.push(domains.explanation || domains.error || 'The mail provider rejected the credential check.');
    }
    if (queue.counts.dead > 0) {
      problems.push(`${queue.counts.dead} queued email(s) were abandoned after repeated failures.`);
    }
    if (config.deadLetterAlertRecipients === 0) {
      problems.push('OPS_ALERT_EMAILS is empty, so abandoned emails alert nobody.');
    }

    res.status(200).json({
      action: 'status',
      checkedAt: Date.now(),
      config,
      domains,
      queue,
      problems,
      healthy: problems.length === 0,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Email diagnostics failed' });
  }
}
