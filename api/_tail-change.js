// Tail-change notice for a live leg.
//
// One planner decides whether a tail write is a real change, and one applier
// runs that decision inside a Firestore transaction so repeated saves of the
// same tail send a single broker email. Callers are the schedule sync /
// import path, trip-meta seeding, trip-detail saves, manual trips, and the
// brokered-operator link mint.

import { applySkywaySignature, textToHtml, withCharterCopy } from './_email-signature.js';
import { deliverNotification } from './_email-transport.js';
import { applyNotifySafety } from './_lib/notifySafety.js';
import { signTripToken } from './_trip-token.js';

export const CHARTER_CC = 'charters@flyskyway.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNASSIGNED = new Set(['', 'TBD', 'TBA', '----', 'UNKNOWN', 'NA', 'N/A', 'NONE', 'PENDING', 'HOLD']);

export function legStateDocId(tripId) {
  return String(tripId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

export function normalizeTail(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

export function isAssignedTail(value) {
  const tail = normalizeTail(value);
  if (!tail) return false;
  if (UNASSIGNED.has(tail)) return false;
  return true;
}

export function parseNotifyEmails(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => EMAIL_RE.test(entry));
}

export function requestOrigin(req) {
  const host = req?.headers?.['x-forwarded-host']
    || req?.headers?.host
    || process.env.VERCEL_PROJECT_PRODUCTION_URL
    || 'skyway-ops.vercel.app';
  const proto = String(host).includes('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
}

function textBlob(value) {
  return String(value || '').toLowerCase();
}

/** A leg that is completed or cancelled is not live. */
export function legIsClosed(existing = {}, incoming = {}) {
  if (existing.completed === true || incoming.completed === true) return true;
  if (existing.cancelled === true || incoming.cancelled === true) return true;
  if (existing.tripMeta?.cancelled === true) return true;
  if (incoming.isFlight === false || existing.tripMeta?.isFlight === false) return true;
  const haystack = [
    incoming.status,
    incoming.legStatus,
    incoming.segmentStatus,
    incoming.category,
    incoming.summary,
    incoming.tripType,
    existing.status,
    existing.segmentStatus,
    existing.tripSheetData?.segmentStatus,
    existing.tripSheetData?.status,
    existing.tripMeta?.summary,
    existing.tripMeta?.category,
  ].map(textBlob).join('\n');
  return /\bcancell?ed\b|\bcxl\b|\bcxld\b/.test(haystack);
}

function resolveType(explicit, tail, aircraftByTail) {
  const direct = String(explicit || '').trim();
  if (direct) return direct;
  const meta = aircraftByTail?.[normalizeTail(tail)];
  if (!meta || typeof meta !== 'object') return '';
  return String(meta.displayName || meta.icaoType || '').trim();
}

function formatWhen(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function formatRoute(from, to) {
  const origin = String(from || '').trim().toUpperCase();
  const dest = String(to || '').trim().toUpperCase();
  if (origin && dest) return `${origin}-${dest}`;
  return origin || dest || 'route pending';
}

export function brokerTrackingUrl({ origin, tripId, linkTokenIssuedAt, linkRevoked, token }) {
  if (linkRevoked === true) return null;
  const base = String(origin || '').replace(/\/+$/, '');
  if (!base || !tripId) return null;
  if (token) {
    return `${base}/trip-track.html?token=${encodeURIComponent(token)}`;
  }
  if (typeof linkTokenIssuedAt !== 'number') return null;
  try {
    const signed = signTripToken(tripId, linkTokenIssuedAt);
    return `${base}/trip-track.html?token=${encodeURIComponent(signed)}`;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildTailChangeEmail({
  tripId,
  route,
  departure,
  arrival,
  oldTail,
  newTail,
  aircraftType,
  oldAircraftType,
  trackingUrl,
}) {
  const id = tripId || 'leg';
  const subject = `Tail change: ${id} ${route} now ${newTail}`.replace(/\s+/g, ' ').trim();
  const typeChanged = Boolean(oldAircraftType) && Boolean(aircraftType)
    && oldAircraftType.toLowerCase() !== aircraftType.toLowerCase();
  const lines = [
    'The aircraft assigned to this leg has changed.',
    '',
    `Trip: ${id}`,
    `Route: ${route}`,
    departure ? `Departure: ${departure}` : null,
    arrival ? `Arrival: ${arrival}` : null,
    `Previous tail: ${oldTail}`,
    `New tail: ${newTail}`,
    `Aircraft type: ${aircraftType || 'not on file'}`,
    typeChanged ? `Previous aircraft type: ${oldAircraftType}` : null,
    `Tracking: ${trackingUrl || 'No tracking link has been issued for this leg yet.'}`,
  ].filter((line) => line != null);
  const text = lines.join('\n');
  const row = (label, value) => (
    `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;font-size:13px;vertical-align:top;">${escapeHtml(label)}</td>`
    + `<td style="padding:2px 0;color:#1f2937;font-size:14px;font-weight:500;">${escapeHtml(value)}</td></tr>`
  );
  const trackingRow = trackingUrl
    ? `<p style="margin:16px 0 0 0;font-size:14px;"><a href="${escapeHtml(trackingUrl)}" style="color:#0e7490;">Open the tracking link</a></p>`
      + `<p style="margin:4px 0 0 0;font-size:12px;color:#6b7280;word-break:break-all;">${escapeHtml(trackingUrl)}</p>`
    : '<p style="margin:16px 0 0 0;font-size:14px;color:#1f2937;">No tracking link has been issued for this leg yet.</p>';
  const html = [
    '<p style="margin:0 0 12px 0;font-size:15px;color:#1f2937;">The aircraft assigned to this leg has changed.</p>',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    row('Trip', id),
    row('Route', route),
    departure ? row('Departure', departure) : '',
    arrival ? row('Arrival', arrival) : '',
    row('Previous tail', oldTail),
    row('New tail', newTail),
    row('Aircraft type', aircraftType || 'not on file'),
    typeChanged ? row('Previous aircraft type', oldAircraftType) : '',
    '</table>',
    trackingRow,
  ].join('');
  return { subject, text, html };
}

function mergedTripMeta(existing, incoming, nextTail, nextType, tripCode) {
  const previous = existing?.tripMeta && typeof existing.tripMeta === 'object' ? existing.tripMeta : {};
  const meta = { ...previous };
  if (nextTail) meta.tail = nextTail;
  const from = String(incoming.from || previous.from || '').trim().toUpperCase();
  const to = String(incoming.to || previous.to || '').trim().toUpperCase();
  if (from) meta.from = from;
  if (to) meta.to = to;
  if (incoming.start != null) meta.start = incoming.start;
  if (incoming.end != null) meta.end = incoming.end;
  if (incoming.legType) meta.legType = String(incoming.legType).slice(0, 24);
  if (nextType) meta.aircraftType = nextType;
  if (tripCode) meta.tripCode = tripCode;
  if (incoming.summary) meta.summary = String(incoming.summary).slice(0, 240);
  if (incoming.cancelled === true) meta.cancelled = true;
  if (incoming.isFlight === false) meta.isFlight = false;
  else if (incoming.isFlight === true) meta.isFlight = true;
  return meta;
}

/**
 * Decide what a tail write should do. Pure: no Firestore, no network.
 * `action` is `unchanged`, `write` (persist tail, no email), or `send`.
 */
export function planTailUpdate(existing = {}, incoming = {}, options = {}) {
  const now = options.now || Date.now();
  const prevTail = normalizeTail(existing?.tripMeta?.tail);
  const nextTail = normalizeTail(incoming?.tail);
  const aircraftByTail = options.aircraftByTail || {};
  const prevType = resolveType(existing?.tripMeta?.aircraftType, prevTail, aircraftByTail);
  const nextType = resolveType(
    incoming?.aircraftType || existing?.tripSheetData?.aircraftType,
    nextTail,
    aircraftByTail,
  );
  const tripCode = String(
    incoming?.tripCode
    || existing?.tripSheetData?.tripCode
    || existing?.tripMeta?.tripCode
    || '',
  ).trim();
  const displayId = tripCode || options.docId || incoming?.tripId || 'leg';
  const from = incoming?.from || existing?.tripMeta?.from;
  const to = incoming?.to || existing?.tripMeta?.to;
  const route = formatRoute(from, to);
  const departure = formatWhen(incoming?.start ?? existing?.tripMeta?.start);
  const arrival = formatWhen(incoming?.end ?? existing?.tripMeta?.end);
  const notice = existing?.tailNotice || null;
  const tripMeta = mergedTripMeta(existing, incoming, nextTail, nextType, tripCode);

  const unchanged = () => ({
    action: 'unchanged',
    reason: 'unchanged',
    patch: null,
    email: null,
    sent: false,
  });

  if (prevTail && nextTail && prevTail === nextTail) {
    if (
      notice
      && notice.status === 'failed'
      && notice.newTail === nextTail
      && notice.oldTail
      && notice.key === `${notice.oldTail}>${notice.newTail}`
    ) {
      const recipients = parseNotifyEmails(existing.brokerEmail || incoming.brokerEmail);
      if (recipients.length === 0 || legIsClosed(existing, incoming)) return unchanged();
      const envelope = withCharterCopy({ to: recipients });
      const email = buildTailChangeEmail({
        tripId: displayId,
        route,
        departure,
        arrival,
        oldTail: notice.oldTail,
        newTail: nextTail,
        aircraftType: notice.newType || nextType,
        oldAircraftType: notice.oldType || prevType,
        trackingUrl: options.trackingUrl || null,
      });
      return {
        action: 'send',
        reason: 'retry-failed',
        existed: true,
        oldTail: notice.oldTail,
        newTail: nextTail,
        oldType: notice.oldType || prevType || null,
        newType: notice.newType || nextType || null,
        patch: {
          tailNotice: { ...notice, status: 'pending', at: now },
          updatedAt: now,
        },
        email: { ...email, to: envelope.to, cc: envelope.cc, bcc: [] },
      };
    }
    return unchanged();
  }

  const writeOnly = (reason, extra = {}) => ({
    action: 'write',
    reason,
    patch: {
      tripMeta,
      updatedAt: now,
      ...(incoming.cancelled === true ? { cancelled: true } : {}),
      ...extra,
    },
    email: null,
    sent: false,
    oldTail: prevTail || null,
    newTail: nextTail || null,
  });

  if (!isAssignedTail(prevTail)) return writeOnly('first-assignment');
  if (!isAssignedTail(nextTail)) return writeOnly('tail-cleared');
  if (legIsClosed(existing, incoming)) return writeOnly('not-live');

  const recipients = parseNotifyEmails(existing.brokerEmail || incoming.brokerEmail);
  const key = `${prevTail}>${nextTail}`;
  const tailNotice = {
    key,
    status: recipients.length ? 'pending' : 'skipped',
    oldTail: prevTail,
    newTail: nextTail,
    oldType: prevType || null,
    newType: nextType || null,
    at: now,
  };
  if (recipients.length === 0) {
    return writeOnly('no-recipients', { tailNotice });
  }

  const envelope = withCharterCopy({ to: recipients });
  const email = buildTailChangeEmail({
    tripId: displayId,
    route,
    departure,
    arrival,
    oldTail: prevTail,
    newTail: nextTail,
    aircraftType: nextType,
    oldAircraftType: prevType,
    trackingUrl: options.trackingUrl || null,
  });
  return {
    action: 'send',
    reason: 'tail-changed',
    oldTail: prevTail,
    newTail: nextTail,
    oldType: prevType || null,
    newType: nextType || null,
    patch: {
      tripMeta,
      tailNotice,
      updatedAt: now,
      ...(incoming.cancelled === true ? { cancelled: true } : {}),
    },
    email: { ...email, to: envelope.to, cc: envelope.cc, bcc: [] },
  };
}

function activityEntry(plan, safe, at) {
  return {
    type: 'tail-change',
    at,
    oldTail: plan.oldTail,
    newTail: plan.newTail,
    oldType: plan.oldType || null,
    newType: plan.newType || null,
    recipients: [...(plan.email?.to || []), ...(plan.email?.cc || [])],
    testMode: safe.testMode === true,
    deliveredTo: safe.to,
  };
}

/**
 * Compare the stored tail with the incoming one, persist the new tail, and
 * send at most one broker email for that change.
 */
export async function applyLegTailUpdate(db, docId, incoming = {}, deps = {}) {
  if (!docId) throw new Error('trip id required');
  if (!incoming?.tail) return { action: 'unchanged', reason: 'missing-tail', sent: false };
  const ref = db.collection('trip-state').doc(docId);
  const env = deps.env || process.env;
  let existed = false;

  const plan = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    existed = snap.exists === true;
    const existing = snap.exists ? (snap.data() || {}) : {};
    const trackingUrl = deps.trackingUrl !== undefined
      ? deps.trackingUrl
      : brokerTrackingUrl({
        origin: deps.origin,
        tripId: docId,
        linkTokenIssuedAt: existing.linkTokenIssuedAt,
        linkRevoked: existing.linkRevoked,
        token: existing.token,
      });
    const decision = planTailUpdate(existing, incoming, {
      now: deps.now,
      aircraftByTail: deps.aircraftByTail,
      trackingUrl,
      docId,
    });
    decision.existed = existed;
    if (decision.patch) tx.set(ref, decision.patch, { merge: true });
    return decision;
  });

  if (plan.action !== 'send' || !plan.email) {
    return { ...plan, existed, sent: false };
  }

  const safe = applyNotifySafety(plan.email, env);
  const html = applySkywaySignature(safe.html || textToHtml(safe.text || ''));
  const deliver = deps.deliver || ((message) => deliverNotification(message));
  let result;
  try {
    result = await deliver({
      to: safe.to,
      cc: safe.cc,
      bcc: safe.bcc,
      subject: safe.subject,
      html,
    });
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
  }

  const at = Date.now();
  if (result?.ok) {
    const entry = activityEntry(plan, safe, at);
    if (deps.recordSend) {
      await deps.recordSend(ref, entry);
    } else {
      const snap = await ref.get();
      const previous = Array.isArray(snap.data()?.activity) ? snap.data().activity : [];
      await ref.update({
        activity: [...previous, entry].slice(-40),
        'tailNotice.status': 'sent',
        'tailNotice.sentAt': at,
        'tailNotice.testMode': safe.testMode === true,
        'tailNotice.deliveredTo': safe.to,
        'tailNotice.error': null,
      });
    }
    return {
      ...plan,
      existed,
      sent: true,
      testMode: safe.testMode === true,
      deliveredTo: safe.to,
      subject: safe.subject,
    };
  }

  const error = String(result?.error || 'send failed').slice(0, 300);
  if (deps.recordFailure) {
    await deps.recordFailure(ref, error);
  } else {
    await ref.update({
      'tailNotice.status': 'failed',
      'tailNotice.error': error,
    });
  }
  return { ...plan, existed, sent: false, reason: 'send-failed', error, testMode: safe.testMode === true };
}
