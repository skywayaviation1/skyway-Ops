// Cron — every minute. Finds service requests where an external tech sent a
// chat message and Skyway hasn't replied within 5 minutes, and emails
// Jake@ + MX@ a "tech is waiting" nudge. Idempotent: marks
// techChatNudgedAt so the same wait doesn't get emailed repeatedly.
//
// Mirror of api/aog-chat-nudge.js. Wired in vercel.json crons (every
// minute). No auth header — Vercel cron calls it directly; it only reads
// service requests and sends an internal notification email.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { applySkywaySignature, ensureCharterCc, textToHtml } from './_email-signature.js';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let _db = null;
function getAdmin() {
  if (adminApp) return adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  }
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

const WAIT_MS = 5 * 60 * 1000; // 5 minutes

export default async function handler(req, res) {
  try {
    const db = getDb();
    const now = Date.now();

    // Open service requests only. Small collection; in-memory filter
    // avoids a composite index.
    const snap = await db.collection('service-requests')
      .where('status', '==', 'open')
      .limit(200)
      .get();

    if (snap.empty) {
      return res.status(200).json({ ok: true, nudged: 0 });
    }

    const apiKey = process.env.RESEND_API_KEY;
    let nudged = 0;

    for (const docSnap of snap.docs) {
      const a = docSnap.data();
      const chat = Array.isArray(a.techChat) ? a.techChat : [];
      if (chat.length === 0) continue;

      const lastTechMsgAt = a.lastTechMsgAt || 0;
      const lastSkywayReplyAt = a.lastSkywayReplyAt || 0;
      const alreadyNudgedAt = a.techChatNudgedAt || 0;

      const techWaiting = lastTechMsgAt > lastSkywayReplyAt;
      if (!techWaiting) continue;

      if (now - lastTechMsgAt < WAIT_MS) continue;

      if (alreadyNudgedAt && alreadyNudgedAt >= lastTechMsgAt) continue;

      const lastTechMsg = [...chat].reverse().find(m => m.from === 'tech');
      const preview = lastTechMsg ? lastTechMsg.message : '(no text)';
      const who = lastTechMsg
        ? `${lastTechMsg.author}${lastTechMsg.company ? ` — ${lastTechMsg.company}` : ''}`
        : 'External technician';

      const mins = Math.round((now - lastTechMsgAt) / 60000);

      if (apiKey) {
        try {
          const emailText =
            `An external maintenance technician has been waiting ${mins} ` +
            `minutes for a reply on the service request for ${a.tail} ` +
            `(${a.location || '—'}${a.fboName ? ' / ' + a.fboName : ''}).\n\n` +
            `From: ${who}\n\n` +
            `Latest message:\n${preview}\n\n` +
            `Open the service request in Skyway Ops → Tech Chat to reply.\n` +
            `— Skyway Ops (automatic reminder)`;
          const recipients = ['Jake@flyskyway.com', 'MX@flyskyway.com'];
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Skyway Ops <noreply@send.flyskyway.com>',
              to: recipients,
              cc: ensureCharterCc([], recipients),
              subject: `[SERVICE CHAT WAITING ${mins}m] ${a.tail || ''} — tech needs a reply`,
              text: emailText,
              html: applySkywaySignature(textToHtml(emailText)),
            }),
          });
        } catch (e) {
          console.warn('[service-chat-nudge] email failed for', docSnap.id, e.message);
          continue; // don't mark nudged if the email didn't go out
        }
      }

      await docSnap.ref.update({ techChatNudgedAt: now });
      nudged++;
    }

    return res.status(200).json({ ok: true, nudged });
  } catch (err) {
    console.error('[service-chat-nudge] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
