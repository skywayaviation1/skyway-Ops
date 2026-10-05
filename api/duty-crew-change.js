// Re-link a pilot who is already on duty, or whose duty a partner closed,
// with a new two-pilot partner. The original duty-on time is preserved.
//
// POST { idToken, periodId, partnerUid, joinAt?, partnerRole? }
// Admin, the pilot on the period, or an admin-role caller.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { planRelink } from '../src/duty-crew-change.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const COLL = 'duty-periods-v2';
const ADMIN_ROLES = new Set(['admin']);
const PILOT_ROLES = new Set(['crew', 'pilot', 'admin', 'ops', 'chief-pilot', 'chief_pilot']);

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { idToken, periodId, partnerUid } = body;
    if (!idToken) { res.status(401).json({ ok: false, error: 'idToken required' }); return; }
    if (!periodId || !partnerUid) {
      res.status(400).json({ ok: false, error: 'periodId and partnerUid required' });
      return;
    }

    let caller;
    try {
      caller = await getAdmin().auth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ ok: false, error: 'invalid idToken' });
      return;
    }
    const database = getDb();
    const callerSnap = await database.collection('users').doc(caller.uid).get();
    const callerProfile = callerSnap.exists ? callerSnap.data() : {};
    const isAdmin = ADMIN_ROLES.has(String(callerProfile.role || '').toLowerCase());

    const snap = await database.collection(COLL).doc(periodId).get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'duty period not found' }); return; }
    const stayer = { id: snap.id, ...snap.data() };
    if (caller.uid !== stayer.pilotUid && !isAdmin) {
      res.status(403).json({ ok: false, error: 'not authorized to relink this duty period' });
      return;
    }

    const partnerSnap = await database.collection('users').doc(String(partnerUid)).get();
    if (!partnerSnap.exists) {
      res.status(400).json({ ok: false, error: 'Replacement pilot profile not found' });
      return;
    }
    const partnerProfile = partnerSnap.data() || {};
    const role = String(partnerProfile.role || '').toLowerCase();
    if (partnerProfile.approved !== true || partnerProfile.active === false || !PILOT_ROLES.has(role)) {
      res.status(400).json({ ok: false, error: 'Replacement is not an active approved pilot' });
      return;
    }

    if (stayer.status !== 'on') {
      const open = await database.collection(COLL)
        .where('pilotUid', '==', stayer.pilotUid)
        .where('status', '==', 'on')
        .get();
      if (!open.empty) {
        res.status(409).json({
          ok: false,
          error: 'You already have an open duty period. Pair that period with your new partner instead of reopening the earlier one.',
        });
        return;
      }
    }

    const partnerOpen = await database.collection(COLL)
      .where('pilotUid', '==', partnerSnap.id)
      .where('status', '==', 'on')
      .get();
    const partnerOpenPeriod = partnerOpen.empty
      ? null
      : { id: partnerOpen.docs[0].id, ...partnerOpen.docs[0].data() };
    const joinAt = Number.isFinite(body.joinAt) ? body.joinAt : Date.now();
    const actorName = callerProfile.name || callerProfile.displayName || stayer.pilotName || 'pilot';
    const plan = planRelink({
      stayer,
      partnerUser: {
        pilotUid: partnerSnap.id,
        pilotName: partnerProfile.name || partnerProfile.displayName || 'Unknown',
        role: body.partnerRole || null,
      },
      partnerOpenPeriod,
      joinAt,
      actorName,
      now: Date.now(),
    });
    if (!plan.ok) {
      res.status(plan.status || 400).json({ ok: false, error: plan.error, code: plan.code || null });
      return;
    }

    const batch = database.batch();
    for (const write of plan.writes) {
      const ref = database.collection(COLL).doc(write.id);
      if (write.op === 'create') {
        const existing = await ref.get();
        if (existing.exists) {
          res.status(409).json({ ok: false, error: `A duty record already exists at ${write.id}` });
          return;
        }
        batch.set(ref, write.doc);
      } else {
        batch.update(ref, write.patch);
      }
    }
    await batch.commit();
    res.status(200).json({
      ok: true,
      resumed: plan.resuming,
      dutyOnAt: stayer.dutyOnAt,
      linkedPeriodId: plan.writes.find((write) => write.id !== stayer.id)?.id || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'duty-crew-change failed' });
  }
}
