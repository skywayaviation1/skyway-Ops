// Admin duty corrections and finding approvals.
//
// Trust-critical writes run server-side so linked periods update atomically,
// every action gets an audit entry, and over-14-hour corrections cannot be
// saved without explicit verification and escalation email.

import admin from 'firebase-admin';
import { getFirestore, FieldPath } from 'firebase-admin/firestore';
import { sendOver14DutyEmail } from './_duty-alert.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const COLL = 'duty-periods-v2';
const MS_14H = 14 * 3600_000;
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

async function authorize(idToken) {
  const caller = await getAdmin().auth().verifyIdToken(idToken);
  const snap = await getDb().collection('users').doc(caller.uid).get();
  const profile = snap.exists ? snap.data() : null;
  if (!profile || !ADMIN_ROLES.has(String(profile.role || '').toLowerCase())) {
    const err = new Error('admin role required');
    err.status = 403;
    throw err;
  }
  return { caller, profile };
}

async function updateTimes(database, periodId, body, actor) {
  const ref = database.collection(COLL).doc(periodId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('duty period not found');
    err.status = 404;
    throw err;
  }
  const period = { id: snap.id, ...snap.data() };
  const dutyOnAt = Number(body.dutyOnAt);
  const dutyOffAt = body.status === 'on' && body.dutyOffAt == null ? null : Number(body.dutyOffAt);
  if (!Number.isFinite(dutyOnAt)) throw new Error('valid dutyOnAt required');
  if (dutyOffAt != null && (!Number.isFinite(dutyOffAt) || dutyOffAt <= dutyOnAt)) {
    throw new Error('dutyOffAt must be after dutyOnAt');
  }
  const effectiveEnd = dutyOffAt ?? Date.now();
  const over14 = effectiveEnd - dutyOnAt > MS_14H;
  if (over14 && body.over14Verified !== true) {
    const err = new Error('Confirm that this duty period actually exceeded 14 hours before saving');
    err.status = 400;
    throw err;
  }
  const now = Date.now();
  const verification = over14 ? {
    over14VerifiedAt: now,
    over14VerifiedBy: actor.name,
    over14VerificationSource: 'admin-time-edit',
  } : {
    over14VerifiedAt: null,
    over14VerifiedBy: null,
    over14VerificationSource: null,
  };
  if (dutyOffAt == null) {
    const pilotUids = [period.pilotUid];
    if (period.partnerPeriodId) {
      const linkedSnap = await database.collection(COLL).doc(period.partnerPeriodId).get();
      if (linkedSnap.exists) pilotUids.push(linkedSnap.data().pilotUid);
    }
    for (const pilotUid of pilotUids.filter(Boolean)) {
      const open = await database.collection(COLL)
        .where('pilotUid', '==', pilotUid)
        .where('status', '==', 'on')
        .get();
      const conflict = open.docs.find((doc) => ![period.id, period.partnerPeriodId].includes(doc.id));
      if (conflict) throw new Error(`${pilotUid} already has another open duty period`);
    }
  }
  const makePatch = (record) => ({
    dutyOnAt,
    dutyOffAt,
    status: dutyOffAt == null ? 'on' : 'off',
    over14,
    ...verification,
    updatedAt: now,
    adminEdits: [...(Array.isArray(record.adminEdits) ? record.adminEdits : []), {
      by: actor.name,
      at: now,
      field: 'dutyTimes',
      from: { dutyOnAt: record.dutyOnAt, dutyOffAt: record.dutyOffAt, status: record.status },
      to: { dutyOnAt, dutyOffAt, status: dutyOffAt == null ? 'on' : 'off' },
      note: body.note || (over14 ? 'Admin verified duty exceeded 14 hours' : 'Admin corrected duty times'),
    }],
  });

  const batch = database.batch();
  batch.update(ref, makePatch(period));
  let partner = null;
  if (period.partnerPeriodId) {
    const partnerRef = database.collection(COLL).doc(period.partnerPeriodId);
    const partnerSnap = await partnerRef.get();
    if (partnerSnap.exists) {
      partner = { id: partnerSnap.id, ...partnerSnap.data() };
      batch.update(partnerRef, makePatch(partner));
    }
  }
  await batch.commit();

  let email = null;
  let partnerEmail = null;
  if (over14) {
    try {
      email = await sendOver14DutyEmail({
        period: { ...period, dutyOnAt, dutyOffAt, over14: true, excursionReason: body.note || period.excursionReason },
        verifiedBy: actor.name,
        verificationSource: 'Admin duty-time correction',
      });
    } catch (err) {
      email = { sent: false, reason: err?.message || 'email failed' };
      await database.collection('duty-alert-failures').add({
        type: 'over14',
        periodId,
        recipients: ['Jim@flyskyway.com', 'Jake@flyskyway.com', 'zack.taylor@flyskyway.com'],
        error: email.reason,
        createdAt: Date.now(),
      }).catch(() => {});
    }
    if (partner) {
      try {
        partnerEmail = await sendOver14DutyEmail({
          period: {
            ...partner,
            dutyOnAt,
            dutyOffAt,
            over14: true,
            excursionReason: body.note || partner.excursionReason,
          },
          verifiedBy: actor.name,
          verificationSource: 'Linked admin duty-time correction',
        });
      } catch (err) {
        partnerEmail = { sent: false, reason: err?.message || 'email failed' };
        await database.collection('duty-alert-failures').add({
          type: 'over14',
          periodId: partner.id,
          recipients: ['Jim@flyskyway.com', 'Jake@flyskyway.com', 'zack.taylor@flyskyway.com'],
          error: partnerEmail.reason,
          createdAt: Date.now(),
        }).catch(() => {});
      }
    }
  }
  return {
    updated: [period.id, partner?.id].filter(Boolean),
    over14,
    email,
    partnerEmail,
  };
}

async function approveFinding(database, periodId, body, actor) {
  const code = String(body.issueCode || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 60);
  if (!code) throw new Error('issueCode required');
  if (!String(body.note || '').trim()) throw new Error('approval note required');
  const ref = database.collection(COLL).doc(periodId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('duty period not found');
    err.status = 404;
    throw err;
  }
  const period = snap.data();
  const now = Date.now();
  if (code === 'OVER_14') {
    const effectiveEnd = Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : now;
    if (!Number.isFinite(period.dutyOnAt) || effectiveEnd - period.dutyOnAt <= MS_14H) {
      throw new Error('This record does not currently exceed 14 hours; refresh the finding before approval');
    }
    if (body.over14Verified !== true) {
      throw new Error('Verify that the duty period actually exceeded 14 hours before approving this finding');
    }
  }
  const approval = {
    status: 'approved',
    approvedAt: now,
    approvedByUid: actor.uid,
    approvedByName: actor.name,
    note: String(body.note).trim().slice(0, 1000),
  };
  // FieldPath avoids interpreting an issue code as a dotted nested path.
  const updateArgs = [
    new FieldPath('findingApprovals', code), approval,
    'updatedAt', now,
    'adminEdits', [...(Array.isArray(period.adminEdits) ? period.adminEdits : []), {
      by: actor.name,
      at: now,
      field: `findingApprovals.${code}`,
      from: period.findingApprovals?.[code] || null,
      to: approval,
      note: `Approved finding ${code}: ${approval.note}`,
    }],
  ];
  if (code === 'OVER_14') {
    updateArgs.push(
      'over14VerifiedAt', now,
      'over14VerifiedBy', actor.name,
      'over14VerificationSource', 'admin-finding-approval',
    );
  }
  await ref.update(...updateArgs);

  let email = null;
  if (code === 'OVER_14') {
    try {
      email = await sendOver14DutyEmail({
        period: {
          ...period,
          dutyOffAt: Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : now,
          over14: true,
        },
        verifiedBy: actor.name,
        verificationSource: 'Admin requires-attention approval',
      });
    } catch (err) {
      email = { sent: false, reason: err?.message || 'email failed' };
      await database.collection('duty-alert-failures').add({
        type: 'over14',
        periodId,
        recipients: ['Jim@flyskyway.com', 'Jake@flyskyway.com', 'zack.taylor@flyskyway.com'],
        error: email.reason,
        createdAt: Date.now(),
      }).catch(() => {});
    }
  }
  return { issueCode: code, approval, email };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!body.idToken) return res.status(401).json({ ok: false, error: 'idToken required' });
    if (!body.periodId) return res.status(400).json({ ok: false, error: 'periodId required' });
    const { caller, profile } = await authorize(body.idToken);
    const actor = { uid: caller.uid, name: profile.name || caller.email || caller.uid };
    const result = body.action === 'update-times'
      ? await updateTimes(getDb(), body.periodId, body, actor)
      : body.action === 'approve-finding'
        ? await approveFinding(getDb(), body.periodId, body, actor)
        : (() => { throw new Error('unknown action'); })();
    return res.status(200).json({ ok: true, action: body.action, ...result });
  } catch (err) {
    console.error('[duty-admin-action]', err);
    return res.status(err.status || 500).json({ ok: false, error: err?.message || 'admin duty action failed' });
  }
}

