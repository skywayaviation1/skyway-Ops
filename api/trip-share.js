import { reviewerSessionBlock } from '../src/reviewer-account.js';
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
import {
  linkPatchFromRequest,
  trackingSubjectMeta,
  trackingUrl,
} from '../src/trip-itinerary.js';

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
    const decoded = reviewerSessionBlock(await admin.auth(getAdmin()).verifyIdToken(idToken));
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
  return trackingUrl(`${proto}://${host}`, token);
}

async function ensureTokenIssued(tripId, opts = {}) {
  const ref = db().collection('trip-state').doc(tripId);
  const snap = await ref.get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const now = Date.now();
  // The link stores a selection rule. The browser itinerary is ignored —
  // trip-public rebuilds legs from the live schedule on every read.
  const { patch, issuedAt, reused, shareRule } = linkPatchFromRequest({
    existing: data,
    tripId,
    rotate: opts.rotate === true,
    shareSelection: opts.shareSelection || null,
    now,
  });
  if (Object.keys(patch).length > 0) {
    await ref.set(patch, { merge: true });
  }
  const token = signTripToken(tripId, issuedAt);
  return { token, issuedAt, reused, shareRule: shareRule || data.shareRule || null };
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

  const selection = body?.shareSelection;
  console.log('[trip-share] incoming', {
    action: body?.action,
    tripId: body?.tripId,
    hasSelection: !!selection,
    tripCode: selection?.tripCode || null,
    tail: selection?.tail || null,
    pinned: Array.isArray(selection?.pinnedLegUids) ? selection.pinnedLegUids.length : 0,
  });

  const auth = await authorize(req, body);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const action = String(body?.action || '');
  const tripId = String(body?.tripId || '').trim();
  if (!tripId) return res.status(400).json({ ok: false, error: 'tripId required' });

  try {
    if (action === 'generate') {
      const r = await ensureTokenIssued(tripId, { rotate: false, shareSelection: body?.shareSelection });
      return res.status(200).json({
        ok: true,
        url: publicUrl(req, r.token),
        token: r.token,
        issuedAt: r.issuedAt,
        reused: r.reused,
      });
    }
    if (action === 'rotate') {
      const r = await ensureTokenIssued(tripId, { rotate: true, shareSelection: body?.shareSelection });
      return res.status(200).json({
        ok: true,
        url: publicUrl(req, r.token),
        token: r.token,
        issuedAt: r.issuedAt,
        rotated: true,
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
      // A full selection replaces the rule. An email from an older client
      // that only has a recipient must not wipe the rule down to that address.
      const shareSelection = body?.shareSelection && typeof body.shareSelection === 'object'
        ? {
            ...body.shareSelection,
            brokerEmail: body.shareSelection.brokerEmail || recipients[0],
            theme: body?.theme || body.shareSelection.theme,
          }
        : null;
      const r = await ensureTokenIssued(tripId, { rotate: false, shareSelection });
      if (!shareSelection) {
        const emailPatch = { brokerEmail: recipients[0] };
        if (body?.theme === 'classic' || body?.theme === 'premium') emailPatch.theme = body.theme;
        await db().collection('trip-state').doc(tripId).set({ shareRule: emailPatch }, { merge: true });
      }
      let url = publicUrl(req, r.token);
      // Append the broker-page theme if ops opted into the classic view.
      // Premium is the default — leave the URL clean in that case.
      if (body?.theme === 'classic') {
        url = `${url}${url.includes('?') ? '&' : '?'}theme=classic`;
      }

      // Trip code and tail come from the selection rule (or the trip-state
      // fields ops already saved). The old browser snapshot is not read.
      const snap = await db().collection('trip-state').doc(tripId).get();
      const data = snap.exists ? snap.data() : {};
      const meta = trackingSubjectMeta(data, r.shareRule);
      const tripCode = meta.tripCode;
      const tail = meta.tail;

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
