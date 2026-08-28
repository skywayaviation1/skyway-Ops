/**
 * Public, token-scoped portal for the operating crew of a brokered flight.
 *
 * GET  ?token=...                       → sanitized trip + ADS-B state
 * POST ?action=status                   → operational milestone
 * POST ?action=reposition               → file a repositioning movement
 *
 * No passenger names, broker contacts, pricing, internal notes, or other trips
 * are exposed. Every write is server-timestamped and appended to an audit log.
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyOperatorToken } from './_operator-token.js';
import { deliverNotification } from './_email-transport.js';

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

const clip = (value, length) => String(value || '').trim().slice(0, length);
const airport = (value) => clip(value, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
const ALLOWED_STATUS = new Set([
  'crew_onsite',
  'aircraft_ready',
  'taxi_dep',
  'wheels_up',
  'landed',
]);

async function loadValid(token) {
  const verified = verifyOperatorToken(token);
  if (!verified.ok) return { error: verified.reason, status: 401 };
  const ref = db().collection('trip-state').doc(verified.tripId);
  const snap = await ref.get();
  if (!snap.exists) return { error: 'Trip not found', status: 404 };
  const data = snap.data() || {};
  if (data.operatorLinkRevoked === true) return { error: 'This link has been revoked', status: 403 };
  if (
    !Number.isFinite(data.operatorLinkIssuedAt)
    || verified.issuedAt < data.operatorLinkIssuedAt
  ) return { error: 'This link has been replaced', status: 403 };
  if (data.operatorTrackingExpiresAt && data.operatorTrackingExpiresAt < Date.now()) {
    return { error: 'This operator link has expired', status: 410 };
  }
  return { ref, data, tripId: verified.tripId };
}

function cleanStatuses(statuses) {
  return Object.fromEntries(ALLOWED_STATUS.values().map((key) => {
    const value = statuses?.[key];
    if (!value || typeof value !== 'object') return [key, null];
    const at = Number.isFinite(value.timestamp) ? value.timestamp
      : Number.isFinite(value.at) ? value.at
        : null;
    return [key, at ? { at, source: value.source === 'external-operator' ? 'operator' : 'adsb-or-ops' } : null];
  }).filter(([, value]) => value));
}

function cleanAdsb(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    available: !state.error,
    dataFresh: state.dataFresh !== false,
    polledAt: state.polledAt || null,
    airborne: state.airborne === true,
    latitude: Number.isFinite(state.latitude) ? state.latitude
      : Number.isFinite(state.lastKnownLatitude) ? state.lastKnownLatitude : null,
    longitude: Number.isFinite(state.longitude) ? state.longitude
      : Number.isFinite(state.lastKnownLongitude) ? state.lastKnownLongitude : null,
    heading: Number.isFinite(state.heading) ? state.heading : null,
    altitude: Number.isFinite(state.altitude) ? state.altitude : null,
    groundspeed: Number.isFinite(state.groundspeed) ? state.groundspeed : null,
    origin: state.origin || state.lastOrigin || null,
    destination: state.destination || state.groundedAt || null,
    actualOff: state.actualOff || null,
    actualOn: state.actualOn || null,
    estimatedOn: state.estimatedOn || null,
    filedFlights: Array.isArray(state.filedFlights)
      ? state.filedFlights.slice(0, 10).map((flight) => ({
        id: clip(flight.id, 120),
        origin: airport(flight.origin),
        destination: airport(flight.destination),
        scheduledOut: flight.scheduledOut || null,
        scheduledIn: flight.scheduledIn || null,
      }))
      : [],
  };
}

async function publicPayload(loaded) {
  const portal = loaded.data.operatorPortal || {};
  const currentTail = loaded.data.tripMeta?.tail || portal.tail || '';
  const tracking = currentTail
    ? await db().collection('flightaware-state').doc(currentTail).get()
    : null;
  return {
    id: loaded.tripId,
    tail: currentTail,
    from: loaded.data.tripMeta?.from || portal.from || '',
    to: loaded.data.tripMeta?.to || portal.to || '',
    departure: loaded.data.tripMeta?.start || portal.start || null,
    arrival: loaded.data.tripMeta?.end || portal.end || null,
    aircraftType: portal.aircraftType || '',
    operatorName: portal.operatorName || '',
    expiresAt: loaded.data.operatorTrackingExpiresAt || null,
    statuses: cleanStatuses(loaded.data.statuses),
    updates: (Array.isArray(loaded.data.operatorUpdates) ? loaded.data.operatorUpdates : [])
      .slice(-30)
      .map((entry) => ({
        id: entry.id,
        at: entry.at,
        author: clip(entry.author, 120),
        company: clip(entry.company, 160),
        statusKey: ALLOWED_STATUS.has(entry.statusKey) ? entry.statusKey : null,
        note: clip(entry.note, 500),
      })),
    repositioning: (Array.isArray(loaded.data.operatorRepositioning)
      ? loaded.data.operatorRepositioning
      : []).slice(-20).map((entry) => ({
      id: entry.id,
      at: entry.at,
      author: clip(entry.author, 120),
      from: airport(entry.from),
      to: airport(entry.to),
      departure: entry.departure || null,
      arrival: entry.arrival || null,
      note: clip(entry.note, 500),
    })),
    adsb: cleanAdsb(tracking?.exists ? tracking.data() : null),
  };
}

async function notifyOps(trip, text) {
  const recipients = String(process.env.OPS_ALERT_EMAILS || 'charters@flyskyway.com')
    .split(/[,;\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!recipients.length) return;
  try {
    await deliverNotification({
      to: recipients,
      subject: `[BROKERED OPERATOR] ${trip.tail} ${trip.from}-${trip.to}`,
      html: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
    });
  } catch (error) {
    console.warn('[operator-flight] notification failed:', error.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const body = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const token = req.method === 'GET' ? String(req.query?.token || '') : String(body.token || '');
  const loaded = await loadValid(token);
  if (loaded.error) return res.status(loaded.status).json({ ok: false, error: loaded.error });

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, trip: await publicPayload(loaded) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

  const action = String(req.query?.action || body.action || '');
  const author = clip(body.author, 120);
  const company = clip(body.company, 160);
  if (!author) return res.status(400).json({ error: 'Crew member name required' });

  try {
    if (action === 'status') {
      const statusKey = clip(body.statusKey, 40);
      if (!ALLOWED_STATUS.has(statusKey)) return res.status(400).json({ error: 'Invalid status update' });
      const now = Date.now();
      const entry = {
        id: `op-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        at: now,
        author,
        company,
        statusKey,
        note: clip(body.note, 500),
        source: 'external-operator',
      };
      await db().runTransaction(async (transaction) => {
        const snap = await transaction.get(loaded.ref);
        const current = snap.data() || {};
        const updates = Array.isArray(current.operatorUpdates) ? current.operatorUpdates : [];
        transaction.set(loaded.ref, {
          statuses: {
            ...(current.statuses || {}),
            [statusKey]: {
              timestamp: now,
              author,
              source: 'external-operator',
              note: entry.note,
            },
          },
          operatorUpdates: [...updates.slice(-99), entry],
          updatedAt: now,
        }, { merge: true });
      });
      const trip = await publicPayload({ ...loaded, data: { ...loaded.data } });
      await notifyOps(trip, `${author}${company ? ` (${company})` : ''} reported ${statusKey.replace(/_/g, ' ')}${entry.note ? `: ${entry.note}` : ''}.`);
      return res.status(200).json({ ok: true, update: entry });
    }

    if (action === 'reposition') {
      const from = airport(body.from);
      const to = airport(body.to);
      const departure = new Date(body.departure).getTime();
      const arrival = body.arrival ? new Date(body.arrival).getTime() : null;
      if (!from || !to || from === to || !Number.isFinite(departure)) {
        return res.status(400).json({ error: 'Different origin/destination and valid departure required' });
      }
      if (arrival != null && (!Number.isFinite(arrival) || arrival <= departure)) {
        return res.status(400).json({ error: 'Arrival must be after departure' });
      }
      const now = Date.now();
      const entry = {
        id: `repo-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        at: now,
        author,
        company,
        from,
        to,
        departure: new Date(departure).toISOString(),
        arrival: arrival == null ? null : new Date(arrival).toISOString(),
        note: clip(body.note, 500),
        source: 'external-operator',
      };
      await db().runTransaction(async (transaction) => {
        const snap = await transaction.get(loaded.ref);
        const current = snap.data() || {};
        const repositioning = Array.isArray(current.operatorRepositioning)
          ? current.operatorRepositioning
          : [];
        transaction.set(loaded.ref, {
          operatorRepositioning: [...repositioning.slice(-19), entry],
          updatedAt: now,
        }, { merge: true });
      });
      const trip = await publicPayload({ ...loaded, data: { ...loaded.data } });
      await notifyOps(trip, `${author}${company ? ` (${company})` : ''} filed repositioning ${from}-${to} for ${entry.departure}.`);
      return res.status(200).json({ ok: true, repositioning: entry });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('[operator-flight]', error.message);
    return res.status(500).json({ error: error.message || 'Update failed' });
  }
}

