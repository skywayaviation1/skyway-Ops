// api/duty-end-pair.js
//
// Atomic crew-synced DUTY OFF for Part 135 duty tracking (V2).
//
// THE BUG THIS FIXES
// ------------------
// The client `endDuty()` closed only the single period it was handed. It
// never read partnerPeriodId to close the OTHER pilot. So when one pilot
// tapped DUTY OFF, the partner stayed status:'on' — their timer ran past
// 14h, threw a false "Duty Limit Exceeded", their rest never started, and
// the two crew records split.
//
// Closing both is right only when the whole crew is done. A crew change
// (one pilot leaves, a replacement joins, the other pilot keeps flying)
// must end only the pilot who is leaving. That choice is explicit. Naming
// a replacement defaults to ending only the caller.
//
// WHY THIS IS A SERVER ENDPOINT (not a client cascade)
// ----------------------------------------------------
// Closing the partner means writing a doc the calling pilot does NOT own.
// Firestore security rules (correctly) restrict a pilot to writing their own
// records. Rather than loosen those rules, this endpoint runs under the Admin
// SDK (which bypasses rules) and writes BOTH periods in a single atomic batch —
// matching the app's existing pattern for trust-critical cross-user writes
// (see api/send-push.js, api/stream-token.js).
//
// Request:  POST {
//             idToken,                       // Firebase id token of the caller
//             periodId,                      // the period being ended
//             dutyOffAt?,    (ms, default now)
//             flightTimeMs?, (initiator only — partner's own time is untouched)
//             excursionReason?,
//             endedByName?,
//             scope?,        'self' | 'crew' — required when a partner is on duty
//             replacement?,  { pilotUid, pilotName, role? } crew change; forces scope 'self'
//             over14Verified?
//           }
// Response: { ok, closed: [ids], dutyOffAt, scope, alreadyClosed? }
//
// scope 'crew' is the only path that ends the linked partner. A crew change
// (replacement set, or scope omitted while a replacement is named) ends only
// the caller and leaves the partner on their original duty-on time.
//
// Env vars (already present for other endpoints):
//   FIREBASE_SERVICE_ACCOUNT_JSON

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { sendOver14DutyEmail } from './_duty-alert.js';
import { planDutyOff } from '../src/duty-crew-change.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const COLL = 'duty-periods-v2';
const ADMIN_ROLES = new Set(['admin']);

let _adminApp = null;
let _db = null;

function getAdmin() {
  if (_adminApp) return _adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  _adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return _adminApp;
}

function getDb() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { idToken, periodId } = body;
    if (!idToken) { res.status(401).json({ ok: false, error: 'idToken required' }); return; }
    if (!periodId) { res.status(400).json({ ok: false, error: 'periodId required' }); return; }

    // --- Verify caller ---
    let caller;
    try {
      caller = await getAdmin().auth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ ok: false, error: 'invalid idToken' });
      return;
    }
    const callerUid = caller.uid;
    const db = getDb();

    // --- Load the period being ended ---
    const ref = db.collection(COLL).doc(periodId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'duty period not found' }); return; }
    const period = snap.data();

    // --- Load partner (if any). Crew-change writes go through the planner. ---
    let partner = null;
    if (period.partnerPeriodId) {
      const ps = await db.collection(COLL).doc(period.partnerPeriodId).get();
      if (ps.exists) partner = ps.data();
    }

    // --- Authorize: either paired pilot, or an admin-ish role ---
    let isAdmin = false;
    try {
      const userSnap = await db.collection('users').doc(callerUid).get();
      const role = userSnap.exists ? String(userSnap.data().role || '').toLowerCase() : '';
      isAdmin = ADMIN_ROLES.has(role);
    } catch { /* fall through to deny */ }
    // Crew must address their OWN period id. Otherwise a pilot who learns the
    // linked id could submit flight time/excursion data against the partner's
    // record. Only the caller's own period accepts caller-supplied details.
    const authorized = callerUid === period.pilotUid || isAdmin;
    if (!authorized) {
      res.status(403).json({ ok: false, error: 'not authorized to end this duty period' });
      return;
    }

    // --- Idempotency: if the initiator's period is already closed, no-op OK ---
    if (period.status !== 'on') {
      res.status(200).json({ ok: true, alreadyClosed: true, closed: [], dutyOffAt: period.dutyOffAt || null });
      return;
    }

    // --- Resolve dutyOffAt and who, if anyone, goes off with the caller ---
    const dutyOffAt = Number.isFinite(body.dutyOffAt) ? body.dutyOffAt : Date.now();
    const endedBy = body.endedByName || period.pilotName || 'pilot';
    const now = Date.now();
    const replacement = body.replacement?.pilotUid ? {
      pilotUid: String(body.replacement.pilotUid),
      pilotName: body.replacement.pilotName || null,
      role: body.replacement.role || null,
    } : null;

    let replacementOpenPeriod = null;
    if (replacement) {
      const profile = await db.collection('users').doc(replacement.pilotUid).get();
      if (!profile.exists) {
        res.status(400).json({ ok: false, error: 'Replacement pilot profile not found' });
        return;
      }
      const user = profile.data() || {};
      const role = String(user.role || '').toLowerCase();
      const pilotRoles = new Set(['crew', 'pilot', 'admin', 'ops', 'chief-pilot', 'chief_pilot']);
      if (user.approved !== true || user.active === false || !pilotRoles.has(role)) {
        res.status(400).json({ ok: false, error: 'Replacement is not an active approved pilot' });
        return;
      }
      replacement.pilotName = user.name || user.displayName || replacement.pilotName || 'Unknown';
      const open = await db.collection(COLL)
        .where('pilotUid', '==', replacement.pilotUid)
        .where('status', '==', 'on')
        .get();
      if (!open.empty) {
        const docSnap = open.docs[0];
        replacementOpenPeriod = { id: docSnap.id, ...docSnap.data() };
      }
    }

    const partnerRecord = partner ? { id: period.partnerPeriodId, ...partner } : null;
    const plan = planDutyOff({
      period: { id: periodId, ...period },
      partner: partnerRecord,
      dutyOffAt,
      flightTimeMs: Number.isFinite(body.flightTimeMs) ? body.flightTimeMs : undefined,
      excursionReason: body.excursionReason || null,
      scope: body.scope,
      replacement,
      replacementOpenPeriod,
      actorName: endedBy,
      now,
      over14Verified: body.over14Verified === true,
    });
    if (!plan.ok) {
      res.status(plan.status || 400).json({ ok: false, error: plan.error, code: plan.code || null });
      return;
    }

    const batch = db.batch();
    const closed = [];
    for (const write of plan.writes) {
      if (write.op === 'create') {
        batch.set(db.collection(COLL).doc(write.id), write.doc);
      } else {
        batch.update(db.collection(COLL).doc(write.id), write.patch);
        if (write.patch?.status === 'off') closed.push(write.id);
      }
    }
    await batch.commit();

    const initiatorOver14 = plan.initiatorOver14;
    const partnerOver14 = plan.partnerOver14;
    const flightTimeMs = Number.isFinite(body.flightTimeMs) ? body.flightTimeMs : (period.flightTimeMs || 0);
    const partnerOffAt = dutyOffAt;

    let email = null;
    if (initiatorOver14) {
      try {
        email = await sendOver14DutyEmail({
          period: {
            ...period,
            dutyOffAt,
            flightTimeMs,
            excursionReason: body.excursionReason || period.excursionReason || null,
            over14: true,
          },
          verifiedBy: endedBy,
          verificationSource: 'Pilot duty-off confirmation',
        });
      } catch (err) {
        email = { sent: false, reason: err?.message || 'email failed' };
        await db.collection('duty-alert-failures').add({
          type: 'over14',
          periodId,
          recipients: ['Jim@flyskyway.com', 'Jake@flyskyway.com', 'zack.taylor@flyskyway.com'],
          error: email.reason,
          createdAt: Date.now(),
        }).catch(() => {});
      }
    }
    if (partnerOver14 && partner) {
      try {
        await sendOver14DutyEmail({
          period: {
            ...partner,
            dutyOffAt: partnerOffAt,
            over14: true,
          },
          verifiedBy: endedBy,
          verificationSource: 'Whole-crew duty-off confirmation',
        });
      } catch (err) {
        await db.collection('duty-alert-failures').add({
          type: 'over14',
          periodId: period.partnerPeriodId,
          recipients: ['Jim@flyskyway.com', 'Jake@flyskyway.com', 'zack.taylor@flyskyway.com'],
          error: err?.message || 'email failed',
          createdAt: Date.now(),
        }).catch(() => {});
      }
    }

    res.status(200).json({
      ok: true,
      closed,
      dutyOffAt,
      scope: plan.scope,
      scopeReason: plan.scopeReason,
      over14: initiatorOver14 || partnerOver14,
      email,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'duty-end-pair failed' });
  }
}
