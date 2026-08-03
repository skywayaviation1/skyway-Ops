// Creates a least-privilege Firestore profile after a verified Microsoft
// company sign-in. This endpoint is deliberately server-side: email-domain
// checks in React are UX only and can be bypassed by a modified client.
//
// Request: POST { idToken }
// Response: { ok, profile }
//
// Required Vercel env:
//   FIREBASE_SERVICE_ACCOUNT_JSON

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const ALLOWED_DOMAIN = 'flyskyway.com';

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

function normalizedEmail(decoded) {
  return String(decoded.email || '').trim().toLowerCase();
}

function hasAllowedDomain(email) {
  return email.endsWith(`@${ALLOWED_DOMAIN}`)
    && email.slice(0, -(ALLOWED_DOMAIN.length + 1)).length > 0;
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
      // checkRevoked catches a disabled/revoked company account immediately.
      decoded = await admin.auth(app).verifyIdToken(idToken, true);
    } catch {
      res.status(401).json({ error: 'Invalid or revoked session' });
      return;
    }

    const email = normalizedEmail(decoded);
    const provider = decoded.firebase?.sign_in_provider;
    if (provider !== 'microsoft.com') {
      res.status(403).json({ error: 'A @flyskyway.com Microsoft account is required' });
      return;
    }
    // A Microsoft token with no email claim is an Entra configuration problem,
    // not a rejected user. Saying so keeps the operator off the wrong trail.
    if (!email) {
      res.status(403).json({
        code: 'missing-email',
        error: 'Microsoft did not return an email address for this account. Entra must issue the email claim before access can be granted.',
      });
      return;
    }
    if (!hasAllowedDomain(email)) {
      res.status(403).json({ error: 'A @flyskyway.com Microsoft account is required' });
      return;
    }

    const db = getFirestore(app, 'appusers');
    const ref = db.collection('users').doc(decoded.uid);
    const existing = await ref.get();

    if (existing.exists) {
      const profile = existing.data() || {};
      // Never silently migrate a profile to a different identity.
      if (profile.email && String(profile.email).toLowerCase() !== email) {
        res.status(409).json({ error: 'Profile email does not match Microsoft identity' });
        return;
      }
      res.status(200).json({ ok: true, profile: { uid: decoded.uid, ...profile } });
      return;
    }

    const displayName = String(decoded.name || decoded.email || '')
      .trim()
      .replace(/@flyskyway\.com$/i, '');
    const profile = {
      email,
      name: displayName || email.split('@')[0],
      callsign: '',
      jetinsightName: displayName || '',
      // New identities never grant themselves a privileged role.
      role: 'crew',
      approved: false,
      active: true,
      authProvider: 'microsoft.com',
      createdAt: Date.now(),
    };

    await ref.create(profile);
    res.status(201).json({ ok: true, profile: { uid: decoded.uid, ...profile } });
  } catch (err) {
    console.error('[auth-profile-bootstrap]', err);
    res.status(500).json({ error: 'Could not provision account profile' });
  }
}
