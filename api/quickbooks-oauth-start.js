// api/quickbooks-oauth-start.js
//
// Begins the QuickBooks OAuth flow.
//
// Flow:
//   1. Client (admin Settings panel) POSTs here with their Firebase ID token
//   2. We verify the token + check the admin role
//   3. We generate a `state` token (random + admin uid + timestamp), store it
//      briefly in Firestore so the callback can verify it
//   4. We return the full Intuit auth URL with our client_id, redirect_uri,
//      scope, and state
//   5. Client redirects window.location to that URL
//   6. Admin authorizes on Intuit's site
//   7. Intuit redirects to /api/quickbooks-oauth-callback with code + state

import admin from 'firebase-admin';
import crypto from 'crypto';

// Singleton Admin SDK init — same pattern as /api/delete-user
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

const INTUIT_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const SCOPE = 'com.intuit.quickbooks.accounting';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    getAdmin();

    const { idToken } = req.body || {};
    if (!idToken) {
      res.status(400).json({ error: 'idToken required' });
      return;
    }

    // Verify the caller is signed in
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      res.status(401).json({ error: 'Invalid token: ' + err.message });
      return;
    }

    // Check admin role from Firestore profile
    const profileSnap = await admin.firestore().collection('users').doc(decoded.uid).get();
    if (!profileSnap.exists) {
      res.status(403).json({ error: 'No profile found' });
      return;
    }
    const profile = profileSnap.data();
    if (profile.role !== 'admin') {
      res.status(403).json({ error: 'Admin role required' });
      return;
    }

    // Check required env vars
    const clientId = process.env.INTUIT_CLIENT_ID;
    const redirectUri = process.env.INTUIT_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      res.status(500).json({ error: 'INTUIT_CLIENT_ID or INTUIT_REDIRECT_URI not configured' });
      return;
    }

    // Generate a CSRF state token: random + uid + ts. Store in Firestore briefly
    // so the callback can verify it. Expires after 10 minutes.
    const state = crypto.randomBytes(24).toString('hex');
    const stateRef = admin.firestore().collection('quickbooks-oauth-state').doc(state);
    await stateRef.set({
      uid: decoded.uid,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    // Build the Intuit auth URL
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      response_type: 'code',
      state,
    });
    const authUrl = `${INTUIT_AUTH_URL}?${params.toString()}`;

    res.status(200).json({ authUrl });
  } catch (err) {
    console.error('[qbo-oauth-start] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
