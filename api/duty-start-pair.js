// Atomic, symmetric PIC/SIC duty-on.
//
// Either assigned crewmember can initiate. Both operational records begin at
// the same instant and are cross-linked. Only the caller is self-attested;
// the counterpart is pending until they personally confirm fitness for duty.
// This preserves the attestation boundary while keeping the crew's duty clock
// synchronized from the first write.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const COLL = 'duty-periods-v2';
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

function finite(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function periodDoc({ own, role, otherId, shared, callerUid, now }) {
  const selfAttested = own.pilotUid === callerUid;
  return {
    id: `${own.pilotUid}_${shared.dutyOnAt}`,
    pilotUid: own.pilotUid,
    pilotName: own.pilotName || 'Unknown',
    location: shared.location,
    tail: shared.tail,
    tripId: shared.tripId,
    role,
    crewType: 'two',
    assignmentType: shared.assignmentType,
    fitForDuty: selfAttested ? true : null,
    priorRestMs: finite(own.priorRestMs),
    dutyOnAt: shared.dutyOnAt,
    dutyOffAt: null,
    flightTimeMs: 0,
    excursionReason: null,
    overrideStatus: 'none',
    overrideRequestedBy: null,
    overrideRequestedAt: null,
    overrideRequestReason: null,
    overrideApprovedBy: null,
    overrideApprovedAt: null,
    overrideApprovalNotes: null,
    confirmStatus: selfAttested ? 'self-attested' : 'pending',
    partnerPeriodId: otherId,
    pendingCreatedBy: selfAttested ? null : callerUid,
    confirmedAt: null,
    declinedAt: null,
    declinedReason: null,
    adminEdits: [{
      by: own.pilotName || 'crew',
      at: now,
      field: 'pairedDutyOn',
      from: null,
      to: { status: 'on', dutyOnAt: shared.dutyOnAt },
      note: selfAttested
        ? `Started linked ${role}/crew duty`
        : `Crew-synced duty on; awaiting ${role} fit-for-duty confirmation`,
    }],
    createdAt: now,
    updatedAt: now,
    status: 'on',
    over14: false,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { idToken, picOpts, sicOpts } = body;
    if (!idToken) return res.status(401).json({ ok: false, error: 'idToken required' });
    if (!picOpts?.pilotUid || !sicOpts?.pilotUid) {
      return res.status(400).json({ ok: false, error: 'PIC and SIC are required' });
    }
    if (picOpts.pilotUid === sicOpts.pilotUid) {
      return res.status(400).json({ ok: false, error: 'PIC and SIC must be different pilots' });
    }

    let caller;
    try {
      caller = await getAdmin().auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ ok: false, error: 'invalid idToken' });
    }
    if (![picOpts.pilotUid, sicOpts.pilotUid].includes(caller.uid)) {
      return res.status(403).json({ ok: false, error: 'caller must be the PIC or SIC being started' });
    }

    const database = getDb();
    const profileSnaps = await Promise.all([
      database.collection('users').doc(picOpts.pilotUid).get(),
      database.collection('users').doc(sicOpts.pilotUid).get(),
    ]);
    for (const [index, snap] of profileSnaps.entries()) {
      const label = index === 0 ? 'PIC' : 'SIC';
      if (!snap.exists) return res.status(400).json({ ok: false, error: `${label} profile not found` });
      const profile = snap.data() || {};
      if (profile.approved !== true || profile.active === false || !PILOT_ROLES.has(String(profile.role || '').toLowerCase())) {
        return res.status(400).json({ ok: false, error: `${label} is not an active approved pilot` });
      }
    }

    const callerOpts = caller.uid === picOpts.pilotUid ? picOpts : sicOpts;
    if (callerOpts.fitForDuty !== true) {
      return res.status(400).json({ ok: false, error: 'fit-for-duty attestation required for the initiating pilot' });
    }
    const assignmentType = callerOpts.assignmentType || picOpts.assignmentType || sicOpts.assignmentType;
    if (!['regular', 'unscheduled'].includes(assignmentType)) {
      return res.status(400).json({ ok: false, error: 'assignmentType must be regular or unscheduled' });
    }

    // Both names are resolved from server-side profiles. A browser cannot
    // create an audit record under someone else's display name.
    const picProfile = profileSnaps[0].data();
    const sicProfile = profileSnaps[1].data();
    const dutyOnAt = finite(callerOpts.dutyOnAt, Date.now());
    const now = Date.now();
    const shared = {
      dutyOnAt,
      assignmentType,
      location: callerOpts.location || picOpts.location || sicOpts.location || '',
      tail: callerOpts.tail || picOpts.tail || sicOpts.tail || null,
      tripId: callerOpts.tripId || picOpts.tripId || sicOpts.tripId || null,
    };
    if (!shared.location) {
      return res.status(400).json({ ok: false, error: 'location required' });
    }
    if (dutyOnAt > now + 60_000) {
      return res.status(400).json({ ok: false, error: 'duty-on time cannot be in the future' });
    }

    const pic = { ...picOpts, pilotName: picProfile.name || picOpts.pilotName || 'Unknown' };
    const sic = { ...sicOpts, pilotName: sicProfile.name || sicOpts.pilotName || 'Unknown' };
    const picId = `${pic.pilotUid}_${dutyOnAt}`;
    const sicId = `${sic.pilotUid}_${dutyOnAt}`;

    // Query guards are repeated inside one transaction. The query reads make
    // concurrent paired starts conflict when either pilot's result set changes,
    // and the deterministic doc reads prevent accidental historical overwrite.
    const result = await database.runTransaction(async (tx) => {
      const openQueries = [pic.pilotUid, sic.pilotUid].map((uid) => (
        database.collection(COLL).where('pilotUid', '==', uid).where('status', '==', 'on')
      ));
      const [picOpen, sicOpen, picExisting, sicExisting] = await Promise.all([
        tx.get(openQueries[0]),
        tx.get(openQueries[1]),
        tx.get(database.collection(COLL).doc(picId)),
        tx.get(database.collection(COLL).doc(sicId)),
      ]);
      if (!picOpen.empty) throw new Error('PIC already has an open duty period');
      if (!sicOpen.empty) throw new Error('SIC already has an open duty period');
      if (picExisting.exists || sicExisting.exists) throw new Error('A duty record already exists at this start time');

      const picDoc = periodDoc({
        own: pic, role: 'PIC', otherId: sicId, shared, callerUid: caller.uid, now,
      });
      const sicDoc = periodDoc({
        own: sic, role: 'SIC', otherId: picId, shared, callerUid: caller.uid, now,
      });
      tx.create(database.collection(COLL).doc(picId), picDoc);
      tx.create(database.collection(COLL).doc(sicId), sicDoc);
      return { picPeriod: picDoc, sicPeriod: sicDoc };
    });

    // Privacy boundary: return only the caller's own duty record. The linked
    // partner record is server-managed and visible only to that pilot or an
    // administrator through their authorized surfaces.
    const ownPeriod = caller.uid === pic.pilotUid ? result.picPeriod : result.sicPeriod;
    return res.status(200).json({
      ok: true,
      period: ownPeriod,
      linked: true,
    });
  } catch (err) {
    const message = err?.message || 'paired duty start failed';
    const conflict = /already has|already exists/i.test(message);
    console.error('[duty-start-pair]', message);
    return res.status(conflict ? 409 : 500).json({ ok: false, error: message });
  }
}
