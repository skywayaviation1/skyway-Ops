// Firebase Authentication and user profile management.
// Authentication is Microsoft-only. Authorization requires an exact
// @flyskyway.com identity plus an active, admin-approved Firestore profile.
// Missing profiles are provisioned server-side with crew/pending defaults;
// the browser never chooses its own role or approval state.

import { auth, db, AUTH_DOMAIN } from './firebase.js';
import {
  OAuthProvider,
  getRedirectResult,
  signInWithRedirect,
  signInWithPopup,
  signInWithCustomToken,
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
import { microsoftAuthMethod } from './auth-environment.js';

const COMPANY_DOMAIN = 'flyskyway.com';

function isPreviewHostname(host) {
  return host.endsWith('.vercel.app')
    && (host.includes('-git-') || /-[a-z0-9]{8,}-/.test(host));
}

// Preview deployments bypass automatically. A non-Vercel development
// environment can opt in explicitly, but production cannot: the token-minting
// endpoint hard-stops when VERCEL_ENV=production regardless of this value.
const DEV_AUTH_BYPASS_ENABLED = (() => {
  if (import.meta.env.VITE_DEV_AUTH_BYPASS === 'true') return true;
  if (typeof window === 'undefined') return false;
  return isPreviewHostname(window.location.hostname);
})();

let devSignInPromise = null;

async function ensureDevelopmentSession() {
  if (devSignInPromise) return devSignInPromise;
  devSignInPromise = (async () => {
    const response = await fetch('/api/dev-auth-bypass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) {
      const err = new Error(data.error || 'Development authentication bypass is unavailable');
      err.code = 'auth/dev-bypass-unavailable';
      throw err;
    }
    return signInWithCustomToken(auth, data.token);
  })().finally(() => {
    devSignInPromise = null;
  });
  return devSignInPromise;
}

async function isDevelopmentBypassUser(user) {
  if (!DEV_AUTH_BYPASS_ENABLED || !user) return false;
  try {
    const result = await user.getIdTokenResult();
    return result.claims?.devAuthBypass === true;
  } catch {
    return false;
  }
}

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
  // Entra only issues an `email` claim when it is actually asked for. Without
  // these scopes Firebase leaves user.email null for most work accounts, the
  // company-domain check below can never pass, and sign-in bounces straight
  // back to the login screen.
  provider.addScope('openid');
  provider.addScope('profile');
  provider.addScope('email');
  return provider;
}

/**
 * Every email address Firebase resolved from verified provider claims. These
 * come from the signed OAuth token, never from anything the user typed, so
 * they are safe to authorize against. Microsoft puts the address on the
 * provider entry rather than the top-level user record often enough that
 * checking only `user.email` rejects legitimate company accounts.
 */
function verifiedEmails(user) {
  const found = [];
  if (user?.email) found.push(user.email);
  for (const p of user?.providerData || []) {
    if (p?.email) found.push(p.email);
  }
  return found.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

/** The company address for this user, or null if none of them qualify. */
function companyEmailFor(user) {
  return verifiedEmails(user).find(isCompanyEmail) || null;
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
      if (DEV_AUTH_BYPASS_ENABLED) {
        onChange({ state: 'loading' });
        try {
          await ensureDevelopmentSession();
          // signInWithCustomToken triggers onAuthStateChanged again with the
          // development identity; that callback continues through normally.
        } catch (err) {
          setDiag('dev-auth-bypass', err);
          onChange({
            state: 'signed-out',
            authError: 'auth/dev-bypass-unavailable',
          });
        }
        return;
      }
      onChange({ state: 'signed-out' });
      return;
    }

    // This is an authorization boundary, not just login-screen decoration.
    // Reject legacy password sessions and non-company identities before any
    // Firestore data is read. Each rejection carries a code so the login
    // screen can explain itself instead of silently reappearing.
    const devBypass = await isDevelopmentBypassUser(user);
    if (DEV_AUTH_BYPASS_ENABLED && !devBypass) {
      // A Microsoft session may still be cached from an earlier attempt.
      // Preview mode is intentionally deterministic: replace it with the
      // development identity so approval/profile state cannot block testing.
      onChange({ state: 'loading' });
      try {
        await ensureDevelopmentSession();
      } catch (err) {
        setDiag('dev-auth-bypass', err);
        onChange({
          state: 'signed-out',
          authError: 'auth/dev-bypass-unavailable',
        });
      }
      return;
    }
    const emails = verifiedEmails(user);
    const companyEmail = companyEmailFor(user);
    if (!devBypass && (!isMicrosoftUser(user) || (emails.length > 0 && !companyEmail))) {
      setDiag('identity-policy', new Error('Unauthorized identity'), {
        emails,
        providers: user.providerData?.map(p => p.providerId) || [],
      });
      await fbSignOut(auth).catch(() => {});
      onChange({ state: 'signed-out', authError: 'auth/company-account-required' });
      return;
    }
    if (!devBypass && !companyEmail) {
      // Authenticated by Microsoft, but the token carried no address at all —
      // an Entra claims configuration problem, not a rejected user.
      setDiag('identity-no-email', new Error('No email claim on Microsoft token'), {
        uid: user.uid,
        providers: user.providerData?.map(p => p.providerId) || [],
      });
      await fbSignOut(auth).catch(() => {});
      onChange({ state: 'signed-out', authError: 'auth/missing-email' });
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
      || String(profile.email).trim().toLowerCase() !== companyEmail
    ) {
      setDiag('profile-identity-mismatch', new Error('Profile identity mismatch'), {
        uid: user.uid,
      });
      await fbSignOut(auth).catch(() => {});
      onChange({ state: 'signed-out', authError: 'auth/profile-identity-mismatch' });
      return;
    }
    // Disabled profiles and unapproved profiles never enter the app.
    if (profile.active === false) {
      await fbSignOut(auth).catch(() => {});
      onChange({ state: 'signed-out', authError: 'auth/account-disabled' });
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

// Marks that we handed the browser to Microsoft. If we come back with no
// credential and this is still set, the round-trip itself lost the session —
// the signature of a browser blocking the cross-origin sign-in helper's
// storage — rather than the user cancelling or being rejected.
const REDIRECT_FLAG = 'skyway_oauth_redirect_at';
const REDIRECT_WINDOW_MS = 10 * 60 * 1000;

function markRedirectStarted() {
  try { sessionStorage.setItem(REDIRECT_FLAG, String(Date.now())); } catch { /* private mode */ }
}
function consumeRedirectFlag() {
  try {
    const at = Number(sessionStorage.getItem(REDIRECT_FLAG) || 0);
    sessionStorage.removeItem(REDIRECT_FLAG);
    return at;
  } catch {
    return 0;
  }
}

async function validateMicrosoftResult(user) {
  if (!isMicrosoftUser(user)) {
    await fbSignOut(auth).catch(() => {});
    const err = new Error('Use your @flyskyway.com Microsoft account');
    err.code = 'auth/company-account-required';
    throw err;
  }
  if (verifiedEmails(user).length === 0) {
    await fbSignOut(auth).catch(() => {});
    const err = new Error('Microsoft returned no email address');
    err.code = 'auth/missing-email';
    throw err;
  }
  if (!companyEmailFor(user)) {
    await fbSignOut(auth).catch(() => {});
    const err = new Error('Use your @flyskyway.com Microsoft account');
    err.code = 'auth/company-account-required';
    throw err;
  }
  return user;
}

export async function signInWithMicrosoft() {
  const method = microsoftAuthMethod({ authDomain: AUTH_DOMAIN });
  if (method === 'popup') {
    const result = await signInWithPopup(auth, microsoftProvider());
    return validateMicrosoftResult(result.user);
  }
  markRedirectStarted();
  try {
    await signInWithRedirect(auth, microsoftProvider());
  } catch (err) {
    consumeRedirectFlag();
    throw err;
  }
}

let redirectCompletionPromise = null;

async function completeMicrosoftRedirectOnce() {
  // Resolves once Firebase has finished restoring persisted auth state, so
  // auth.currentUser is trustworthy immediately afterwards.
  const result = await getRedirectResult(auth);

  if (result?.user) {
    consumeRedirectFlag();
    return validateMicrosoftResult(result.user);
  }

  const startedAt = consumeRedirectFlag();
  if (startedAt && (Date.now() - startedAt) < REDIRECT_WINDOW_MS && !auth.currentUser) {
    const err = new Error('Sign-in did not carry back to the app');
    err.code = 'auth/redirect-session-lost';
    throw err;
  }
  return null;
}

/** Safe to call from app boot and StrictMode replays; Firebase consumes a
 * redirect result once, so every caller shares the same completion promise. */
export function completeMicrosoftRedirect() {
  if (!redirectCompletionPromise) {
    redirectCompletionPromise = completeMicrosoftRedirectOnce();
  }
  return redirectCompletionPromise;
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
