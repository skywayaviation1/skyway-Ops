// DEVELOPMENT / PREVIEW AUTHENTICATION BYPASS
//
// This endpoint mints a Firebase custom token for a fixed development-admin
// identity so preview deployments can be exercised without Microsoft OAuth.
//
// SECURITY BOUNDARIES:
//   1. VERCEL_ENV=production is an unconditional hard stop.
//   2. Vercel preview deployments are allowed automatically.
//   3. Other non-production environments require DEV_AUTH_BYPASS=true.
//
// Anyone who can open an unprotected preview deployment can obtain this admin
// token. Use Vercel Deployment Protection while the bypass is active. Delete
// this endpoint (and its client path) before production launch.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const DEV_UID = 'skyway-development-admin';
const DEV_EMAIL = 'developer@flyskyway.com';

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

function bypassAllowed() {
  if (process.env.VERCEL_ENV === 'production') return false;
  if (process.env.VERCEL_ENV === 'preview') return true;
  return process.env.DEV_AUTH_BYPASS === 'true';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Return 404 instead of advertising a disabled development backdoor.
  if (!bypassAllowed()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const app = getAdmin();

    // Custom tokens inherit standard identity fields from the Firebase Auth
    // user record. Ensure it exists so user.email passes the same profile
    // identity checks as a real account.
    try {
      await admin.auth(app).getUser(DEV_UID);
      await admin.auth(app).updateUser(DEV_UID, {
        email: DEV_EMAIL,
        displayName: 'Development Admin',
        disabled: false,
      });
    } catch (err) {
      if (err?.code !== 'auth/user-not-found') throw err;
      await admin.auth(app).createUser({
        uid: DEV_UID,
        email: DEV_EMAIL,
        displayName: 'Development Admin',
        emailVerified: true,
      });
    }

    // This profile is intentionally privileged because the purpose of the
    // bypass is exercising every development surface. It is a fixed UID and
    // can never be minted by this endpoint in production.
    const profile = {
      email: DEV_EMAIL,
      name: 'Development Admin',
      callsign: 'DEV',
      jetinsightName: 'Development Admin',
      role: 'admin',
      approved: true,
      active: true,
      authProvider: 'dev-bypass',
      developmentOnly: true,
      updatedAt: Date.now(),
    };
    const db = getFirestore(app, 'appusers');
    await db.collection('users').doc(DEV_UID).set(profile, { merge: true });

    const token = await admin.auth(app).createCustomToken(DEV_UID, {
      devAuthBypass: true,
    });

    res.status(200).json({
      ok: true,
      token,
      environment: process.env.VERCEL_ENV || 'development',
    });
  } catch (err) {
    console.error('[dev-auth-bypass]', err);
    res.status(500).json({ error: 'Development sign-in failed' });
  }
}
