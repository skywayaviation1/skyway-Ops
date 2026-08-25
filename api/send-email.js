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
import { applySkywaySignature, textToHtml, withCharterCopy } from './_email-signature.js';
import { explainSendFailure } from './_email-delivery.js';
import { deliverNotification } from './_email-transport.js';

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

  // No longer a hard stop: a message addressed only to mailboxes in the
  // operator's own tenant is delivered by Exchange and needs no provider key.
  // Anything bound for an outside recipient still fails, with the provider's
  // own error, further down.
  if (!process.env.RESEND_API_KEY) {
    console.warn('[send-email] RESEND_API_KEY missing from env — only tenant mailboxes can be reached');
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
    // Build a branded HTML body from the plain text caller passed us, and put
    // charters@flyskyway.com on the CC line so any reply (despite the
    // do-not-reply notice in the wrapper) lands in the company's monitored
    // inbox. Callers pass an ops constant that is this same address, so it also
    // has to come off the To line to actually appear as a CC.
    const html = applySkywaySignature(textToHtml(text));
    const { to: finalTo, cc: ccList } = withCharterCopy({ to: validRecipients });

    // Same routing as the queue path: mailboxes in the operator's own tenant
    // are delivered by Exchange, because provider mail from a subdomain of that
    // tenant's domain is filtered as spoofing before it reaches an inbox.
    const result = await deliverNotification({
      to: finalTo,
      cc: ccList,
      subject: String(subject).slice(0, 200),
      html,
    });

    if (!result.ok) {
      console.error('[send-email] delivery failed:', result.error);
      return res.status(502).json({
        error: result.error || 'Send failed',
        explanation: explainSendFailure(result.error),
      });
    }

    console.log('[send-email] Sent OK, id:', result.provider?.id || '-',
      'to:', finalTo.join(','), 'cc:', ccList.join(',') || '-',
      'tenant mailboxes:', result.internal?.ok ? 'sent by Exchange' : (result.internal?.skipped || '-'));
    return res.status(200).json({ ok: true, id: result.provider?.id || null });
  } catch (err) {
    console.error('[send-email] Network/timeout error:', err.message);
    return res.status(502).json({ error: `Send failed: ${err.message}` });
  }
}
