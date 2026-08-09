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
// the two crew records split. Every admin function (addPartner / removePartner
// / link / unlink) already cascades to the partner in a batch; the one
// daily-use path (endDuty) did not.
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
//             endedByName?
//           }
// Response: { ok, closed: [ids], dutyOffAt, alreadyClosed? }
//
// Env vars (already present for other endpoints):
//   FIREBASE_SERVICE_ACCOUNT_JSON

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { sendOver14DutyEmail } from './_duty-alert.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const COLL = 'duty-periods-v2';
const MS_14H = 14 * 3600 * 1000;
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

    // --- Load partner (if any) up front: needed for both authz and cascade ---
    let partnerRef = null;
    let partner = null;
    if (period.partnerPeriodId) {
      partnerRef = db.collection(COLL).doc(period.partnerPeriodId);
      const ps = await partnerRef.get();
      if (ps.exists) partner = ps.data();
      else partnerRef = null;
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
    // record. The server still closes both records, but only the caller's own
    // period accepts caller-supplied details.
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

    // --- Resolve dutyOffAt ---
    const dutyOffAt = Number.isFinite(body.dutyOffAt) ? body.dutyOffAt : Date.now();
    if (dutyOffAt <= period.dutyOnAt) {
      res.status(400).json({ ok: false, error: 'dutyOffAt must be after dutyOnAt' });
      return;
    }
    const endedBy = body.endedByName || period.pilotName || 'pilot';
    const now = Date.now();
    const closed = [];
    const initiatorOver14 = (dutyOffAt - period.dutyOnAt) > MS_14H;
    const partnerOffAt = partner && dutyOffAt <= partner.dutyOnAt
      ? partner.dutyOnAt + 1
      : dutyOffAt;
    const partnerOver14 = Boolean(
      partner && partner.status === 'on' && partnerOffAt - partner.dutyOnAt > MS_14H,
    );
    if ((initiatorOver14 || partnerOver14) && body.over14Verified !== true) {
      res.status(400).json({
        ok: false,
        error: 'Confirm that this duty period actually exceeded 14 hours before ending duty',
        code: 'over14-verification-required',
      });
      return;
    }

    const batch = db.batch();

    // --- Close the initiator's period ---
    const flightTimeMs = Number.isFinite(body.flightTimeMs) ? body.flightTimeMs : (period.flightTimeMs || 0);
    const pEdits = Array.isArray(period.adminEdits) ? period.adminEdits : [];
    batch.update(ref, {
      dutyOffAt,
      flightTimeMs,
      excursionReason: body.excursionReason || period.excursionReason || null,
      status: 'off',
      over14: initiatorOver14,
      over14VerifiedAt: initiatorOver14 ? now : null,
      over14VerifiedBy: initiatorOver14 ? endedBy : null,
      over14VerificationSource: initiatorOver14 ? 'pilot-duty-off' : null,
      updatedAt: now,
      adminEdits: [...pEdits, {
        by: endedBy,
        at: now,
        field: 'endDuty',
        from: { status: 'on', dutyOffAt: null },
        to: { status: 'off', dutyOffAt },
        note: body.excursionReason || null,
      }],
    });
    closed.push(periodId);

    // --- Cascade: close the paired partner at the SAME dutyOffAt ---
    // Skip if the partner already closed, or declined the pairing (status would
    // already be 'off' in that case, but we double-guard). The partner's own
    // flightTimeMs is left untouched — each pilot owns their flight time.
    if (partner && partnerRef && partner.status === 'on' && partner.confirmStatus !== 'declined') {
      const sEdits = Array.isArray(partner.adminEdits) ? partner.adminEdits : [];
      batch.update(partnerRef, {
        dutyOffAt: partnerOffAt,
        status: 'off',
        over14: partnerOver14,
        over14VerifiedAt: partnerOver14 ? now : null,
        over14VerifiedBy: partnerOver14 ? endedBy : null,
        over14VerificationSource: partnerOver14 ? 'crew-synced-duty-off' : null,
        updatedAt: now,
        adminEdits: [...sEdits, {
          by: endedBy,
          at: now,
          field: 'endDuty',
          from: { status: 'on', dutyOffAt: null },
          to: { status: 'off', dutyOffAt: partnerOffAt },
          note: `Crew-synced duty off — closed automatically when ${endedBy} (${period.role || 'crew'}) ended duty`,
        }],
      });
      closed.push(period.partnerPeriodId);
    }

    await batch.commit();

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
          verificationSource: 'Crew-synced pilot duty-off confirmation',
        });
      } catch (err) {
        await db.collection('duty-alert-failures').add({
          type: 'over14',
          periodId: partner.id || period.partnerPeriodId,
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
      over14: initiatorOver14 || partnerOver14,
      email,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'duty-end-pair failed' });
  }
}
