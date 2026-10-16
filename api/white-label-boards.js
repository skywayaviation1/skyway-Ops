// Admin and ops setup for white-label TV boards.
//
// Clients never read or write `white-label-boards` directly. This route is
// the only writer. Feed URLs are returned here, to an authenticated ops or
// admin user, and nowhere else.

import {
  BOARD_CACHE_COLLECTION,
  BOARD_COLLECTION,
  MAX_BOARDS,
  adminBoardView,
  callerMayManageBoards,
  decodeLogoPayload,
  feedUrlAllowed,
  fetchIcs,
  generateBoardId,
  generatePublicToken,
  isBoardId,
  logoObjectPath,
  normalizeAccentColor,
  normalizeCompanyName,
  normalizeFlag,
  tailsFromTrips,
  tripsFromIcal,
} from '../src/white-label-board.js';
import { authorizeBoardManager, whiteLabelBucket, whiteLabelDb } from './_white-label.js';

export const config = { runtime: 'nodejs' };

function statusError(message, status) {
  return Object.assign(new Error(message), { status });
}

function boardPatch(input, existing) {
  const companyName = input.companyName !== undefined
    ? normalizeCompanyName(input.companyName)
    : (existing?.companyName || null);
  if (!companyName) throw statusError('Company name is required', 400);
  const accentColor = input.accentColor !== undefined || !existing?.accentColor
    ? normalizeAccentColor(input.accentColor || existing?.accentColor || '#2DD4BF')
    : existing.accentColor;
  if (!accentColor) throw statusError('Accent color must be a 6-digit hex color', 400);
  const feedUrl = input.feedUrl !== undefined ? String(input.feedUrl || '').trim() : existing?.feedUrl;
  if (!feedUrlAllowed(feedUrl)) throw statusError('Feed must be an https calendar URL', 400);
  return {
    companyName,
    accentColor,
    feedUrl,
    poweredBy: normalizeFlag(input.poweredBy, existing ? existing.poweredBy !== false : true),
    enabled: normalizeFlag(input.enabled, existing ? existing.enabled !== false : true),
    feedChanged: Boolean(existing && existing.feedUrl !== feedUrl),
  };
}

async function mintToken(db) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generatePublicToken();
    const snap = await db.collection(BOARD_COLLECTION).where('publicToken', '==', token).limit(1).get();
    if (!snap || snap.empty) return token;
  }
  throw statusError('Could not allocate a board link', 500);
}

async function saveLogo(bucket, boardId, logo) {
  const inspected = decodeLogoPayload(logo);
  if (!inspected.ok) throw statusError(inspected.error, 400);
  const file = bucket.file(logoObjectPath(boardId));
  await file.save(inspected.body, {
    resumable: false,
    metadata: {
      contentType: inspected.contentType,
      cacheControl: 'private, max-age=300',
    },
  });
  return inspected.contentType;
}

async function deleteLogo(bucket, boardId) {
  try {
    await bucket.file(logoObjectPath(boardId)).delete({ ignoreNotFound: true });
  } catch (error) {
    if (error?.code === 404) return;
    throw error;
  }
}

async function readBoard(db, boardId) {
  if (!isBoardId(boardId)) throw statusError('Board not found', 404);
  const snap = await db.collection(BOARD_COLLECTION).doc(boardId).get();
  if (!snap.exists) throw statusError('Board not found', 404);
  return { id: snap.id, data: snap.data() || {} };
}

export async function handleWhiteLabelAdmin(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = req.body || {};
    const authorize = deps.authorize || authorizeBoardManager;
    const caller = await authorize(body.idToken);
    if (!caller || !callerMayManageBoards({ role: caller.role, active: true, approved: true, appReviewer: caller.appReviewer })) {
      res.status(caller ? 403 : 401).json({ error: caller ? 'Operations access required' : 'Sign in required' });
      return;
    }
    const db = deps.db || whiteLabelDb();
    const bucket = deps.bucket || whiteLabelBucket();
    const now = typeof deps.now === 'function' ? deps.now() : Date.now();
    const fetchImpl = deps.fetchImpl || fetch;
    const resolveHost = deps.resolveHost;
    const action = String(body.action || 'list');

    if (action === 'list') {
      const snap = await db.collection(BOARD_COLLECTION).orderBy('updatedAt', 'desc').limit(MAX_BOARDS).get();
      const boards = (snap.docs || []).map((doc) => adminBoardView(doc.id, doc.data() || {}));
      res.status(200).json({ ok: true, boards });
      return;
    }

    if (action === 'check-feed') {
      const feedUrl = String(body.feedUrl || '').trim();
      if (!feedUrlAllowed(feedUrl)) throw statusError('Feed must be an https calendar URL', 400);
      const text = await fetchIcs(feedUrl, fetchImpl, resolveHost);
      const trips = tripsFromIcal(text, now);
      res.status(200).json({ ok: true, tripsToday: trips.length, tails: tailsFromTrips(trips) });
      return;
    }

    if (action === 'create') {
      const existingSnap = await db.collection(BOARD_COLLECTION).limit(MAX_BOARDS + 1).get();
      if ((existingSnap.size || existingSnap.docs?.length || 0) >= MAX_BOARDS) {
        throw statusError('Board limit reached', 400);
      }
      const patch = boardPatch(body, null);
      const id = generateBoardId();
      const publicToken = await mintToken(db);
      let logoContentType = null;
      if (body.logo) logoContentType = await saveLogo(bucket, id, body.logo);
      const record = {
        ...patch,
        publicToken,
        logoContentType,
        createdAt: now,
        updatedAt: now,
        updatedByUid: caller.uid,
        updatedByName: caller.name,
      };
      delete record.feedChanged;
      await db.collection(BOARD_COLLECTION).doc(id).set(record);
      console.info(`[white-label] create board=${id} uid=${caller.uid}`);
      res.status(200).json({ ok: true, board: adminBoardView(id, record) });
      return;
    }

    if (action === 'update' || action === 'regenerate' || action === 'delete') {
      const current = await readBoard(db, body.boardId);
      if (action === 'delete') {
        await db.collection(BOARD_COLLECTION).doc(current.id).delete();
        await db.collection(BOARD_CACHE_COLLECTION).doc(current.id).delete().catch(() => {});
        await deleteLogo(bucket, current.id);
        console.info(`[white-label] delete board=${current.id} uid=${caller.uid}`);
        res.status(200).json({ ok: true, id: current.id });
        return;
      }
      if (action === 'regenerate') {
        const publicToken = await mintToken(db);
        const record = {
          ...current.data,
          publicToken,
          updatedAt: now,
          updatedByUid: caller.uid,
          updatedByName: caller.name,
        };
        await db.collection(BOARD_COLLECTION).doc(current.id).set(record);
        console.info(`[white-label] regenerate board=${current.id} uid=${caller.uid}`);
        res.status(200).json({ ok: true, board: adminBoardView(current.id, record) });
        return;
      }
      const patch = boardPatch(body, current.data);
      let logoContentType = current.data.logoContentType || null;
      if (body.logo && body.logo.remove === true) {
        await deleteLogo(bucket, current.id);
        logoContentType = null;
      } else if (body.logo && (body.logo.dataBase64 || body.logo.base64)) {
        logoContentType = await saveLogo(bucket, current.id, body.logo);
      }
      const record = {
        ...current.data,
        companyName: patch.companyName,
        accentColor: patch.accentColor,
        feedUrl: patch.feedUrl,
        poweredBy: patch.poweredBy,
        enabled: patch.enabled,
        logoContentType,
        updatedAt: now,
        updatedByUid: caller.uid,
        updatedByName: caller.name,
      };
      await db.collection(BOARD_COLLECTION).doc(current.id).set(record);
      if (patch.feedChanged) {
        await db.collection(BOARD_CACHE_COLLECTION).doc(current.id).delete().catch(() => {});
      }
      console.info(`[white-label] update board=${current.id} uid=${caller.uid}`);
      res.status(200).json({ ok: true, board: adminBoardView(current.id, record) });
      return;
    }

    throw statusError('Unknown action', 400);
  } catch (error) {
    const status = Number.isFinite(error?.status) ? error.status : 500;
    if (status >= 500) console.error('[white-label] admin failed', error?.message || error);
    const feedDown = error?.message === 'feed unavailable' || error?.message === 'feed redirect limit';
    res.status(status).json({
      error: status >= 500
        ? (feedDown ? 'The calendar feed did not respond' : 'The board could not be saved')
        : (error.message || 'Request failed'),
    });
  }
}

export default function handler(req, res) {
  return handleWhiteLabelAdmin(req, res);
}
