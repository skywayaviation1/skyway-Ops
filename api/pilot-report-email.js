// Email a broker-facing pilot report as a PDF attachment.
//
// Admin, ops, and sales only. The PDF is built on the server from Firestore
// so the attachment matches the sanitized report, not a client-supplied file.
// Resend carries the attachment directly. The shared email queue does not
// store attachments, which is why this route sends immediately, the same
// way malfunction reports do.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { applySkywaySignature, ensureCharterCc, textToHtml } from './_email-signature.js';
import { buildPilotReportPdf } from './_pilot-report-pdf.js';
import { reportsForPilots } from './_pilot-report-data.js';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let firestore = null;

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

function db() {
  if (firestore) return firestore;
  firestore = getFirestore(getAdmin(), 'appusers');
  return firestore;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function authorize(body, req) {
  const internal = req.headers['x-internal-secret'];
  if (internal && internal === process.env.INTERNAL_API_SECRET) return { ok: true, role: 'internal' };
  if (!body?.idToken) return { ok: false, error: 'Unauthorized' };
  try {
    const decoded = await admin.auth(getAdmin()).verifyIdToken(body.idToken);
    const userDoc = await db().collection('users').doc(decoded.uid).get();
    const role = userDoc.exists ? (userDoc.data().role || '') : '';
    if (!['admin', 'ops', 'sales'].includes(role)) return { ok: false, error: 'Not allowed to send pilot reports' };
    return { ok: true, uid: decoded.uid, role };
  } catch (err) {
    return { ok: false, error: 'invalid idToken' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-internal-secret');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const authResult = await authorize(body, req);
  if (!authResult.ok) return res.status(401).json({ error: authResult.error || 'Unauthorized' });

  const recipients = (Array.isArray(body?.to) ? body.to : [])
    .map((value) => String(value || '').trim())
    .filter((value) => EMAIL_RE.test(value))
    .slice(0, 8);
  if (recipients.length === 0) return res.status(400).json({ error: 'A broker email address is required' });

  const pilotUid = String(body?.pilotUid || '').slice(0, 128);
  if (!pilotUid) return res.status(400).json({ error: 'pilotUid is required' });

  try {
    const userSnap = await db().collection('users').doc(pilotUid).get();
    const profile = userSnap.exists ? userSnap.data() : {};
    const pilotName = profile.name || profile.displayName || 'Pilot';
    const prepared = await reportsForPilots(db(), [{ uid: pilotUid, name: pilotName }]);
    const reports = prepared.reports || [];
    if (!reports.length) {
      const reasons = prepared.blocked?.[0]?.reasons || [];
      return res.status(409).json({
        ok: false,
        blocked: true,
        error: 'This report was not sent. The pilot’s hours or medical do not meet the seat, so nothing was emailed to the broker.',
        reasons,
      });
    }
    const report = reports[0];
    const pdf = await buildPilotReportPdf(reports);
    const filename = `crew-report-${pilotName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pilot'}.pdf`;
    const note = String(body?.note || '').trim().slice(0, 2000);
    const text = [
      `Crew report for ${report.crew?.[0]?.pilotName || pilotName}.`,
      report.hoursAsOf ? `Totals as of ${report.hoursAsOf}.` : '',
      note || null,
      '',
      'The PDF is attached. It is the crew summary sent only when the pilot’s hours and medical meet the seat.',
    ].filter((line) => line != null && line !== '').join('\n');

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return res.status(200).json({
        ok: false,
        emailError: 'RESEND_API_KEY not configured',
        recipients,
        report,
      });
    }

    const upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.OPS_FROM_EMAIL || 'Skyway Ops <noreply@send.flyskyway.com>',
        to: recipients,
        cc: ensureCharterCc([], recipients),
        reply_to: process.env.OPS_REPLY_TO || 'charters@flyskyway.com',
        subject: `Crew report — ${report.crew?.[0]?.pilotName || pilotName}`,
        text,
        html: applySkywaySignature(textToHtml(text)),
        attachments: [{ filename, content: pdf.toString('base64') }],
      }),
    });
    const upstreamData = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(200).json({
        ok: false,
        emailError: upstreamData?.message || `Resend ${upstream.status}`,
        recipients,
      });
    }
    return res.status(200).json({ ok: true, emailId: upstreamData?.id || null, recipients });
  } catch (err) {
    console.error('[pilot-report-email]', err);
    return res.status(500).json({ error: err.message || 'Could not send the pilot report' });
  }
}
