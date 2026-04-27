// Firebase Authentication + user profile management.
// 
// Two-collection model:
// - Firebase Auth holds the credential (email + hashed password). We never see the password.
// - Firestore `users/{uid}` holds the profile (name, callsign, role, jetinsightName, approved flag).
//
// On signup: create Auth user, send verification email, create Firestore profile (approved: false).
// On login: Auth verifies credential, we load profile, gate access on emailVerified + approved.
//
// First-user bootstrap: if no admins exist when a user signs up, that user becomes admin AND
// is auto-approved. Solves the chicken-and-egg problem of "who approves the first admin?".

import { auth, db } from './firebase.js';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
  reload as reloadAuthUser,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';

/**
 * Subscribes to auth state changes and resolves a profile from Firestore.
 * Returns an unsubscribe function.
 *
 * The callback receives one of:
 *   { state: 'loading' }
 *   { state: 'signed-out' }
 *   { state: 'unverified', user, profile? }   — signed in but email not verified
 *   { state: 'pending',    user, profile }    — verified but not yet approved
 *   { state: 'active',     user, profile }    — verified AND approved (full access)
 *   { state: 'no-profile', user }             — signed in but Firestore record missing (broken state)
 */
export function watchAuth(onChange) {
  onChange({ state: 'loading' });
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      onChange({ state: 'signed-out' });
      return;
    }

    // Reload to ensure emailVerified is fresh (in case user just clicked link in another tab)
    try {
      await reloadAuthUser(user);
    } catch (err) {
      console.warn('reloadAuthUser failed', err);
    }

    let profile = null;
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) profile = { uid: user.uid, ...snap.data() };
    } catch (err) {
      console.error('Failed to load user profile:', err);
    }

    if (!profile) {
      onChange({ state: 'no-profile', user });
      return;
    }
    if (!user.emailVerified) {
      onChange({ state: 'unverified', user, profile });
      return;
    }
    if (!profile.approved) {
      onChange({ state: 'pending', user, profile });
      return;
    }
    onChange({ state: 'active', user, profile });
  });
}

/**
 * Creates a new account.
 * - Creates Firebase Auth user
 * - Sends verification email
 * - Creates Firestore profile
 * - First-user-to-sign-up automatically becomes admin AND approved
 *
 * Throws if email already exists or password is too weak.
 */
export async function signUp({ email, password, name, callsign, jetinsightName }) {
  if (!email || !password) throw new Error('Email and password are required');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');

  // Check if any admins already exist (decides whether this is the first user)
  let isFirstUser = false;
  try {
    const adminsQuery = query(collection(db, 'users'), where('role', '==', 'admin'));
    const adminSnap = await getDocs(adminsQuery);
    isFirstUser = adminSnap.empty;
  } catch (err) {
    // If we can't read users (rules issue), assume not first user — safer default
    console.warn('Failed to check for existing admins:', err);
  }

  // Create the Firebase Auth account (this is what holds the password)
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);

  // Build the profile
  const profile = {
    email: email.trim(),
    name: name?.trim() || email.trim().split('@')[0],
    callsign: callsign?.trim() || '',
    jetinsightName: jetinsightName?.trim() || name?.trim() || '',
    role: isFirstUser ? 'admin' : 'crew',
    approved: isFirstUser, // first user auto-approved
    createdAt: Date.now(),
    active: true,
  };

  await setDoc(doc(db, 'users', credential.user.uid), profile);

  // Send verification email
  try {
    await sendEmailVerification(credential.user);
  } catch (err) {
    console.error('Failed to send verification email:', err);
  }

  return { uid: credential.user.uid, ...profile, isFirstUser };
}

/**
 * Sign in with email + password. Throws on bad credentials.
 */
export async function signIn(email, password) {
  if (!email || !password) throw new Error('Email and password required');
  await signInWithEmailAndPassword(auth, email.trim(), password);
}

/**
 * Sign out the current user.
 */
export async function signOut() {
  await fbSignOut(auth);
}

/**
 * Send a "reset your password" email.
 */
export async function requestPasswordReset(email) {
  if (!email) throw new Error('Email required');
  await sendPasswordResetEmail(auth, email.trim());
}

/**
 * Re-send the email verification link.
 */
export async function resendVerification() {
  if (!auth.currentUser) throw new Error('Not signed in');
  await sendEmailVerification(auth.currentUser);
}

/**
 * Reloads the auth user to refresh emailVerified status. Call this after the
 * user clicks the verification link, to update the local view.
 */
export async function refreshVerification() {
  if (!auth.currentUser) return false;
  await reloadAuthUser(auth.currentUser);
  return auth.currentUser.emailVerified;
}

/* ---------- Admin: user management ---------- */

/**
 * Subscribe to the users collection. Calls onUpdate with array of user profiles.
 * Returns unsubscribe.
 */
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

/**
 * Approve a pending user.
 */
export async function approveUser(uid) {
  await updateDoc(doc(db, 'users', uid), { approved: true });
}

/**
 * Update fields on a user profile (name, callsign, role, jetinsightName, etc.).
 * Cannot change email or password — those go through Auth.
 */
export async function updateUserProfile(uid, patch) {
  // Whitelist patchable fields
  const allowed = ['name', 'callsign', 'role', 'jetinsightName', 'approved', 'active'];
  const safe = {};
  for (const k of allowed) if (patch[k] !== undefined) safe[k] = patch[k];
  await updateDoc(doc(db, 'users', uid), safe);
}

/**
 * Delete a user's Firestore profile. NOTE: this does not delete their Firebase
 * Auth account — that requires admin SDK on the backend, which we don't have.
 * The user will still be able to sign in but won't have a profile (resulting in
 * 'no-profile' state, which the UI treats as denied access).
 */
export async function deleteUserProfile(uid) {
  await deleteDoc(doc(db, 'users', uid));
}
