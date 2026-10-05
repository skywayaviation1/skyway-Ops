// Server-side broker brand store.
//
// Logos live in Cloud Storage at broker-logos/{email}/logo.{ext}. The broker
// document in the named `appusers` database holds the metadata. The Admin SDK
// writes both; client SDKs are denied (see docs/broker-white-label.md).
//
// The public tracking page never reads this collection. It receives a
// whitelisted branding object from trip-public, and the logo bytes from
// broker-logo after the trip token is checked again.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { verifyTripToken } from './_trip-token.js';
import {
  brokerDocId,
  brokerLogoPath,
  brokerRecordForOps,
  cleanDisplayName,
  inspectLogoBytes,
  normalizeAccentColor,
  parseBrokerEmails,
  resolvePublicBranding,
} from '../src/broker-brand.js';

export const STORAGE_BUCKET = 'skyway-ops-app.firebasestorage.app';

let adminApp = null;
function getAdmin() {
  if (adminApp) return adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON missing');
  }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
      credential: admin.credential.cert(sa),
      storageBucket: STORAGE_BUCKET,
    });
  return adminApp;
}

function db() {
  return getFirestore(getAdmin(), 'appusers');
}

function bucket() {
  return getStorage(getAdmin()).bucket(STORAGE_BUCKET);
}

export async function authorizeOps(req, body) {
  const idToken = req.headers?.authorization?.replace(/^Bearer\s+/i, '') || body?.idToken;
  if (!idToken) return { ok: false, status: 401, error: 'Sign in required.' };
  try {
    const decoded = await admin.auth(getAdmin()).verifyIdToken(idToken);
    const userDoc = await db().collection('users').doc(decoded.uid).get();
    const profile = userDoc.exists ? (userDoc.data() || {}) : {};
    const role = profile.role || '';
    if (profile.active === false) {
      return { ok: false, status: 403, error: 'This account is inactive.' };
    }
    if (role !== 'ops' && role !== 'admin') {
      return { ok: false, status: 403, error: 'Only ops and admin can edit broker branding.' };
    }
    return {
      ok: true,
      uid: decoded.uid,
      role,
      name: profile.name || decoded.email || '',
    };
  } catch {
    return { ok: false, status: 401, error: 'Sign in required.' };
  }
}

function logoUrlForToken(token) {
  return `/api/broker-logo?token=${encodeURIComponent(token)}`;
}

async function readBroker(email) {
  const id = brokerDocId(email);
  if (!id) return null;
  const snap = await db().collection('brokers').doc(id).get();
  if (!snap.exists) return null;
  return { id, data: snap.data() || {} };
}

/**
 * First broker email on the trip that has a stored logo. Later addresses are
 * ignored once one brand is found, matching the share dialog which brands
 * the first address ops entered.
 */
export async function publicBrandingForTrip(tripData, token) {
  const emails = parseBrokerEmails(tripData?.brokerEmail);
  if (!token || emails.length === 0) return null;
  for (const email of emails) {
    const record = await readBroker(email);
    if (!record) continue;
    const branding = resolvePublicBranding(record.data, { logoUrl: logoUrlForToken(token) });
    if (branding) return branding;
  }
  return null;
}

export async function brokerIdForTrip(tripData) {
  const emails = parseBrokerEmails(tripData?.brokerEmail);
  for (const email of emails) {
    const record = await readBroker(email);
    if (record && resolvePublicBranding(record.data, { logoUrl: '/api/broker-logo?token=preview' })) {
      return record.id;
    }
  }
  return null;
}

const GRACE_MS = 24 * 3600 * 1000;

function lastLandedAt(data) {
  const statuses = data?.statuses;
  if (!statuses || typeof statuses !== 'object') return null;
  let latest = null;
  for (const byEvent of Object.values(statuses)) {
    if (!byEvent || typeof byEvent !== 'object') continue;
    for (const [name, payload] of Object.entries(byEvent)) {
      if (!payload || typeof payload !== 'object') continue;
      if (!/land|arriv|complete/i.test(name)) continue;
      const at = payload.at || payload.ts;
      if (typeof at === 'number' && (!latest || at > latest)) latest = at;
    }
  }
  return latest;
}

/** Same gate the public trip endpoint uses, so an expired link cannot load a logo. */
export async function loadTripForPublicToken(token) {
  const v = verifyTripToken(token);
  if (!v.ok) return { error: { code: 401, reason: v.reason } };
  const snap = await db().collection('trip-state').doc(v.tripId).get();
  if (!snap.exists) return { error: { code: 404, reason: 'trip not found' } };
  const data = snap.data() || {};
  if (data.linkRevoked === true) return { error: { code: 403, reason: 'link revoked' } };
  if (typeof data.linkTokenIssuedAt === 'number' && v.issuedAt < data.linkTokenIssuedAt) {
    return { error: { code: 403, reason: 'link rotated' } };
  }
  const landedAt = lastLandedAt(data);
  if (landedAt && (Date.now() - landedAt) > GRACE_MS) {
    return { error: { code: 410, reason: 'link expired after trip completion' } };
  }
  return { tripId: v.tripId, data };
}

export async function readLogoForBroker(brokerId) {
  const id = brokerDocId(brokerId);
  if (!id) return null;
  const record = await readBroker(id);
  if (!record?.data?.logoPath) return null;
  const file = bucket().file(record.data.logoPath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [bytes] = await file.download();
  return {
    bytes,
    contentType: record.data.logoContentType || 'application/octet-stream',
    updatedAt: record.data.logoUpdatedAt || record.data.updatedAt || null,
  };
}

async function deleteLogoFiles(brokerId) {
  const prefix = `broker-logos/${brokerId}/`;
  const [files] = await bucket().getFiles({ prefix });
  await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true }).catch(() => {})));
}

function brandingPatch(body, actor) {
  const patch = {
    email: brokerDocId(body.email),
    updatedAt: Date.now(),
    updatedByUid: actor.uid,
    updatedByName: String(actor.name || '').slice(0, 80),
  };
  if ('displayName' in body) patch.displayName = cleanDisplayName(body.displayName);
  if ('accentColor' in body) patch.accentColor = normalizeAccentColor(body.accentColor);
  if ('showPoweredBy' in body) patch.showPoweredBy = body.showPoweredBy === true;
  return patch;
}

export async function saveBrokerBranding(body, actor) {
  const id = brokerDocId(body?.email);
  if (!id) return { error: { code: 400, error: 'Enter a valid broker email.' } };
  const patch = brandingPatch({ ...body, email: id }, actor);
  await db().collection('brokers').doc(id).set(patch, { merge: true });
  const saved = await readBroker(id);
  return { broker: brokerRecordForOps(id, saved?.data || {}) };
}

export async function uploadBrokerLogo(body, actor) {
  const id = brokerDocId(body?.email);
  if (!id) return { error: { code: 400, error: 'Enter a valid broker email.' } };
  const raw = String(body?.dataBase64 || '').replace(/^data:[^,]*,/, '').trim();
  if (!raw) return { error: { code: 400, error: 'Choose a logo file.' } };
  let bytes;
  try {
    bytes = Buffer.from(raw, 'base64');
  } catch {
    return { error: { code: 400, error: 'Logo file could not be read.' } };
  }
  const inspected = inspectLogoBytes(bytes, body?.contentType);
  if (!inspected.ok) return { error: { code: 400, error: inspected.error } };
  const payload = inspected.svg ? Buffer.from(inspected.svg, 'utf8') : bytes;
  const path = brokerLogoPath(id, inspected.ext);
  await deleteLogoFiles(id);
  await bucket().file(path).save(payload, {
    resumable: false,
    metadata: {
      contentType: inspected.contentType,
      cacheControl: 'private, max-age=3600',
      metadata: { brokerId: id, uploadedBy: actor.uid },
    },
  });
  const now = Date.now();
  const patch = {
    ...brandingPatch(body, actor),
    email: id,
    logoPath: path,
    logoContentType: inspected.contentType,
    logoFileName: String(body?.fileName || `logo.${inspected.ext}`).slice(0, 120),
    logoUpdatedAt: now,
    updatedAt: now,
  };
  await db().collection('brokers').doc(id).set(patch, { merge: true });
  const saved = await readBroker(id);
  return { broker: brokerRecordForOps(id, saved?.data || {}) };
}

export async function removeBrokerLogo(body, actor) {
  const id = brokerDocId(body?.email);
  if (!id) return { error: { code: 400, error: 'Enter a valid broker email.' } };
  await deleteLogoFiles(id);
  await db().collection('brokers').doc(id).set({
    email: id,
    logoPath: admin.firestore.FieldValue.delete(),
    logoContentType: admin.firestore.FieldValue.delete(),
    logoFileName: admin.firestore.FieldValue.delete(),
    logoUpdatedAt: admin.firestore.FieldValue.delete(),
    updatedAt: Date.now(),
    updatedByUid: actor.uid,
    updatedByName: String(actor.name || '').slice(0, 80),
  }, { merge: true });
  const saved = await readBroker(id);
  return { broker: brokerRecordForOps(id, saved?.data || {}) };
}

export async function getBrokerBranding(email) {
  const id = brokerDocId(email);
  if (!id) return { error: { code: 400, error: 'Enter a valid broker email.' } };
  const record = await readBroker(id);
  if (!record) {
    return { broker: brokerRecordForOps(id, { email: id }) };
  }
  return { broker: brokerRecordForOps(id, record.data) };
}

export async function listBrokerBranding() {
  const snap = await db().collection('brokers').limit(200).get();
  const brokers = snap.docs
    .map((doc) => brokerRecordForOps(doc.id, doc.data() || {}))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { brokers };
}
