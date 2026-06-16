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
        // Per-pax records: each entry is an object the broker page can
        // render with individual check-in indicators. Whitelist the four
        // fields we care about; reject anything else (covers PII leakage
        // if a future caller mistakenly forwards DOB/weight/etc).
        pax: Array.isArray(leg.pax)
          ? leg.pax.slice(0, 30).map((p) => {
              if (!p || typeof p !== 'object') return null;
              const name = String(p.name || '').slice(0, 80).trim();
              if (!name) return null;
              const status = ['checked_in', 'pending', 'skipped', 'no_show'].includes(p.status)
                ? p.status : 'pending';
              const checkedInAt = Number.isFinite(p.checkedInAt) ? p.checkedInAt : null;
              return { name, status, checkedInAt, walkUp: p.walkUp === true };
            }).filter(Boolean)
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

async function sendBrokerEmail(req, { to, url, tripCode, tail, tripId, message, fromOpsName, idToken }) {
  const host = req.headers.host || 'skyway-ops.vercel.app';
  const proto = host.includes('localhost') ? 'http' : 'https';
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.INTERNAL_API_SECRET) headers['x-internal-secret'] = process.env.INTERNAL_API_SECRET;
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const subject = `Skyway tracking link${tripCode ? ` — ${tripCode}` : ''}${tail ? ` (${tail})` : ''}`;

  // Build an HTML body with a real clickable link, escaped trip metadata,
  // and the optional ops message. email-enqueue will wrap this with the
  // Skyway header/footer (logo + DO NOT REPLY + contact info) before sending.
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const htmlParts = [
    `<p style="margin:0 0 16px 0; font-size:15px; color:#1f2937;">You have a live tracking link for your upcoming Skyway charter.</p>`,
  ];
  if (tripCode || tail) {
    htmlParts.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">');
    if (tripCode) htmlParts.push(`<tr><td style="padding:2px 12px 2px 0; color:#6b7280; font-size:13px;">Trip</td><td style="padding:2px 0; color:#1f2937; font-size:14px; font-weight:500;">${esc(tripCode)}</td></tr>`);
    if (tail) htmlParts.push(`<tr><td style="padding:2px 12px 2px 0; color:#6b7280; font-size:13px;">Aircraft</td><td style="padding:2px 0; color:#1f2937; font-size:14px; font-weight:500;">${esc(tail)}</td></tr>`);
    htmlParts.push('</table>');
  }
  htmlParts.push(`<p style="margin:0 0 12px 0; font-size:14px; color:#1f2937;">Track aircraft position, repositioning leg, and live status:</p>`);
  htmlParts.push(
    `<p style="margin:0 0 24px 0;">` +
    `<a href="${esc(url)}" style="display:inline-block; background:#1ec0e9; color:#0a0a0a; padding:12px 24px; font-weight:600; text-decoration:none; font-size:14px; letter-spacing:0.02em;">TRACK FLIGHT</a>` +
    `</p>`
  );
  htmlParts.push(`<p style="margin:0 0 16px 0; font-size:12px; color:#6b7280; word-break:break-all;">Or paste this link: <a href="${esc(url)}" style="color:#1ec0e9; text-decoration:none;">${esc(url)}</a></p>`);
  if (message) {
    htmlParts.push(`<div style="margin:24px 0 16px 0; padding:12px 16px; background:#f9fafb; border-left:3px solid #1ec0e9; font-size:14px; color:#1f2937; white-space:pre-wrap;">${esc(message)}</div>`);
  }
  htmlParts.push(`<p style="margin:24px 0 0 0; font-size:12px; color:#6b7280;">The link expires 24 hours after the final leg lands.</p>`);
  const html = htmlParts.join('\n');

  // Plain text fallback for mail clients that don't render HTML.
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
    `The link expires 24 hours after the final leg lands.`,
  ].filter((l) => l !== null);
  const text = lines.join('\n');

  // email-enqueue REQUIRES auth — either `x-internal-secret` header
  // (server-to-server) OR `idToken` in the body (user-authenticated). We
  // try internal secret first (set in Vercel env), and fall back to the
  // user's idToken (which we already validated at the top of this handler).
  // Without idToken fallback, if INTERNAL_API_SECRET is missing or mismatched
  // on the target side, enqueue 401s and the broker email silently fails.
  //
  // `to` may be a single string (legacy) or an array (multi-recipient).
  // email-enqueue accepts both shapes — pass through as-is, normalizing
  // a stray string to a single-element array for consistency.
  const toArray = Array.isArray(to) ? to : [to];
  const body = JSON.stringify({
    to: toArray,
    subject,
    html,
    text,
    source: 'trip-share',
    // tripId carries through so email-enqueue can derive the threadKey
    // automatically (it falls back to `trip-${tripId}` when threadKey is
    // absent). We pass both explicitly so audit records stay clean.
    tripId: tripId || null,
    threadKey: tripId ? `trip-${tripId}` : null,
    // Always include idToken when available — email-enqueue accepts EITHER
    // auth mode, and the broker share flow is always user-initiated so we
    // always have one. This is the belt-and-suspenders fix for silent
    // delivery failures.
    ...(idToken ? { idToken } : {}),
  });
  try {
    const r = await fetch(`${proto}://${host}/api/email-enqueue`, { method: 'POST', headers, body });
    if (r.ok) return { sent: true };
    // Read the response body for diagnostics so this doesn't fail silently
    // again in the future. If enqueue rejected our payload, we want to know
    // why instead of opaque "false."
    const errBody = await r.json().catch(() => ({}));
    console.error('[trip-share] email-enqueue rejected:', r.status, errBody);
    return { sent: false, error: errBody.error || `email-enqueue HTTP ${r.status}` };
  } catch (e) {
    console.error('[trip-share] email send failed:', e.message);
    return { sent: false, error: e.message || 'email send failed' };
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
      // Accept `to` as either a single string or an array of strings.
      // Mirror notify's split pattern so a comma-separated string from
      // an older client (or a paste like "a@x.com, b@x.com") works too.
      const rawTo = body?.to;
      const candidates = Array.isArray(rawTo)
        ? rawTo.map(s => String(s || '').trim()).filter(Boolean)
        : String(rawTo || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
      if (candidates.length === 0) {
        return res.status(400).json({ ok: false, error: 'at least one "to" address required' });
      }
      const EMAIL_RE = /.+@.+\..+/;
      const bad = candidates.find(e => !EMAIL_RE.test(e));
      if (bad) {
        return res.status(400).json({ ok: false, error: `invalid email: ${bad}` });
      }
      // Dedupe case-insensitively. Cap at 20 to deter abuse.
      const seen = new Set();
      const recipients = [];
      for (const e of candidates) {
        const key = e.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        recipients.push(e);
        if (recipients.length >= 20) break;
      }
      const r = await ensureTokenIssued(tripId, { rotate: false });
      let url = publicUrl(req, r.token);
      // Append the broker-page theme if ops opted into the classic view.
      // Premium is the default — leave the URL clean in that case.
      if (body?.theme === 'classic') {
        url = `${url}${url.includes('?') ? '&' : '?'}theme=classic`;
      }

      // Pull trip code + tail for the subject line.
      const snap = await db().collection('trip-state').doc(tripId).get();
      const data = snap.exists ? snap.data() : {};
      const tripCode = data?.tripCode || data?.tripMeta?.tripCode || null;
      const tail = data?.tail || data?.tripMeta?.tail || null;

      // Forward the user's idToken to email-enqueue so it can authenticate
      // EVEN IF the internal-secret env var is missing or mismatched. The
      // user already authed at the top of this handler; reusing their token
      // is safe.
      const userIdToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || body?.idToken || null;

      const result = await sendBrokerEmail(req, {
        to: recipients, url, tripCode, tail, tripId,
        message: body?.message || null,
        fromOpsName: body?.fromOpsName || 'Skyway Ops',
        idToken: userIdToken,
      });

      // If the send failed, return a non-200 with the error reason so the
      // UI can surface a real message instead of falsely claiming success.
      if (!result.sent) {
        return res.status(502).json({ ok: false, error: result.error || 'email delivery failed', url });
      }

      // Record share history for audit. Joined string keeps the field
      // shape unchanged for any downstream consumer that expected a
      // single string (backwards compatible).
      await db().collection('trip-state').doc(tripId).set({
        lastSharedTo: recipients.join(', '),
        lastSharedToList: recipients,
        lastSharedAt: Date.now(),
        lastSharedBy: auth.uid || null,
      }, { merge: true });

      return res.status(200).json({ ok: true, sent: true, url, recipientCount: recipients.length });
    }
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (e) {
    console.error('[trip-share] error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Internal error' });
  }
}
