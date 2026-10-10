// Replace the App Review sandbox documents in the named `appreview` database.
// Safe to re-run. It only writes that database. Company data in `appusers` is untouched.
//
//   FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/seed-reviewer-demo.mjs
//
// The Auth user must already exist (scripts/create-reviewer-account.mjs creates
// it and then calls this). Duty records are keyed to that user's uid.

import { APP_REVIEWER_EMAIL } from '../src/reviewer-account.js';
import { buildReviewerDemo } from '../src/reviewer-demo-data.js';
import { initReviewerAdmin, reviewerDb } from './lib/reviewer-admin.mjs';
import admin from 'firebase-admin';

const COLLECTIONS = [
  'manual-trips',
  'trip-state',
  'manifests',
  'duty-periods-v2',
  'flightaware-state',
  'users',
];

async function clearCollection(db, name) {
  const snap = await db.collection(name).get();
  let batch = db.batch();
  let pending = 0;
  let removed = 0;
  for (const docSnap of snap.docs) {
    batch.delete(docSnap.ref);
    pending += 1;
    removed += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending) await batch.commit();
  return removed;
}

async function main() {
  const app = initReviewerAdmin();
  let user;
  try {
    user = await admin.auth(app).getUserByEmail(APP_REVIEWER_EMAIL);
  } catch (err) {
    if (err?.code === 'auth/user-not-found') {
      throw new Error(`No Auth user for ${APP_REVIEWER_EMAIL}. Run scripts/create-reviewer-account.mjs first.`);
    }
    throw err;
  }

  const db = reviewerDb();
  const demo = buildReviewerDemo(Date.now(), user.uid);
  const removed = {};
  for (const name of COLLECTIONS) {
    removed[name] = await clearCollection(db, name);
  }

  const batch = db.batch();
  batch.set(db.collection('users').doc(user.uid), demo.reviewerProfile, { merge: true });
  for (const person of demo.users) {
    const { uid, ...profile } = person;
    batch.set(db.collection('users').doc(uid), profile);
  }
  for (const trip of demo.trips) {
    batch.set(db.collection('manual-trips').doc(trip.uid), { ...trip, updatedAt: Date.now() });
  }
  for (const state of demo.tripStates) {
    const { id, ...data } = state;
    batch.set(db.collection('trip-state').doc(id), { ...data, updatedAt: Date.now() });
  }
  for (const manifest of demo.manifests) {
    batch.set(db.collection('manifests').doc(manifest.id), {
      ...manifest,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  for (const period of demo.duty) {
    batch.set(db.collection('duty-periods-v2').doc(period.id), period);
  }
  for (const position of demo.positions) {
    const { id, ...data } = position;
    batch.set(db.collection('flightaware-state').doc(id), data);
  }
  batch.set(db.collection('app-config').doc('fleet'), demo.fleet);
  await batch.commit();

  console.log(`[reviewer-seed] reset sandbox for ${APP_REVIEWER_EMAIL} (${user.uid})`);
  console.log(`[reviewer-seed] removed ${JSON.stringify(removed)}`);
  console.log(`[reviewer-seed] wrote ${demo.trips.length} trips, ${demo.manifests.length} manifest, ${demo.duty.length} duty periods`);
}

main().catch((err) => {
  console.error('[reviewer-seed]', err?.message || err);
  process.exit(1);
});
