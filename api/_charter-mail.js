// Server-only Microsoft Graph client for the charters@ shared mailbox.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
let app = null;
let tokenCache = null;

export function mailAdminApp() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return app;
}

export function mailDb() {
  return getFirestore(mailAdminApp(), 'appusers');
}

export function mailboxUpn() {
  return String(process.env.CHARTER_MAILBOX_UPN || 'charters@flyskyway.com').trim().toLowerCase();
}

export function isSharedMailConfigured() {
  return Boolean(
    process.env.MICROSOFT_MAIL_TENANT_ID
    && process.env.MICROSOFT_MAIL_CLIENT_ID
    && process.env.MICROSOFT_MAIL_CLIENT_SECRET,
  );
}

export async function authorizeMailboxCaller(idToken, roles = ['admin', 'sales']) {
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
  if (
    !snap.exists
    || !roles.includes(profile.role)
    || profile.active === false
    || profile.approved !== true
  ) {
    const error = new Error('Admin or sales access required');
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    email: decoded.email || profile.email || '',
    name: profile.name || decoded.name || decoded.email || 'Charter Team',
    role: profile.role,
    emailSignature: String(profile.emailSignature || '').slice(0, 4000),
  };
}

async function graphToken(force = false) {
  if (!force && tokenCache?.token && tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const tenant = process.env.MICROSOFT_MAIL_TENANT_ID;
  const clientId = process.env.MICROSOFT_MAIL_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_MAIL_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) {
    const error = new Error(
      'Shared mailbox Graph credentials are not configured. An administrator must set MICROSOFT_MAIL_TENANT_ID, MICROSOFT_MAIL_CLIENT_ID, and MICROSOFT_MAIL_CLIENT_SECRET on the server (see Settings → Mailboxes).',
    );
    error.status = 503;
    error.code = 'shared_mail_not_configured';
    throw error;
  }
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    console.error('[charter-mail] token failure', response.status, data);
    const error = new Error(`Microsoft Graph authorization failed (${data.error || response.status})`);
    error.status = 502;
    throw error;
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return tokenCache.token;
}

export async function graphRequest(pathOrUrl, options = {}, retry = true) {
  const token = await graphToken();
  const url = String(pathOrUrl).startsWith('https://')
    ? pathOrUrl
    : `${GRAPH_BASE}${pathOrUrl}`;
  if (!url.startsWith(`${GRAPH_BASE}/users/`) && !url.startsWith(`${GRAPH_BASE}/subscriptions`)) {
    throw new Error('Invalid Microsoft Graph URL');
  }
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Prefer: 'IdType="ImmutableId"',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401 && retry) {
    tokenCache = null;
    return graphRequest(pathOrUrl, options, false);
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
    error.graphCode = data?.error?.code || null;
    throw error;
  }
  return data;
}

export function mailboxPath(suffix = '') {
  return `/users/${encodeURIComponent(mailboxUpn())}${suffix}`;
}

export function addressList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      const address = typeof value === 'string' ? value : value?.emailAddress?.address;
      const name = typeof value === 'string' ? '' : value?.emailAddress?.name || '';
      return address ? { name, address: String(address).toLowerCase() } : null;
    })
    .filter(Boolean);
}

export function graphRecipients(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    .map((address) => ({ emailAddress: { address } }));
}

export function normalizeMessage(message, includeBody = false) {
  const normalized = {
    id: message.id,
    conversationId: message.conversationId || '',
    internetMessageId: message.internetMessageId || '',
    subject: message.subject || '(no subject)',
    from: message.from?.emailAddress
      ? {
        name: message.from.emailAddress.name || '',
        address: String(message.from.emailAddress.address || '').toLowerCase(),
      }
      : null,
    sender: message.sender?.emailAddress
      ? {
        name: message.sender.emailAddress.name || '',
        address: String(message.sender.emailAddress.address || '').toLowerCase(),
      }
      : null,
    to: addressList(message.toRecipients),
    cc: addressList(message.ccRecipients),
    bcc: addressList(message.bccRecipients),
    receivedAt: message.receivedDateTime || null,
    sentAt: message.sentDateTime || null,
    createdAt: message.createdDateTime || null,
    modifiedAt: message.lastModifiedDateTime || null,
    preview: message.bodyPreview || '',
    isRead: message.isRead === true,
    isDraft: message.isDraft === true,
    hasAttachments: message.hasAttachments === true,
    importance: message.importance || 'normal',
    flag: message.flag?.flagStatus || 'notFlagged',
    parentFolderId: message.parentFolderId || '',
    webLink: message.webLink || '',
  };
  if (includeBody) {
    normalized.body = {
      type: message.body?.contentType || 'html',
      content: message.body?.content || '',
    };
    normalized.uniqueBody = {
      type: message.uniqueBody?.contentType || message.body?.contentType || 'html',
      content: message.uniqueBody?.content || message.body?.content || '',
    };
    normalized.attachments = (message.attachments || []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name || 'attachment',
      contentType: attachment.contentType || 'application/octet-stream',
      size: Number(attachment.size || 0),
      isInline: attachment.isInline === true,
      contentId: attachment.contentId || null,
      type: attachment['@odata.type'] || '',
    }));
  }
  return normalized;
}

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function signatureHtml(caller) {
  const custom = caller.emailSignature
    ? escapeHtml(caller.emailSignature).replace(/\r?\n/g, '<br>')
    : `${escapeHtml(caller.name)}<br>Skyway Aviation`;
  return `<br><br><div style="font-family:Arial,sans-serif;font-size:13px;color:#334155">${custom}<br><a href="mailto:${escapeHtml(mailboxUpn())}">${escapeHtml(mailboxUpn())}</a></div>`;
}
