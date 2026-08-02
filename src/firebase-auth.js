// Firebase Authentication and user profile management.
// Authentication is Microsoft-only. Authorization requires an exact
// @flyskyway.com identity plus an active, admin-approved Firestore profile.
// Missing profiles are provisioned server-side with crew/pending defaults;
// the browser never chooses its own role or approval state.

import { auth, db } from './firebase.js';
import {
  OAuthProvider,
  getRedirectResult,
  signInWithRedirect,
  signOut as fbSignOut,
  onAuthStateChanged,
  reload as reloadAuthUser,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  onSnapshot,
} from 'firebase/firestore';

const COMPANY_DOMAIN = 'flyskyway.com';

function isCompanyEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return normalized.endsWith(`@${COMPANY_DOMAIN}`)
    && normalized.slice(0, -(COMPANY_DOMAIN.length + 1)).length > 0;
}

function isMicrosoftUser(user) {
  return user?.providerData?.some(p => p.providerId === 'microsoft.com') === true;
}

function microsoftProvider() {
  const provider = new OAuthProvider('microsoft.com');
  const tenant = String(import.meta.env.VITE_MICROSOFT_TENANT_ID || '').trim();
  provider.setCustomParameters({
    prompt: 'select_account',
    domain_hint: COMPANY_DOMAIN,
    ...(tenant ? { tenant } : {}),
  });
  return provider;
}

// Diagnostic state — exposed for the UI to show error details
let lastDiagnostic = null;
export function getLastDiagnostic() {
  return lastDiagnostic;
}

function setDiag(stage, error, extra) {
  lastDiagnostic = {
    stage,
    error: error?.message || String(error),
    code: error?.code || null,
    extra: extra || null,
    timestamp: Date.now(),
  };
  console.error('[auth-diagnostic]', stage, error, extra);
}

export function watchAuth(onChange) {
  onChange({ state: 'loading' });
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      onChange({ state: 'signed-out' });
      return;
    }

    // This is an authorization boundary, not just login-screen decoration.
    // Reject legacy password sessions and non-company Microsoft identities
    // before any Firestore data is read.
    if (!isMicrosoftUser(user) || !isCompanyEmail(user.email)) {
      setDiag('identity-policy', new Error('Unauthorized identity'), {
        email: user.email || null,
        providers: user.providerData?.map(p => p.providerId) || [],
      });
      await fbSignOut(auth).catch(() => {});
      onChange({ state: 'signed-out', authError: 'company-account-required' });
      return;
    }

    try {
      await reloadAuthUser(user);
    } catch (err) {
      console.warn('reloadAuthUser failed', err);
    }

    let profile = null;
    let readError = null;
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) profile = { uid: user.uid, ...snap.data() };
    } catch (err) {
      readError = err;
      setDiag('profile-read', err, { uid: user.uid });
    }

    // Profiles are provisioned by a token-verifying server endpoint. The
    // browser never decides its own role or approval state.
    if (!profile && !readError) {
      try {
        profile = await bootstrapCompanyProfile(user);
      } catch (err) {
        readError = err;
        setDiag('profile-bootstrap', err, { uid: user.uid });
      }
    }

    if (!profile) {
      onChange({ state: 'no-profile', user, error: readError });
      return;
    }
    if (
      !isCompanyEmail(profile.email)
      || String(profile.email).trim().toLowerCase() !== String(user.email).trim().toLowerCase()
    ) {
      setDiag('profile-identity-mismatch', new Error('Profile identity mismatch'), {
        uid: user.uid,
      });
      await fbSignOut(auth).catch(() => {});
      onChange({ state: 'signed-out', authError: 'company-account-required' });
      return;
    }
    // Disabled profiles and unapproved profiles never enter the app.
    if (profile.active === false) {
      await fbSignOut(auth).catch(() => {});
      onChange({ state: 'signed-out', authError: 'account-disabled' });
      return;
    }
    if (profile.approved !== true) {
      onChange({ state: 'pending', user, profile });
      return;
    }
    onChange({ state: 'active', user, profile });
  });
}

async function bootstrapCompanyProfile(user) {
  const idToken = await user.getIdToken(true);
  const response = await fetch('/api/auth-profile-bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.profile) {
    throw new Error(data.error || 'Could not provision company profile');
  }
  return data.profile;
}

export async function signInWithMicrosoft() {
  await signInWithRedirect(auth, microsoftProvider());
}

export async function completeMicrosoftRedirect() {
  const result = await getRedirectResult(auth);
  if (!result?.user) return null;
  if (!isMicrosoftUser(result.user) || !isCompanyEmail(result.user.email)) {
    await fbSignOut(auth).catch(() => {});
    const err = new Error('Use your @flyskyway.com Microsoft account');
    err.code = 'auth/company-account-required';
    throw err;
  }
  return result.user;
}

export async function signOut() {
  await fbSignOut(auth);
}

export function subscribeToUsers(onUpdate) {
  return onSnapshot(
    collection(db, 'users'),
    (snapshot) => {
      const users = snapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
      onUpdate(users);
    },
    (err) => {
      console.error('Users subscription error:', err);
    }
  );
}

export async function approveUser(uid) {
  await updateDoc(doc(db, 'users', uid), { approved: true });
}

export async function updateUserProfile(uid, patch) {
  const allowed = ['name', 'callsign', 'role', 'jetinsightName', 'approved', 'active'];
  const safe = {};
  for (const k of allowed) if (patch[k] !== undefined) safe[k] = patch[k];
  await updateDoc(doc(db, 'users', uid), safe);
}

export async function deleteUserProfile(uid) {
  await deleteDoc(doc(db, 'users', uid));
}
