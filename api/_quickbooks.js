// Shared server-only QuickBooks Online client. Tokens never leave the server.
// All data lives in the same named Firestore database as the application.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
};

let app = null;

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
  return getFirestore(getAdminApp(), 'appusers');
}

export async function authorizeQboCaller(idToken, roles = ['accounting', 'admin']) {
  if (!idToken) {
    const error = new Error('idToken required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = await admin.auth(getAdminApp()).verifyIdToken(idToken, true);
  } catch {
    const error = new Error('Invalid or revoked session');
    error.status = 401;
    throw error;
  }
  const snap = await getDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (
    !snap.exists
    || !roles.includes(profile.role)
    || profile.active === false
    || profile.approved !== true
  ) {
    const error = new Error(`${roles.join(' or ')} role required`);
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    email: decoded.email || profile.email || '',
    name: profile.name || decoded.name || decoded.email || 'Accounting',
    role: profile.role,
    profile,
  };
}

export function publicConnection(connection) {
  if (!connection) return { connected: false };
  return {
    connected: true,
    realmId: connection.realmId || null,
    companyName: connection.companyName || null,
    environment: connection.environment || 'sandbox',
    connectedBy: connection.connectedBy || null,
    connectedByName: connection.connectedByName || null,
    connectedAt: connection.connectedAt || null,
    lastRefreshedAt: connection.lastRefreshedAt || null,
    accessTokenExpiresAt: connection.accessTokenExpiresAt || null,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt || null,
    lastSyncAt: connection.lastSyncAt || null,
    lastSyncByName: connection.lastSyncByName || null,
    expenseAccountMap: connection.expenseAccountMap || {},
    paymentAccountMap: connection.paymentAccountMap || {},
  };
}

export async function readConnection() {
  const snap = await getDb().collection('quickbooks').doc('connection').get();
  return snap.exists ? snap.data() : null;
}

async function refreshConnection(connection) {
  const clientId = process.env.INTUIT_CLIENT_ID;
  const clientSecret = process.env.INTUIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('QuickBooks client credentials are not configured');
  if (!connection?.refreshToken) throw new Error('QuickBooks refresh token is missing — reconnect QuickBooks');
  if (connection.refreshTokenExpiresAt && connection.refreshTokenExpiresAt <= Date.now()) {
    throw new Error('QuickBooks authorization expired — reconnect QuickBooks');
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refreshToken,
    }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    console.error('[quickbooks] token refresh failed', response.status, data);
    throw new Error(`QuickBooks token refresh failed (${data.error || response.status}) — reconnect if this persists`);
  }

  const now = Date.now();
  const patch = {
    accessToken: data.access_token,
    // Intuit rotates refresh tokens; never keep the old one when a new one is supplied.
    refreshToken: data.refresh_token || connection.refreshToken,
    accessTokenExpiresAt: now + (Number(data.expires_in) || 3600) * 1000,
    refreshTokenExpiresAt: data.x_refresh_token_expires_in
      ? now + Number(data.x_refresh_token_expires_in) * 1000
      : connection.refreshTokenExpiresAt,
    lastRefreshedAt: now,
  };
  await getDb().collection('quickbooks').doc('connection').set(patch, { merge: true });
  return { ...connection, ...patch };
}

export async function getValidConnection(forceRefresh = false) {
  const connection = await readConnection();
  if (!connection?.realmId || !connection?.accessToken) {
    const error = new Error('QuickBooks is not connected');
    error.status = 409;
    throw error;
  }
  const needsRefresh = forceRefresh
    || !connection.accessTokenExpiresAt
    || connection.accessTokenExpiresAt <= Date.now() + 5 * 60 * 1000;
  return needsRefresh ? refreshConnection(connection) : connection;
}

export async function qboRequest(path, options = {}, retry = true) {
  let connection = await getValidConnection();
  const run = (conn) => fetch(
    `${API_BASE[conn.environment] || API_BASE.sandbox}/v3/company/${conn.realmId}${path}`,
    {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${conn.accessToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    },
  );
  let response = await run(connection);
  if (response.status === 401 && retry) {
    connection = await getValidConnection(true);
    response = await run(connection);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.Fault) {
    const qboError = body?.Fault?.Error?.[0];
    const message = qboError?.Detail || qboError?.Message || `QuickBooks API returned ${response.status}`;
    const error = new Error(message);
    error.status = response.status || 502;
    error.qboCode = qboError?.code || null;
    throw error;
  }
  return body;
}

export function qboString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function qboQuery(query) {
  return qboRequest(`/query?query=${encodeURIComponent(query)}&minorversion=70`);
}

export async function queryOne(entity, where) {
  const body = await qboQuery(`select * from ${entity} where ${where} maxresults 1`);
  return body?.QueryResponse?.[entity]?.[0] || null;
}

export async function createEntity(entityPath, payload) {
  const body = await qboRequest(`/${entityPath}?minorversion=70`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const key = entityPath.charAt(0).toUpperCase() + entityPath.slice(1);
  return body?.[key] || null;
}
