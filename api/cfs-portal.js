// CFS portal API. Every read and write goes through the Admin SDK.
// The response is the CFS-safe projection: no premium, rate, margin, payment,
// broker contact, passengers, or 50% trips.

import crypto from 'crypto';
import admin from 'firebase-admin';
import {
  acknowledgeCfs,
  appendCoverageEvent,
  authorizeOps,
  findByAckToken,
  getAdmin,
  hashOfferToken,
  loadSettings,
  publicBaseUrl,
  readJson,
  readPdf,
  recoveryDb,
  sendRecoveryEmail,
} from './_aog-recovery.js';
import {
  CFS_SESSION_TTL_MS,
  MAGIC_LINK_TTL_MS,
  PORTAL_PAGE_SIZE,
  PREVIEW_TTL_MS,
  cfsEventProjection,
  cfsTripProjection,
  dashboardSummary,
  filterPortalTrips,
  isCfsVisibleRecord,
  magicLinkDecision,
  magicLinkPayload,
  pagePortalTrips,
  sortPortalTrips,
  statementCsv,
  statementFor,
  statementPdf,
} from '../src/cfs-portal.js';
import { normalizeTripId } from '../src/trip-id.js';

export const config = { runtime: 'nodejs' };

const LINKS = 'cfsAuthLinks';
const SESSIONS = 'cfsSessions';
const DOWNLOADS = 'cfsDownloads';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function loadVisible(db) {
  let snap;
  try {
    snap = await db.collection('aogRecovery').orderBy('createdAt', 'desc').limit(400).get();
  } catch {
    snap = await db.collection('aogRecovery').limit(400).get();
  }
  return snap.docs
    .map((docSnap) => ({ id: docSnap.id, ref: docSnap.ref, ...docSnap.data() }))
    .filter(isCfsVisibleRecord);
}

async function legsFor(db, record) {
  const code = normalizeTripId(record.tripId);
  if (!code) return [];
  try {
    const snap = await db.collection('trip-state').where('tripSheetData.tripCode', '==', code).limit(20).get();
    return snap.docs.map((docSnap) => {
      const data = docSnap.data() || {};
      const meta = data.tripMeta || {};
      return {
        from: meta.from || '',
        to: meta.to || '',
        start: meta.start || '',
        end: meta.end || '',
        tail: meta.tail || '',
      };
    }).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  } catch {
    return [];
  }
}

async function requireSession(db, token) {
  const raw = String(token || '').trim();
  if (raw.length < 20) {
    const error = new Error('Sign in to the CFS portal');
    error.status = 401;
    throw error;
  }
  const snap = await db.collection(SESSIONS).doc(hashToken(raw)).get();
  const data = snap.data() || {};
  if (!snap.exists || Date.parse(data.expiresAt || '') < Date.now()) {
    const error = new Error('This CFS portal session has expired');
    error.status = 401;
    throw error;
  }
  return { token: raw, email: data.email || '', preview: data.preview === true };
}

async function customTokenFor(email) {
  try {
    const auth = admin.auth(getAdmin());
    const uid = `cfs_${hashToken(email).slice(0, 28)}`;
    try {
      await auth.getUser(uid);
    } catch {
      await auth.createUser({ uid, email, emailVerified: true });
    }
    await auth.setCustomUserClaims(uid, { role: 'cfs' });
    return await auth.createCustomToken(uid, { role: 'cfs' });
  } catch (err) {
    console.warn('[cfs-portal] custom token skipped:', err.message);
    return '';
  }
}

function listPayload(records, body) {
  const projected = records.map((record) => cfsTripProjection(record)).filter(Boolean);
  const filtered = sortPortalTrips(filterPortalTrips(projected, body || {}), body.sort || 'depart');
  return {
    summary: dashboardSummary(projected),
    ...pagePortalTrips(filtered, body.page, PORTAL_PAGE_SIZE),
  };
}

async function sendMagicLink({ email, link }) {
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1c1917">`
    + `<p style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#57534e">Skyway Aviation × Charter Flight Support</p>`
    + `<h1 style="font-size:22px">Sign in to the CFS portal</h1>`
    + `<p>This link signs you in for 7 days. It expires in 15 minutes and works once.</p>`
    + `<p><a href="${link}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px">Open the CFS portal</a></p>`
    + `</div>`;
  return sendRecoveryEmail({
    to: email,
    subject: 'Sign in to the Charter Flight Support portal',
    html,
    text: `Sign in to the CFS portal:\n${link}\nThis link expires in 15 minutes.`,
  });
}

async function handleDownload(db, token, res) {
  const snap = await db.collection(DOWNLOADS).doc(hashToken(token)).get();
  const data = snap.data() || {};
  if (!snap.exists || Date.parse(data.expiresAt || '') < Date.now() || !data.path) {
    res.status(404).json({ error: 'This contract link has expired' });
    return;
  }
  const bytes = await readPdf(data.path);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="charter-contract.pdf"');
  res.end(bytes);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const download = String(req.query?.download || '').trim();
    if (!download) {
      res.status(405).json({ error: 'POST only' });
      return;
    }
    try {
      await handleDownload(recoveryDb(), download, res);
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Download failed' });
    }
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const body = readJson(req);
    const action = String(body.action || 'list').trim();
    const db = recoveryDb();
    const base = publicBaseUrl(req);

    if (action === 'request-link') {
      const settings = await loadSettings(db);
      const decision = magicLinkDecision(body.email, settings.cfsStaff);
      if (!decision.ok) {
        res.status(decision.status).json({ error: decision.error });
        return;
      }
      let devLink = '';
      if (decision.send) {
        const token = newToken();
        const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
        await db.collection(LINKS).doc(hashOfferToken(token)).set({
          email: decision.email,
          expiresAt,
          used: false,
        });
        const link = `${base}/cfs?link=${encodeURIComponent(token)}`;
        try {
          await sendMagicLink({ email: decision.email, link });
        } catch (err) {
          console.warn('[cfs-portal] magic link mail failed:', err.message);
        }
        devLink = magicLinkPayload({ emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST), link }).devLink || '';
      }
      res.status(200).json({ ok: true, ...(devLink ? { devLink } : {}) });
      return;
    }

    if (action === 'redeem') {
      const token = String(body.token || '').trim();
      const linkSnap = await db.collection(LINKS).doc(hashOfferToken(token)).get();
      const link = linkSnap.data() || {};
      if (!linkSnap.exists || link.used || Date.parse(link.expiresAt || '') < Date.now()) {
        res.status(400).json({ error: 'This sign-in link is not valid anymore' });
        return;
      }
      await linkSnap.ref.set({ used: true }, { merge: true });
      const session = newToken();
      await db.collection(SESSIONS).doc(hashToken(session)).set({
        email: link.email,
        preview: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CFS_SESSION_TTL_MS).toISOString(),
      });
      const customToken = await customTokenFor(link.email);
      res.status(200).json({ ok: true, sessionToken: session, email: link.email, customToken, preview: false });
      return;
    }

    if (action === 'preview') {
      const actor = await authorizeOps(body.idToken);
      const session = newToken();
      await db.collection(SESSIONS).doc(hashToken(session)).set({
        email: actor.email,
        preview: true,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      });
      res.status(200).json({
        ok: true,
        preview: true,
        portalPath: `/cfs?preview=${encodeURIComponent(session)}`,
      });
      return;
    }

    const session = await requireSession(db, body.sessionToken || body.previewToken);
    if (session.preview && ['acknowledge', 'bulk-acknowledge'].includes(action)) {
      res.status(403).json({ error: 'The CFS portal preview is read-only' });
      return;
    }

    const records = await loadVisible(db);

    if (action === 'list' || action === 'dashboard') {
      res.status(200).json({ ok: true, email: session.email, preview: session.preview, ...listPayload(records, body) });
      return;
    }

    if (action === 'trip') {
      const found = records.find((record) => record.id === body.id || normalizeTripId(record.tripId) === normalizeTripId(body.tripId));
      if (!found) {
        res.status(404).json({ error: 'That trip is not in the CFS portal' });
        return;
      }
      const legs = await legsFor(db, found);
      const eventsSnap = await found.ref.collection('coverageEvents').get();
      const events = eventsSnap.docs.map((docSnap) => cfsEventProjection({ id: docSnap.id, ...docSnap.data() })).filter(Boolean);
      if (!session.preview) {
        const last = Date.parse(found.cfsLastPortalViewAt || '');
        if (!Number.isFinite(last) || Date.now() - last > 60 * 60 * 1000) {
          const at = new Date().toISOString();
          await found.ref.set({ cfsLastPortalViewAt: at }, { merge: true });
          await appendCoverageEvent(db, found.id, {
            type: 'cfs_portal_opened',
            atUtc: at,
            actor: session.email,
            detail: 'Opened in the CFS portal',
            tripId: found.tripId,
          }).catch(() => {});
        }
      }
      res.status(200).json({
        ok: true,
        preview: session.preview,
        trip: cfsTripProjection(found, legs),
        events,
      });
      return;
    }

    if (action === 'contract') {
      const found = records.find((record) => record.id === body.id);
      if (!found?.charterContractPath) {
        res.status(404).json({ error: 'No charter contract is on file for this trip' });
        return;
      }
      const token = newToken();
      await db.collection(DOWNLOADS).doc(hashToken(token)).set({
        path: found.charterContractPath,
        email: session.email,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      res.status(200).json({ ok: true, url: `${base}/api/cfs-portal?download=${encodeURIComponent(token)}`, expiresInSeconds: 300 });
      return;
    }

    if (action === 'acknowledge' || action === 'bulk-acknowledge') {
      const items = action === 'acknowledge'
        ? [{ id: body.id, ...body }]
        : (Array.isArray(body.trips) ? body.trips : []);
      if (!items.length) {
        res.status(400).json({ error: 'Choose at least one trip' });
        return;
      }
      const results = [];
      for (const item of items) {
        const found = records.find((record) => record.id === item.id);
        if (!found) {
          results.push({ id: item.id, ok: false, error: 'Trip is not visible to CFS' });
          continue;
        }
        try {
          const outcome = await acknowledgeCfs(db, found.ref, {
            name: item.name,
            email: item.email || session.email,
            cfsCost: item.cfsCost,
            reference: item.reference,
            notes: item.notes,
          });
          results.push({ id: found.id, tripId: normalizeTripId(found.tripId), ok: true, emailError: outcome.emailError || '' });
        } catch (err) {
          results.push({ id: found.id, ok: false, error: err.message });
        }
      }
      res.status(200).json({ ok: results.every((row) => row.ok), results });
      return;
    }

    if (action === 'statement') {
      const projected = records.map((record) => cfsTripProjection(record)).filter(Boolean);
      const statement = statementFor(projected, body.month || new Date().toISOString().slice(0, 7));
      if (body.format === 'csv') {
        res.status(200).json({ ok: true, csv: statementCsv(statement), statement: { ...statement, rows: statement.rows } });
        return;
      }
      if (body.format === 'pdf') {
        const pdf = statementPdf(statement);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="cfs-statement-${statement.month}.pdf"`);
        res.end(pdf);
        return;
      }
      res.status(200).json({ ok: true, statement });
      return;
    }

    res.status(400).json({ error: 'Unknown portal action' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'CFS portal request failed' });
  }
}

export async function portalTripByAck(db, token) {
  const found = await findByAckToken(db, token);
  if (!found) return null;
  if (!isCfsVisibleRecord(found.data)) return null;
  const legs = await legsFor(db, found.data);
  return cfsTripProjection({ id: found.id, ...found.data }, legs);
}
