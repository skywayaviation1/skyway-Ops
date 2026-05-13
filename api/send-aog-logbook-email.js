// Send an AOG maintenance logbook entry email — HTML body with logo + PDF
// attachment. Same auth pattern as send-email.js (idToken or internal secret).
//
// Body shape:
//   {
//     aog:        <full AOG record>,
//     entry:      <logbook entry being recorded>,
//     pdfBase64:  <base64 string of the PDF, no data: prefix>,
//     pdfFilename: <filename>,
//     idToken:    <Firebase idToken for frontend calls>
//   }

import admin from 'firebase-admin';

export const config = { runtime: 'nodejs' };

let adminApp = null;
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

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtmlBody(aog, entry) {
  const logoSrc = 'https://skyway-ops.vercel.app/skyway-logo-nav.png';
  const partsRows = (entry.partsReplaced || []).map(p =>
    `<li style="margin-bottom:4px"><strong>${escapeHtml(p.partNumber || '—')}</strong> — ${escapeHtml(p.description || '')}${p.serialOff ? ` · S/N off: ${escapeHtml(p.serialOff)}` : ''}${p.serialOn ? ` · S/N on: ${escapeHtml(p.serialOn)}` : ''}</li>`
  ).join('');

  const rtsBlock = entry.rtsApproved ? `
    <div style="border:1px solid #1a1a1a; padding:14px; margin:18px 0; background:#fafafa">
      <div style="font-weight:600; font-size:11px; letter-spacing:0.08em; color:#222; margin-bottom:6px">APPROVAL FOR RETURN TO SERVICE</div>
      <div style="font-size:13px; color:#222; line-height:1.5">
        I certify that this aircraft has been inspected/repaired and is approved for return to service with respect to the work performed.
      </div>
    </div>` : `
    <div style="font-size:12px; color:#a83232; font-style:italic; margin:14px 0">
      Work performed — aircraft NOT yet approved for return to service.
    </div>`;

  return `<!doctype html>
<html><body style="margin:0; padding:0; background:#f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
  <div style="max-width:680px; margin:0 auto; background:#ffffff; padding:32px 36px;">

    <!-- Header with logo -->
    <table style="width:100%; border-collapse:collapse;">
      <tr>
        <td style="vertical-align:top">
          <img src="${logoSrc}" alt="Skyway Aviation" style="height:36px; display:block" />
        </td>
        <td style="vertical-align:top; text-align:right">
          <div style="font-size:13px; font-weight:600; color:#222; letter-spacing:0.04em">MAINTENANCE LOGBOOK ENTRY</div>
          <div style="font-size:11px; color:#888; margin-top:2px">${escapeHtml(fmtDate(entry.timestamp))}</div>
          <div style="font-size:10px; color:#aaa; margin-top:2px; font-family:monospace">${escapeHtml(entry.id)}</div>
        </td>
      </tr>
    </table>

    <hr style="border:none; border-top:1px solid #e0e0e0; margin:20px 0">

    <!-- Aircraft block -->
    <div style="margin-bottom:18px">
      <div style="font-size:11px; font-weight:600; color:#555; letter-spacing:0.08em; margin-bottom:8px">AIRCRAFT</div>
      <table style="width:100%; font-size:13px; border-collapse:collapse">
        <tr>
          <td style="color:#888; padding:3px 0; width:130px">TAIL NUMBER:</td>
          <td style="color:#222; padding:3px 0; font-weight:500">${escapeHtml(aog.tail)}</td>
          <td style="color:#888; padding:3px 0; width:120px">TOTAL TIME:</td>
          <td style="color:#222; padding:3px 0">${escapeHtml(entry.aircraftTotalTime || '—')}</td>
        </tr>
        <tr>
          <td style="color:#888; padding:3px 0">LOCATION:</td>
          <td style="color:#222; padding:3px 0">${escapeHtml(aog.location)}${aog.fboName ? ' / ' + escapeHtml(aog.fboName) : ''}</td>
          <td style="color:#888; padding:3px 0">CYCLES:</td>
          <td style="color:#222; padding:3px 0">${escapeHtml(entry.aircraftCycles || '—')}</td>
        </tr>
        <tr>
          <td style="color:#888; padding:3px 0">AOG REPORTED:</td>
          <td colspan="3" style="color:#222; padding:3px 0">${escapeHtml(fmtDate(aog.reportedAt))}</td>
        </tr>
      </table>
    </div>

    <!-- Discrepancy -->
    <div style="margin-bottom:18px">
      <div style="font-size:11px; font-weight:600; color:#555; letter-spacing:0.08em; margin-bottom:6px">DISCREPANCY / REPORTED ISSUE</div>
      <div style="font-size:13px; color:#222; line-height:1.6">${escapeHtml(aog.issueDescription || '—')}</div>
    </div>

    <!-- Work performed -->
    <div style="margin-bottom:18px">
      <div style="font-size:11px; font-weight:600; color:#555; letter-spacing:0.08em; margin-bottom:6px">WORK PERFORMED</div>
      <div style="font-size:13px; color:#222; line-height:1.6; white-space:pre-wrap">${escapeHtml(entry.workPerformed || '—')}</div>
    </div>

    ${partsRows ? `
    <div style="margin-bottom:18px">
      <div style="font-size:11px; font-weight:600; color:#555; letter-spacing:0.08em; margin-bottom:6px">PARTS REPLACED</div>
      <ul style="font-size:13px; color:#222; line-height:1.6; padding-left:18px; margin:0">${partsRows}</ul>
    </div>` : ''}

    ${entry.inspectionPerformed ? `
    <div style="margin-bottom:18px">
      <div style="font-size:11px; font-weight:600; color:#555; letter-spacing:0.08em; margin-bottom:6px">INSPECTION PERFORMED</div>
      <div style="font-size:13px; color:#222; line-height:1.6; white-space:pre-wrap">${escapeHtml(entry.inspectionPerformed)}</div>
    </div>` : ''}

    ${rtsBlock}

    <!-- Signature block -->
    <div style="margin-top:24px; padding-top:18px; border-top:1px solid #e0e0e0">
      <div style="font-size:11px; font-weight:600; color:#555; letter-spacing:0.08em; margin-bottom:10px">TECHNICIAN</div>
      ${entry.signatureDataUrl
        ? `<img src="${entry.signatureDataUrl}" alt="Signature" style="display:block; max-width:200px; max-height:60px; margin-bottom:6px" />`
        : ''}
      <div style="border-top:1px solid #555; width:240px; padding-top:6px">
        <div style="font-size:13px; color:#222; font-weight:500">${escapeHtml(entry.technicianName || '—')}</div>
        <div style="font-size:11px; color:#666; margin-top:2px; font-family:monospace">${escapeHtml(entry.technicianCertType || 'CERT')}: ${escapeHtml(entry.technicianCertNumber || '—')}</div>
        <div style="font-size:11px; color:#888; margin-top:2px">Signed: ${escapeHtml(fmtDate(entry.signedAt))}</div>
      </div>
    </div>

    <!-- Footer -->
    <div style="margin-top:32px; padding-top:14px; border-top:1px solid #e0e0e0">
      <div style="font-size:10px; color:#999; font-style:italic; line-height:1.5">
        Skyway Aviation maintenance coordination record. This document is generated by the Skyway Ops platform for team coordination and broker communication.
        Official Part 43 / 91 / 135 maintenance records are maintained in Skyway Aviation's primary maintenance tracking system per OpSpecs.
      </div>
      <div style="font-size:10px; color:#aaa; margin-top:10px">
        See attached PDF for the complete record.
      </div>
    </div>
  </div>
</body></html>`;
}

function buildSubject(aog, entry) {
  const prefix = entry.rtsApproved ? '[RTS LOGBOOK]' : '[MAINTENANCE LOG]';
  return `${prefix} ${aog.tail} at ${aog.location} — ${(entry.workPerformed || '').slice(0, 60)}`;
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
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

  // Auth check — same as send-email
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const providedInternal = req.headers['x-internal-secret'];
  const isInternalCall = internalSecret && providedInternal === internalSecret;

  let isAuthorized = isInternalCall;
  let authFailReason = '';
  if (!isAuthorized) {
    if (!body.idToken) {
      authFailReason = 'no idToken and no internal secret';
    } else {
      try {
        const auth = admin.auth(getAdmin());
        await auth.verifyIdToken(body.idToken);
        isAuthorized = true;
      } catch (e) {
        authFailReason = `idToken verify failed: ${e.message}`;
      }
    }
  }
  if (!isAuthorized) {
    console.warn('[send-aog-logbook-email] unauthorized:', authFailReason);
    return res.status(401).json({ error: 'Unauthorized', reason: authFailReason });
  }

  const { aog, entry, pdfBase64, pdfFilename } = body;
  if (!aog || !entry) return res.status(400).json({ error: 'aog and entry required' });

  const recipients = Array.isArray(aog.recipients)
    ? aog.recipients.filter(e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))
    : [];
  if (recipients.length === 0) return res.status(400).json({ error: 'no valid recipients' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[send-aog-logbook-email] RESEND_API_KEY missing');
    return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  }

  const html = buildHtmlBody(aog, entry);
  const subject = buildSubject(aog, entry);

  const payload = {
    from: 'Skyway Ops <noreply@send.flyskyway.com>',
    to: recipients,
    subject: subject.slice(0, 200),
    html,
  };

  if (pdfBase64 && pdfFilename) {
    payload.attachments = [{
      filename: pdfFilename,
      content: pdfBase64,
    }];
  }

  try {
    const upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[send-aog-logbook-email] Resend error:', upstream.status, data);
      return res.status(upstream.status).json({ error: data.message || `Resend ${upstream.status}` });
    }
    console.log('[send-aog-logbook-email] Sent OK', data.id, 'to', recipients.join(','), 'rts:', !!entry.rtsApproved);
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[send-aog-logbook-email] error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
