// Delegated Microsoft Graph client for each employee's own work mailbox.

import admin from 'firebase-admin';
import {
  escapeHtml,
  mailAdminApp,
  mailDb,
} from './_charter-mail.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_PATH = '/oauth2/v2.0/token';

export function isUserMailConfigured() {
  const tenant = process.env.MICROSOFT_USER_MAIL_TENANT_ID
    || process.env.MICROSOFT_MAIL_TENANT_ID;
  const clientId = process.env.MICROSOFT_USER_MAIL_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_USER_MAIL_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_USER_MAIL_REDIRECT_URI;
  return Boolean(tenant && clientId && clientSecret && redirectUri);
}

export function userMailConfig() {
  const tenant = process.env.MICROSOFT_USER_MAIL_TENANT_ID
    || process.env.MICROSOFT_MAIL_TENANT_ID;
  const clientId = process.env.MICROSOFT_USER_MAIL_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_USER_MAIL_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_USER_MAIL_REDIRECT_URI;
  if (!tenant || !clientId || !clientSecret || !redirectUri) {
    const error = new Error(
      'Personal work-mail integration is not configured. An administrator must set MICROSOFT_USER_MAIL_CLIENT_ID, MICROSOFT_USER_MAIL_CLIENT_SECRET, MICROSOFT_USER_MAIL_REDIRECT_URI (and tenant) on the server, then use Profile or Settings → Mailboxes to connect.',
    );
    error.status = 503;
    error.code = 'user_mail_not_configured';
    throw error;
  }
  return { tenant, clientId, clientSecret, redirectUri };
}

export async function authorizeApprovedUser(idToken) {
  if (!idToken) {
    const error = new Error('idToken required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = await admin.auth(mailAdminApp()).verifyIdToken(idToken, true);
  } catch {
    const error = new Error('Invalid or revoked session');
    error.status = 401;
    throw error;
  }
  const snap = await mailDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (!snap.exists || profile.active === false || profile.approved !== true) {
    const error = new Error('Active approved company account required');
    error.status = 403;
    throw error;
  }
  const email = String(decoded.email || profile.email || '').trim().toLowerCase();
  if (!email.endsWith('@flyskyway.com')) {
    const error = new Error('A @flyskyway.com work account is required');
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    email,
    name: profile.name || decoded.name || email,
    role: profile.role || 'crew',
    emailSignature: String(profile.emailSignature || '').slice(0, 4000),
  };
}

export function userMailboxRef(uid) {
  return mailDb().collection('user-mailboxes').doc(uid);
}

export async function readUserMailbox(uid) {
  const snap = await userMailboxRef(uid).get();
  return snap.exists ? snap.data() : null;
}

export function publicUserMailbox(connection) {
  const configured = isUserMailConfigured();
  if (!connection) {
    return {
      connected: false,
      configured,
      setupHint: configured
        ? null
        : 'Server env vars MICROSOFT_USER_MAIL_CLIENT_ID, MICROSOFT_USER_MAIL_CLIENT_SECRET, and MICROSOFT_USER_MAIL_REDIRECT_URI are required before anyone can connect.',
    };
  }
  return {
    connected: true,
    configured,
    mailbox: connection.mail || connection.userPrincipalName || '',
    displayName: connection.displayName || '',
    connectedAt: connection.connectedAt || null,
    lastRefreshedAt: connection.lastRefreshedAt || null,
    accessTokenExpiresAt: connection.accessTokenExpiresAt || null,
    scopes: connection.scopes || [],
  };
}

async function refreshUserToken(uid, connection) {
  const config = userMailConfig();
  if (!connection?.refreshToken) throw new Error('Mailbox refresh token is missing — reconnect your mailbox');
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}${TOKEN_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: connection.refreshToken,
        scope: 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send',
      }).toString(),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    console.error('[user-mail] refresh failed', response.status, data);
    const error = new Error(data.error === 'invalid_grant'
      ? 'Microsoft mailbox authorization expired — reconnect your mailbox'
      : `Microsoft mailbox refresh failed (${data.error || response.status})`);
    error.status = 401;
    throw error;
  }
  const now = Date.now();
  const patch = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || connection.refreshToken,
    accessTokenExpiresAt: now + (Number(data.expires_in) || 3600) * 1000,
    lastRefreshedAt: now,
    scopes: String(data.scope || '').split(/\s+/).filter(Boolean),
  };
  await userMailboxRef(uid).set(patch, { merge: true });
  return { ...connection, ...patch };
}

export async function validUserMailbox(uid, forceRefresh = false) {
  const connection = await readUserMailbox(uid);
  if (!connection?.accessToken) {
    const error = new Error('Work mailbox is not connected');
    error.status = 409;
    throw error;
  }
  const refresh = forceRefresh
    || !connection.accessTokenExpiresAt
    || connection.accessTokenExpiresAt <= Date.now() + 5 * 60 * 1000;
  return refresh ? refreshUserToken(uid, connection) : connection;
}

function validateGraphUrl(pathOrUrl, connection) {
  const url = String(pathOrUrl).startsWith('https://')
    ? new URL(pathOrUrl)
    : new URL(`${GRAPH_BASE}${pathOrUrl}`);
  if (url.origin !== 'https://graph.microsoft.com') throw new Error('Invalid Microsoft Graph URL');
  const allowed = [
    '/v1.0/me',
    connection?.graphUserId ? `/v1.0/users/${encodeURIComponent(connection.graphUserId)}` : null,
  ].filter(Boolean);
  if (!allowed.some((prefix) => url.pathname.startsWith(prefix))) {
    throw new Error('Personal mailbox Graph path is not allowed');
  }
  return url.toString();
}

export async function userGraphRequest(uid, pathOrUrl, options = {}, retry = true) {
  let connection = await validUserMailbox(uid);
  const run = async (conn) => fetch(validateGraphUrl(pathOrUrl, conn), {
    ...options,
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      Accept: 'application/json',
      Prefer: 'IdType="ImmutableId"',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let response = await run(connection);
  if (response.status === 401 && retry) {
    connection = await validUserMailbox(uid, true);
    response = await run(connection);
  }
  if (options.raw) {
    if (!response.ok) {
      const error = new Error(`Microsoft Graph returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  }
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `Microsoft Graph returned ${response.status}`);
    error.status = response.status || 502;
    throw error;
  }
  return data;
}

export function personalSignatureHtml(caller, mailbox) {
  const custom = caller.emailSignature
    ? escapeHtml(caller.emailSignature).replace(/\r?\n/g, '<br>')
    : `${escapeHtml(caller.name)}<br>Skyway Aviation`;
  return `<br><br><div style="font-family:Arial,sans-serif;font-size:13px;color:#334155">${custom}<br><a href="mailto:${escapeHtml(mailbox)}">${escapeHtml(mailbox)}</a></div>`;
}
