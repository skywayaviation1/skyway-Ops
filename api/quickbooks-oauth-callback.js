// api/quickbooks-oauth-callback.js
//
// Intuit redirects users back here after they authorize on Intuit's site.
// Query string contains:
//   - code         : authorization code, exchanged for access + refresh tokens
//   - state        : the CSRF token we generated in /api/quickbooks-oauth-start
//   - realmId      : the QBO company ID they connected
//   - error        : present only on user-deny (e.g. "access_denied")
//
// Flow:
//   1. Validate state token (lookup in Firestore, check not expired)
//   2. Exchange code for tokens (POST to Intuit token endpoint)
//   3. Fetch company info to get a display name
//   4. Write everything to quickbooks/connection
//   5. Delete the used state token
//   6. Redirect back to the app's settings (with a success/error param)

import { getDb, qboApiBase, qboEnvironment } from './_quickbooks.js';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// Where to send the user after we're done. Must match the deployed app URL.
function buildAppRedirect(success, message) {
  // Use the deployed app URL; fallback to relative if env var not set
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.skyway.app';
  const params = new URLSearchParams({
    qbo: success ? 'connected' : 'error',
    msg: message || '',
  });
  params.set('section', 'accounting');
  return `${appUrl}/?${params.toString()}#accounting`;
}

export default async function handler(req, res) {
  try {
    const db = getDb();

    const { code, state, realmId, error: oauthError, error_description } = req.query;

    // User denied or Intuit returned an error
    if (oauthError) {
      const msg = error_description || oauthError;
      console.warn('[qbo-callback] user denied / Intuit error:', oauthError, msg);
      res.redirect(302, buildAppRedirect(false, `Authorization denied: ${msg}`));
      return;
    }

    if (!code || !state || !realmId) {
      res.redirect(302, buildAppRedirect(false, 'Missing code, state, or realmId'));
      return;
    }

    // === Validate state token ===
    const stateRef = db.collection('quickbooks-oauth-state').doc(state);
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

    // === Get the user's profile for the connectedByName field ===
    let connectedByName = '';
    try {
      const profile = await db.collection('users').doc(uid).get();
      if (profile.exists) connectedByName = profile.data().name || '';
    } catch (_) { /* non-fatal */ }

    // === Exchange code for tokens ===
    const clientId = process.env.INTUIT_CLIENT_ID;
    const clientSecret = process.env.INTUIT_CLIENT_SECRET;
    const redirectUri = process.env.INTUIT_REDIRECT_URI;
    const env = qboEnvironment();
    if (!clientId || !clientSecret || !redirectUri) {
      res.redirect(302, buildAppRedirect(false, 'Server not configured (missing Intuit env vars)'));
      return;
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: tokenBody.toString(),
    });
    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('[qbo-callback] token exchange failed:', tokenResp.status, tokenData);
      res.redirect(302, buildAppRedirect(false, `Token exchange failed: ${tokenData.error || tokenResp.status}`));
      return;
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const accessTokenExpiresIn = Number(tokenData.expires_in) || 3600;          // seconds
    const refreshTokenExpiresIn = Number(tokenData.x_refresh_token_expires_in) || (100 * 24 * 3600);

    const now = Date.now();
    const accessTokenExpiresAt = now + accessTokenExpiresIn * 1000;
    const refreshTokenExpiresAt = now + refreshTokenExpiresIn * 1000;

    // === Fetch company name for display ===
    let companyName = '';
    try {
      const apiBase = qboApiBase(env);
      const companyResp = await fetch(
        `${apiBase}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=70`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      const companyData = await companyResp.json().catch(() => ({}));
      if (companyResp.ok && companyData?.CompanyInfo) {
        companyName = companyData.CompanyInfo.CompanyName ||
                      companyData.CompanyInfo.LegalName || '';
      } else {
        console.warn('[qbo-callback] companyinfo fetch failed:', companyResp.status, companyData);
      }
    } catch (err) {
      console.warn('[qbo-callback] companyinfo fetch threw:', err.message);
    }

    // === Save connection ===
    await db.collection('quickbooks').doc('connection').set({
      realmId,
      companyName,
      environment: env,
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      connectedBy: uid,
      connectedByName,
      connectedAt: now,
      lastRefreshedAt: now,
    });

    // Cleanup state token
    await stateRef.delete().catch(() => {});

    res.redirect(302, buildAppRedirect(true, companyName || 'Connected'));
  } catch (err) {
    console.error('[qbo-callback] unexpected error:', err);
    res.redirect(302, buildAppRedirect(false, err.message || 'Server error'));
  }
}
