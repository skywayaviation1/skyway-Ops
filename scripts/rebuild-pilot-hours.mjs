#!/usr/bin/env node
/**
 * Recompute pilot-logbook totals from the stored flight log and baseline.
 *
 * This does not read the schedule. The Pilot Safety screen is what credits
 * new legs. Run this when totals need to be rebuilt from the ledger that is
 * already in Firestore.
 *
 * Dry-run unless --apply is present. Never prints service-account material.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/rebuild-pilot-hours.mjs
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/rebuild-pilot-hours.mjs --apply
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { rollUpPilotHours } from '../src/flight-log.js';
import { normalizeLogbook } from '../src/pilot-safety.js';

const apply = process.argv.includes('--apply');

const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!rawServiceAccount) {
  console.error(
    'FIREBASE_SERVICE_ACCOUNT_JSON is required. No database changes were made.',
  );
  process.exit(2);
}

let credential;
try {
  credential = JSON.parse(rawServiceAccount);
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. No database changes were made.');
  process.exit(2);
}

const app = admin.apps.length
  ? admin.app()
  : admin.initializeApp({ credential: admin.credential.cert(credential) });
const db = getFirestore(app, 'appusers');

const [logbookSnap, entrySnap] = await Promise.all([
  db.collection('pilot-logbooks').get(),
  db.collection('pilot-flight-log').get(),
]);

const entriesByUid = new Map();
entrySnap.forEach((entry) => {
  const data = { ...entry.data(), id: entry.id };
  if (!entriesByUid.has(data.uid)) entriesByUid.set(data.uid, []);
  entriesByUid.get(data.uid).push(data);
});

const now = Date.now();
let changed = 0;
let skipped = 0;
for (const docSnap of logbookSnap.docs) {
  const book = normalizeLogbook({ ...docSnap.data(), uid: docSnap.id }, docSnap.id);
  if (!book.baseline?.asOf) {
    skipped += 1;
    console.log(`SKIP · ${book.pilotName || docSnap.id} · no baseline as-of date`);
    continue;
  }
  const rolled = rollUpPilotHours({
    baseline: book.baseline,
    storedHours: book.hours,
    entries: entriesByUid.get(docSnap.id) || [],
    now,
  });
  const before = book.hours?.totalTime ?? 'blank';
  const after = rolled.hours.totalTime ?? 'blank';
  console.log(
    `${apply ? 'WRITE' : 'DRY'} · ${book.pilotName || docSnap.id} · total ${before} → ${after} · as of ${rolled.meta.asOf}`,
  );
  if (!apply) continue;
  changed += 1;
  await docSnap.ref.set({
    ...book,
    uid: docSnap.id,
    hours: rolled.hours,
    hoursMeta: rolled.meta,
    updatedAt: now,
    updatedBy: 'rebuild-pilot-hours',
    updatedByName: 'Flight log rebuild',
  });
}

console.log(
  apply
    ? `Updated ${changed} logbook${changed === 1 ? '' : 's'}. Skipped ${skipped} without a baseline date.`
    : `Dry run. ${logbookSnap.size - skipped} logbook${logbookSnap.size - skipped === 1 ? '' : 's'} would update. Skipped ${skipped}. Re-run with --apply to write.`,
);
