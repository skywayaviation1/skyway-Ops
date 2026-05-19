// api/veryon-oauth-callback.js
//
// Veryon redirects the user back here after they authorize. Query string:
//   - code   : authorization code -> exchanged for access + refresh tokens
//   - state  : the CSRF token from /api/veryon-oauth-start (also holds the
//              PKCE code_verifier server-side)
//   - error  : present on user-deny
//
// Mirrors api/quickbooks-oauth-callback.js. Differences, both certain:
//   * PKCE: the token exchange sends code_verifier (from the state doc —
//     it must never round-trip through the browser). NO client_secret
//     (PKCE public client).
//   * Connection stored at veryon/connection (named DB `appusers`),
//     mirroring quickbooks/connection.
//
// Token URL: https://auth.flightdocs.com/connect/token
//
// NOTE: the token endpoint's exact response field names are standard OAuth2
// (access_token, refresh_token, expires_in). If Veryon returns extra fields
// (e.g. a non-standard refresh-expiry), they are captured defensively but
// the refresh-lifetime default is conservative and must be confirmed.

import admin from 'firebase-admin';

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

const TOKEN_URL = 'https://auth.flightdocs.com/connect/token';

function buildAppRedirect(success, message) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://skyway-ops.vercel.app';
  const params = new URLSearchParams({
    veryon: success ? 'connected' : 'error',
    msg: message || '',
  });
  return `${appUrl}/?${params.toString()}#settings`;
}

export default async function handler(req, res) {
  try {
    getAdmin();
    const db = getDb();

    const { code, state, error: oauthError, error_description } = req.query;

    if (oauthError) {
      const msg = error_description || oauthError;
      console.warn('[veryon-callback] user denied / error:', oauthError, msg);
      res.redirect(302, buildAppRedirect(false, `Authorization denied: ${msg}`));
      return;
    }
    if (!code || !state) {
      res.redirect(302, buildAppRedirect(false, 'Missing code or state'));
      return;
    }

    // === Validate state + recover PKCE verifier (server-side only) ===
    const stateRef = db.collection('veryon-oauth-state').doc(state);
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) {
      res.redirect(302, buildAppRedirect(false, 'Invalid or expired state token'));
      return;
    }
    const stateData = stateSnap.data();
    if (Date.now() > stateData.expiresAt) {
      await stateRef.delete().catch(() => {});
      res.redirect(302, buildAppRedirect(false, 'State token expired — try again'));
      return;
    }
    const uid = stateData.uid;
    const codeVerifier = stateData.codeVerifier;
    if (!codeVerifier) {
      res.redirect(302, buildAppRedirect(false, 'Missing PKCE verifier — restart the connection'));
      return;
    }

    let connectedByName = '';
    try {
      const profile = await db.collection('users').doc(uid).get();
      if (profile.exists) connectedByName = profile.data().name || '';
    } catch (_) { /* non-fatal */ }

    const clientId = process.env.VERYON_CLIENT_ID;
    const redirectUri = process.env.VERYON_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      res.redirect(302, buildAppRedirect(false, 'Server not configured (missing Veryon env vars)'));
      return;
    }

    // === Exchange code for tokens (PKCE; no client_secret) ===
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });

    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenBody.toString(),
    });
    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('[veryon-callback] token exchange failed:', tokenResp.status, tokenData);
      res.redirect(302, buildAppRedirect(false,
        `Token exchange failed: ${tokenData.error || tokenResp.status}`));
      return;
    }

    const now = Date.now();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const accessTokenExpiresIn = Number(tokenData.expires_in) || 3600; // seconds
    const accessTokenExpiresAt = now + accessTokenExpiresIn * 1000;
    // Refresh lifetime: Veryon may not return one. Conservative default;
    // refresh logic also treats refresh failure as "reconnect required",
    // so an over-long default cannot cause silent bad writes.
    const refreshTokenExpiresAt = now + (Number(tokenData.refresh_expires_in) || (60 * 24 * 3600)) * 1000;

    await db.collection('veryon').doc('connection').set({
      provider: 'veryon-tracking',
      tokenUrl: TOKEN_URL,
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      scope: tokenData.scope || (process.env.VERYON_SCOPE || ''),
      connectedBy: uid,
      connectedByName,
      connectedAt: now,
      lastRefreshedAt: now,
      // Write path stays disabled until validated, regardless of connection.
      writeEnabled: false,
    });

    await stateRef.delete().catch(() => {});
    res.redirect(302, buildAppRedirect(true, 'Veryon connected'));
  } catch (err) {
    console.error('[veryon-callback] unexpected error:', err);
    res.redirect(302, buildAppRedirect(false, err.message || 'Server error'));
  }
}
