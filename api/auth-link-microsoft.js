// Links a verified Microsoft identity onto the existing Firebase Auth user
// that already owns the same @flyskyway.com email — typically a legacy
// password account. Preserves the Auth UID (and every Firestore document
// keyed by it) while retiring the old sign-in methods.
//
// Called automatically when Microsoft sign-in fails with
// auth/account-exists-with-different-credential. The client then retries
// with the pending OAuth credential against the now-linked account.
//
// Request: POST { accessToken, idToken?, email? }
// Response: { ok, uid, action: 'link' | 'already-linked' }
//
// Required Vercel env:
//   FIREBASE_SERVICE_ACCOUNT_JSON

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import {
  isCompanyEmail,
  microsoftIdentityFromGraph,
  normalizeEmail,
  planProviderMerge,
} from '../src/auth-account-merge.js';

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

async function microsoftIdentityFromAccessToken(accessToken) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body?.error?.message || 'Microsoft token was not accepted');
    err.code = 'microsoft-token-rejected';
    err.status = response.status;
    throw err;
  }
  return microsoftIdentityFromGraph(body);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const { accessToken, email: claimedEmail } = req.body || {};
    if (!accessToken || typeof accessToken !== 'string') {
      res.status(400).json({ error: 'accessToken required' });
      return;
    }

    let identity;
    try {
      identity = await microsoftIdentityFromAccessToken(accessToken);
    } catch (err) {
      res.status(err.status === 401 || err.status === 403 ? 401 : 502).json({
        code: err.code || 'microsoft-token-rejected',
        error: 'Microsoft could not confirm this sign-in. Try again.',
      });
      return;
    }

    if (!identity || !isCompanyEmail(identity.email)) {
      res.status(403).json({
        code: 'company-account-required',
        error: 'A @flyskyway.com Microsoft account is required',
      });
      return;
    }

    // The client may pass the email Firebase reported on the conflict. When it
    // disagrees with Graph, refuse — that is a confused-deputy signal, not a
    // merge we should attempt.
    if (claimedEmail && normalizeEmail(claimedEmail) !== identity.email) {
      res.status(409).json({
        code: 'email-mismatch',
        error: 'Microsoft identity does not match the account being merged',
      });
      return;
    }

    const app = getAdmin();
    const auth = admin.auth(app);

    let existing;
    try {
      existing = await auth.getUserByEmail(identity.email);
    } catch (err) {
      if (err?.code === 'auth/user-not-found') {
        // No legacy account to merge into — the client should retry a normal
        // Microsoft sign-in, which will create the Auth user cleanly.
        res.status(404).json({
          code: 'no-existing-account',
          error: 'No existing account found for this email',
        });
        return;
      }
      throw err;
    }

    const plan = planProviderMerge(existing, identity);
    if (plan.action === 'reject') {
      res.status(409).json({
        code: plan.reason,
        error: plan.reason === 'microsoft-oid-conflict'
          ? 'This email is already linked to a different Microsoft account'
          : 'This account cannot be merged automatically',
      });
      return;
    }

    const update = {
      emailVerified: true,
      displayName: identity.displayName || existing.displayName || undefined,
    };
    if (plan.action === 'link') update.providerToLink = plan.link;
    if (plan.unlink?.length) update.providersToUnlink = plan.unlink;

    // Linking and unlinking in one call keeps a window where both password and
    // Microsoft could sign in from ever opening.
    if (update.providerToLink || update.providersToUnlink) {
      await auth.updateUser(existing.uid, update);
    } else if (!existing.emailVerified) {
      await auth.updateUser(existing.uid, { emailVerified: true });
    }

    // The Auth UID is unchanged, so the existing Firestore profile continues
    // to authorize this person. Mark how they sign in for admin visibility.
    const db = getFirestore(app, 'appusers');
    const ref = db.collection('users').doc(existing.uid);
    const snap = await ref.get();
    if (snap.exists) {
      const profile = snap.data() || {};
      if (!profile.email || normalizeEmail(profile.email) === identity.email) {
        await ref.set({
          authProvider: 'microsoft.com',
          email: identity.email,
          migratedToMicrosoftAt: Date.now(),
        }, { merge: true });
      }
    }

    console.log(
      `[auth-link-microsoft] ${plan.action} uid=${existing.uid} email=${identity.email}`
      + (plan.unlink?.length ? ` unlinked=${plan.unlink.join(',')}` : ''),
    );

    res.status(200).json({
      ok: true,
      uid: existing.uid,
      action: plan.action,
      unlinked: plan.unlink || [],
    });
  } catch (err) {
    console.error('[auth-link-microsoft]', err);
    res.status(500).json({ error: 'Could not merge accounts for this email' });
  }
}
