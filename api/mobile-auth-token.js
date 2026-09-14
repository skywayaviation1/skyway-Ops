// Bridges a native Firebase Microsoft session into the Firebase JavaScript
// session used by the existing Firestore application.
//
// The native plugin is required because OAuth redirects inside iOS/Android
// WebViews are unreliable and disallowed by several identity providers. The
// incoming token is verified server-side before a short-lived custom token is
// minted for the same Firebase uid.

import admin from 'firebase-admin';

const ALLOWED_DOMAIN = 'flyskyway.com';

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

export function allowedCompanyEmail(value, allowedDomain = ALLOWED_DOMAIN) {
  const email = String(value || '').trim().toLowerCase();
  return email.endsWith(`@${allowedDomain}`)
    && email.slice(0, -(allowedDomain.length + 1)).length > 0;
}

/**
 * Decide whether a decoded native Firebase ID token may be exchanged for a
 * web custom token. Kept pure so the policy can be unit-tested without
 * minting tokens.
 */
export function authorizeNativeMicrosoftToken(decoded, allowedDomain = ALLOWED_DOMAIN) {
  const email = String(decoded?.email || '').trim().toLowerCase();
  const provider = decoded?.firebase?.sign_in_provider;
  if (provider !== 'microsoft.com') {
    return {
      ok: false,
      status: 403,
      error: 'A @flyskyway.com Microsoft account is required',
    };
  }
  if (!email) {
    return {
      ok: false,
      status: 403,
      code: 'missing-email',
      error: 'Microsoft did not return an email address for this account. Entra must issue the email claim before access can be granted.',
    };
  }
  if (!allowedCompanyEmail(email, allowedDomain)) {
    return {
      ok: false,
      status: 403,
      error: 'A @flyskyway.com Microsoft account is required',
    };
  }
  return { ok: true, email, uid: decoded.uid };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const { idToken } = req.body || {};
    if (!idToken || typeof idToken !== 'string') {
      res.status(400).json({ error: 'idToken required' });
      return;
    }

    const app = getAdmin();
    let decoded;
    try {
      decoded = await admin.auth(app).verifyIdToken(idToken, true);
    } catch {
      res.status(401).json({ error: 'Invalid or revoked native session' });
      return;
    }

    const decision = authorizeNativeMicrosoftToken(decoded);
    if (!decision.ok) {
      res.status(decision.status).json({
        error: decision.error,
        ...(decision.code ? { code: decision.code } : {}),
      });
      return;
    }

    const token = await admin.auth(app).createCustomToken(decoded.uid, {
      nativeMicrosoft: true,
    });
    res.status(200).json({ ok: true, token });
  } catch (err) {
    console.error('[mobile-auth-token]', err);
    res.status(500).json({ error: 'Could not complete mobile sign-in' });
  }
}
