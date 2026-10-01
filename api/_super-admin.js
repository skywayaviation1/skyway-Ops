import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

export const JAKE_EMAIL = 'jake@flyskyway.com';

let app = null;
let database = null;

export function getAdminApp() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return app;
}

export function getDb() {
  if (!database) database = getFirestore(getAdminApp(), 'appusers');
  return database;
}

function ownerEmails() {
  return new Set(
    String(process.env.SUPER_OWNER_EMAILS || JAKE_EMAIL)
      .split(/[,;\s]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isJakeOwner(profile = {}) {
  return ownerEmails().has(String(profile.email || '').trim().toLowerCase());
}

export async function authorizeAppUser(idToken) {
  if (!idToken) {
    const error = new Error('Sign in required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = await admin.auth(getAdminApp()).verifyIdToken(idToken, true);
  } catch {
    const error = new Error('Invalid or expired session');
    error.status = 401;
    throw error;
  }
  const snap = await getDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (!snap.exists || profile.approved !== true || profile.active === false) {
    const error = new Error('Approved active user required');
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    email: String(decoded.email || profile.email || '').toLowerCase(),
    name: profile.name || decoded.name || decoded.email || 'User',
    role: String(profile.role || 'crew').toLowerCase(),
    superAdmin: profile.superAdmin === true || isJakeOwner({ email: decoded.email || profile.email }),
  };
}

export async function authorizeSuperAdmin(idToken) {
  const actor = await authorizeAppUser(idToken);
  if (!actor.superAdmin) {
    const error = new Error('Super admin access required');
    error.status = 403;
    throw error;
  }
  return actor;
}

export async function authorizeJake(idToken) {
  const actor = await authorizeAppUser(idToken);
  if (!isJakeOwner(actor)) {
    const error = new Error('Jake Cambria owner access required');
    error.status = 403;
    throw error;
  }
  return actor;
}

export function sanitizeAuditInput(input = {}) {
  const summary = String(input.summary || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const section = String(input.section || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const action = String(input.action || 'ui.action').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100);
  return {
    action,
    summary: summary || action,
    section,
    targetType: String(input.targetType || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100),
    targetId: String(input.targetId || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 160),
  };
}

export async function writeAudit(actor, input, source = 'client') {
  const safe = sanitizeAuditInput(input);
  const id = `audit_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const event = {
    id,
    timestamp: Date.now(),
    source,
    ...safe,
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    actorSuperAdmin: actor.superAdmin === true,
  };
  await getDb().collection('audit-events').doc(id).set(event);
  return event;
}

