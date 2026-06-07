// /api/wear-notify.js
//
// Fast MX notification endpoint. Called from the client right after a
// wear inspection is saved. Two trigger conditions:
//
//   1. Pilot logged anything other than GOOD     -> alert email immediately
//   2. Pilot used DEFER WITH REASON              -> alert email immediately
//
// Does NOT depend on AI vision (which runs separately and may flag
// additional issues later in /api/wear-vision-check).
//
// Body: { idToken, inspectionId }

import admin from 'firebase-admin';

export const config = { runtime: 'nodejs' };

let adminApp = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}

async function authorize(req, body) {
  const idToken =
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') || body?.idToken;
  if (!idToken) return null;
  try { return await admin.auth(getAdmin()).verifyIdToken(idToken); }
  catch { return null; }
}

async function sendEmail({ subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[wear-notify] RESEND_API_KEY not configured');
    return false;
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Skyway Ops <ops@send.flyskyway.com>',
      to: ['mx@flyskyway.com'],
      cc: ['jake@flyskyway.com', 'charters@flyskyway.com'],
      subject,
      text,
      html,
    }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    console.warn('[wear-notify] resend error:', resp.status, j);
    return false;
  }
  return true;
}

const STATUS_LABEL = { good: 'GOOD', monitor: 'MONITOR', replace_soon: 'REPLACE SOON', grounded: 'GROUNDED' };
const POSITION_LABEL = { nose: 'Nose Gear', 'main-l': 'Main Gear L', 'main-r': 'Main Gear R' };
const ITEM_LABEL = { tire: 'Tire', brake: 'Brake' };

function buildBody(insp) {
  const when = new Date(insp.inspectedAtMs).toLocaleString('en-US', {
    timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short',
  });
  const lines = [
    `Tail:     ${insp.tail}`,
    `Item:     ${POSITION_LABEL[insp.position] || insp.position} · ${ITEM_LABEL[insp.itemType] || insp.itemType}`,
    `Status:   ${insp.isDeferred ? 'DEFERRED' : STATUS_LABEL[insp.pilotStatus] || insp.pilotStatus}`,
    `Pilot:    ${insp.inspectedByName || insp.inspectedBy || '—'}`,
    `When:     ${when} ET`,
    `Type:     ${insp.inspectionType}`,
    '',
    `Notes:    ${insp.notes || insp.deferReason || '(none)'}`,
    '',
    `Photo:    ${insp.photoUrl || '(no photo — deferred)'}`,
    '',
    `View in Skyway Ops: https://skyway-ops.vercel.app`,
  ];
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  const decoded = await authorize(req, body);
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

  const inspectionId = body?.inspectionId;
  if (!inspectionId) return res.status(400).json({ error: 'inspectionId required' });

  try {
    const a = getAdmin();
    const db = admin.firestore(a, 'appusers');
    const snap = await db.collection('wear-inspections').doc(inspectionId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Inspection not found' });
    const insp = { id: snap.id, ...snap.data() };

    const isDrop = !insp.isDeferred && insp.pilotStatus && insp.pilotStatus !== 'good';
    const isDefer = !!insp.isDeferred;
    if (!isDrop && !isDefer) {
      return res.status(200).json({ ok: true, skipped: 'no alert needed' });
    }

    let subject;
    if (isDefer) {
      subject = `[Skyway WEAR] DEFER · ${insp.tail} ${insp.inspectionType.replace(/_/g, ' ')}`;
    } else {
      subject = `[Skyway WEAR] ${STATUS_LABEL[insp.pilotStatus]} · ${insp.tail} ${POSITION_LABEL[insp.position] || insp.position} ${ITEM_LABEL[insp.itemType] || insp.itemType}`;
    }
    const text = buildBody(insp);
    await sendEmail({ subject, text });

    // Mark on the inspection that we sent the email so we don't double-send
    await db.collection('wear-inspections').doc(inspectionId).set({
      notifyEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
      notifyEmailSentAtMs: Date.now(),
    }, { merge: true });

    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    console.error('[wear-notify] error:', e);
    return res.status(500).json({ error: e?.message || 'notify failed' });
  }
}
