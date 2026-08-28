/**
 * Public, token-scoped portal for the operating crew of a brokered flight.
 *
 * GET  ?token=...                       → sanitized trip + ADS-B state
 * POST ?action=status                   → operational milestone
 * POST ?action=reposition               → file a repositioning movement
 *
 * Only this trip's manifest names/check-in state are exposed. DOB, document
 * number, ID images, broker contacts, pricing, internal notes, and other trips
 * are never returned. Every write is server-timestamped and audited.
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseNotifyEmails(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => EMAIL_RE.test(entry));
}

/** Skyway ops alerts + trip broker-notify list + operator ops email. Never returned to the public portal. */
export function operatorNotificationRecipients(data, env = process.env) {
  return [...new Set([
    ...parseNotifyEmails(env.OPS_ALERT_EMAILS || 'charters@flyskyway.com'),
    ...parseNotifyEmails(data?.brokerEmail),
    ...parseNotifyEmails(data?.operatorPortal?.opsEmail),
  ])];
}

const ALLOWED_STATUS = new Set([
  'crew_onsite',
  'aircraft_ready',
  'pax_arrived',
  'pax_boarded',
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

function passengerRoster(data) {
  const preloaded = Array.isArray(data.preloadedPax) ? data.preloadedPax : [];
  const scanned = Array.isArray(data.passengers) ? data.passengers : [];
  const scanByRef = new Map(
    scanned.filter((entry) => entry?.preloadedRefId)
      .map((entry) => [String(entry.preloadedRefId), entry]),
  );
  return preloaded.slice(0, 30).map((passenger, index) => {
    const id = clip(passenger?.id || `manifest-${index + 1}`, 120);
    const scan = scanByRef.get(id);
    const name = [
      clip(passenger?.firstName, 80),
      clip(passenger?.lastName, 80),
    ].filter(Boolean).join(' ');
    const status = passenger?.checkInStatus || scan?.checkInStatus || '';
    return {
      id,
      name,
      checkedIn: [
        'matched', 'mismatch', 'manual_override', 'child_verified', 'carried_over',
      ].includes(status) || Boolean(scan?.verifiedAt),
      checkedInAt: scan?.verifiedAt || passenger?.verifiedAt || null,
    };
  }).filter((passenger) => passenger.name);
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
    passengers: passengerRoster(loaded.data),
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
  pax_arrived: {
    title: 'Passengers Arrived',
    message: 'The passengers have arrived at the FBO.',
    next: 'The operating crew will verify IDs and send the next update after check-in.',
  },
  pax_boarded: {
    title: 'Passengers Checked In',
    message: 'Passenger IDs have been verified and the passengers are boarding the aircraft.',
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
    <p style="margin:0 0 16px;font-size:15px;color:#1f2937;">Hello,</p>
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
    <p style="margin:0 0 16px;font-size:15px;color:#1f2937;">Hello,</p>
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

export function buildPassengerCheckInEmail(trip, update) {
  const html = applySkywaySignature(`
    <p style="margin:0 0 16px;font-size:15px;color:#1f2937;">Hello,</p>
    <p style="margin:0 0 16px;font-size:14px;color:#1f2937;">
      The operating crew verified a passenger ID and completed check-in.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;width:100%;max-width:520px;">
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Aircraft</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(trip.tail)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Route</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(trip.from)} → ${escapeHtml(trip.to)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Passenger</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(update.passengerName)}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Verified by</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${escapeHtml(update.author)}${update.company ? ` · ${escapeHtml(update.company)}` : ''}</td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:12px;">Result</td><td style="padding:5px 0;color:#1f2937;font-size:13px;font-weight:600;">${update.overridden ? 'Crew override after name mismatch' : 'ID name matched manifest'}</td></tr>
    </table>
  `);
  return {
    subject: `Passenger Checked In — ${trip.tail} ${trip.from}-${trip.to}`,
    html,
  };
}

async function notifyOps(data, trip, email) {
  const uniqueRecipients = operatorNotificationRecipients(data);
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

    if (action === 'check-in') {
      const passengerId = clip(body.passengerId, 120);
      const parsed = body.parsed && typeof body.parsed === 'object' ? body.parsed : {};
      const scannedFirst = clip(parsed.firstName, 80);
      const scannedLast = clip(parsed.lastName, 80);
      const scannedName = [scannedFirst, scannedLast].filter(Boolean).join(' ');
      if (!passengerId || !scannedName) {
        return res.status(400).json({ error: 'Passenger and parsed ID name required' });
      }
      const manifest = Array.isArray(loaded.data.preloadedPax) ? loaded.data.preloadedPax : [];
      const passenger = manifest.find((entry, index) => (
        String(entry?.id || `manifest-${index + 1}`) === passengerId
      ));
      if (!passenger) return res.status(404).json({ error: 'Passenger is not on this trip manifest' });
      const expectedName = [
        clip(passenger.firstName, 80),
        clip(passenger.lastName, 80),
      ].filter(Boolean).join(' ');
      const nameKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const expectedParts = expectedName.split(/\s+/).filter(Boolean);
      const scannedParts = scannedName.split(/\s+/).filter(Boolean);
      const matched = nameKey(expectedName) === nameKey(scannedName)
        || (
          expectedParts.length > 0
          && scannedParts.length > 0
          && nameKey(expectedParts[0]) === nameKey(scannedParts[0])
          && nameKey(expectedParts.at(-1)) === nameKey(scannedParts.at(-1))
        );
      if (!matched && body.override !== true) {
        return res.status(409).json({
          error: 'ID name does not match the selected manifest passenger',
          requiresOverride: true,
          expectedName,
          scannedName,
        });
      }
      const now = Date.now();
      const checkIn = {
        id: `op-pax-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        firstName: scannedFirst,
        lastName: scannedLast,
        preloadedRefId: passengerId,
        verifiedAt: now,
        checkInStatus: matched ? 'matched' : 'manual_override',
        verifiedBy: author,
        source: 'external-operator',
      };
      await db().runTransaction(async (transaction) => {
        const snap = await transaction.get(loaded.ref);
        const current = snap.data() || {};
        const currentManifest = Array.isArray(current.preloadedPax) ? current.preloadedPax : [];
        const nextManifest = currentManifest.map((entry, index) => (
          String(entry?.id || `manifest-${index + 1}`) === passengerId
            ? {
              ...entry,
              checkInStatus: checkIn.checkInStatus,
              verifiedAt: now,
              verifiedBy: author,
            }
            : entry
        ));
        const currentScans = Array.isArray(current.passengers) ? current.passengers : [];
        const nextScans = [
          ...currentScans.filter((entry) => String(entry?.preloadedRefId || '') !== passengerId),
          checkIn,
        ].slice(-60);
        const updates = Array.isArray(current.operatorUpdates) ? current.operatorUpdates : [];
        transaction.set(loaded.ref, {
          preloadedPax: nextManifest,
          passengers: nextScans,
          operatorUpdates: [...updates.slice(-99), {
            id: checkIn.id,
            at: now,
            author,
            company,
            statusKey: 'passenger_check_in',
            note: `${expectedName} checked in`,
            source: 'external-operator',
          }],
          updatedAt: now,
        }, { merge: true });
      });
      const trip = await publicPayload({ ...loaded, data: { ...loaded.data } });
      await notifyOps(loaded.data, trip, buildPassengerCheckInEmail(trip, {
        passengerName: expectedName,
        author,
        company,
        overridden: !matched,
      }));
      return res.status(200).json({
        ok: true,
        passenger: {
          id: passengerId,
          name: expectedName,
          checkedIn: true,
          checkedInAt: now,
        },
        matched,
        overridden: !matched,
      });
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

