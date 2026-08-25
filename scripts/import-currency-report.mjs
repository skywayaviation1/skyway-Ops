#!/usr/bin/env node
/**
 * Import a JetInsight Crew checks by crew member PDF into pilot-currencies.
 *
 * Safe defaults:
 *   - dry-run unless --apply is present
 *   - refuses to write when any report pilot is unmatched/ambiguous
 *   - never prints service-account material
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *     node scripts/import-currency-report.mjs /path/to/report.pdf
 *
 *   # After reviewing the matches:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' \
 *     node scripts/import-currency-report.mjs /path/to/report.pdf --apply
 */

import { readFile } from 'node:fs/promises';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  buildCurrencyPatch,
  parseJetInsightReportItems,
} from '../src/currency-report-parser.js';

const reportPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!reportPath) {
  console.error('Usage: node scripts/import-currency-report.mjs <report.pdf> [--apply]');
  process.exit(2);
}

const normalize = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const tokens = (value) => normalize(value).split(' ').filter(Boolean);

function matchPilot(name, users) {
  const target = normalize(name);
  const exact = users.filter((user) => user.names.some((candidate) => candidate === target));
  if (exact.length === 1) return { user: exact[0], reason: 'exact' };
  if (exact.length > 1) return { user: null, reason: 'ambiguous exact match' };

  const parts = tokens(name);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return { user: null, reason: 'name is incomplete' };
  const fuzzy = users.filter((user) => user.names.some((candidate) => {
    const candidateParts = new Set(tokens(candidate));
    return candidateParts.has(first) && candidateParts.has(last);
  }));
  if (fuzzy.length === 1) return { user: fuzzy[0], reason: 'first + last' };
  return {
    user: null,
    reason: fuzzy.length ? `ambiguous (${fuzzy.length} first/last matches)` : 'no user match',
  };
}

async function extractItems(path) {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
  }).promise;
  const items = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      items.push({
        str: item.str,
        x: item.transform[4],
        y: viewport.height - item.transform[5],
        page: pageNumber,
      });
    }
  }
  return { items, pages: pdf.numPages };
}

const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!rawServiceAccount) {
  console.error(
    'FIREBASE_SERVICE_ACCOUNT_JSON is required to match this report to live user profiles. '
    + 'No database changes were made.',
  );
  process.exit(2);
}

const app = admin.apps.length
  ? admin.app()
  : admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(rawServiceAccount)),
  });
const db = getFirestore(app, 'appusers');

const { items, pages } = await extractItems(reportPath);
const parsed = parseJetInsightReportItems(items);
if (parsed.warnings.length) {
  for (const warning of parsed.warnings) console.warn(`WARNING: ${warning}`);
}
if (parsed.pilots.length === 0) {
  console.error('No pilot rows parsed; no database changes were made.');
  process.exit(1);
}

const userSnap = await db.collection('users').get();
const users = userSnap.docs.map((doc) => {
  const data = doc.data() || {};
  return {
    uid: doc.id,
    display: data.name || data.jetinsightName || data.email || doc.id,
    names: [data.name, data.jetinsightName, data.displayName]
      .filter(Boolean)
      .map(normalize),
  };
});

const rows = parsed.pilots.map((pilot) => {
  const match = matchPilot(pilot.name, users);
  return { pilot, match, patch: buildCurrencyPatch(pilot) };
});

console.log(`Report: ${pages} pages · ${parsed.pilots.length} pilots · 24 checks per pilot`);
for (const row of rows) {
  console.log(
    `${row.match.user ? 'MATCH' : 'UNMATCHED'} · ${row.pilot.name}`
    + (row.match.user ? ` → ${row.match.user.display} [${row.match.reason}]` : ` · ${row.match.reason}`)
    + ` · ${Object.keys(row.patch.updates).length} check fields`
    + (row.patch.medical ? ` · ${row.patch.medical.class} medical` : ' · no medical'),
  );
}

const unmatched = rows.filter((row) => !row.match.user);
if (unmatched.length) {
  console.error(`${unmatched.length} pilot(s) unmatched. Resolve the roster names before applying; no changes made.`);
  process.exit(1);
}

if (!apply) {
  console.log('DRY RUN ONLY — rerun with --apply after reviewing every match.');
  process.exit(0);
}

const batch = db.batch();
const now = Date.now();
for (const row of rows) {
  const updates = { ...row.patch.updates };
  if (row.patch.medical) updates.medical = row.patch.medical;
  batch.set(db.collection('pilot-currencies').doc(row.match.user.uid), {
    ...updates,
    uid: row.match.user.uid,
    pilotName: row.match.user.display,
    updatedAt: now,
    updatedBy: 'currency-report-import',
    reportImportedAt: now,
    reportSource: 'JetInsight Crew checks by crew member',
  }, { merge: true });
}
await batch.commit();
console.log(`APPLIED: updated ${rows.length} pilot currency records.`);

