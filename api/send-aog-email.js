// Send an AOG (Aircraft On Ground) status email.
//
// Uses the same auth pattern as send-email.js (idToken from frontend OR
// INTERNAL_API_SECRET for server-to-server). Generates a formatted plain-text
// email from the AOG record and calls Resend.
//
// Body:
//   { aog: <full AOG record>, eventType: 'declared'|'rts_changed'|'resolved'|'manual_update',
//     idToken: <Firebase idToken> }

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


function detectCarrierServer(trackingNumber) {
  if (!trackingNumber) return null;
  const clean = String(trackingNumber).replace(/[\s-]/g, '').toUpperCase();
  if (/^1Z[A-Z0-9]{16}$/.test(clean)) return 'UPS';
  if (/^\d{12}$/.test(clean)) return 'FedEx';
  if (/^\d{14}$/.test(clean)) return 'FedEx';
  if (/^\d{15}$/.test(clean)) return 'FedEx';
  if (/^\d{20}$/.test(clean)) return 'FedEx';
  if (/^\d{22}$/.test(clean)) return 'FedEx';
  return null;
}

function buildTrackingUrlServer(carrier, trackingNumber) {
  if (!carrier || !trackingNumber) return null;
  const clean = String(trackingNumber).replace(/[\s-]/g, '');
  if (carrier === 'UPS') return `https://www.ups.com/track?tracknum=${encodeURIComponent(clean)}`;
  if (carrier === 'FedEx') return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(clean)}`;
  return null;
}

function fmtTime(ts) {
  if (!ts) return '—';
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return String(ts);
  }
}

function buildAogEmail(aog, eventType) {
  const subjectPrefix = eventType === 'declared' ? '[AOG DECLARED]'
                      : eventType === 'rts_changed' ? '[AOG RTS UPDATE]'
                      : eventType === 'resolved' ? '[AOG RESOLVED]'
                      : '[AOG UPDATE]';

  const subject = `${subjectPrefix} ${aog.tail} at ${aog.location}${aog.rtsEstimate ? ` — RTS ${aog.rtsEstimate}` : ''}`;

  const parts = aog.parts && aog.parts.length > 0
    ? aog.parts.map(p => {
        const cols = [
          p.partNumber || '—',
          p.description || '—',
          p.status || '—',
          p.eta || '—',
          p.shipMethod || '—',
        ];
        let line = `  • ${cols.join(' | ')}`;
        if (p.trackingNumber) {
          const carrier = detectCarrierServer(p.trackingNumber);
          const url = buildTrackingUrlServer(carrier, p.trackingNumber);
          line += `\n    Tracking: ${p.trackingNumber}` +
                  (carrier ? ` (${carrier})` : '') +
                  (url ? ` — ${url}` : '');
        }
        return line;
      }).join('\n')
    : '  (none recorded)';

  const openItems = aog.openItems && aog.openItems.length > 0
    ? aog.openItems.map(i => `  • ${i}`).join('\n')
    : '  (none)';

  const lines = [];
  lines.push(`Aircraft: ${aog.tail}`);
  lines.push(`Location: ${aog.location}${aog.fboName ? ' / ' + aog.fboName : ''}`);
  lines.push(`Issue Reported: ${aog.issueDescription || '—'}`);
  lines.push(`Date/Time Reported: ${fmtTime(aog.reportedAt)}`);
  lines.push(`Current Aircraft Status: ${aog.status === 'resolved' ? 'RETURNED TO SERVICE' : 'AOG'}`);
  lines.push('');
  lines.push('AOG COORDINATION TEAM');
  lines.push(`  Maintenance Lead: ${aog.coordination?.maintLead || '—'}`);
  lines.push(`  Technician Assigned: ${aog.coordination?.technician || '—'}`);
  lines.push(`  Vendor/OEM Contact: ${aog.coordination?.vendor || '—'}`);
  lines.push(`  Operations Contact: ${aog.coordination?.opsContact || '—'}`);
  lines.push('');
  lines.push('INITIAL DIAGNOSTICS');
  lines.push(`  Pilot Discrepancy: ${aog.diagnostics?.pilotDiscrepancy || '—'}`);
  lines.push(`  Troubleshooting Completed: ${aog.diagnostics?.troubleshooting || '—'}`);
  lines.push(`  Vendor/OEM Recommendations: ${aog.diagnostics?.oemRecommendation || '—'}`);
  lines.push('');
  lines.push('PARTS STATUS');
  lines.push('  Part # | Description | Status | ETA | Ship Method');
  lines.push(parts);
  lines.push('');
  lines.push(`Parts Shipping Address:`);
  lines.push(`  ${aog.shipTo?.fboName || aog.fboName || '—'}`);
  lines.push(`  ${aog.shipTo?.address || '—'}`);
  if (aog.shipTo?.attn) lines.push(`  ATTN: ${aog.shipTo.attn}`);
  lines.push('');
  lines.push('PERSONNEL LOGISTICS');
  lines.push(`  Technician Departure Time: ${aog.personnel?.techDeparture || '—'}`);
  lines.push(`  Technician Arrival ETA: ${aog.personnel?.techArrivalEta || '—'}`);
  lines.push(`  Transportation Arranged: ${aog.personnel?.transport || '—'}`);
  lines.push('');
  lines.push('CURRENT STATUS UPDATE');
  lines.push(`  ${aog.currentStatus || '(no update recorded yet)'}`);
  lines.push('');
  lines.push('ESTIMATED RETURN TO SERVICE (RTS)');
  lines.push(`  ${aog.rtsEstimate || 'TBD'}`);
  if (eventType === 'rts_changed' && aog.rtsEstimatePrevious) {
    lines.push(`  (previous: ${aog.rtsEstimatePrevious})`);
  }
  lines.push('');
  lines.push('OPEN ITEMS / DELAYS');
  lines.push(openItems);
  lines.push('');
  lines.push('NEXT UPDATE EXPECTED');
  lines.push(`  ${aog.nextUpdateDue || 'TBD'}`);
  lines.push('');
  lines.push('Please reply-all with any updates so the entire team remains aligned throughout the AOG event.');
  lines.push('');
  lines.push('— Skyway Aviation');
  lines.push('Private Jet & Helicopter Charter Services');

  return { subject, text: lines.join('\n') };
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
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }

  // Auth check — same pattern as send-email.js
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
    console.warn('[send-aog-email] unauthorized:', authFailReason);
    return res.status(401).json({ error: 'Unauthorized', reason: authFailReason });
  }

  const { aog, eventType } = body;
  if (!aog || typeof aog !== 'object') {
    return res.status(400).json({ error: 'aog object required' });
  }
  if (!eventType || !['declared', 'rts_changed', 'resolved', 'manual_update'].includes(eventType)) {
    return res.status(400).json({ error: 'invalid eventType' });
  }

  const recipients = Array.isArray(aog.recipients)
    ? aog.recipients.filter(e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))
    : [];
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'no valid recipients' });
  }

  const { subject, text } = buildAogEmail(aog, eventType);

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[send-aog-email] RESEND_API_KEY missing');
    return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  }

  try {
    const upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skyway Ops <noreply@send.flyskyway.com>',
        to: recipients,
        subject: subject.slice(0, 200),
        text: text.slice(0, 20000),
      }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[send-aog-email] Resend error:', upstream.status, data);
      return res.status(upstream.status).json({ error: data.message || `Resend ${upstream.status}` });
    }
    console.log('[send-aog-email] Sent OK', data.id, 'to', recipients.join(','), 'eventType:', eventType);
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[send-aog-email] error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
