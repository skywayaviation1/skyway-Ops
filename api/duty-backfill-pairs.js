// Admin-only paired-duty audit and backfill.
//
// POST { idToken, mode: 'preview'|'apply', trips: [...] }
//
// Preview and apply both recompute the plan from current Firestore state.
// Apply never trusts action ids supplied by the browser. Missing counterpart
// periods copy the existing pilot's times and assignment data, are marked
// admin-attested, and receive reciprocal partnerPeriodId links plus audit
// entries. Ambiguous evidence is skipped, never guessed.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { buildDutyPairBackfillPlan } from '../src/duty-pairing.js';
import { sendOver14DutyEmail } from './_duty-alert.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const COLL = 'duty-periods-v2';
const RETENTION_DAYS = 365;
const MS_HOUR = 3600_000;
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

function normalizedTrips(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 1000).map((trip) => ({
    uid: String(trip.uid || trip.id || '').slice(0, 200),
    start: trip.start,
    end: trip.end,
    info: {
      tail: String(trip.info?.tail || '').slice(0, 20),
      pic: String(trip.info?.pic || '').slice(0, 160),
      sic: String(trip.info?.sic || '').slice(0, 160),
    },
  })).filter((trip) => trip.uid && trip.start);
}

function cloneCounterpart(source, action, now, adminName, over14Verified) {
  const audit = {
    by: adminName,
    at: now,
    field: 'pairedDutyBackfill',
    from: null,
    to: {
      sourcePeriodId: source.id,
      dutyOnAt: source.dutyOnAt,
      dutyOffAt: source.dutyOffAt,
    },
    note: `Created missing ${action.targetRole} duty from paired ${source.role || 'crew'} record (${action.evidence})`,
  };
  return {
    id: action.targetId,
    pilotUid: action.targetUid,
    pilotName: action.targetName,
    location: source.location || '',
    tail: source.tail || null,
    tripId: action.tripId || source.tripId || null,
    role: action.targetRole,
    crewType: 'two',
    assignmentType: source.assignmentType || 'regular',
    // Shared operational data: paired pilots worked the same duty window and
    // flight legs. Pilot-specific rest, overrides, approvals and audit history
    // are deliberately not cloned.
    dutyOnAt: source.dutyOnAt,
    dutyOffAt: source.dutyOffAt,
    status: source.status === 'on' ? 'on' : 'off',
    flightTimeMs: Number.isFinite(source.flightTimeMs) ? source.flightTimeMs : 0,
    excursionReason: source.excursionReason || null,
    over14: source.over14 === true,
    priorRestMs: null,
    confirmStatus: 'admin-attested',
    fitForDuty: true,
    partnerPeriodId: source.id,
    pendingCreatedBy: `admin-backfill:${adminName}`,
    confirmedAt: now,
    declinedAt: null,
    declinedReason: null,
    overrideStatus: 'none',
    overrideRequestedBy: null,
    overrideRequestedAt: null,
    overrideRequestReason: null,
    overrideApprovedBy: null,
    overrideApprovedAt: null,
    overrideApprovalNotes: null,
    findingApprovals: {},
    over14VerifiedAt: source.over14 && over14Verified ? now : null,
    over14VerifiedBy: source.over14 && over14Verified ? adminName : null,
    over14VerificationSource: source.over14 && over14Verified ? 'admin-paired-duty-backfill' : null,
    adminEdits: [audit],
    createdAt: now,
    updatedAt: now,
    backfilledFromPeriodId: source.id,
    backfillEvidence: action.evidence,
  };
}

async function commitPlan(database, plan, periods, adminName, over14Verified) {
  const byId = new Map(periods.map((period) => [period.id, period]));
  const now = Date.now();
  const writes = [];

  for (const action of plan.actions) {
    if (action.type === 'link') {
      const pic = byId.get(action.picId);
      const sic = byId.get(action.sicId);
      if (!pic || !sic || pic.partnerPeriodId || sic.partnerPeriodId) continue;
      const audit = {
        by: adminName,
        at: now,
        field: 'partnerPeriodId',
        from: null,
        note: `Retroactively linked crew periods (${action.evidence})`,
      };
      writes.push({
        kind: 'update',
        ref: database.collection(COLL).doc(pic.id),
        data: {
          partnerPeriodId: sic.id,
          crewType: 'two',
          updatedAt: now,
          adminEdits: [...(Array.isArray(pic.adminEdits) ? pic.adminEdits : []), { ...audit, to: sic.id }],
        },
      });
      writes.push({
        kind: 'update',
        ref: database.collection(COLL).doc(sic.id),
        data: {
          partnerPeriodId: pic.id,
          crewType: 'two',
          updatedAt: now,
          adminEdits: [...(Array.isArray(sic.adminEdits) ? sic.adminEdits : []), { ...audit, to: pic.id }],
        },
      });
    } else if (action.type === 'create') {
      const source = byId.get(action.sourceId);
      if (!source || (source.partnerPeriodId && source.partnerPeriodId !== action.targetId)) continue;
      const targetRef = database.collection(COLL).doc(action.targetId);
      const targetSnap = await targetRef.get();
      if (targetSnap.exists) {
        const target = { id: targetSnap.id, ...targetSnap.data() };
        const agrees = target.pilotUid === action.targetUid
          && String(target.role || '').toUpperCase() === action.targetRole
          && Math.abs(Number(target.dutyOnAt) - Number(source.dutyOnAt)) <= 30 * 60_000
          && (!target.partnerPeriodId || target.partnerPeriodId === source.id);
        if (!agrees) continue;
        const sourceAudit = {
          by: adminName,
          at: now,
          field: 'partnerPeriodId',
          from: source.partnerPeriodId || null,
          to: target.id,
          note: `Linked to existing counterpart found during apply (${action.evidence})`,
        };
        writes.push({
          kind: 'update',
          ref: targetRef,
          data: {
            partnerPeriodId: source.id,
            crewType: 'two',
            updatedAt: now,
            adminEdits: [...(Array.isArray(target.adminEdits) ? target.adminEdits : []), {
              ...sourceAudit,
              from: target.partnerPeriodId || null,
              to: source.id,
            }],
          },
        });
        writes.push({
          kind: 'update',
          ref: database.collection(COLL).doc(source.id),
          data: {
            partnerPeriodId: target.id,
            crewType: 'two',
            updatedAt: now,
            adminEdits: [...(Array.isArray(source.adminEdits) ? source.adminEdits : []), sourceAudit],
          },
        });
        continue;
      }
      const targetDoc = cloneCounterpart(source, action, now, adminName, over14Verified);
      const sourceAudit = {
        by: adminName,
        at: now,
        field: 'partnerPeriodId',
        from: source.partnerPeriodId || null,
        to: action.targetId,
        note: `Linked to retroactively created ${action.targetRole} period (${action.evidence})`,
      };
      writes.push({ kind: 'create', ref: targetRef, data: targetDoc });
      writes.push({
        kind: 'update',
        ref: database.collection(COLL).doc(source.id),
        data: {
          partnerPeriodId: action.targetId,
          crewType: 'two',
          updatedAt: now,
          adminEdits: [...(Array.isArray(source.adminEdits) ? source.adminEdits : []), sourceAudit],
        },
      });
    }
  }

  // Keep the repair atomic. If the plan exceeds one safe Firestore batch,
  // require a narrower/manual run instead of leaving an unaudited half-apply.
  if (writes.length > 400) {
    throw new Error(`Repair requires ${writes.length} document writes; maximum safe atomic run is 400`);
  }
  const batch = database.batch();
  for (const write of writes) {
    if (write.kind === 'create') batch.create(write.ref, write.data);
    else batch.update(write.ref, write.data);
  }
  await batch.commit();
  return {
    documentsWritten: writes.length,
    actionsApplied: Math.floor(writes.length / 2),
    createdPeriods: writes.filter((write) => write.kind === 'create').map((write) => write.data),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!body.idToken) return res.status(401).json({ ok: false, error: 'idToken required' });
    let caller;
    try {
      caller = await getAdmin().auth().verifyIdToken(body.idToken);
    } catch {
      return res.status(401).json({ ok: false, error: 'invalid idToken' });
    }

    const database = getDb();
    const profileSnap = await database.collection('users').doc(caller.uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : null;
    if (!profile || !ADMIN_ROLES.has(String(profile.role || '').toLowerCase())) {
      return res.status(403).json({ ok: false, error: 'admin role required' });
    }

    const cutoff = Date.now() - RETENTION_DAYS * 24 * MS_HOUR;
    const [periodSnap, userSnap] = await Promise.all([
      database.collection(COLL).where('dutyOnAt', '>=', cutoff).get(),
      database.collection('users').get(),
    ]);
    const periods = periodSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const users = userSnap.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
    let tripEvidence;
    let previewRef = null;
    if (body.mode === 'apply') {
      if (!body.previewId) {
        return res.status(400).json({ ok: false, error: 'previewId required; run a fresh read-only audit first' });
      }
      previewRef = database.collection('duty-pair-backfill-previews').doc(String(body.previewId));
      const previewSnap = await previewRef.get();
      const preview = previewSnap.exists ? previewSnap.data() : null;
      if (!preview
          || preview.createdByUid !== caller.uid
          || preview.usedAt
          || !Number.isFinite(preview.expiresAt)
          || preview.expiresAt < Date.now()) {
        return res.status(400).json({ ok: false, error: 'backfill preview is missing, expired, or already used' });
      }
      tripEvidence = Array.isArray(preview.trips) ? preview.trips : [];
    } else {
      tripEvidence = normalizedTrips(body.trips);
    }

    const plan = buildDutyPairBackfillPlan({
      periods,
      users,
      trips: tripEvidence,
    });
    const over14Creates = plan.actions.filter((action) => {
      if (action.type !== 'create') return false;
      const source = periods.find((period) => period.id === action.sourceId);
      return source?.over14 === true
        || (Number.isFinite(source?.dutyOffAt) && source.dutyOffAt - source.dutyOnAt > 14 * MS_HOUR);
    }).length;
    const summary = { ...plan.summary, over14Creates };

    const sample = plan.actions.slice(0, 50).map((action) => {
      const source = periods.find((period) => period.id === (action.sourceId || action.picId));
      return {
        ...action,
        sourcePilot: source?.pilotName || null,
        dutyOnAt: source?.dutyOnAt || null,
        tail: source?.tail || null,
      };
    });

    if (body.mode !== 'apply') {
      previewRef = database.collection('duty-pair-backfill-previews').doc();
      await previewRef.set({
        previewId: previewRef.id,
        createdByUid: caller.uid,
        createdByName: profile.name || caller.email || caller.uid,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60_000,
        usedAt: null,
        trips: tripEvidence,
        summary,
      });
      return res.status(200).json({
        ok: true,
        mode: 'preview',
        previewId: previewRef.id,
        expiresAt: Date.now() + 30 * 60_000,
        summary,
        sample,
        skippedByReason: plan.skips.reduce((counts, item) => {
          counts[item.reason] = (counts[item.reason] || 0) + 1;
          return counts;
        }, {}),
      });
    }

    if (over14Creates > 0 && body.over14Verified !== true) {
      return res.status(400).json({
        ok: false,
        error: `Verify ${over14Creates} over-14-hour backfill record${over14Creates === 1 ? '' : 's'} before applying`,
      });
    }
    const adminName = profile.name || caller.email || caller.uid;
    const runRef = database.collection('duty-pair-backfill-runs').doc();
    await runRef.set({
      runId: runRef.id,
      runByUid: caller.uid,
      runByName: adminName,
      runAt: Date.now(),
      retentionDays: RETENTION_DAYS,
      summary,
      status: 'applying',
      previewId: previewRef.id,
    });
    const result = await commitPlan(database, plan, periods, adminName, body.over14Verified === true);
    const emailResults = [];
    for (const created of result.createdPeriods.filter((period) => period.over14)) {
      try {
        emailResults.push(await sendOver14DutyEmail({
          period: created,
          verifiedBy: adminName,
          verificationSource: 'Admin paired-duty historical backfill',
        }));
      } catch (err) {
        emailResults.push({ sent: false, reason: err?.message || 'email failed' });
      }
    }
    const auditBatch = database.batch();
    auditBatch.update(runRef, {
      status: 'complete',
      completedAt: Date.now(),
      documentsWritten: result.documentsWritten,
      actionsApplied: result.actionsApplied,
      over14Emails: emailResults,
    });
    auditBatch.update(previewRef, { usedAt: Date.now(), runId: runRef.id });
    await auditBatch.commit();
    return res.status(200).json({
      ok: true,
      mode: 'apply',
      runId: runRef.id,
      summary,
      documentsWritten: result.documentsWritten,
      actionsApplied: result.actionsApplied,
      over14Emails: emailResults,
    });
  } catch (err) {
    console.error('[duty-backfill-pairs]', err);
    return res.status(500).json({ ok: false, error: err?.message || 'duty pair backfill failed' });
  }
}

