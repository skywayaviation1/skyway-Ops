// api/aog-offer-respond.js
//
// Public endpoint the broker hits when they click Accept or Decline.
// Validates the HMAC token, updates the coverage record, and (on
// accept) sends notifications to the pre-configured ops + CFS recipients.
//
// POST { token, action, respondedByEmail? }
// Returns { ok, coverageId, status, trip: {...} }
//
// No Firebase auth required — the token IS the auth. It's HMAC-signed
// server-side and cannot be forged without AOG_OFFER_SECRET.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyAogToken } from './_aog-token.js';
import { withCharterCopy } from './_email-signature.js';

export const config = { runtime: 'nodejs' };

let _adminApp = null;
function getAdmin() {
  if (_adminApp) return _adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  _adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(svc) });
  return _adminApp;
}

function fmtCurrency(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n));
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

async function sendNotifications(coverage, action, db) {
  // Load recipient list from aogConfig/settings
  const cfgSnap = await db.collection('aogConfig').doc('settings').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const opsRecipients = Array.isArray(cfg.opsRecipients) ? cfg.opsRecipients : [];
  const cfsRecipients = Array.isArray(cfg.cfsRecipients) ? cfg.cfsRecipients : [];
  const allRecipients = [...new Set([...opsRecipients, ...cfsRecipients])].filter(Boolean);
  if (allRecipients.length === 0) {
    console.warn('[aog-offer-respond] no notification recipients configured');
    return { sent: 0 };
  }

  const resendKey = process.env.RESEND_API_KEY;
  const fromAddr  = process.env.RESEND_FROM_ADDRESS;
  if (!resendKey || !fromAddr) return { sent: 0, warn: 'Resend not configured' };

  const isAccept = action === 'accept';
  const subject = isAccept
    ? `✓ AOG Coverage ACCEPTED — ${coverage.tail} ${coverage.routeFrom}→${coverage.routeTo} ${fmtDate(coverage.tripDate)} — ${fmtCurrency(coverage.coverageCost)}`
    : `✗ AOG Coverage DECLINED — ${coverage.tail} ${coverage.routeFrom}→${coverage.routeTo} ${fmtDate(coverage.tripDate)}`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a">
  <div style="display:inline-block;padding:4px 10px;background:${isAccept ? '#10b981' : '#64748b'};color:white;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;border-radius:3px;margin-bottom:16px">
    ${isAccept ? 'COVERAGE ACCEPTED' : 'COVERAGE DECLINED'}
  </div>

  <h1 style="font-size:18px;font-weight:600;margin:0 0 8px">${coverage.broker || 'Broker'}</h1>
  <p style="color:#64748b;margin:0 0 20px;font-size:14px">${coverage.brokerEmail}</p>

  <table style="width:100%;font-size:14px;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px">
    <tr><td style="padding:6px 12px;color:#64748b;width:35%">Aircraft</td><td style="padding:6px 12px;font-family:ui-monospace,monospace">${coverage.tail} (${coverage.class})</td></tr>
    <tr><td style="padding:6px 12px;color:#64748b">Route</td><td style="padding:6px 12px;font-family:ui-monospace,monospace">${coverage.routeFrom} → ${coverage.routeTo}</td></tr>
    <tr><td style="padding:6px 12px;color:#64748b">Trip Date</td><td style="padding:6px 12px">${fmtDate(coverage.tripDate)}</td></tr>
    <tr><td style="padding:6px 12px;color:#64748b">Trip Total</td><td style="padding:6px 12px">${fmtCurrency(coverage.tripTotal)}</td></tr>
    <tr><td style="padding:6px 12px;color:#64748b">Net (post-FET)</td><td style="padding:6px 12px">${fmtCurrency(coverage.netAmount)}</td></tr>
    <tr><td style="padding:6px 12px;color:#64748b">Coverage Rate</td><td style="padding:6px 12px">${(coverage.rate * 100).toFixed(2)}%</td></tr>
    ${isAccept ? `<tr><td style="padding:12px;color:#0f172a;font-weight:600;border-top:1px solid #e2e8f0">Coverage Cost</td><td style="padding:12px;color:#0ea5e9;font-weight:600;font-size:16px;border-top:1px solid #e2e8f0">${fmtCurrency(coverage.coverageCost)}</td></tr>` : ''}
  </table>

  ${isAccept ? `
  <div style="margin-top:24px;padding:16px;background:#fef3c7;border:1px solid #fbbf24;border-radius:6px">
    <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#92400e;font-weight:600;margin-bottom:8px">Action Required</div>
    <div style="font-size:14px;color:#0f172a;line-height:1.5">Add <strong>${fmtCurrency(coverage.coverageCost)}</strong> to the broker's JetInsight invoice for this trip.</div>
  </div>
  ` : ''}

  <p style="margin-top:24px;font-size:12px;color:#94a3b8">Coverage ID: <code>${coverage.id || ''}</code> · Responded ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>
</div>
`.trim();

  const text = `${isAccept ? 'ACCEPTED' : 'DECLINED'}: AOG Coverage — ${coverage.broker || 'Broker'} (${coverage.brokerEmail})
Aircraft: ${coverage.tail} (${coverage.class})
Route: ${coverage.routeFrom} → ${coverage.routeTo}
Date: ${fmtDate(coverage.tripDate)}
Trip Total: ${fmtCurrency(coverage.tripTotal)}
Net: ${fmtCurrency(coverage.netAmount)}
Coverage Rate: ${(coverage.rate * 100).toFixed(2)}%
${isAccept ? `Coverage Cost: ${fmtCurrency(coverage.coverageCost)}\n\nACTION REQUIRED: Add ${fmtCurrency(coverage.coverageCost)} to broker's JetInsight invoice.` : ''}
Coverage ID: ${coverage.id || ''}`;

  // Ops and charter flight support are configured recipients; the charter
  // inbox is copied so the accept/decline outcome is on record there too.
  const { to: notifyTo, cc: notifyCc } = withCharterCopy({ to: allRecipients });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddr,
        to: notifyTo,
        cc: notifyCc,
        subject,
        html,
        text,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('[aog-offer-respond] notification email failed:', r.status, t.slice(0, 300));
      return { sent: 0, error: `Resend ${r.status}` };
    }
    return { sent: notifyTo.length + notifyCc.length };
  } catch (e) {
    console.error('[aog-offer-respond] notification fetch failed:', e.message);
    return { sent: 0, error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }
  const token = String(body?.token || '').trim();
  const action = String(body?.action || '').trim().toLowerCase();
  const respondedByEmail = String(body?.respondedByEmail || '').trim().toLowerCase();

  if (!token) return res.status(400).json({ error: 'token required' });
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'action must be accept or decline' });

  const check = verifyAogToken(token);
  if (!check.ok) return res.status(401).json({ error: 'Token invalid: ' + check.reason });

  const db = getFirestore(getAdmin(), 'appusers');
  const ref = db.collection('aogCoverage').doc(check.coverageId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Coverage record not found' });

  const c = snap.data();

  // Idempotency — if already responded, return current state without re-notifying
  if (c.status === 'accepted' || c.status === 'declined') {
    return res.status(200).json({
      ok: true,
      alreadyResponded: true,
      status: c.status,
      trip: {
        tail: c.tail, class: c.class,
        routeFrom: c.routeFrom, routeTo: c.routeTo,
        tripDate: c.tripDate?.toDate?.() ?? c.tripDate,
        coverageCost: c.coverageCost,
      },
    });
  }

  // Update record
  const newStatus = action === 'accept' ? 'accepted' : 'declined';
  await ref.update({
    status: newStatus,
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    respondedByEmail: respondedByEmail || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Notifications — only on accept for the "add to invoice" alert; on
  // decline, still notify so ops has full audit trail
  const notif = await sendNotifications({ ...c, id: check.coverageId }, action, db);

  return res.status(200).json({
    ok: true,
    status: newStatus,
    notificationsSent: notif.sent,
    trip: {
      tail: c.tail, class: c.class,
      routeFrom: c.routeFrom, routeTo: c.routeTo,
      tripDate: c.tripDate?.toDate?.() ?? c.tripDate,
      coverageCost: c.coverageCost,
    },
  });
}
