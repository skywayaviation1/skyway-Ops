// Server-only trade-show archive.
//
// Clients never read Firestore for this feature. The public route checks the
// unguessable token, then returns the projected leg list. Admin SDK bypasses
// security rules; firebase/appusers-showcase.rules denies every client.

import { timingSafeEqual, randomBytes } from 'node:crypto';
import admin from 'firebase-admin';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { reviewerSessionBlock } from '../src/reviewer-account.js';
import { lookupCoords } from '../src/airport-coords.js';
import {
  SHOWCASE_CACHE_MS,
  SHOWCASE_ORIGIN,
  isShowcaseToken,
  publicShowcaseBody,
  selectShowcaseLegs,
  showcaseUrl,
} from '../src/showcase-replay.js';

export const SHOWCASE_COLLECTION = 'showcase';
export const SHOWCASE_DOC = 'config';
const ROLES = ['admin', 'ops'];

let adminApp = null;
let database = null;
const memoryCache = { token: '', at: 0, body: null };

export function clearShowcaseCache() {
  memoryCache.token = '';
  memoryCache.at = 0;
  memoryCache.body = null;
}

function adminAppInstance() {
  if (adminApp) return adminApp;
  if (admin.apps.length) {
    adminApp = admin.app();
    return adminApp;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  adminApp = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return adminApp;
}

export function showcaseDb() {
  if (database) return database;
  database = getFirestore(adminAppInstance(), 'appusers');
  return database;
}

export function showcaseTokenMatches(stored, provided) {
  if (typeof stored !== 'string' || typeof provided !== 'string') return false;
  const left = Buffer.from(stored);
  const right = Buffer.from(provided);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function mintShowcaseToken() {
  return randomBytes(32).toString('base64url');
}

function readBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

export function requestToken(req) {
  const query = req?.query?.token;
  if (typeof query === 'string' && query) return query;
  if (Array.isArray(query) && typeof query[0] === 'string') return query[0];
  try {
    const url = new URL(req?.url || '/', 'https://skyway.app');
    return url.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

export async function readShowcaseConfig(db) {
  const snap = await db.collection(SHOWCASE_COLLECTION).doc(SHOWCASE_DOC).get();
  if (!snap?.exists) return null;
  return snap.data() || null;
}

export async function writeShowcaseConfig(db, value) {
  await db.collection(SHOWCASE_COLLECTION).doc(SHOWCASE_DOC).set(value, { merge: true });
  clearShowcaseCache();
}

export async function readAllLegs(db, { pageSize = 400, maxPages = 40 } = {}) {
  const legs = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    let query = db.collection('legs').orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    const docs = snap?.docs || [];
    if (!docs.length) break;
    for (const doc of docs) legs.push(typeof doc.data === 'function' ? (doc.data() || {}) : {});
    if (docs.length < pageSize) break;
    const next = docs[docs.length - 1];
    if (!next || next === cursor) break;
    cursor = next;
  }
  return legs;
}

async function defaultVerify(idToken) {
  const decoded = reviewerSessionBlock(
    await admin.auth(adminAppInstance()).verifyIdToken(idToken, true),
  );
  return decoded;
}

export async function authorizeShowcase(req, deps = {}) {
  const body = readBody(req);
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  const idToken = (header.replace(/^Bearer\s+/i, '') !== header ? header.replace(/^Bearer\s+/i, '') : '')
    || body.idToken
    || '';
  if (!idToken) {
    const error = new Error('Sign in required');
    error.status = 401;
    throw error;
  }
  const verify = deps.verifyIdToken || defaultVerify;
  let decoded;
  try {
    decoded = await verify(idToken);
  } catch (err) {
    const error = new Error('Invalid or revoked session');
    error.status = err?.status || 401;
    throw error;
  }
  const db = deps.db || showcaseDb();
  const snap = await db.collection('users').doc(decoded.uid).get();
  const profile = snap?.exists ? (snap.data() || {}) : {};
  if (!snap?.exists || !ROLES.includes(profile.role) || profile.active === false || profile.approved !== true) {
    const error = new Error('Ops or administrator access required');
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    name: profile.name || decoded.name || decoded.email || 'Skyway Ops',
    role: profile.role,
    db,
    body,
  };
}

export async function loadPublicShowcase(deps = {}) {
  const db = deps.db || showcaseDb();
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const cache = deps.cache || memoryCache;
  const token = deps.token;
  if (
    cache.body
    && cache.token === token
    && (now - cache.at) < SHOWCASE_CACHE_MS
  ) {
    return { body: cache.body, cached: true };
  }
  const raw = await readAllLegs(db);
  const selected = selectShowcaseLegs(raw, {
    now,
    lookupCoords: deps.lookupCoords || lookupCoords,
  });
  const body = publicShowcaseBody(selected, now);
  cache.token = token;
  cache.at = now;
  cache.body = body;
  return { body, cached: false };
}

export function adminView(config, coverage) {
  const enabled = config?.enabled === true && isShowcaseToken(config?.token || '');
  return {
    ok: true,
    enabled,
    hasToken: isShowcaseToken(config?.token || ''),
    url: enabled ? showcaseUrl(config.token, SHOWCASE_ORIGIN) : null,
    updatedAt: config?.updatedAt || null,
    updatedByName: config?.updatedByName || null,
    year: coverage?.year || null,
    storedFrom: coverage?.storedFrom || null,
    storedTo: coverage?.storedTo || null,
    legCount: coverage?.legCount || 0,
    truncated: coverage?.truncated === true,
  };
}

export async function coverageFor(db, deps = {}) {
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const raw = await readAllLegs(db);
  const selected = selectShowcaseLegs(raw, {
    now,
    lookupCoords: deps.lookupCoords || lookupCoords,
  });
  const body = publicShowcaseBody(selected, now);
  return {
    year: body.year,
    storedFrom: body.storedFrom,
    storedTo: body.storedTo,
    legCount: body.legs.length,
    truncated: body.truncated,
  };
}
