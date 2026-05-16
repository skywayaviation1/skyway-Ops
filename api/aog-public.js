// PUBLIC token-gated AOG access for external maintenance vendors.
//
// This is the ONLY endpoint reachable without a Skyway account. It is
// deliberately narrow:
//
//   GET  ?token=...&action=get        → returns a SANITIZED view of one AOG
//   POST ?action=status   {token, update}        → append a tech status update
//   POST ?action=logbook  {token, entry}          → append an EXTERNAL logbook entry
//
// Security model (checked on EVERY request):
//   1. HMAC token signature must verify (api/_aog-token.js)
//   2. AOG must exist
//   3. AOG.status must NOT be 'resolved'  (link dies when AOG closes)
//   4. AOG.linkRevoked must be falsy       (instant kill switch)
//   5. token.issuedAt must be >= AOG.linkTokenIssuedAt (rotation invalidates
//      previously-issued links)
//
// The Admin SDK bypasses Firestore rules, so NO rule changes are needed and
// the external party can never read/write anything except this one AOG via
// these three scoped operations. Returned data is whitelisted — internal
// fields (recipients, internal logs, other collections) are never exposed.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyAogToken } from './_aog-token.js';

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

function clip(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}

// Whitelisted projection — only what an external tech needs to see.
function sanitizeAog(a) {
  return {
    id: a.id,
    tail: a.tail || '',
    location: a.location || '',
    fboName: a.fboName || '',
    issueDescription: a.issueDescription || '',
    status: a.status || 'active',
    reportedAt: a.reportedAt || null,
    coordination: {
      maintLead: a.coordination?.maintLead || '',
      technician: a.coordination?.technician || '',
      vendor: a.coordination?.vendor || '',
    },
    diagnostics: {
      pilotDiscrepancy: a.diagnostics?.pilotDiscrepancy || '',
      troubleshooting: a.diagnostics?.troubleshooting || '',
      oemRecommendation: a.diagnostics?.oemRecommendation || '',
    },
    parts: Array.isArray(a.parts) ? a.parts.map((p, idx) => ({
      idx,
      partNumber: p.partNumber || '', description: p.description || '',
      status: p.status || '', eta: p.eta || '',
      techUsage: p.techUsage || null,            // 'used' | 'not_used' | null
      techUsageNote: p.techUsageNote || '',
      techUsageBy: p.techUsageBy || '',
      techUsageAt: p.techUsageAt || null,
    })) : [],
    currentStatus: a.currentStatus || '',
    rtsEstimate: a.rtsEstimate || '',
    referenceDocs: Array.isArray(a.referenceDocs) ? a.referenceDocs.map(d => ({
      id: d.id, filename: d.filename, url: d.url,
    })) : [],
    techUpdates: Array.isArray(a.techUpdates) ? a.techUpdates : [],
    techChat: Array.isArray(a.techChat) ? a.techChat : [],
    logbookEntries: Array.isArray(a.logbookEntries) ? a.logbookEntries.map(e => ({
      id: e.id, timestamp: e.timestamp,
      technicianName: e.technicianName || '',
      workPerformed: e.workPerformed || '',
      external: e.external === true,
      verified: e.verified === true,
    })) : [],
  };
}

async function loadValidAog(token) {
  const v = verifyAogToken(token);
  if (!v.ok) return { error: 'Invalid or expired link', code: 401 };

  const ref = getDb().collection('aog-events').doc(v.aogId);
  const snap = await ref.get();
  if (!snap.exists) return { error: 'AOG not found', code: 404 };
  const data = { id: snap.id, ...snap.data() };

  if (data.status === 'resolved') {
    return { error: 'This AOG has been resolved. The link is no longer active.', code: 410 };
  }
  if (data.linkRevoked) {
    return { error: 'This link has been revoked by Skyway Operations.', code: 403 };
  }
  if (data.linkTokenIssuedAt && v.issuedAt < data.linkTokenIssuedAt) {
    return { error: 'This link has been superseded by a newer link.', code: 403 };
  }
  return { ref, data, tokenIssuedAt: v.issuedAt };
}

async function notifyTeam(data, subject, text) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return;
    const recips = (Array.isArray(data.recipients) ? data.recipients : [])
      .filter(e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    const opsAlert = (process.env.OPS_ALERT_EMAILS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const to = Array.from(new Set([...recips, ...opsAlert]));
    if (to.length === 0) return;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Skyway Ops <noreply@send.flyskyway.com>',
        to,
        subject: subject.slice(0, 200),
        text: text.slice(0, 20000),
      }),
    });
  } catch (e) {
    console.warn('[aog-public] notify failed:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query?.action || '').toString();

  try {
    // ---------- GET: fetch sanitized AOG ----------
    if (req.method === 'GET' && action === 'get') {
      const token = (req.query?.token || '').toString();
      const r = await loadValidAog(token);
      if (r.error) return res.status(r.code).json({ error: r.error });
      return res.status(200).json({ ok: true, aog: sanitizeAog(r.data) });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const r = await loadValidAog(body.token);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const { ref, data } = r;

    // ---------- POST status update ----------
    if (action === 'status') {
      const u = body.update || {};
      const author = clip(u.author, 120).trim();
      const message = clip(u.message, 5000).trim();
      if (!author || !message) {
        return res.status(400).json({ error: 'author and message required' });
      }
      const entry = {
        id: `tu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        author,
        company: clip(u.company, 160).trim(),
        message,
        source: 'external',
      };
      const existing = Array.isArray(data.techUpdates) ? data.techUpdates : [];
      const log = Array.isArray(data.logEntries) ? data.logEntries : [];
      await ref.update({
        techUpdates: [...existing, entry],
        logEntries: [...log, {
          timestamp: Date.now(),
          author: `${author} (external)`,
          message: `Tech status update: ${message.slice(0, 100)}${message.length > 100 ? '…' : ''}`,
        }],
        updatedAt: Date.now(),
      });
      await notifyTeam(
        data,
        `[AOG TECH UPDATE] ${data.tail} at ${data.location}`,
        `External technician update on ${data.tail} (${data.location}).\n\n` +
        `From: ${author}${entry.company ? ` — ${entry.company}` : ''}\n\n` +
        `${message}\n\n— Submitted via Skyway external maintenance link.`
      );
      return res.status(200).json({ ok: true, id: entry.id });
    }

    // ---------- POST external logbook entry (flagged unverified) ----------
    if (action === 'logbook') {
      const e = body.entry || {};
      const technicianName = clip(e.technicianName, 160).trim();
      const workPerformed = clip(e.workPerformed, 8000).trim();
      if (!technicianName || !workPerformed) {
        return res.status(400).json({ error: 'technicianName and workPerformed required' });
      }
      const entry = {
        id: `entry-ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        technicianName,
        technicianCertType: clip(e.technicianCertType, 40).trim(),
        technicianCertNumber: clip(e.technicianCertNumber, 60).trim(),
        company: clip(e.company, 160).trim(),
        workPerformed,
        partsReplaced: Array.isArray(e.partsReplaced)
          ? e.partsReplaced.slice(0, 50).map(p => ({
              partNumber: clip(p.partNumber, 80), description: clip(p.description, 200),
              serialOff: clip(p.serialOff, 80), serialOn: clip(p.serialOn, 80),
            }))
          : [],
        inspectionPerformed: clip(e.inspectionPerformed, 4000).trim(),
        aircraftTotalTime: clip(e.aircraftTotalTime, 40).trim(),
        aircraftCycles: clip(e.aircraftCycles, 40).trim(),
        rtsApproved: e.rtsApproved === true,
        signatureTyped: clip(e.signatureTyped, 160).trim(),
        // CRITICAL: external entries are coordination records, NOT verified
        // 14 CFR Part 43 entries until Skyway personnel review them.
        external: true,
        verified: false,
        signedAt: Date.now(),
      };
      const existing = Array.isArray(data.logbookEntries) ? data.logbookEntries : [];
      const log = Array.isArray(data.logEntries) ? data.logEntries : [];
      await ref.update({
        logbookEntries: [...existing, entry],
        logEntries: [...log, {
          timestamp: Date.now(),
          author: `${technicianName} (external)`,
          message: `EXTERNAL logbook entry added (unverified) — pending Skyway review`,
        }],
        updatedAt: Date.now(),
      });
      await notifyTeam(
        data,
        `[AOG EXTERNAL LOGBOOK — REVIEW NEEDED] ${data.tail}`,
        `An external technician submitted a logbook entry for ${data.tail} ` +
        `(${data.location}). This entry is flagged UNVERIFIED and requires ` +
        `review by Skyway maintenance personnel.\n\n` +
        `Technician: ${technicianName}${entry.company ? ` — ${entry.company}` : ''}\n` +
        `Cert: ${entry.technicianCertType || '—'} ${entry.technicianCertNumber || ''}\n` +
        `RTS claimed: ${entry.rtsApproved ? 'YES' : 'no'}\n\n` +
        `Work performed:\n${workPerformed}\n\n` +
        `Open the AOG in Skyway Ops to review and verify this entry.\n— Skyway Ops`
      );
      return res.status(200).json({ ok: true, id: entry.id });
    }

    // ---------- POST part usage (tech marks part used / not used) ----------
    if (action === 'part-usage') {
      const partIdx = Number(body.partIdx);
      const usage = String(body.usage || '').trim(); // 'used' | 'not_used' | ''
      const note = clip(body.note, 1000).trim();
      const author = clip(body.author, 120).trim();
      if (!Number.isInteger(partIdx) || partIdx < 0) {
        return res.status(400).json({ error: 'valid partIdx required' });
      }
      if (!['used', 'not_used', ''].includes(usage)) {
        return res.status(400).json({ error: "usage must be 'used', 'not_used', or '' to clear" });
      }
      const parts = Array.isArray(data.parts) ? data.parts.slice() : [];
      if (partIdx >= parts.length) {
        return res.status(400).json({ error: 'partIdx out of range' });
      }
      const before = parts[partIdx] || {};
      parts[partIdx] = {
        ...before,
        techUsage: usage || null,
        techUsageNote: note,
        techUsageBy: author || before.techUsageBy || 'External tech',
        techUsageAt: usage ? Date.now() : null,
      };

      const log = Array.isArray(data.logEntries) ? data.logEntries : [];
      const label = usage === 'used' ? 'USED'
                  : usage === 'not_used' ? 'NOT USED'
                  : 'cleared';
      await ref.update({
        parts,
        updatedAt: Date.now(),
        logEntries: [...log, {
          timestamp: Date.now(),
          author: `${author || 'External tech'} (external)`,
          message: `Part marked ${label}: ${before.partNumber || '(no P/N)'}${before.description ? ` — ${before.description}` : ''}${note ? ` · note: ${note}` : ''}`,
        }],
      });

      return res.status(200).json({ ok: true });
    }

    // ---------- POST tech question (emails Jake + MX with link) ----------
    if (action === 'chat') {
      const q = body.message || {};
      const author = clip(q.author, 120).trim();
      const text = clip(q.text, 4000).trim();
      if (!author || !text) {
        return res.status(400).json({ error: 'author and message are required' });
      }
      const msg = {
        id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        from: 'tech',
        author,
        company: clip(q.company, 160).trim(),
        message: text,
      };
      const existing = Array.isArray(data.techChat) ? data.techChat : [];
      const isFirstMessage = existing.length === 0;
      const log = Array.isArray(data.logEntries) ? data.logEntries : [];

      await ref.update({
        techChat: [...existing, msg],
        // Tech is now waiting. The 5-min nudge cron uses these two fields:
        // it emails if lastTechMsgAt is newer than lastSkywayReplyAt by >5min
        // and we haven't already nudged for this exact message.
        lastTechMsgAt: msg.timestamp,
        techChatNudgedAt: null,
        logEntries: [...log, {
          timestamp: Date.now(),
          author: `${author} (external)`,
          message: `Tech chat: ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`,
        }],
        updatedAt: Date.now(),
      });

      // Email Jake + MX ONLY on the first message of the conversation.
      // Subsequent unanswered messages are handled by the 5-min nudge cron.
      if (isFirstMessage) {
        const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
        const techLink = `${proto}://${host}/aog-tech?token=${encodeURIComponent(body.token)}`;
        try {
          const apiKey = process.env.RESEND_API_KEY;
          if (apiKey) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'Skyway Ops <noreply@send.flyskyway.com>',
                to: ['Jake@flyskyway.com', 'MX@flyskyway.com'],
                subject: `[AOG CHAT STARTED] ${data.tail} at ${data.location} — tech is waiting`,
                text:
                  `An external maintenance technician started a chat on the AOG for ` +
                  `${data.tail} (${data.location}${data.fboName ? ' / ' + data.fboName : ''}).\n\n` +
                  `From: ${author}${msg.company ? ` — ${msg.company}` : ''}\n\n` +
                  `Message:\n${text}\n\n` +
                  `Reply in Skyway Ops (open the AOG → Tech Chat), or use this ` +
                  `quick-reply link which opens the conversation:\n${techLink}\n\n` +
                  `You'll get another email if the tech is left waiting more ` +
                  `than 5 minutes.\n— Skyway Ops`,
              }),
            });
          }
        } catch (e) {
          console.warn('[aog-public] chat first-message email failed:', e.message);
        }
      }

      return res.status(200).json({ ok: true, id: msg.id });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[aog-public] error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
