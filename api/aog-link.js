// AUTHENTICATED endpoint — Skyway staff only. Mints or revokes the external
// maintenance link for an AOG.
//
// Body:
//   { action: 'mint'|'revoke', aogId, idToken }
//
// mint   → stamps AOG.linkTokenIssuedAt = now, clears linkRevoked, returns
//          a freshly-signed token + full URL. Re-minting rotates the token
//          (older links stop working because their issuedAt < new stamp).
// revoke → sets AOG.linkRevoked = true. All existing links die immediately.
//
// Auth: Firebase idToken (same pattern as send-aog-email.js). The signing
// secret never leaves the server.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { signAogToken } from './_aog-token.js';

export const config = { runtime: 'nodejs' };

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

  // Auth: internal secret OR verified Firebase idToken
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const providedInternal = req.headers['x-internal-secret'];
  let authed = false;
  if (internalSecret && providedInternal && providedInternal === internalSecret) {
    authed = true;
  } else if (body.idToken) {
    try {
      await getAdmin().auth().verifyIdToken(body.idToken);
      authed = true;
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized', reason: e.message });
    }
  }
  if (!authed) return res.status(401).json({ error: 'Unauthorized' });

  const aogId = String(body.aogId || '').trim();
  const action = String(body.action || '').trim();
  if (!aogId) return res.status(400).json({ error: 'aogId required' });

  const ref = getDb().collection('aog-events').doc(aogId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'AOG not found' });

  // Pre-flight: surface the most common misconfig with a clear message
  // instead of a generic 500 from deep inside signAogToken().
  if (action === 'mint') {
    const secret = process.env.AOG_LINK_SECRET;
    if (!secret || secret.length < 16) {
      return res.status(500).json({
        error: 'AOG_LINK_SECRET not configured',
        detail: 'Set the AOG_LINK_SECRET environment variable in Vercel (min 16 characters), then redeploy.',
      });
    }
  }

  try {
    if (action === 'mint') {
      const issuedAt = Date.now();
      await ref.update({
        linkTokenIssuedAt: issuedAt,
        linkRevoked: false,
        updatedAt: Date.now(),
      });
      const token = signAogToken(aogId, issuedAt);
      // Build absolute URL from the request origin
      const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
      const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
      const url = `${proto}://${host}/aog-tech?token=${encodeURIComponent(token)}`;
      return res.status(200).json({ ok: true, token, url, issuedAt });
    }

    if (action === 'revoke') {
      await ref.update({ linkRevoked: true, updatedAt: Date.now() });
      return res.status(200).json({ ok: true, revoked: true });
    }

    if (action === 'set-logbook') {
      const enabled = body.enabled === true;
      await ref.update({ externalLogbookEnabled: enabled, updatedAt: Date.now() });
      return res.status(200).json({ ok: true, externalLogbookEnabled: enabled });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[aog-link] error:', err && err.message, err && err.stack);
    // Return the real message so the UI can show something actionable.
    return res.status(500).json({
      error: 'Server error',
      detail: (err && err.message) ? String(err.message).slice(0, 300) : 'unknown',
    });
  }
}
