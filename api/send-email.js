// Vercel serverless function: send transactional email via Resend.
//
// Called by:
//   - Frontend (with Firebase idToken) — for status notifications, ETA updates, etc.
//   - Backend webhook handler (with INTERNAL_API_SECRET) — for FA auto-fire emails
//   - Backend cron poll (with INTERNAL_API_SECRET) — for FA auto-fire emails
//
// Auth: requires EITHER a valid Firebase idToken (frontend) OR the
// INTERNAL_API_SECRET header (server-to-server). Without one of these,
// returns 401. This prevents abuse of the Resend account by random callers.
//
// Body shape:
//   { to: ['ops@example.com', 'broker@example.com'], subject: '...', text: '...',
//     idToken?: '...' (frontend), }
// Header:
//   x-internal-secret: <INTERNAL_API_SECRET> (server-to-server)

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

export default async function handler(req, res) {
  // CORS — needed for the frontend to call us from skyway-ops.vercel.app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-internal-secret');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[send-email] RESEND_API_KEY missing from env');
    return res.status(500).json({ error: 'RESEND_API_KEY not configured on server' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // === Auth check — accept EITHER a valid Firebase idToken OR the internal secret ===
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const providedInternal = req.headers['x-internal-secret'];
  const isInternalCall = internalSecret && providedInternal === internalSecret;

  let isAuthorized = isInternalCall;
  let authFailReason = '';

  if (!isAuthorized) {
    if (!body.idToken) {
      authFailReason = 'no idToken in body and no internal secret in headers';
    } else {
      try {
        const auth = admin.auth(getAdmin());
        await auth.verifyIdToken(body.idToken);
        isAuthorized = true;
      } catch (e) {
        authFailReason = `idToken verify failed: ${e.code || ''} ${e.message || e}`;
      }
    }
  }

  if (!isAuthorized) {
    console.warn('[send-email] unauthorized:', authFailReason,
      '· hasInternalSecret:', !!providedInternal,
      '· hasIdToken:', !!body.idToken,
      '· hasFirebaseEnv:', !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
      '· hasInternalSecretEnv:', !!process.env.INTERNAL_API_SECRET);
    return res.status(401).json({ error: 'Unauthorized', reason: authFailReason });
  }

  const { to, subject, text } = body;
  if (!Array.isArray(to) || to.length === 0 || !subject || !text) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, text' });
  }

  const validRecipients = to.filter(
    (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
  );
  if (validRecipients.length === 0) {
    return res.status(400).json({ error: 'No valid recipient email addresses' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Skyway Ops <noreply@send.flyskyway.com>',
        to: validRecipients,
        subject: String(subject).slice(0, 200),
        text: String(text).slice(0, 10000),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      console.error('[send-email] Resend upstream error:', upstream.status, data);
      return res.status(upstream.status).json({
        error: data.message || `Resend returned ${upstream.status}`,
        details: data,
      });
    }

    console.log('[send-email] Sent OK, id:', data.id, 'to:', validRecipients.join(','));
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[send-email] Network/timeout error:', err.message);
    return res.status(502).json({ error: `Send failed: ${err.message}` });
  }
}
