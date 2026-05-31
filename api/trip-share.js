// /api/trip-share.js
//
// AUTHENTICATED endpoint (Firebase idToken required) used by ops to:
//   - generate a public broker tracking link for a trip
//   - rotate (revoke all old, issue new) the link
//   - revoke entirely (linkRevoked = true)
//   - email the link to a broker
//
// Actions (POST body):
//   { action: 'generate', tripId }                  → returns { url, token }
//   { action: 'rotate',   tripId }                  → invalidates old tokens, returns fresh
//   { action: 'revoke',   tripId }                  → marks linkRevoked: true
//   { action: 'email',    tripId, to, message? }    → generates if needed, emails the link
//
// Token signing uses TRIP_LINK_SECRET (must be set in env).

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { signTripToken } from './_trip-token.js';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let _db = null;
function getAdmin() {
  if (adminApp) return adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON missing');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}
function db() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

async function authorize(req, body) {
  const internalSecret = req.headers['x-internal-secret'];
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) return { ok: true, role: 'internal' };
  const idToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || body?.idToken;
  if (!idToken) return { ok: false };
  try {
    const decoded = await admin.auth(getAdmin()).verifyIdToken(idToken);
    // Look up role — only admin / ops / sales can generate tracking links.
    // (Sales because they often field broker questions.)
    const userDoc = await db().collection('users').doc(decoded.uid).get();
    const role = userDoc.exists ? (userDoc.data().role || '') : '';
    const allowed = ['admin', 'ops', 'sales'].includes(role);
    return { ok: allowed, uid: decoded.uid, role };
  } catch (e) {
    return { ok: false };
  }
}

function publicUrl(req, token) {
  const host = req.headers.host || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'skyway-ops.vercel.app';
  const proto = host.includes('localhost') ? 'http' : 'https';
  return `${proto}://${host}/trip-track.html?token=${encodeURIComponent(token)}`;
}

async function ensureTokenIssued(tripId, opts = {}) {
  const ref = db().collection('trip-state').doc(tripId);
  const snap = await ref.get();
  const data = snap.exists ? (snap.data() || {}) : {};
  // Generate-fresh (rotate) or reuse the existing issuedAt.
  const now = Date.now();
  const reuse = !opts.rotate && typeof data.linkTokenIssuedAt === 'number' && !data.linkRevoked;
  const issuedAt = reuse ? data.linkTokenIssuedAt : now;
  // Validate + sanitize the publicTripData payload from the client. We accept
  // it (with shape checks) because the trip-state doc itself doesn't carry
  // legs — each leg is its own doc — so the broker page needs this snapshot
  // to show the itinerary.
  const incoming = opts.publicTripData;
  let publicTripData = null;
  if (incoming && typeof incoming === 'object' && Array.isArray(incoming.legs)) {
    publicTripData = {
      tail: String(incoming.tail || '').slice(0, 16),
      aircraftType: incoming.aircraftType ? String(incoming.aircraftType).slice(0, 80) : null,
      legs: incoming.legs.slice(0, 20).map((leg, i) => ({
        tripId: leg.tripId ? String(leg.tripId).slice(0, 200) : null,
        legNumber: Number.isFinite(leg.legNumber) ? leg.legNumber : (i + 1),
        from: leg.from ? String(leg.from).slice(0, 8) : null,
        to: leg.to ? String(leg.to).slice(0, 8) : null,
        fromFbo: leg.fromFbo ? String(leg.fromFbo).slice(0, 120) : null,
        toFbo: leg.toFbo ? String(leg.toFbo).slice(0, 120) : null,
        departure: leg.departure || null,   // ISO string
        arrival: leg.arrival || null,
        category: leg.category ? String(leg.category).slice(0, 16) : 'REVENUE',
        picName: leg.picName ? String(leg.picName).slice(0, 80) : null,
        sicName: leg.sicName ? String(leg.sicName).slice(0, 80) : null,
        // Pax visibility flag (per privacy spec). Even if pax array is
        // present, the broker page must honor showPax — defensive defense.
        showPax: leg.showPax === true,
        pax: Array.isArray(leg.pax)
          ? leg.pax.slice(0, 30).map((p) => String(p || '').slice(0, 80)).filter(Boolean)
          : [],
        // Per-leg status timeline. Whitelist the known keys + only the
        // numeric `at` timestamp per entry. Reject anything else.
        status: leg.status && typeof leg.status === 'object'
          ? ['crew_onsite', 'aircraft_ready', 'catering_aboard', 'pax_arrived', 'pax_boarded', 'taxi_dep', 'wheels_up', 'landed']
              .reduce((acc, key) => {
                const v = leg.status[key];
                if (v && typeof v === 'object' && typeof v.at === 'number') {
                  acc[key] = { at: v.at };
                }
                return acc;
              }, {})
          : {},
      })),
      updatedAt: now,
    };
  }
  // Write whichever fields are needed. Always upsert so trips that have never
  // had their state touched still get a token.
  const patch = {};
  if (!reuse) {
    patch.linkTokenIssuedAt = issuedAt;
    patch.linkRevoked = false;
    patch.linkUpdatedAt = now;
  }
  if (publicTripData) patch.publicTripData = publicTripData;
  if (Object.keys(patch).length > 0) {
    await ref.set(patch, { merge: true });
  }
  const token = signTripToken(tripId, issuedAt);
  return { token, issuedAt, reused: reuse, persistedPublicTripData: !!publicTripData };
}

async function sendBrokerEmail(req, { to, url, tripCode, tail, message, fromOpsName }) {
  const host = req.headers.host || 'skyway-ops.vercel.app';
  const proto = host.includes('localhost') ? 'http' : 'https';
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.INTERNAL_API_SECRET) headers['x-internal-secret'] = process.env.INTERNAL_API_SECRET;
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const subject = `Skyway tracking link${tripCode ? ` — ${tripCode}` : ''}${tail ? ` (${tail})` : ''}`;
  const lines = [
    `You have a live tracking link for your upcoming Skyway charter.`,
    ``,
    tripCode ? `Trip: ${tripCode}` : null,
    tail ? `Aircraft: ${tail}` : null,
    ``,
    `Track aircraft position, repositioning leg, and live status:`,
    url,
    ``,
    message ? `${message}` : null,
    message ? `` : null,
    `The link expires 24 hours after the final leg lands. If you need anything in the meantime, reach out at charters@flyskyway.com or 727-605-5000.`,
    ``,
    `— ${fromOpsName || 'Skyway Aviation Services'}`,
  ].filter((l) => l !== null);
  const text = lines.join('\n');

  // Use the email queue (reliable retry) — fall back to direct send.
  const body = JSON.stringify({ to, subject, text, source: 'trip-share' });
  try {
    const r = await fetch(`${proto}://${host}/api/email-enqueue`, { method: 'POST', headers, body });
    if (r.ok) return true;
    const r2 = await fetch(`${proto}://${host}/api/send-email`, {
      method: 'POST', headers, body: JSON.stringify({ to, subject, text }),
    });
    return r2.ok;
  } catch (e) {
    console.error('[trip-share] email send failed:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }
  }

  // DIAGNOSTIC: log what came in so we can verify publicTripData is being
  // sent by the client. Safe to leave in — body is small, no PII.
  const ptd = body?.publicTripData;
  console.log('[trip-share] incoming', {
    action: body?.action,
    tripId: body?.tripId,
    hasPublicTripData: !!ptd,
    ptdHasLegs: Array.isArray(ptd?.legs),
    ptdLegCount: Array.isArray(ptd?.legs) ? ptd.legs.length : 0,
    ptdTail: ptd?.tail || null,
  });

  const auth = await authorize(req, body);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const action = String(body?.action || '');
  const tripId = String(body?.tripId || '').trim();
  if (!tripId) return res.status(400).json({ ok: false, error: 'tripId required' });

  try {
    if (action === 'generate') {
      const r = await ensureTokenIssued(tripId, { rotate: false, publicTripData: body?.publicTripData });
      return res.status(200).json({
        ok: true,
        url: publicUrl(req, r.token),
        token: r.token,
        reused: r.reused,
        // DIAGNOSTIC: confirms what the server received + persisted
        _diag: {
          received_publicTripData: !!body?.publicTripData,
          received_legCount: Array.isArray(body?.publicTripData?.legs) ? body.publicTripData.legs.length : 0,
          received_tail: body?.publicTripData?.tail || null,
          persisted: r.persistedPublicTripData === true,
        },
      });
    }
    if (action === 'rotate') {
      const r = await ensureTokenIssued(tripId, { rotate: true, publicTripData: body?.publicTripData });
      return res.status(200).json({
        ok: true, url: publicUrl(req, r.token), token: r.token, rotated: true,
        _diag: {
          received_publicTripData: !!body?.publicTripData,
          received_legCount: Array.isArray(body?.publicTripData?.legs) ? body.publicTripData.legs.length : 0,
          received_tail: body?.publicTripData?.tail || null,
          persisted: r.persistedPublicTripData === true,
        },
      });
    }
    if (action === 'revoke') {
      await db().collection('trip-state').doc(tripId).set({
        linkRevoked: true, linkUpdatedAt: Date.now(),
      }, { merge: true });
      return res.status(200).json({ ok: true, revoked: true });
    }
    if (action === 'email') {
      const to = String(body?.to || '').trim();
      if (!to || !/.+@.+\..+/.test(to)) {
        return res.status(400).json({ ok: false, error: 'valid email "to" required' });
      }
      const r = await ensureTokenIssued(tripId, { rotate: false });
      const url = publicUrl(req, r.token);

      // Pull trip code + tail for the subject line.
      const snap = await db().collection('trip-state').doc(tripId).get();
      const data = snap.exists ? snap.data() : {};
      const tripCode = data?.tripCode || data?.tripMeta?.tripCode || null;
      const tail = data?.tail || data?.tripMeta?.tail || null;

      const sent = await sendBrokerEmail(req, {
        to, url, tripCode, tail,
        message: body?.message || null,
        fromOpsName: body?.fromOpsName || 'Skyway Ops',
      });

      // Record share history for audit
      await db().collection('trip-state').doc(tripId).set({
        lastSharedTo: to,
        lastSharedAt: Date.now(),
        lastSharedBy: auth.uid || null,
      }, { merge: true });

      return res.status(200).json({ ok: true, sent, url });
    }
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (e) {
    console.error('[trip-share] error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Internal error' });
  }
}
