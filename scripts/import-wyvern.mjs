#!/usr/bin/env node
/**
 * Load a Wyvern ACES pilot export into pilot-logbooks and pilot-currencies.
 *
 * Active pilots only. Match is email, then normalized name, then a Wyvern ID
 * already stored on a logbook. Re-running updates the same uid and does not
 * create a second record. Certificate numbers, dates of birth, addresses, and
 * document files are dropped.
 *
 * Safe defaults:
 *   - dry-run unless --apply is present
 *   - refuses to write when any active pilot is unmatched or ambiguous
 *   - --skip-unmatched writes the matched rows and leaves the rest
 *   - never prints service-account material
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *     node scripts/import-wyvern.mjs ./wyvern-pilots.json
 *
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *     node scripts/import-wyvern.mjs ./wyvern-pilots.csv --apply
 */

import { readFile } from 'node:fs/promises';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import {
  parseWyvernText,
  planWyvernImport,
  wyvernConflictLabel,
  wyvernCurrencyPatch,
  wyvernLogbookDraft,
} from '../src/wyvern-import.js';

const filePath = process.argv[2];
const apply = process.argv.includes('--apply');
const skipUnmatched = process.argv.includes('--skip-unmatched');
if (!filePath || filePath.startsWith('--')) {
  console.error('Usage: node scripts/import-wyvern.mjs <pilots.json|pilots.csv> [--apply] [--skip-unmatched]');
  process.exit(2);
}

let text;
try {
  text = await readFile(filePath, 'utf8');
} catch (err) {
  console.error(`Could not read ${filePath}: ${err.message}`);
  process.exit(1);
}

const parsed = parseWyvernText(text, filePath);
for (const warning of parsed.warnings) console.warn(`WARNING: ${warning}`);
if (!parsed.records.length) {
  console.error('No pilot records parsed. No database changes were made.');
  process.exit(1);
}

const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!rawServiceAccount) {
  console.error(
    'FIREBASE_SERVICE_ACCOUNT_JSON is required to match this export to live user profiles. '
    + 'No database changes were made.',
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

const [userSnap, logbookSnap, currencySnap] = await Promise.all([
  db.collection('users').get(),
  db.collection('pilot-logbooks').get(),
  db.collection('pilot-currencies').get(),
]);

const users = userSnap.docs.map((entry) => {
  const data = entry.data() || {};
  return {
    uid: entry.id,
    name: data.name || data.displayName || '',
    displayName: data.displayName || '',
    jetinsightName: data.jetinsightName || '',
    email: data.email || '',
    approved: data.approved !== false,
  };
});
const logbooks = {};
logbookSnap.forEach((entry) => { logbooks[entry.id] = entry.data() || {}; });
const currencies = {};
currencySnap.forEach((entry) => { currencies[entry.id] = entry.data() || {}; });

const plan = planWyvernImport(parsed.records, { users, logbooks, currencies });
console.log(
  `${parsed.records.length} records · ${plan.rows.length} active · ${plan.skipped.length} skipped (not active)`,
);
for (const entry of plan.skipped) {
  console.log(`SKIP · ${entry.record.name || entry.record.email || entry.record.wyvernId || 'Unknown'} · ${entry.reason}`);
}
for (const row of plan.rows) {
  const who = row.record.name || row.record.email || row.record.wyvernId;
  const linked = row.match.user
    ? `→ ${row.match.user.name || row.match.user.email} [${row.match.reason}]`
    : row.match.reason;
  const label = row.bucket === 'matched' ? 'MATCH' : row.bucket === 'conflict' ? 'CONFLICT' : 'UNMATCHED';
  console.log(`${label} · ${who} ${linked}`);
  for (const item of row.conflicts) {
    console.log(`  ${wyvernConflictLabel(item.field)}: ${item.existing} on file → ${item.incoming} from Wyvern`);
  }
}

const blocked = plan.rows.filter((row) => !row.match.user);
if (blocked.length && !skipUnmatched) {
  console.error(`${blocked.length} active pilot(s) unmatched or ambiguous. Link them in the app, or rerun with --skip-unmatched. No changes made.`);
  process.exit(1);
}

const ready = plan.rows.filter((row) => row.match.user);
if (!ready.length) {
  console.error('No matched active pilots to write. No changes made.');
  process.exit(1);
}

if (!apply) {
  console.log(`DRY RUN ONLY — ${ready.length} pilot(s) would be updated. Rerun with --apply after reviewing every match.`);
  process.exit(0);
}

const now = Date.now();
const writes = [];
for (const row of ready) {
  const uid = row.match.user.uid;
  const draft = wyvernLogbookDraft(logbooks[uid], row.record, {
    uid,
    pilotName: row.match.user.name || row.record.name,
    now,
  });
  writes.push({
    collection: 'pilot-logbooks',
    id: uid,
    data: {
      ...draft,
      uid,
      updatedAt: now,
      updatedBy: 'wyvern-import',
      updatedByName: 'Wyvern import',
    },
    merge: true,
  });
  const currencyPatch = wyvernCurrencyPatch(currencies[uid], row.record, now);
  if (currencyPatch) {
    writes.push({
      collection: 'pilot-currencies',
      id: uid,
      data: {
        ...currencyPatch,
        uid,
        pilotName: row.match.user.name || row.record.name,
        updatedAt: now,
        updatedBy: 'wyvern-import',
      },
      merge: true,
    });
  }
}

const CHUNK = 400;
for (let index = 0; index < writes.length; index += CHUNK) {
  const batch = db.batch();
  for (const write of writes.slice(index, index + CHUNK)) {
    batch.set(db.collection(write.collection).doc(write.id), write.data, { merge: write.merge });
  }
  await batch.commit();
}
console.log(`APPLIED: updated ${ready.length} pilot record(s) from Wyvern.`);
