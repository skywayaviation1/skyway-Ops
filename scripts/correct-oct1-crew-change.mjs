#!/usr/bin/env node
/**
 * Correct the Oct 1, 2026 Matt / Daniel / Kameron crew-change records.
 *
 * Dry-run is the default and writes nothing. Apply is explicit.
 *
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *     node scripts/correct-oct1-crew-change.mjs
 *
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *     node scripts/correct-oct1-crew-change.mjs --apply
 *
 * The service account must be able to read and write the named Firestore
 * database `appusers` in project skyway-ops-app. The script never prints
 * the credential.
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { planOct1CrewCorrection } from '../src/duty-crew-change.js';
import { applyDutyWrites, loadOct1Records } from '../api/duty-oct1-correction.js';

const apply = process.argv.includes('--apply');
const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not set. No production data was read or written.');
  console.error('');
  console.error('Dry run (prints before/after, writes nothing):');
  console.error("  FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/correct-oct1-crew-change.mjs");
  console.error('');
  console.error('Apply after reviewing the dry run:');
  console.error("  FIREBASE_SERVICE_ACCOUNT_JSON='...' node scripts/correct-oct1-crew-change.mjs --apply");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Nothing was written.');
  process.exit(1);
}

const app = admin.apps.length
  ? admin.app()
  : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = getFirestore(app, 'appusers');
const now = Date.now();
const loaded = await loadOct1Records(db, now);
const plan = planOct1CrewCorrection({
  ...loaded,
  now,
  actorName: apply ? 'oct1-crew-correction --apply' : 'oct1-crew-correction --dry-run',
});

const printable = {
  mode: apply ? 'apply' : 'dry-run',
  incidentDate: plan.incidentDate,
  timeZone: plan.timeZone,
  dayStart: new Date(plan.dayStart).toISOString(),
  dayEnd: new Date(plan.dayEnd).toISOString(),
  applicable: plan.applicable,
  alreadyApplied: plan.alreadyApplied,
  continuous: plan.continuous,
  reason: plan.reason,
  warnings: plan.warnings,
  flightTimeNote: plan.flightTimeNote,
  pilots: plan.pilots,
  changes: plan.changes,
  before: plan.before,
  after: plan.after,
  wrong16HourBlockCleared: plan.wrong16HourBlockCleared ?? null,
  signOnAllowedAt0800EtOct2: plan.signOnAllowedAt0800EtOct2 ?? null,
};

console.log(JSON.stringify(printable, null, 2));

if (!apply) {
  console.error('\nDry run only. No production records were changed.');
  process.exit(plan.applicable || plan.alreadyApplied ? 0 : 2);
}

if (!plan.applicable) {
  console.error(`\nRefusing to apply: ${plan.reason}`);
  process.exit(2);
}

await applyDutyWrites(db, plan.writes);
console.error(`\nApplied ${plan.writes.length} write(s). Each record has an audit entry.`);
