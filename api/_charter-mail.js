// Server-only Microsoft Graph client for the charters@ shared mailbox.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
let app = null;
let tokenCache = null;
// A warm serverless instance may serve several users at once. Microsoft
// counts every request against one shared-mailbox concurrency bucket, so queue
// them instead of firing a burst at charters@.
let mailboxGraphQueue = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueueMailboxFetch(run) {
  const result = mailboxGraphQueue.catch(() => {}).then(run);
  mailboxGraphQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function isMailboxConcurrencyError(status, graphCode, message) {
  const text = `${graphCode || ''} ${message || ''}`;
  return status === 429
    || status === 503
    || /MailboxConcurrency|ErrorExceededConnectionCount|over its MailboxConcurrency limit/i.test(text);
}

export function graphRetryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  return Math.min(750 * (2 ** attempt), 12_000);
}

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

/**
 * Read a Graph credential from the environment.
 *
 * Secrets pasted from the Vercel UI or a password manager routinely arrive with
 * a trailing newline or wrapping quotes. Microsoft rejects those as
 * `invalid_client`, which reads as a permissions problem and sends operators
 * hunting through Entra for a fault that is purely cosmetic.
 */
export function mailCredential(name) {
  return String(process.env[name] || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

export function isSharedMailConfigured() {
  return Boolean(
    mailCredential('MICROSOFT_MAIL_TENANT_ID')
    && mailCredential('MICROSOFT_MAIL_CLIENT_ID')
    && mailCredential('MICROSOFT_MAIL_CLIENT_SECRET'),
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

/**
 * Name what an administrator has to change, in the vocabulary of the Entra UI.
 *
 * `invalid_client` is ambiguous on its own: it covers a wrong secret, an
 * expired secret, and the very common mistake of copying the Secret **ID**
 * instead of the secret **Value**.
 */
export function explainGraphTokenFailure(error, description = '') {
  const detail = String(description || '');
  if (error === 'invalid_client') {
    return 'Microsoft rejected the mailbox app secret. In Entra open the shared-mailbox app '
      + '(the one matching MICROSOFT_MAIL_CLIENT_ID) → Certificates & secrets → New client secret, '
      + 'copy the Value (not the Secret ID), set MICROSOFT_MAIL_CLIENT_SECRET in Vercel, and '
      + 'redeploy. An expired secret fails the same way.';
  }
  if (error === 'unauthorized_client' || error === 'invalid_request') {
    return 'The mailbox app is not allowed to request an application token. Confirm '
      + 'MICROSOFT_MAIL_CLIENT_ID and MICROSOFT_MAIL_TENANT_ID belong to the same registration.';
  }
  if (/AADSTS7000215/.test(detail)) {
    return 'Microsoft reported an invalid client secret (AADSTS7000215). Replace '
      + 'MICROSOFT_MAIL_CLIENT_SECRET with a newly generated secret Value.';
  }
  if (/AADSTS700016|application with identifier/i.test(detail)) {
    return 'That client ID does not exist in this tenant. Check MICROSOFT_MAIL_CLIENT_ID and '
      + 'MICROSOFT_MAIL_TENANT_ID.';
  }
  return detail.slice(0, 240) || 'See docs/charter-shared-inbox-setup.md.';
}

async function graphToken(force = false) {
  if (!force && tokenCache?.token && tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const tenant = mailCredential('MICROSOFT_MAIL_TENANT_ID');
  const clientId = mailCredential('MICROSOFT_MAIL_CLIENT_ID');
  const clientSecret = mailCredential('MICROSOFT_MAIL_CLIENT_SECRET');
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
    console.error('[charter-mail] token failure', response.status, {
      error: data.error,
      error_description: data.error_description,
      clientId,
      tenant,
      secretLength: clientSecret.length,
    });
    const error = new Error(
      `Microsoft Graph authorization failed (${data.error || response.status}). `
      + explainGraphTokenFailure(data.error, data.error_description),
    );
    error.status = 502;
    error.code = data.error || 'graph_token_failed';
    throw error;
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return tokenCache.token;
}

export async function graphRequest(pathOrUrl, options = {}) {
  const { raw = false, ...init } = options;
  const url = String(pathOrUrl).startsWith('https://')
    ? pathOrUrl
    : `${GRAPH_BASE}${pathOrUrl}`;
  if (!url.startsWith(`${GRAPH_BASE}/users/`) && !url.startsWith(`${GRAPH_BASE}/subscriptions`)) {
    throw new Error('Invalid Microsoft Graph URL');
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const token = await graphToken();
    // eslint-disable-next-line no-await-in-loop
    const response = await enqueueMailboxFetch(() => fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        Prefer: 'IdType="ImmutableId"',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    }));

    if (response.status === 401 && attempt === 0) {
      tokenCache = null;
      continue;
    }

    // Read a clone when checking an error so successful raw downloads keep
    // their original body stream.
    // eslint-disable-next-line no-await-in-loop
    const errorData = response.ok ? {} : await response.clone().json().catch(() => ({}));
    const graphCode = errorData?.error?.code || null;
    const graphMessage = errorData?.error?.message || '';
    if (
      isMailboxConcurrencyError(response.status, graphCode, graphMessage)
      && attempt < 4
    ) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(graphRetryDelayMs(response, attempt));
      continue;
    }

    if (raw) {
      if (!response.ok) {
        const error = new Error(sharedMailErrorMessage(response.status, graphCode, graphMessage));
        error.status = response.status;
        error.graphCode = graphCode;
        throw error;
      }
      return response;
    }

    // eslint-disable-next-line no-await-in-loop
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok || data?.error) {
      const code = data?.error?.code || graphCode;
      const error = new Error(sharedMailErrorMessage(
        response.status,
        code,
        data?.error?.message || graphMessage,
      ));
      error.status = response.status || 502;
      error.graphCode = code || null;
      throw error;
    }
    return data;
  }

  const error = new Error(
    `Microsoft is temporarily limiting concurrent access to ${mailboxUpn()}. Skyway retried automatically; wait a moment and refresh.`,
  );
  error.status = 503;
  error.graphCode = 'MailboxConcurrency';
  throw error;
}

/**
 * Graph reports missing application Mail grants and missing Exchange mailbox
 * scoping with the same opaque wording, which reads as a Skyway fault. Name the
 * administrator action instead.
 */
export function sharedMailErrorMessage(status, graphCode, graphMessage) {
  const raw = String(graphMessage || '').trim();
  const denied = status === 403
    || graphCode === 'ErrorAccessDenied'
    || graphCode === 'Authorization_RequestDenied'
    || /insufficient privileges/i.test(raw);
  if (denied) {
    return `Microsoft denied access to ${mailboxUpn()}. In Entra grant the mailbox app application permissions Mail.ReadWrite and Mail.Send with admin consent, and scope it to this mailbox with Exchange Online application RBAC (see docs/charter-shared-inbox-setup.md).`;
  }
  if (status === 404 || graphCode === 'ResourceNotFound' || /object was not found/i.test(raw)) {
    return `Microsoft could not find the mailbox ${mailboxUpn()}. Confirm CHARTER_MAILBOX_UPN matches a real licensed or shared mailbox in this tenant.`;
  }
  return raw || `Microsoft Graph returned ${status}`;
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Build an address book from raw Graph messages. Contacts are the people a
 * mailbox has actually corresponded with (senders + recipients), ranked by how
 * often and how recently they appear so autocomplete surfaces real contacts
 * first. This needs only Mail read scope — no separate People/Contacts grant.
 */
export function extractContacts(messages, selfAddresses = []) {
  const self = new Set(
    (Array.isArray(selfAddresses) ? selfAddresses : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const byAddress = new Map();
  const note = (emailAddress, whenMs) => {
    const address = String(emailAddress?.address || '').trim().toLowerCase();
    if (!EMAIL_RE.test(address) || self.has(address)) return;
    const name = String(emailAddress?.name || '').trim();
    const existing = byAddress.get(address);
    if (existing) {
      existing.count += 1;
      if (name && (!existing.name || existing.name === address)) existing.name = name;
      if (whenMs > existing.lastSeen) existing.lastSeen = whenMs;
    } else {
      byAddress.set(address, { name: name || '', address, count: 1, lastSeen: whenMs || 0 });
    }
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    const whenMs = new Date(message?.receivedDateTime || message?.sentDateTime || 0).getTime() || 0;
    note(message?.from?.emailAddress, whenMs);
    note(message?.sender?.emailAddress, whenMs);
    for (const recipient of message?.toRecipients || []) note(recipient?.emailAddress, whenMs);
    for (const recipient of message?.ccRecipients || []) note(recipient?.emailAddress, whenMs);
  }
  return [...byAddress.values()]
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.address.localeCompare(b.address))
    .slice(0, 500)
    .map(({ name, address }) => ({ name, address }));
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
