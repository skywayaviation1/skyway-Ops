/* Stand-in for `firebase/auth`.
 *
 * Signs in a fixed company identity immediately so the harness renders the
 * authenticated app instead of the Microsoft sign-in screen. The identity is
 * shaped to satisfy the real authorization checks in src/firebase-auth.js:
 * a microsoft.com provider entry carrying a verified @flyskyway.com address.
 */

const DEFAULT_IDENTITY = {
  uid: 'demo-ops-dana',
  email: 'd.whitfield@flyskyway.com',
  displayName: 'Dana Whitfield',
};

/* boot.jsx sets window.__harnessIdentity before the app loads, so the harness
 * can render either the ops/admin surfaces or a pilot's own view. */
function identity() {
  const chosen = (typeof window !== 'undefined' && window.__harnessIdentity) || DEFAULT_IDENTITY;
  return {
    uid: chosen.uid,
    email: chosen.email,
    emailVerified: true,
    displayName: chosen.displayName,
    photoURL: null,
    providerData: [{ providerId: 'microsoft.com', email: chosen.email }],
    getIdToken: async () => 'harness-id-token',
    getIdTokenResult: async () => ({ claims: {} }),
    reload: async () => {},
  };
}

export const HARNESS_USER = identity();

const authInstance = {
  get currentUser() { return identity(); },
  app: { name: 'mock' },
  onAuthStateChanged: (cb) => onAuthStateChanged(authInstance, cb),
  signOut: async () => {},
};

export function getAuth() { return authInstance; }

export function onAuthStateChanged(_auth, next) {
  const cb = typeof next === 'function' ? next : next?.next;
  if (cb) Promise.resolve().then(() => cb(identity()));
  return () => {};
}

export class OAuthProvider {
  constructor(providerId) { this.providerId = providerId; }
  setCustomParameters() { return this; }
  addScope() { return this; }
}

export async function signInWithRedirect() {}
export async function signInWithPopup() { return { user: identity() }; }
export async function signInWithCredential() { return { user: identity() }; }
export async function getRedirectResult() { return null; }
export async function signInWithCustomToken() { return { user: HARNESS_USER }; }
export async function signOut() {}
export async function reload() {}
export function connectAuthEmulator() {}
