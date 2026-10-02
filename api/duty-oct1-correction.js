// Admin-only correction for the Oct 1, 2026 crew change.
// mode 'dry-run' (default) prints the plan and writes nothing.
// mode 'apply' writes the plan and an audit entry on every record.
//
// POST { idToken, mode?: 'dry-run' | 'apply' }

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { etDayBounds, planOct1CrewCorrection } from '../src/duty-crew-change.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const COLL = 'duty-periods-v2';
const ADMIN_ROLES = new Set(['admin']);

let app;
let db;

function getAdmin() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  const credential = admin.credential.cert(JSON.parse(raw));
  app = admin.apps.length ? admin.app() : admin.initializeApp({ credential });
  return app;
}

function getDb() {
  if (!db) db = getFirestore(getAdmin(), 'appusers');
  return db;
}

export async function loadOct1Records(database, now = Date.now()) {
  const day = etDayBounds(2026, 10, 1);
  const [usersSnap, periodsSnap] = await Promise.all([
    database.collection('users').get(),
    database.collection(COLL)
      .where('dutyOnAt', '>=', day.start - 36 * 3600 * 1000)
      .where('dutyOnAt', '<', day.end)
      .get(),
  ]);
  const users = usersSnap.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
  const periods = periodsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return { users, periods, now };
}

export async function applyDutyWrites(database, writes) {
  for (const write of writes) {
    if (write.op !== 'create') continue;
    const existing = await database.collection(COLL).doc(write.id).get();
    if (existing.exists) {
      throw new Error(`Refusing to create ${write.id}; a record already exists. Re-run the dry run.`);
    }
  }
  const batch = database.batch();
  for (const write of writes) {
    const ref = database.collection(COLL).doc(write.id);
    if (write.op === 'create') batch.set(ref, write.doc);
    else batch.update(ref, write.patch);
  }
  await batch.commit();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!body.idToken) { res.status(401).json({ ok: false, error: 'idToken required' }); return; }
    const mode = body.mode === 'apply' ? 'apply' : 'dry-run';
    let caller;
    try {
      caller = await getAdmin().auth().verifyIdToken(body.idToken);
    } catch {
      res.status(401).json({ ok: false, error: 'invalid idToken' });
      return;
    }
    const database = getDb();
    const callerSnap = await database.collection('users').doc(caller.uid).get();
    const profile = callerSnap.exists ? callerSnap.data() : {};
    if (!ADMIN_ROLES.has(String(profile.role || '').toLowerCase())) {
      res.status(403).json({ ok: false, error: 'admin role required' });
      return;
    }
    const now = Date.now();
    const loaded = await loadOct1Records(database, now);
    const plan = planOct1CrewCorrection({
      ...loaded,
      now,
      actorName: profile.name || profile.displayName || profile.email || 'admin',
    });
    if (mode === 'apply') {
      if (!plan.applicable) {
        res.status(409).json({ ok: false, error: plan.reason || 'Nothing to apply', plan });
        return;
      }
      await applyDutyWrites(database, plan.writes);
    }
    res.status(200).json({
      ok: true,
      mode,
      applied: mode === 'apply',
      plan,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'oct1 correction failed' });
  }
}
