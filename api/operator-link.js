/**
 * Staff-only lifecycle for a brokered operator crew-update link.
 *
 * POST { action: 'mint'|'status'|'revoke', tripId, trip?, idToken }
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { signOperatorToken } from './_operator-token.js';

export const config = { runtime: 'nodejs' };

let app = null;
let database = null;
function getAdmin() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return app;
}
function db() {
  if (!database) database = getFirestore(getAdmin(), 'appusers');
  return database;
}

async function authorize(idToken) {
  if (!idToken) return null;
  try {
    const decoded = await admin.auth(getAdmin()).verifyIdToken(idToken, true);
    const snap = await db().collection('users').doc(decoded.uid).get();
    const profile = snap.data() || {};
    if (
      !snap.exists
      || !['admin', 'ops', 'sales'].includes(profile.role)
      || profile.active === false
      || profile.approved !== true
    ) return null;
    return { uid: decoded.uid, role: profile.role };
  } catch {
    return null;
  }
}

const clip = (value, length) => String(value || '').trim().slice(0, length);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tail = (value) => clip(value, 16).toUpperCase().replace(/[^A-Z0-9-]/g, '');
const airport = (value) => clip(value, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
const validMs = (value) => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

function publicUrl(req, token) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/operator-flight?token=${encodeURIComponent(token)}`;
}

function trackingExpiry(trip) {
  const end = validMs(trip?.end);
  const start = validMs(trip?.start);
  const reference = end || start || Date.now() + 24 * 60 * 60 * 1000;
  return Math.max(Date.now() + 24 * 60 * 60 * 1000, reference + 48 * 60 * 60 * 1000);
}

function cleanTrip(input) {
  return {
    tail: tail(input?.tail),
    from: airport(input?.from),
    to: airport(input?.to),
    start: input?.start || null,
    end: input?.end || null,
    operatorName: clip(input?.operatorName, 160),
    opsEmail: clip(input?.opsEmail, 254).toLowerCase(),
    aircraftType: clip(input?.aircraftType, 80),
  };
}

function responseFor(req, tripId, data) {
  const active = (
    Number.isFinite(data.operatorLinkIssuedAt)
    && data.operatorLinkRevoked !== true
    && (!data.operatorTrackingExpiresAt || data.operatorTrackingExpiresAt > Date.now())
  );
  const token = active ? signOperatorToken(tripId, data.operatorLinkIssuedAt) : null;
  return {
    ok: true,
    active,
    url: token ? publicUrl(req, token) : null,
    issuedAt: data.operatorLinkIssuedAt || null,
    expiresAt: data.operatorTrackingExpiresAt || null,
    operatorName: data.operatorPortal?.operatorName || '',
    operatorOpsEmail: data.operatorPortal?.opsEmail || '',
    updates: Array.isArray(data.operatorUpdates) ? data.operatorUpdates.slice(-30) : [],
    repositioning: Array.isArray(data.operatorRepositioning)
      ? data.operatorRepositioning.slice(-20)
      : [],
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const caller = await authorize(body.idToken);
  if (!caller) return res.status(401).json({ error: 'Active operations, sales, or admin access required' });
  const tripId = clip(body.tripId, 200);
  if (!tripId) return res.status(400).json({ error: 'tripId required' });

  try {
    const ref = db().collection('trip-state').doc(tripId);
    const trackingRef = db().collection('brokered-tail-tracking').doc(tripId);
    const action = clip(body.action, 20);
    const snap = await ref.get();
    const current = snap.data() || {};

    if (action === 'status') return res.status(200).json(responseFor(req, tripId, current));

    if (action === 'mint') {
      const trip = cleanTrip(body.trip);
      if (!trip.tail || !trip.from || !trip.to || !trip.start) {
        return res.status(400).json({ error: 'Brokered trip needs tail, origin, destination, and departure' });
      }
      if (trip.opsEmail && !EMAIL_RE.test(trip.opsEmail)) {
        return res.status(400).json({ error: 'Operating company ops email is invalid' });
      }
      const issuedAt = Date.now();
      const expiresAt = trackingExpiry(trip);
      const patch = {
        operatorLinkIssuedAt: issuedAt,
        operatorLinkRevoked: false,
        operatorTrackingExpiresAt: expiresAt,
        operatorPortal: trip,
        operatorIdScanCount: 0,
        tripMeta: {
          tail: trip.tail,
          from: trip.from,
          to: trip.to,
          start: trip.start,
          end: trip.end,
          legType: 'REVENUE',
        },
        operatorLinkUpdatedAt: issuedAt,
        operatorLinkUpdatedBy: caller.uid,
      };
      await ref.set(patch, { merge: true });
      await trackingRef.set({
        tripId,
        tail: trip.tail,
        active: true,
        expiresAt,
        updatedAt: issuedAt,
        updatedBy: caller.uid,
      }, { merge: true });
      return res.status(200).json(responseFor(req, tripId, { ...current, ...patch }));
    }

    if (action === 'update-contact') {
      const operatorName = clip(body.operatorName, 160);
      const opsEmail = clip(body.opsEmail, 254).toLowerCase();
      if (opsEmail && !EMAIL_RE.test(opsEmail)) {
        return res.status(400).json({ error: 'Operating company ops email is invalid' });
      }
      const operatorPortal = {
        ...(current.operatorPortal || {}),
        operatorName,
        opsEmail,
      };
      await ref.set({
        operatorPortal,
        operatorLinkUpdatedAt: Date.now(),
        operatorLinkUpdatedBy: caller.uid,
      }, { merge: true });
      return res.status(200).json(responseFor(req, tripId, { ...current, operatorPortal }));
    }

    if (action === 'revoke') {
      await Promise.all([
        ref.set({
          operatorLinkRevoked: true,
          operatorLinkUpdatedAt: Date.now(),
          operatorLinkUpdatedBy: caller.uid,
        }, { merge: true }),
        trackingRef.set({ active: false, updatedAt: Date.now(), updatedBy: caller.uid }, { merge: true }),
      ]);
      return res.status(200).json({ ok: true, active: false, revoked: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('[operator-link]', error.message);
    return res.status(500).json({ error: error.message || 'Operator link failed' });
  }
}

