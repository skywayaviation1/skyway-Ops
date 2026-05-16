// Send AOG manual reference PDF(s) to selected recipients as email
// attachments.
//
// Same auth pattern as send-aog-email.js (idToken from frontend OR
// INTERNAL_API_SECRET for server-to-server). The PDFs are fetched from their
// Firebase Storage download URLs server-side and attached to a Resend email.
//
// Body:
//   {
//     aog:        { id, tail, location, fboName, ... },   // for subject/body
//     docs:       [{ id, filename, url }],                 // references to send
//     recipients: ["tech@example.com", ...],               // chosen at send time
//     note:       "optional free-text message to the tech",
//     idToken:    <Firebase idToken>
//   }
//
// IMPORTANT: these are COORDINATION copies, not official 14 CFR Part 43
// maintenance records. The email body says so explicitly.

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTACH_BYTES = 18 * 1024 * 1024;        // per-file safety ceiling
const MAX_TOTAL_BYTES = 35 * 1024 * 1024;         // Resend/most inboxes choke past ~40MB

function fmtTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return String(ts);
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
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }

  // ---- Auth: internal secret OR verified Firebase idToken ----
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const providedInternal = req.headers['x-internal-secret'];
  let authed = false;
  let authFailReason = '';
  if (internalSecret && providedInternal && providedInternal === internalSecret) {
    authed = true;
  } else if (!body.idToken) {
    authFailReason = 'no idToken and no internal secret';
  } else {
    try {
      const auth = getAdmin().auth();
      await auth.verifyIdToken(body.idToken);
      authed = true;
    } catch (e) {
      authFailReason = `idToken verify failed: ${e.message}`;
    }
  }
  if (!authed) {
    return res.status(401).json({ error: 'Unauthorized', reason: authFailReason });
  }

  // ---- Validate payload ----
  const aog = body.aog;
  if (!aog || typeof aog !== 'object' || !aog.tail) {
    return res.status(400).json({ error: 'aog object with tail required' });
  }

  const docs = Array.isArray(body.docs) ? body.docs : [];
  if (docs.length === 0) {
    return res.status(400).json({ error: 'at least one document required' });
  }
  for (const d of docs) {
    if (!d || !d.url || !d.filename) {
      return res.status(400).json({ error: 'each doc needs url and filename' });
    }
  }

  const recipients = (Array.isArray(body.recipients) ? body.recipients : [])
    .map(e => String(e || '').trim())
    .filter(e => EMAIL_RE.test(e));
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'no valid recipients' });
  }

  const note = String(body.note || '').slice(0, 4000);

  // ---- Fetch PDFs from Firebase Storage download URLs ----
  const attachments = [];
  let totalBytes = 0;
  for (const d of docs) {
    let r;
    try {
      r = await fetch(d.url);
    } catch (e) {
      return res.status(502).json({ error: `Failed to fetch ${d.filename}: ${e.message}` });
    }
    if (!r.ok) {
      return res.status(502).json({ error: `Storage returned ${r.status} for ${d.filename}` });
    }
    const arrayBuf = await r.arrayBuffer();
    const bytes = arrayBuf.byteLength;
    if (bytes > MAX_ATTACH_BYTES) {
      return res.status(413).json({ error: `${d.filename} exceeds per-file size limit` });
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: 'Combined attachment size too large — send fewer documents per email' });
    }
    const b64 = Buffer.from(arrayBuf).toString('base64');
    const safeName = String(d.filename).toLowerCase().endsWith('.pdf')
      ? d.filename
      : `${d.filename}.pdf`;
    attachments.push({ filename: safeName, content: b64 });
  }

  // ---- Build email ----
  const subject = `[AOG REFERENCE] ${aog.tail} at ${aog.location || '—'} — ${docs.length} document${docs.length === 1 ? '' : 's'}`;

  const lines = [];
  lines.push(`Manual reference documents for the AOG event on ${aog.tail}.`);
  lines.push('');
  lines.push(`Aircraft: ${aog.tail}`);
  lines.push(`Location: ${aog.location || '—'}${aog.fboName ? ' / ' + aog.fboName : ''}`);
  if (aog.issueDescription) lines.push(`Issue: ${aog.issueDescription}`);
  lines.push(`Sent: ${fmtTime(Date.now())}`);
  lines.push('');
  lines.push(`Attached (${attachments.length}):`);
  for (const a of attachments) lines.push(`  • ${a.filename}`);
  if (note) {
    lines.push('');
    lines.push('NOTE FROM OPS:');
    lines.push(note);
  }
  lines.push('');
  lines.push('------------------------------------------------------------');
  lines.push('These are coordination/reference copies provided to support');
  lines.push('the AOG response. They are NOT official 14 CFR Part 43/91/135');
  lines.push("maintenance records. Official records are maintained in Skyway");
  lines.push("Aviation's primary maintenance tracking system per OpSpecs.");
  lines.push('');
  lines.push('— Skyway Aviation');
  lines.push('Private Jet & Helicopter Charter Services');

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
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
        text: lines.join('\n').slice(0, 20000),
        attachments,
      }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[send-aog-references] Resend error:', upstream.status, data);
      return res.status(upstream.status).json({ error: data.message || `Resend ${upstream.status}` });
    }
    console.log('[send-aog-references] Sent OK', data.id, 'to', recipients.join(','), `${attachments.length} attachment(s)`);
    return res.status(200).json({ ok: true, id: data.id, sentTo: recipients, count: attachments.length });
  } catch (err) {
    console.error('[send-aog-references] error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
