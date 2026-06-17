// api/currency-alerts.js
//
// Daily cron — scans every pilot's currency/training status and emails
// notifications when an item crosses a notification threshold.
//
// Thresholds: 60 days (CAUTION), 30 days (WARNING), 14 days (CRITICAL),
// 0 days (EXPIRED). Mirrors the dashboard's STATUS_THRESHOLDS.
//
// Idempotence model: each pilot-currencies doc carries an `alerts`
// map keyed by currency type. We store the last-alerted bucket per
// type. When today's computed bucket differs from the stored one AND
// the new bucket is alertworthy (caution|warning|critical|expired),
// we send the email and update the stored bucket. This means alerts
// fire exactly ONCE per state transition — no daily spam.
//
// Wired in vercel.json crons (daily at 14:00 UTC = 9am Central US,
// 10am Eastern). Pilots get one consolidated email; ops gets a digest.
//
// First-run behavior: stored buckets start null. The first cron run
// after deploy fires alerts for everything currently in caution or
// worse — desired as an initial heads-up baseline.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { applySkywaySignature, ensureCharterCc, textToHtml } from './_email-signature.js';

export const config = { runtime: 'nodejs' };

// Firebase Admin singleton (matches the pattern in aog-chat-nudge etc)
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

// Currency types — keep in sync with src/firebase-currency.js.
// Source of truth there; this is a duplicated catalog because Vercel
// functions can't import from src/.
const CURRENCY_TYPES = [
  { key: 'takeoffLanding',       label: '61.57(a) T/O + Landing',  interval: 90,  category: 'FAA' },
  { key: 'nightCurrency',        label: '61.57(b) Night',          interval: 90,  category: 'FAA' },
  { key: 'instrumentCurrency',   label: '61.57(c) Instrument',     interval: 180, category: 'FAA' },
  { key: 'competencyCheck293',   label: '§135.293 Competency',     interval: 365, category: 'PART 135' },
  { key: 'instrumentCheck297',   label: '§135.297 IPC',            interval: 180, category: 'PART 135' },
  { key: 'lineCheck299',         label: '§135.299 Line Check',     interval: 365, category: 'PART 135' },
  { key: 'recurrentTraining351', label: '§135.351 Recurrent',      interval: 180, category: 'TRAINING' },
];

const THRESHOLDS = { CRITICAL: 14, WARNING: 30, CAUTION: 60 };
const ALERTWORTHY = new Set(['caution', 'warning', 'critical', 'expired']);

function bucketize(daysUntil) {
  if (daysUntil < 0) return 'expired';
  if (daysUntil <= THRESHOLDS.CRITICAL) return 'critical';
  if (daysUntil <= THRESHOLDS.WARNING) return 'warning';
  if (daysUntil <= THRESHOLDS.CAUTION) return 'caution';
  return 'current';
}

function computeDaysUntil(lastDate, intervalDays, todayMs) {
  if (!lastDate) return null;
  const last = new Date(lastDate).getTime();
  if (!Number.isFinite(last)) return null;
  return Math.floor((last + intervalDays * 86400000 - todayMs) / 86400000);
}

function computeMedicalDaysUntil(expirationDate, todayMs) {
  if (!expirationDate) return null;
  const due = new Date(expirationDate).getTime();
  if (!Number.isFinite(due)) return null;
  return Math.floor((due - todayMs) / 86400000);
}

export default async function handler(req, res) {
  try {
    const db = getDb();
    const todayMs = Date.now();

    // Pull every pilot-currencies doc. Collection is small (one per
    // pilot, fleet has ~13). No pagination needed.
    const snap = await db.collection('pilot-currencies').get();
    if (snap.empty) {
      return res.status(200).json({ ok: true, scanned: 0, alertsSent: 0 });
    }

    // Group new alerts per pilot so each pilot gets ONE email
    const alertsByPilot = {};   // uid -> { pilotName, items: [] }
    let docsUpdated = 0;

    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      const uid = docSnap.id;
      const pilotName = data.pilotName || uid;
      const existingAlerts = data.alerts || {};
      const updatedAlerts = { ...existingAlerts };
      let docChanged = false;

      const evaluate = (key, label, category, daysUntil, dueDate) => {
        if (daysUntil == null) return;
        const newBucket = bucketize(daysUntil);
        const lastBucket = existingAlerts[key]?.lastBucket || null;
        if (newBucket === lastBucket) return;
        // Bucket changed. Two cases:
        //   1. New bucket is alertworthy → send alert + update store
        //   2. New bucket is 'current' (pilot completed the check) →
        //      just update the store so the next degradation alerts again
        updatedAlerts[key] = { lastBucket: newBucket, lastAlertedAt: todayMs };
        docChanged = true;
        if (ALERTWORTHY.has(newBucket)) {
          if (!alertsByPilot[uid]) alertsByPilot[uid] = { pilotName, items: [] };
          alertsByPilot[uid].items.push({
            key, label, category, bucket: newBucket, daysUntil, dueDate,
          });
        }
      };

      // Each FAA + Part 135 + training type
      for (const type of CURRENCY_TYPES) {
        const item = data[type.key];
        if (!item || !item.lastDate) continue;
        const daysUntil = computeDaysUntil(item.lastDate, type.interval, todayMs);
        if (daysUntil == null) continue;
        const dueDate = new Date(
          new Date(item.lastDate).getTime() + type.interval * 86400000
        ).toISOString().slice(0, 10);
        evaluate(type.key, type.label, type.category, daysUntil, dueDate);
      }

      // Medical — separate evaluator because it uses explicit expiration
      const med = data.medical;
      if (med?.expirationDate) {
        const daysUntil = computeMedicalDaysUntil(med.expirationDate, todayMs);
        if (daysUntil != null) {
          const label = `${med.class ? med.class + ' Class ' : ''}Medical Certificate`;
          evaluate('medical', label, 'MEDICAL', daysUntil, med.expirationDate);
        }
      }

      if (docChanged) {
        await docSnap.ref.update({ alerts: updatedAlerts });
        docsUpdated++;
      }
    }

    // Send one email per pilot (with all their alerts grouped)
    const apiKey = process.env.RESEND_API_KEY;
    let pilotEmailsSent = 0;
    let opsDigestSent = false;
    const allAlerts = [];

    if (apiKey && Object.keys(alertsByPilot).length > 0) {
      for (const uid of Object.keys(alertsByPilot)) {
        const { pilotName, items } = alertsByPilot[uid];
        allAlerts.push(...items.map((i) => ({ ...i, uid, pilotName })));

        // Look up the pilot's email from the users collection
        const userSnap = await db.collection('users').doc(uid).get();
        const pilotEmail = userSnap.exists ? (userSnap.data() || {}).email : null;
        if (!pilotEmail) continue;

        try {
          await sendPilotEmail(apiKey, pilotEmail, pilotName, items);
          pilotEmailsSent++;
        } catch (e) {
          console.warn('[currency-alerts] pilot email failed for', uid, e.message);
        }
      }

      // Ops digest — single roll-up email of everything that changed today
      try {
        await sendOpsDigest(apiKey, allAlerts);
        opsDigestSent = true;
      } catch (e) {
        console.warn('[currency-alerts] ops digest failed:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      scanned: snap.size,
      docsUpdated,
      pilotsAlerted: Object.keys(alertsByPilot).length,
      pilotEmailsSent,
      opsDigestSent,
    });
  } catch (err) {
    console.error('[currency-alerts] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

// =====================================================================
// EMAIL BUILDERS
// =====================================================================

function severitySubject(items) {
  if (items.some((i) => i.bucket === 'expired')) return '[ACTION REQUIRED]';
  if (items.some((i) => i.bucket === 'critical')) return '[URGENT]';
  if (items.some((i) => i.bucket === 'warning'))  return '[ATTENTION]';
  return '[REMINDER]';
}

function groupByBucket(items) {
  const groups = { expired: [], critical: [], warning: [], caution: [] };
  for (const item of items) groups[item.bucket]?.push(item);
  return groups;
}

function renderGroup(label, list) {
  if (list.length === 0) return [];
  const lines = [`${label}:`];
  for (const item of list) {
    const remain = item.daysUntil >= 0
      ? `${item.daysUntil}d remaining`
      : `${-item.daysUntil}d overdue`;
    lines.push(`  • ${item.label} — due ${item.dueDate} (${remain})`);
  }
  lines.push('');
  return lines;
}

async function sendPilotEmail(apiKey, toEmail, pilotName, items) {
  const tag = severitySubject(items);
  const subject = `${tag} Currency status — ${pilotName}`;
  const groups = groupByBucket(items);

  const textLines = [];
  textLines.push(`Hi ${pilotName},`);
  textLines.push('');
  textLines.push('The following items need attention:');
  textLines.push('');
  textLines.push(...renderGroup('EXPIRED', groups.expired));
  textLines.push(...renderGroup('CRITICAL (≤14 days)', groups.critical));
  textLines.push(...renderGroup('WARNING (≤30 days)', groups.warning));
  textLines.push(...renderGroup('CAUTION (≤60 days)', groups.caution));
  textLines.push('Coordinate with ops to schedule the necessary check or training.');
  textLines.push('');
  textLines.push('Open Skyway Ops → CURRENCY for full status.');
  const text = textLines.join('\n');

  const recipients = [toEmail];
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.OPS_FROM_EMAIL || 'Skyway Ops <noreply@send.flyskyway.com>',
      reply_to: process.env.OPS_REPLY_TO || 'charters@flyskyway.com',
      to: recipients,
      cc: ensureCharterCc([], recipients),
      subject,
      text,
      html: applySkywaySignature(textToHtml(text)),
    }),
  });
}

async function sendOpsDigest(apiKey, allAlerts) {
  if (!allAlerts || allAlerts.length === 0) return;

  // Group alerts by pilot for digest readability
  const byPilot = {};
  for (const a of allAlerts) {
    if (!byPilot[a.uid]) byPilot[a.uid] = { pilotName: a.pilotName, items: [] };
    byPilot[a.uid].items.push(a);
  }

  const opsEmail = process.env.OPS_REPLY_TO || 'charters@flyskyway.com';
  const expiredCount = allAlerts.filter((a) => a.bucket === 'expired').length;
  const subject = expiredCount > 0
    ? `[ACTION REQUIRED] Currency digest — ${expiredCount} expired, ${allAlerts.length - expiredCount} expiring`
    : `Currency digest — ${allAlerts.length} item${allAlerts.length !== 1 ? 's' : ''} expiring`;

  const lines = [];
  lines.push('Pilot currency status changes since the last daily scan:');
  lines.push('');

  // Sort pilots by who has the worst overall (expired first, then critical, etc.)
  const severityRank = { expired: 0, critical: 1, warning: 2, caution: 3 };
  const sortedPilots = Object.keys(byPilot).sort((a, b) => {
    const aWorst = Math.min(...byPilot[a].items.map((i) => severityRank[i.bucket] ?? 99));
    const bWorst = Math.min(...byPilot[b].items.map((i) => severityRank[i.bucket] ?? 99));
    return aWorst - bWorst;
  });

  for (const uid of sortedPilots) {
    const { pilotName, items } = byPilot[uid];
    lines.push(`${pilotName}:`);
    // Sort items within each pilot by bucket severity then days
    const sortedItems = [...items].sort((a, b) => {
      const aRank = severityRank[a.bucket] ?? 99;
      const bRank = severityRank[b.bucket] ?? 99;
      if (aRank !== bRank) return aRank - bRank;
      return a.daysUntil - b.daysUntil;
    });
    for (const item of sortedItems) {
      const remain = item.daysUntil >= 0
        ? `${item.daysUntil}d remaining`
        : `${-item.daysUntil}d overdue`;
      lines.push(`  [${item.bucket.toUpperCase()}] ${item.label} — due ${item.dueDate} (${remain})`);
    }
    lines.push('');
  }

  lines.push('Open Skyway Ops → CURRENCY for the full dashboard.');
  const text = lines.join('\n');

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.OPS_FROM_EMAIL || 'Skyway Ops <noreply@send.flyskyway.com>',
      reply_to: opsEmail,
      to: [opsEmail],
      subject,
      text,
      html: applySkywaySignature(textToHtml(text)),
    }),
  });
}
