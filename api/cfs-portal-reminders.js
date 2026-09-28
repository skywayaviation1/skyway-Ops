// Hourly CFS reminder pass. A bind that is still open after 24 hours gets one
// reminder. A trip that is still open inside 24 hours of departure gets one
// more. Test mode redirects both to jake@flyskyway.com.

import { emailButton, emailShell } from '../src/aog-mail-layout.js';
import { appendCoverageEvent, loadSettings, publicBaseUrl, recoveryDb, sendRecoveryEmail } from './_aog-recovery.js';
import { planCfsReminders } from '../src/cfs-portal.js';
import { normalizeTripId } from '../src/trip-id.js';
import { CFS_BIND_TO } from '../src/aog-recovery.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

function cronAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

function reminderLetter(record, kind, portalUrl) {
  const tripId = normalizeTripId(record.tripId) || record.tripId || 'trip';
  const why = kind === 'depart_24h'
    ? 'The first departure is inside 24 hours and coverage is not acknowledged yet.'
    : 'This bind request has been open for 24 hours.';
  const subject = `Reminder: acknowledge AOG coverage — ${tripId}`;
  const html = emailShell({
    coBrand: true,
    preheader: 'AOG coverage is still waiting for acknowledgement.',
    headline: 'Coverage is still waiting',
    lede: why,
    body: `<p style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;color:#14202b">Trip ${tripId}. Coverage: 100%.</p>${emailButton(portalUrl, 'Open the CFS portal')}`,
  });
  const text = `${why}\nTrip ${tripId}\nCoverage: 100%\nOpen the CFS portal: ${portalUrl}\n`;
  return { subject, html, text };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'GET only' });
    return;
  }
  if (!cronAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const db = recoveryDb();
    const settings = await loadSettings(db);
    const to = settings.cfsStaff[0]?.email || CFS_BIND_TO;
    const portalUrl = `${publicBaseUrl(req)}/cfs`;
    const now = new Date();
    let snap;
    try {
      snap = await db.collection('aogRecovery').orderBy('createdAt', 'desc').limit(400).get();
    } catch {
      snap = await db.collection('aogRecovery').limit(400).get();
    }
    const sent = [];
    for (const docSnap of snap.docs) {
      const record = { id: docSnap.id, ...docSnap.data() };
      const plans = planCfsReminders(record, now);
      for (const plan of plans) {
        const letter = reminderLetter(record, plan.kind, portalUrl);
        const result = await sendRecoveryEmail({ to, subject: letter.subject, html: letter.html, text: letter.text });
        if (!result.ok) {
          sent.push({ id: docSnap.id, kind: plan.kind, error: result.error || 'send failed' });
          continue;
        }
        const at = new Date().toISOString();
        await docSnap.ref.set({
          [plan.field]: at,
          cfsReminderDue: true,
        }, { merge: true });
        await appendCoverageEvent(db, docSnap.id, {
          type: 'cfs_reminder_sent',
          atUtc: at,
          actor: 'cfs-portal-reminders',
          detail: plan.kind === 'depart_24h' ? 'Reminder 24h before departure' : 'Reminder 24h after bind',
          tripId: record.tripId,
        }).catch(() => {});
        sent.push({ id: docSnap.id, kind: plan.kind, ok: true });
      }
    }
    res.status(200).json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Reminder pass failed' });
  }
}
