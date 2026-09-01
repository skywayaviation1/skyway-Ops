// /api/email-enqueue.js
//
// Reliable email submission: writes the email into the email-queue Firestore
// collection. The email-queue-drain cron picks it up within ~60 seconds and
// delivers via Resend, retrying on failure.
//
// Frontend should call this INSTEAD OF send-email for any email that should
// be reliably delivered (status notifications, AOG, logbook, MX). Use the old
// send-email.js only when you absolutely need an immediate, in-line send (rare).
//
// Auth: same dual-auth as send-email — Firebase idToken (frontend) OR
// INTERNAL_API_SECRET header (server-to-server).
//
// Body:
//   {
//     to: ['...'],                  // required, array of strings
//     cc: ['...'],                  // optional
//     subject: '...',               // required
//     html: '...',                  // either html OR text required
//     text: '...',                  //   (text is converted to a basic html wrapper)
//     from: '...',                  // optional override
//     source: 'manual_status',      // optional metadata for traceability
//     tripId: '...',                // optional
//     statusKey: '...',             // optional
//     maxAttempts: 5,               // optional, default 5
//     idToken: '...',               // when called from frontend
//   }
// Response:
//   { ok: true, queueId: '...' }   — queued, will deliver within ~60s
//   { error: '...' }                — failed to queue (Firestore down etc)

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { applySkywaySignature, textToHtml, withCharterCopy } from './_email-signature.js';
import { explainSendFailure, isPermanentSendFailure } from './_email-delivery.js';
import { deliverNotification } from './_email-transport.js';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let _db = null;

function getAdmin() {
  if (adminApp) return adminApp;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return adminApp;
}
function getDb() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

function genId() {
  return 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-internal-secret');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'invalid json body' });
  }

  // Auth: idToken OR internal secret
  let authedAs = null;
  const internalSecret = req.headers['x-internal-secret'];
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) {
    authedAs = 'internal';
  } else if (body.idToken) {
    try {
      const decoded = await admin.auth(getAdmin()).verifyIdToken(body.idToken);
      authedAs = `user:${decoded.uid}`;
    } catch (e) {
      return res.status(401).json({ error: 'invalid idToken', reason: e.message });
    }
  } else {
    return res.status(401).json({ error: 'Unauthorized: provide idToken or x-internal-secret' });
  }

  const { to, cc, subject, html, text, from, source, tripId, statusKey, threadKey, includeTrackingButton } = body;
  if (!Array.isArray(to) || to.length === 0) {
    return res.status(400).json({ error: 'to[] required' });
  }
  if (!subject || (!html && !text)) {
    return res.status(400).json({ error: 'subject and (html or text) required' });
  }

  // Validate recipients
  const validTo = to.filter(
    (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
  );
  if (validTo.length === 0) {
    return res.status(400).json({ error: 'No valid recipient email addresses' });
  }
  const validCc = Array.isArray(cc)
    ? cc.filter(e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))
    : [];
  // Put charters@flyskyway.com on the CC line of every outgoing email so any
  // broker reply lands in the monitored inbox (despite the do-not-reply
  // notice). Callers build recipient lists from an ops constant that is this
  // same address, so this also moves it off the To line — otherwise it is a
  // direct recipient and never shows as a CC. It stays on To only when it
  // would otherwise be the sole recipient.
  const { to: finalTo, cc: finalCc } = withCharterCopy({ to: validTo, cc: validCc });

  // Build the final HTML body. Either:
  //   - caller passed html → we wrap it with Skyway header/footer
  //   - caller passed text → convert to a basic html wrapper, THEN wrap
  // Both paths end up running through the same signature wrapper so every
  // email leaving Skyway carries the brand + do-not-reply notice.
  let rawHtml = html
    ? String(html).slice(0, 200000)
    : textToHtml(text).slice(0, 200000);

  // "Track This Flight" button injection. When the client sets
  // includeTrackingButton=true AND provides a tripId, we look up the
  // trip's broker tracking link from trip-state. If the link is active
  // (token present, not revoked), we prepend a styled button to the
  // body BEFORE applySkywaySignature wraps with the Skyway header/footer.
  // This way the button lands between the header and the message body —
  // prominent placement above the fold for brokers reading the email.
  if (includeTrackingButton && tripId) {
    try {
      const trackingUrl = await findActiveBrokerTrackingUrl(req, tripId);
      if (trackingUrl) {
        rawHtml = renderTrackButton(trackingUrl) + rawHtml;
      }
    } catch (e) {
      // Non-fatal: if the lookup fails for any reason, the email still
      // goes out without the button. We'd rather deliver a delay/status
      // notification than block on a button render.
      console.warn('[email-enqueue] track-button lookup failed:', e.message);
    }
  }

  const wrappedHtml = applySkywaySignature(rawHtml);

  try {
    getAdmin();
    const db = getDb();
    const id = genId();
    const now = Date.now();

    // Threading headers — applied ONLY when the caller explicitly passes
    // `threadKey`. We deliberately do NOT auto-derive from tripId here;
    // many App.jsx-initiated emails (delay notifications, status updates)
    // already carry tripId for audit purposes, and Jake doesn't want those
    // threaded into one inbox conversation per trip. Currently only the
    // broker tracking-link flow (trip-share.js) passes `threadKey`.
    const threadHeaders = threadKey
      ? buildThreadHeaders(threadKey)
      : null;

    // ATTEMPT 1: deliver immediately. This is the fast path that 99% of
    // emails take. The dispatcher tapped the status; they want the email out
    // NOW, not in 60 seconds when the queue cron next runs.
    //
    // Recipients inside the operator's own Microsoft 365 tenant are handed to
    // Exchange rather than to the provider: mail sent by the provider comes
    // from a subdomain of the tenant's own domain, so Exchange treats it as
    // spoofed and filters it before it reaches an inbox. Everyone else goes out
    // through the provider as before.
    const sendResult = await deliverNotification({
      to: finalTo,
      cc: finalCc,
      subject: String(subject).slice(0, 200),
      html: wrappedHtml,
      from: from || null,
      headers: threadHeaders,
    });
    const internalDelivery = sendResult.internal;

    // Write the record either way — sent or pending. This gives us a full
    // audit trail of every email that should have gone out, regardless of
    // delivery success.
    const baseRecord = {
      to: finalTo,
      cc: finalCc,
      internalDelivery,
      internalDelivered: internalDelivery.ok === true,
      tenantMailDegraded: sendResult.tenantMailDegraded === true,
      tenantMailError: sendResult.tenantMailError || null,
      subject: String(subject).slice(0, 200),
      html: wrappedHtml,
      from: from || null,
      attempts: 1,
      maxAttempts: body.maxAttempts || 5,
      queuedAt: now,
      lastAttemptAt: now,
      source: source || null,
      tripId: tripId || null,
      threadKey: threadKey || null,
      statusKey: statusKey || null,
      queuedBy: authedAs,
    };

    if (sendResult.ok) {
      // FAST PATH: every recipient was accepted on the first try.
      await db.collection('email-queue').doc(id).set({
        ...baseRecord,
        status: 'sent',
        sentAt: Date.now(),
        resendId: sendResult.provider?.id || null,
        lastError: null,
        nextAttemptAt: null,
        deadAt: null,
      });
      console.log('[email-enqueue] SENT inline', id, '→', finalTo.join(','),
        '· cc:', finalCc.join(',') || '-',
        '· tenant mailboxes:', internalDeliveryLabel(internalDelivery),
        '· resend id:', sendResult.provider?.id || '-', '· source:', source || '-');
      return res.status(200).json({
        ok: true,
        delivered: true,
        queueId: id,
        resendId: sendResult.provider?.id || null,
        delivery: sendResult.internalOnly ? 'tenant-mailbox' : 'inline',
        internalDelivery,
        error: null,
      });
    }

    // SLOW PATH: Resend rejected the message. A configuration rejection (bad
    // key, unverified sending domain, malformed from) will fail identically on
    // every retry, so it is reported as permanent instead of being dressed up
    // as a queued success that never arrives.
    const permanent = isPermanentSendFailure(sendResult.error);
    await db.collection('email-queue').doc(id).set({
      ...baseRecord,
      status: permanent ? 'dead' : 'failed',
      sentAt: null,
      resendId: null,
      lastError: sendResult.error || 'unknown error',
      nextAttemptAt: permanent ? null : now + 10 * 1000,   // retry in 10 seconds
      deadAt: permanent ? now : null,
    });
    console.warn('[email-enqueue] inline send failed for', id, '· error:', sendResult.error,
      '· tenant mailboxes:', internalDeliveryLabel(internalDelivery),
      permanent ? '· permanent, not retrying' : '· queued for retry');

    // `delivered: false` is the contract the app relies on to keep the status
    // marked un-notified and show the retry affordance. Returning ok:true with
    // no delivery signal is what previously made failures look like successes.
    return res.status(200).json({
      ok: true,
      delivered: false,
      queueId: id,
      delivery: permanent ? 'failed' : 'queued',
      willRetry: !permanent,
      error: sendResult.error || 'unknown error',
      explanation: explainSendFailure(sendResult.error),
      reason: sendResult.error,
    });
  } catch (err) {
    console.error('[email-enqueue] error:', err);
    return res.status(500).json({ error: err.message || 'enqueue failed' });
  }
}

// Look up the broker tracking URL for a given trip. Returns null when
// there's no active link (no trip-state doc, no token, or link revoked).
// Used by the "Track This Flight" button injection above.
//
// The URL format matches /api/trip-share's publicUrl helper so brokers
// land on exactly the same page whether the link came from the SHARE
// dialog email or from a notify/delay email button.
async function findActiveBrokerTrackingUrl(req, tripId) {
  try {
    const db = getDb();
    const snap = await db.collection('trip-state').doc(String(tripId)).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    if (data.linkRevoked === true) return null;
    if (!data.token) return null;
    const host = req.headers.host
      || process.env.VERCEL_PROJECT_PRODUCTION_URL
      || 'skyway-ops.vercel.app';
    const proto = host.includes('localhost') ? 'http' : 'https';
    return `${proto}://${host}/trip-track.html?token=${encodeURIComponent(data.token)}`;
  } catch (e) {
    console.warn('[track-url] lookup error:', e.message);
    return null;
  }
}

// Render the "Track This Flight" button as inline HTML. Styles are
// inlined because email clients (Outlook in particular) don't reliably
// load external stylesheets. Skyway brand: cyan #1ec0e9 on black with
// the same tracking-letter aesthetic as the in-app buttons.
//
// Font stack: Inter / Helvetica Neue / Arial. Email clients can't load
// Google Fonts (Bebas Neue, JetBrains Mono), so a safe sans-serif
// fallback chain gives a clean uppercase button on every reader.
function renderTrackButton(url) {
  return `<div style="text-align:center;margin:24px 0;">`
    + `<a href="${url}" `
    + `style="display:inline-block;background:#1ec0e9;color:#000;`
    + `padding:14px 36px;text-decoration:none;`
    + `font-family:'Inter','Helvetica Neue',Arial,sans-serif;`
    + `font-weight:700;font-size:14px;letter-spacing:0.18em;`
    + `border:2px solid #1ec0e9;">`
    + `TRACK THIS FLIGHT &rarr;`
    + `</a>`
    + `</div>`;
}

// Build email threading headers from a stable thread key (e.g. "trip-JI-1234"
// or "aog-N20UF-7"). Returns a headers object suitable for Resend's API.
//
// The phantom Message-ID format is `<threadKey@flyskyway.com>` — never
// actually sent as a real email, but every message about the same
// thread references it so mail clients group them.
//
// Why both References AND In-Reply-To:
//   - Gmail/Apple Mail thread primarily on References
//   - Outlook (desktop + M365 web) uses In-Reply-To as the strong signal
//   - Setting both maximizes threading compatibility across recipient inboxes
function buildThreadHeaders(threadKey) {
  if (!threadKey) return null;
  // Sanitize to safe Message-ID characters. RFC 5322 allows a wide charset
  // in dot-atoms but keeping to [A-Za-z0-9_-] avoids any client doing
  // weird parsing tricks.
  const safe = String(threadKey).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  if (!safe) return null;
  const phantomId = `<${safe}@flyskyway.com>`;
  return {
    'References': phantomId,
    'In-Reply-To': phantomId,
  };
}

// One-line summary of the tenant-mailbox leg, for the server log.
function internalDeliveryLabel(internal) {
  if (!internal) return 'not attempted';
  if (internal.ok) return internal.filedCopy ? 'filed directly in mailbox' : 'sent by Exchange';
  return internal.skipped || internal.error || 'failed';
}
