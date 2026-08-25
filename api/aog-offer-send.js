// api/aog-offer-send.js
//
// Sends the broker an email with Accept / Decline links for AOG
// additional coverage. Updates the coverage doc to status='offered'
// and stores the offer token + sent timestamp.
//
// POST { coverageId }
//
// The coverage doc must already exist (created from the AOG tab
// when ops uploads the invoice).

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { signAogToken, AOG_TOKEN_TTL_MS } from './_aog-token.js';
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
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); } }
  const coverageId = String(body?.coverageId || '').trim();
  if (!coverageId) return res.status(400).json({ error: 'coverageId required' });

  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!baseUrl) return res.status(500).json({ error: 'PUBLIC_BASE_URL not configured' });
  const resendKey = process.env.RESEND_API_KEY;
  const fromAddr  = process.env.RESEND_FROM_ADDRESS;
  if (!resendKey || !fromAddr) return res.status(500).json({ error: 'Resend not configured' });

  const db = getFirestore(getAdmin(), 'appusers');
  const ref = db.collection('aogCoverage').doc(coverageId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Coverage record not found' });

  const c = snap.data();
  if (!c.brokerEmail) return res.status(400).json({ error: 'Coverage record missing brokerEmail' });
  if (c.status === 'accepted' || c.status === 'declined') {
    return res.status(400).json({ error: `Coverage already ${c.status}` });
  }

  const issuedAt = Date.now();
  const token = signAogToken(coverageId, issuedAt);
  const acceptUrl  = `${baseUrl.replace(/\/$/, '')}/aog-response.html?token=${encodeURIComponent(token)}&action=accept`;
  const declineUrl = `${baseUrl.replace(/\/$/, '')}/aog-response.html?token=${encodeURIComponent(token)}&action=decline`;
  const expiresAt  = issuedAt + AOG_TOKEN_TTL_MS;

  const subject = `AOG Additional Coverage Offer — ${c.tail} · ${c.routeFrom} → ${c.routeTo} · ${fmtDate(c.tripDate)}`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;color:#0f172a;background:#ffffff">
  <div style="border-bottom:2px solid #0ea5e9;padding-bottom:16px;margin-bottom:24px">
    <div style="font-size:11px;letter-spacing:0.15em;color:#64748b;text-transform:uppercase;font-family:ui-monospace,monospace">Skyway Aviation Services · Charter Flight Support</div>
    <h1 style="font-size:22px;font-weight:600;margin:8px 0 0;color:#0f172a">AOG Additional Coverage Offer</h1>
  </div>

  <p style="line-height:1.6;color:#334155;margin:0 0 20px">
    Your booked charter with Skyway Aviation is automatically covered up to <strong>50%</strong> of AOG (Aircraft on Ground) recovery cost through our JetSure / Charter Flight Support policy.
  </p>

  <p style="line-height:1.6;color:#334155;margin:0 0 20px">
    For an additional cost, you may elect to purchase the remaining <strong>50%</strong> of AOG coverage, bringing your protection to 100% of AOG recovery cost in the event Skyway's aircraft becomes unavailable due to a mechanical or operational issue.
  </p>

  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:24px 0">
    <div style="font-size:11px;letter-spacing:0.1em;color:#64748b;text-transform:uppercase;margin-bottom:12px">Trip Detail</div>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 0;color:#64748b;width:40%">Aircraft</td><td style="padding:4px 0;color:#0f172a;font-family:ui-monospace,monospace">${c.tail} (${c.class})</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Route</td><td style="padding:4px 0;color:#0f172a;font-family:ui-monospace,monospace">${c.routeFrom} → ${c.routeTo}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Trip Date</td><td style="padding:4px 0;color:#0f172a">${fmtDate(c.tripDate)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Trip Total</td><td style="padding:4px 0;color:#0f172a">${fmtCurrency(c.tripTotal)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Less FET</td><td style="padding:4px 0;color:#0f172a">−${fmtCurrency(c.fetAmount)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Net (basis for coverage)</td><td style="padding:4px 0;color:#0f172a">${fmtCurrency(c.netAmount)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Coverage rate (${c.class})</td><td style="padding:4px 0;color:#0f172a">${(c.rate * 100).toFixed(2)}%</td></tr>
    </table>
    <div style="border-top:1px solid #e2e8f0;margin-top:16px;padding-top:16px;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:11px;letter-spacing:0.1em;color:#64748b;text-transform:uppercase">Additional Coverage Cost</div>
      <div style="font-size:24px;font-weight:600;color:#0ea5e9">${fmtCurrency(c.coverageCost)}</div>
    </div>
  </div>

  <p style="line-height:1.6;color:#334155;margin:24px 0">
    If accepted, this amount will be added to your JetInsight invoice for this trip. Please review the terms below and select your response.
  </p>

  <div style="text-align:center;margin:32px 0">
    <a href="${acceptUrl}" style="display:inline-block;background:#0ea5e9;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;margin:0 8px">Accept Coverage — ${fmtCurrency(c.coverageCost)}</a>
    <a href="${declineUrl}" style="display:inline-block;background:transparent;color:#64748b;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:500;border:1px solid #cbd5e1;margin:0 8px">Decline</a>
  </div>

  <details style="margin-top:32px;font-size:13px;color:#475569">
    <summary style="cursor:pointer;font-weight:600;color:#0f172a;padding:8px 0">Terms and Conditions</summary>
    <div style="padding:12px 0;line-height:1.6">
      <p style="margin:0 0 12px">By accepting this offer, you agree that:</p>
      <ol style="margin:0 0 12px;padding-left:20px">
        <li style="margin-bottom:8px">The additional coverage amount shown above will be added to your JetInsight invoice for the referenced trip and is due per your existing payment terms with Skyway Aviation Services.</li>
        <li style="margin-bottom:8px">AOG coverage combines Skyway's standard 50% coverage with the additional 50% purchased hereunder for a total of up to 100% of documented AOG recovery cost.</li>
        <li style="margin-bottom:8px">Coverage applies only to AOG events on the referenced aircraft for the referenced trip. It does not extend to weather delays, ATC delays, passenger-caused delays, or trips not documented on file.</li>
        <li style="margin-bottom:8px">Recovery cost means the actual documented additional cost of arranging a replacement aircraft of equal or greater category to complete the trip.</li>
        <li style="margin-bottom:8px">Coverage is administered by Skyway Aviation Services through its JetSure / Charter Flight Support policy. Claims must be submitted within 30 days of the trip.</li>
      </ol>
      <p style="margin:0 0 12px;font-style:italic;color:#64748b">Full policy terms available on request from ops@flyskyway.com.</p>
    </div>
  </details>

  <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 16px">
  <p style="font-size:11px;color:#94a3b8;line-height:1.5;margin:0">
    This offer expires ${new Date(expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. Questions? Reply to this email or call Skyway Aviation Ops.
  </p>
</div>
`.trim();

  const text = `AOG Additional Coverage Offer

Skyway Aviation Services · Charter Flight Support

Trip: ${c.tail} (${c.class}) ${c.routeFrom} → ${c.routeTo} on ${fmtDate(c.tripDate)}
Trip Total: ${fmtCurrency(c.tripTotal)}
Less FET: -${fmtCurrency(c.fetAmount)}
Net: ${fmtCurrency(c.netAmount)}
Additional Coverage Cost (${(c.rate * 100).toFixed(2)}% of net): ${fmtCurrency(c.coverageCost)}

Accept:  ${acceptUrl}
Decline: ${declineUrl}

If accepted, this amount will be added to your JetInsight invoice for this trip.
Offer expires ${new Date(expiresAt).toLocaleDateString('en-US')}.`;

  // Coverage offers go to a broker, so the charter inbox is copied for the
  // same reason as every other broker-facing message: replies land somewhere
  // monitored, and there is a record of what the broker was quoted.
  const { to: offerTo, cc: offerCc } = withCharterCopy({ to: c.brokerEmail });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromAddr, to: offerTo, cc: offerCc, subject, html, text }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: `Resend ${r.status}: ${t.slice(0, 200)}` });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Email send failed: ' + e.message });
  }

  await ref.update({
    status: 'offered',
    offerToken: token,
    offerSentAt: admin.firestore.FieldValue.serverTimestamp(),
    offerExpiresAt: expiresAt,
    acceptUrl, declineUrl,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return res.status(200).json({ ok: true, sent: true, expiresAt, acceptUrl, declineUrl });
}
