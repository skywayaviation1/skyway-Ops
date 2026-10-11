import { reviewerSessionBlock } from '../src/reviewer-account.js';
// Admin-only schedule resync for paired duty.
//
// Preview is read-only and stores the scope, the schedule snapshot, and a
// fingerprint for 30 minutes. Apply recomputes against current duty records
// and refuses to write if the fingerprint moved. The browser never sends the
// write list. Every applied change is copied onto the duty record and into
// duty-audit-log.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { planScheduleResync } from '../src/duty-schedule-resync.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const COLL = 'duty-periods-v2';
const PREVIEW_COLL = 'duty-schedule-resync-previews';
const AUDIT_COLL = 'duty-audit-log';
const ADMIN_ROLES = new Set(['admin']);
const PREVIEW_TTL_MS = 30 * 60 * 1000;

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

function normalizedTrips(trips) {
  if (!Array.isArray(trips)) return [];
  return trips.slice(0, 4000).map((trip) => ({
    uid: trip?.uid || trip?.id || null,
    start: trip?.start || null,
    end: trip?.end || null,
    info: {
      tail: trip?.info?.tail || '',
      pic: trip?.info?.pic || '',
      sic: trip?.info?.sic || '',
      from: trip?.info?.from || '',
      to: trip?.info?.to || '',
      category: trip?.info?.category || '',
      tripType: trip?.info?.tripType || '',
    },
  })).filter((trip) => trip.uid && trip.start);
}

function scopeFrom(body) {
  const scope = body?.scope || {};
  return {
    kind: scope.kind,
    day: scope.day || null,
    startDay: scope.startDay || null,
    endDay: scope.endDay || null,
    pilotUid: scope.pilotUid || null,
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
      caller = reviewerSessionBlock(await getAdmin().auth().verifyIdToken(body.idToken));
    } catch {
      return res.status(401).json({ ok: false, error: 'invalid idToken' });
    }
    const database = getDb();
    const profileSnap = await database.collection('users').doc(caller.uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : null;
    if (!profile || !ADMIN_ROLES.has(String(profile.role || '').toLowerCase())) {
      return res.status(403).json({ ok: false, error: 'admin role required' });
    }

    const now = Date.now();
    const actorName = profile.name || profile.displayName || caller.email || caller.uid;
    let trips;
    let scope;
    let reason;
    let previewRef = null;

    if (body.mode === 'apply') {
      if (!body.previewId) {
        return res.status(400).json({ ok: false, error: 'previewId required; run the dry run first' });
      }
      previewRef = database.collection(PREVIEW_COLL).doc(String(body.previewId));
      const previewSnap = await previewRef.get();
      const preview = previewSnap.exists ? previewSnap.data() : null;
      if (!preview
          || preview.createdByUid !== caller.uid
          || preview.usedAt
          || !Number.isFinite(preview.expiresAt)
          || preview.expiresAt < now) {
        return res.status(400).json({ ok: false, error: 'Resync preview is missing, expired, or already used' });
      }
      trips = Array.isArray(preview.trips) ? preview.trips : [];
      scope = preview.scope;
      reason = preview.reason;
    } else {
      trips = normalizedTrips(body.trips);
      scope = scopeFrom(body);
      reason = body.reason;
    }

    const cutoff = now - 365 * 2 * 24 * 3600 * 1000;
    const [periodSnap, userSnap] = await Promise.all([
      database.collection(COLL).where('dutyOnAt', '>=', cutoff).get(),
      database.collection('users').get(),
    ]);
    const periods = periodSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const users = userSnap.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
    const plan = planScheduleResync({
      periods,
      trips,
      users,
      scope,
      now,
      actorName,
      reason,
    });
    if (!plan.ok) return res.status(plan.status || 400).json({ ok: false, error: plan.error });

    if (body.mode !== 'apply') {
      previewRef = database.collection(PREVIEW_COLL).doc();
      await previewRef.set({
        previewId: previewRef.id,
        createdByUid: caller.uid,
        createdByName: actorName,
        createdAt: now,
        expiresAt: now + PREVIEW_TTL_MS,
        usedAt: null,
        trips,
        scope,
        reason: String(reason || '').trim(),
        fingerprint: plan.fingerprint,
        summary: plan.summary,
      });
      return res.status(200).json({
        ok: true,
        mode: 'preview',
        previewId: previewRef.id,
        expiresAt: now + PREVIEW_TTL_MS,
        summary: plan.summary,
        changes: plan.changes,
        warnings: plan.warnings,
        fingerprint: plan.fingerprint,
      });
    }

    const stored = (await previewRef.get()).data();
    if (stored.fingerprint !== plan.fingerprint) {
      return res.status(409).json({
        ok: false,
        error: 'Duty records changed after the dry run. Preview again before writing.',
      });
    }
    if (plan.writes.length > 400) {
      return res.status(400).json({
        ok: false,
        error: `Resync needs ${plan.writes.length} writes. Narrow the date range and run it again.`,
      });
    }

    if (plan.writes.length > 0) {
      const batch = database.batch();
      for (const write of plan.writes) {
        batch.update(database.collection(COLL).doc(write.id), write.patch);
      }
      const auditRef = database.collection(AUDIT_COLL).doc();
      batch.set(auditRef, {
        id: auditRef.id,
        at: now,
        byUid: caller.uid,
        byName: actorName,
        reason: stored.reason,
        scope,
        source: 'schedule-resync',
        summary: plan.summary,
        changes: plan.changes.map((change) => ({
          id: change.id,
          pilotUid: change.pilotUid,
          pilotName: change.pilotName,
          before: change.before,
          after: change.after,
          limitsBefore: change.limitsBefore || null,
          limitsAfter: change.limitsAfter || null,
          reason: change.reason,
        })),
      });
      await batch.commit();
    }

    await previewRef.update({ usedAt: now });
    return res.status(200).json({
      ok: true,
      mode: 'apply',
      summary: plan.summary,
      written: plan.writes.length,
    });
  } catch (err) {
    console.error('[duty-schedule-resync]', err);
    return res.status(500).json({ ok: false, error: err?.message || 'schedule resync failed' });
  }
}
