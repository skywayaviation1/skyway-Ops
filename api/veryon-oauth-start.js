// api/veryon-oauth-start.js
//
// Begins the Veryon Tracking OAuth2 flow (authorizationCode + PKCE).
//
// Mirrors the proven QuickBooks pattern (api/quickbooks-oauth-start.js):
//   1. Client (maint/admin Settings panel) POSTs here with Firebase ID token
//   2. We verify the token + check maint/admin role
//   3. We generate PKCE (code_verifier/code_challenge) + a CSRF `state`
//      token, and store BOTH server-side in Firestore (the callback needs
//      the verifier to complete the token exchange — it must never touch
//      the browser)
//   4. We return the Veryon authorize URL; client redirects to it
//   5. User signs in to Veryon, Veryon redirects to
//      /api/veryon-oauth-callback with code + state
//
// Veryon app:  Veryon Tracking - Maintenance OpenAPI Client
//   Authorize: https://auth.flightdocs.com/oauth2/authorize
//   Token:     https://auth.flightdocs.com/connect/token
//   Flow:      authorizationCode with PKCE
//
// ENV (Vercel):
//   VERYON_CLIENT_ID      — the OAuth client_id
//   VERYON_REDIRECT_URI   — MUST exactly match the redirect URI registered
//                           with Veryon for this client_id. Planned value:
//                           https://www.skyway.app/api/veryon-oauth-callback
//   VERYON_SCOPE          — space-delimited scopes (set once known from
//                           Veryon; left configurable, not guessed)
//   FIREBASE_SERVICE_ACCOUNT_JSON — existing

import admin from 'firebase-admin';
import crypto from 'crypto';

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

let cachedDb = null;
function getDb() {
  if (cachedDb) return cachedDb;
  getAdmin();
  const { getFirestore } = require('firebase-admin/firestore');
  cachedDb = getFirestore(admin.app(), 'appusers');
  return cachedDb;
}

const VERYON_AUTHORIZE_URL = 'https://auth.flightdocs.com/oauth2/authorize';

// RFC 7636 PKCE: verifier = 43-128 char unreserved; challenge = BASE64URL(
// SHA256(verifier)). base64url = base64 with +/= -> -_ and no padding.
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function makePkce() {
  const code_verifier = b64url(crypto.randomBytes(48)); // 64 chars, in-range
  const code_challenge = b64url(crypto.createHash('sha256').update(code_verifier).digest());
  return { code_verifier, code_challenge, code_challenge_method: 'S256' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    getAdmin();

    const { idToken } = req.body || {};
    if (!idToken) { res.status(400).json({ error: 'idToken required' }); return; }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      res.status(401).json({ error: 'Invalid token: ' + err.message });
      return;
    }

    const db = getDb();
    const profileSnap = await db.collection('users').doc(decoded.uid).get();
    if (!profileSnap.exists) { res.status(403).json({ error: 'No profile found' }); return; }
    const role = profileSnap.data().role;
    if (!['maint', 'admin'].includes(role)) {
      res.status(403).json({ error: 'maint or admin role required' });
      return;
    }

    const clientId = process.env.VERYON_CLIENT_ID;
    const redirectUri = process.env.VERYON_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      res.status(500).json({ error: 'VERYON_CLIENT_ID or VERYON_REDIRECT_URI not configured' });
      return;
    }
    // Scope is intentionally NOT hardcoded/guessed — set VERYON_SCOPE in env
    // once confirmed from Veryon. offline_access is required for a refresh
    // token (unattended server refresh); included as a sensible default that
    // can be overridden entirely by VERYON_SCOPE.
    const scope = process.env.VERYON_SCOPE || 'openid offline_access';

    const { code_verifier, code_challenge, code_challenge_method } = makePkce();
    const state = crypto.randomBytes(24).toString('hex');

    await db.collection('veryon-oauth-state').doc(state).set({
      uid: decoded.uid,
      codeVerifier: code_verifier,           // server-side only
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
      code_challenge,
      code_challenge_method,
    });
    res.status(200).json({ authUrl: `${VERYON_AUTHORIZE_URL}?${params.toString()}` });
  } catch (err) {
    console.error('[veryon-oauth-start] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
