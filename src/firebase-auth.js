// Firebase Authentication and user profile management.
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
    if (!profile && !readError) {
      profile = await tryCreateProfile(user);
    }
    if (!profile) {
      onChange({ state: 'no-profile', user, error: readError });
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

async function tryCreateProfile(user) {
  let isFirstUser = true;
  try {
    const adminsQuery = query(collection(db, 'users'), where('role', '==', 'admin'));
    const adminSnap = await getDocs(adminsQuery);
    isFirstUser = adminSnap.empty;
  } catch (err) {
    console.warn('Cannot check for admins, assuming first user', err);
    isFirstUser = true;
  }
  const profile = {
    email: user.email || '',
    name: (user.displayName || user.email || '').split('@')[0],
    callsign: '',
    jetinsightName: user.displayName || '',
    role: isFirstUser ? 'admin' : 'crew',
    approved: isFirstUser,
    createdAt: Date.now(),
    active: true,
  };
  try {
    await setDoc(doc(db, 'users', user.uid), profile);
    return { uid: user.uid, ...profile };
  } catch (err) {
    setDiag('profile-create', err, { uid: user.uid });
    return null;
  }
}

export async function repairProfile() {
  if (!auth.currentUser) throw new Error('Not signed in');
  const profile = await tryCreateProfile(auth.currentUser);
  if (!profile) {
    const diag = getLastDiagnostic();
    throw new Error(diag?.error || 'Could not create profile. Check Firestore security rules.');
  }
  return profile;
}

export async function signUp({ email, password, name, callsign, jetinsightName }) {
  if (!email || !password) throw new Error('Email and password are required');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  let isFirstUser = true;
  try {
    const adminsQuery = query(collection(db, 'users'), where('role', '==', 'admin'));
    const adminSnap = await getDocs(adminsQuery);
    isFirstUser = adminSnap.empty;
  } catch (err) {
    console.warn('Cannot check for admins, assuming first user', err);
    isFirstUser = true;
  }
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const profile = {
    email: email.trim(),
    name: name?.trim() || email.trim().split('@')[0],
    callsign: callsign?.trim() || '',
    jetinsightName: jetinsightName?.trim() || name?.trim() || '',
    role: isFirstUser ? 'admin' : 'crew',
    approved: isFirstUser,
    createdAt: Date.now(),
    active: true,
  };
  try {
    await setDoc(doc(db, 'users', credential.user.uid), profile);
  } catch (err) {
    setDiag('signup-profile-create', err, { uid: credential.user.uid });
  }
  try {
    await sendEmailVerification(credential.user);
  } catch (err) {
    console.error('Failed to send verification email:', err);
  }
  return { uid: credential.user.uid, ...profile, isFirstUser };
}

export async function signIn(email, password) {
  if (!email || !password) throw new Error('Email and password required');
  await signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function signOut() {
  await fbSignOut(auth);
}

export async function requestPasswordReset(email) {
  if (!email) throw new Error('Email required');
  await sendPasswordResetEmail(auth, email.trim());
}

export async function resendVerification() {
  if (!auth.currentUser) throw new Error('Not signed in');
  await sendEmailVerification(auth.currentUser);
}

export async function refreshVerification() {
  if (!auth.currentUser) return false;
  await reloadAuthUser(auth.currentUser);
  return auth.currentUser.emailVerified;
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
