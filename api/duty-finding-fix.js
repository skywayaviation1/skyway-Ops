import { reviewerSessionBlock } from '../src/reviewer-account.js';
// Administrator fixes for duty findings.
//
// The browser sends the action and the record ids. The server reloads
// duty-periods-v2, plans the fix, and refuses to write if a bulk fingerprint
// moved. Every apply stores the before and after documents in duty-audit-log
// so undo can put the snapshot back. Clients cannot read that collection.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { omitUndefined, planFindingFix, planFingerprint, undoPlan } from '../src/duty-findings.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const COLL = 'duty-periods-v2';
const AUDIT_COLL = 'duty-audit-log';
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

function json(res, status, body) {
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'POST only' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!body.idToken) return json(res, 401, { ok: false, error: 'idToken required' });
    let caller;
    try {
      caller = reviewerSessionBlock(await getAdmin().auth().verifyIdToken(body.idToken));
    } catch {
      return json(res, 401, { ok: false, error: 'invalid idToken' });
    }
    const database = getDb();
    const profileSnap = await database.collection('users').doc(caller.uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : null;
    if (!profile || !ADMIN_ROLES.has(String(profile.role || '').toLowerCase())) {
      return json(res, 403, { ok: false, error: 'admin role required' });
    }
    const actorName = profile.name || profile.displayName || caller.email || caller.uid;
    const now = Date.now();
    const mode = body.mode || 'apply';

    if (mode === 'list') {
      const snap = await database.collection(AUDIT_COLL)
        .where('source', '==', 'finding-fix')
        .limit(40)
        .get();
      const audits = snap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, 20)
        .map((audit) => ({
          id: audit.id,
          at: audit.at || null,
          byName: audit.byName || null,
          reason: audit.reason || '',
          kind: audit.kind || null,
          summary: audit.summary || '',
          undoneAt: audit.undoneAt || null,
          periodIds: (audit.before || []).map((row) => row.id),
        }));
      return json(res, 200, { ok: true, audits });
    }

    if (mode === 'undo') {
      if (!body.auditId) return json(res, 400, { ok: false, error: 'auditId required' });
      const auditRef = database.collection(AUDIT_COLL).doc(String(body.auditId));
      const auditSnap = await auditRef.get();
      if (!auditSnap.exists) return json(res, 404, { ok: false, error: 'Fix not found' });
      const audit = { id: auditSnap.id, ...auditSnap.data() };
      if (audit.source !== 'finding-fix') return json(res, 400, { ok: false, error: 'That audit entry is not a duty fix' });
      const plan = undoPlan(audit, { reason: body.reason, actorName, now });
      if (!plan.ok) return json(res, plan.status || 400, { ok: false, error: plan.error });
      const batch = database.batch();
      for (const write of plan.writes) {
        batch.set(database.collection(COLL).doc(write.id), write.data);
      }
      batch.update(auditRef, { undoneAt: now, undoneBy: actorName, undoReason: plan.reason });
      const undoRef = database.collection(AUDIT_COLL).doc();
      batch.set(undoRef, omitUndefined({
        id: undoRef.id,
        at: now,
        byUid: caller.uid,
        byName: actorName,
        reason: plan.reason,
        source: 'finding-fix',
        kind: 'undo',
        summary: plan.summary,
        restores: audit.id,
        before: plan.before,
        after: plan.after,
        undoneAt: null,
      }));
      await batch.commit();
      const records = plan.after.map((row) => ({ id: row.id, ...row.data }));
      return json(res, 200, { ok: true, mode: 'undo', auditId: undoRef.id, summary: plan.summary, records });
    }

    const cutoff = now - 365 * 2 * 24 * 3600 * 1000;
    const periodSnap = await database.collection(COLL).where('dutyOnAt', '>=', cutoff).get();
    const periods = periodSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const plan = planFindingFix({
      kind: body.kind,
      periods,
      periodId: body.periodId || null,
      otherId: body.otherId || null,
      dropId: body.dropId || null,
      partnerPeriodId: body.partnerPeriodId || null,
      pilotUid: body.pilotUid || null,
      dutyOnAt: body.dutyOnAt,
      dutyOffAt: body.dutyOffAt,
      over14Verified: body.over14Verified === true,
      force: body.force === true,
      reason: body.reason,
      actorName,
      now,
    });
    if (!plan.ok) return json(res, plan.status || 400, { ok: false, error: plan.error });

    if (mode === 'preview') {
      return json(res, 200, {
        ok: true,
        mode: 'preview',
        summary: plan.summary,
        warnings: plan.warnings || [],
        fingerprint: plan.fingerprint,
        changes: plan.changes,
        bulkActions: plan.bulkActions || [],
        limits: plan.limits || [],
      });
    }

    if (body.kind === 'fix-overlaps') {
      if (!body.fingerprint || body.fingerprint !== plan.fingerprint) {
        return json(res, 409, { ok: false, error: 'The overlap preview is stale. Preview again before writing.' });
      }
    } else if (body.fingerprint && body.fingerprint !== planFingerprint(plan)) {
      return json(res, 409, { ok: false, error: 'The duty record changed. Review the fix again.' });
    }

    if (plan.writes.length === 0) return json(res, 200, { ok: true, summary: plan.summary, records: [], auditId: null });
    if (plan.writes.length > 400) {
      return json(res, 400, { ok: false, error: 'That fix touches too many records. Narrow it and try again.' });
    }

    const batch = database.batch();
    for (const write of plan.writes) {
      batch.update(database.collection(COLL).doc(write.id), omitUndefined(write.patch));
    }
    const auditRef = database.collection(AUDIT_COLL).doc();
    batch.set(auditRef, omitUndefined({
      id: auditRef.id,
      at: now,
      byUid: caller.uid,
      byName: actorName,
      reason: plan.reason,
      source: 'finding-fix',
      kind: plan.kind,
      summary: plan.summary,
      warnings: plan.warnings || [],
      fingerprint: plan.fingerprint,
      limits: plan.limits || [],
      before: plan.before,
      after: plan.after,
      undoneAt: null,
    }));
    await batch.commit();
    const records = plan.after.map((row) => ({ id: row.id, ...row.data }));
    return json(res, 200, {
      ok: true,
      mode: 'apply',
      auditId: auditRef.id,
      summary: plan.summary,
      warnings: plan.warnings || [],
      limits: plan.limits || [],
      records,
    });
  } catch (err) {
    console.error('[duty-finding-fix]', err);
    return json(res, err.status || 500, { ok: false, error: err?.message || 'duty fix failed' });
  }
}
