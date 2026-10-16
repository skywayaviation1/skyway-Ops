// Shared Admin SDK handles for white-label board routes. Not a public endpoint.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { callerMayManageBoards } from '../src/white-label-board.js';
import { reviewerSessionBlock } from '../src/reviewer-account.js';

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  const bucket = process.env.FIREBASE_STORAGE_BUCKET;
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
    ...(bucket ? { storageBucket: bucket } : {}),
  });
}

export function whiteLabelDb() {
  return getFirestore(getAdmin(), 'appusers');
}

export function whiteLabelBucket() {
  const name = process.env.FIREBASE_STORAGE_BUCKET;
  return name ? getStorage(getAdmin()).bucket(name) : getStorage(getAdmin()).bucket();
}

export async function authorizeBoardManager(idToken) {
  if (!idToken) return null;
  const app = getAdmin();
  let decoded;
  try {
    decoded = reviewerSessionBlock(await admin.auth(app).verifyIdToken(idToken, true));
  } catch {
    return null;
  }
  const snap = await getFirestore(app, 'appusers').collection('users').doc(decoded.uid).get();
  const profile = snap.exists ? (snap.data() || {}) : null;
  if (!callerMayManageBoards(profile)) return null;
  return {
    uid: decoded.uid,
    name: profile.name || decoded.name || decoded.email || 'Operations',
    role: profile.role,
  };
}
