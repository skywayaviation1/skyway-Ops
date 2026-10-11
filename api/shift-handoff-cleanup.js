// Daily retention for shift handoff notes in the `appusers` database.
//
// Vercel Cron sends GET with `Authorization: Bearer ${CRON_SECRET}`.
// POST is accepted for a manual run. Add `?dryRun=1` to count deletions
// without writing. Documents with a submitted (or created) time strictly
// older than 7 days are deleted. Undated documents are left in place and
// counted as skipped.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import {
  HANDOFF_COLLECTION,
  HANDOFF_DATABASE_ID,
  chunkIds,
  runShiftHandoffCleanup,
} from '../src/shift-handoff.js';

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

export function cronRequestAuthorized(req, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  return header === `Bearer ${secret}`;
}

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function cleanupDryRun(req) {
  const query = req.query || {};
  if (isTruthy(query.dryRun) || isTruthy(query.dry_run)) return true;
  const body = req.body;
  if (body && (isTruthy(body.dryRun) || isTruthy(body.dry_run))) return true;
  const url = req.url || '';
  try {
    const params = new URL(url, 'http://localhost').searchParams;
    if (isTruthy(params.get('dryRun')) || isTruthy(params.get('dry_run'))) return true;
  } catch {
    // A relative URL that URL cannot parse is not a dry run.
  }
  return false;
}

export async function listHandoffDocs(db) {
  const snap = await db.collection(HANDOFF_COLLECTION).get();
  return snap.docs.map((doc) => ({
    id: doc.id,
    ...(typeof doc.data === 'function' ? doc.data() : doc.data),
  }));
}

export async function deleteHandoffDocs(db, ids) {
  const chunks = chunkIds(ids);
  let deleted = 0;
  for (const slice of chunks) {
    const batch = db.batch();
    for (const id of slice) batch.delete(db.collection(HANDOFF_COLLECTION).doc(id));
    await batch.commit();
    deleted += slice.length;
  }
  return deleted;
}

function defaultDb() {
  return getFirestore(getAdmin(), HANDOFF_DATABASE_ID);
}

export function createShiftHandoffCleanupHandler({
  authorize = cronRequestAuthorized,
  openDb,
  log = console.log,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'GET or POST only' });
      return;
    }
    if (!authorize(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const db = openDb ? await openDb() : defaultDb();
      const summary = await runShiftHandoffCleanup({
        dryRun: cleanupDryRun(req),
        log,
        listDocs: () => listHandoffDocs(db),
        deleteDocs: (ids) => deleteHandoffDocs(db, ids),
      });
      res.status(200).json(summary);
    } catch (err) {
      console.error('[shift-handoff-cleanup]', err);
      res.status(500).json({ error: 'Shift handoff cleanup failed' });
    }
  };
}

export default createShiftHandoffCleanupHandler();
