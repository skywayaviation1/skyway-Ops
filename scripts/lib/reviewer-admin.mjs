// Shared Firebase Admin bootstrap for the App Review scripts.
// Uses the Auth and Firestore emulators when their host variables are set.
// Otherwise FIREBASE_SERVICE_ACCOUNT_JSON is required. The password is never written to disk.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

export const PROJECT_ID = 'skyway-ops-app';
export const DEMO_DATABASE_ID = 'appreview';

export function emulatorMode() {
  return Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST);
}

export function initReviewerAdmin() {
  if (admin.apps.length) return admin.app();
  if (emulatorMode()) {
    return admin.initializeApp({ projectId: PROJECT_ID });
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'Set FIREBASE_SERVICE_ACCOUNT_JSON to the skyway-ops-app service account, or set FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST for the local emulators.',
    );
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id || PROJECT_ID,
  });
}

export function reviewerDb() {
  return getFirestore(initReviewerAdmin(), DEMO_DATABASE_ID);
}
