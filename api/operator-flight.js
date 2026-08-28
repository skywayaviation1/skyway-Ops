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
import { applySkywaySignature } from './_email-signature.js';

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

const STATUS_CONTENT = {
  crew_onsite: {
    title: 'Crew Arrival Notification',
    message: 'The operating crew has arrived at the FBO and is preparing the aircraft.',
    next: 'The next update will be sent when the aircraft is ready.',
  },
  aircraft_ready: {
    title: 'Aircraft Ready for Passengers',
    message: 'The aircraft is ready for passenger boarding.',
    next: 'The next update will be sent when the aircraft begins taxiing.',
  },
  taxi_dep: {
    title: 'Aircraft Taxiing for Departure',
    message: 'The aircraft has begun taxiing for departure.',
    next: 'The next update will include wheels-up status.',
  },
  wheels_up: {
    title: 'Wheels Up',
    message: 'The aircraft is airborne and en route to its destination.',
    next: 'The next update will be sent when the aircraft lands.',
  },
  landed: {
    title: 'Landed',
    message: 'The aircraft has landed at its destination.',
    next: 'This flight movement is complete.',
  },
};

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export function buildOperatorStatusEmail(trip, update) {
  const content = STATUS_CONTENT[update.statusKey] || {
    title: 'Flight Update',
    message: 'The operating crew submitted a flight update.',
    next: '',
  };
  const route = `${trip.from || '—'}-${trip.to || '—'}`;
  const at = new Date(update.at || Date.now()).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const detailRows = [
    ['Aircraft', trip.tail],
    ['Route', `${trip.from || '—'} → ${trip.to || '—'}`],
    ['Status time', at],
    ['Reported by', `${update.author}${update.company ? ` · ${update.company}` : ''}`],
  ];
  const html = applySkywaySignature(`
    <p style="margin:0 0 16px;font-size:15px;color:#1f2937;">Hello Operations,</p>
    <p style="margin:0 0 16px;font-size:14px;color:#1f2937;">${escapeHtml(content.message)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;width:100%;max-width:520px;">
      ${detailRows.map(([label, value]) => `<tr>
        <td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">${escapeHtml(label)}</td>
        <td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(value)}</td>
      </tr>`).join('')}
    </table>
    ${update.note ? `<div style="margin:16px 0;padding:12px 14px;background:#f3f4f6;border-left:3px solid #1ec0e9;color:#1f2937;font-size:13px;"><strong>Crew note:</strong> ${escapeHtml(update.note)}</div>` : ''}
    ${content.next ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;">${escapeHtml(content.next)}</p>` : ''}
  `);
  return {
    subject: `${content.title} — ${trip.tail} ${route}`,
    html,
  };
}

export function buildOperatorRepositionEmail(trip, update) {
  const html = applySkywaySignature(`
    <p style="margin:0 0 16px;font-size:15px;color:#1f2937;">Hello Operations,</p>
    <p style="margin:0 0 16px;font-size:14px;color:#1f2937;">
      The operating crew filed an empty repositioning movement for ${escapeHtml(trip.tail)}.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;width:100%;max-width:520px;">
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Route</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(update.from)} → ${escapeHtml(update.to)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Departure</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(update.departure)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Arrival</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(update.arrival || 'Not provided')}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Filed by</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(update.author)}${update.company ? ` · ${escapeHtml(update.company)}` : ''}</td></tr>
    </table>
    ${update.note ? `<div style="margin:16px 0;padding:12px 14px;background:#f3f4f6;border-left:3px solid #1ec0e9;color:#1f2937;font-size:13px;"><strong>Crew note:</strong> ${escapeHtml(update.note)}</div>` : ''}
  `);
  return {
    subject: `Repositioning Filed — ${trip.tail} ${update.from}-${update.to}`,
    html,
  };
}

async function notifyOps(data, trip, email) {
  const recipients = String(process.env.OPS_ALERT_EMAILS || 'charters@flyskyway.com')
    .split(/[,;\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const operatorOps = String(data.operatorPortal?.opsEmail || '').trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operatorOps)) recipients.push(operatorOps);
  const uniqueRecipients = [...new Set(recipients.map((value) => value.toLowerCase()))];
  if (!uniqueRecipients.length) return;
  try {
    await deliverNotification({
      to: uniqueRecipients,
      subject: email.subject,
      html: email.html,
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
      await notifyOps(loaded.data, trip, buildOperatorStatusEmail(trip, entry));
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
      await notifyOps(loaded.data, trip, buildOperatorRepositionEmail(trip, entry));
      return res.status(200).json({ ok: true, repositioning: entry });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('[operator-flight]', error.message);
    return res.status(500).json({ error: error.message || 'Update failed' });
  }
}

