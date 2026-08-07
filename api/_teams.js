// Delegated Microsoft Teams access for the signed-in employee.
//
// Teams reuses the same delegated connection as personal mail (one Microsoft
// consent per employee). Only Teams resources the signed-in user can already
// reach are exposed; Skyway never uses application-wide Teams permissions.

import { hasTeamsScopes, userGraphRequest } from './_user-mail.js';

// Teams lives outside the /me and /users paths the mail client is limited to,
// so Teams calls carry their own explicit allowlist.
const TEAMS_PREFIXES = [
  '/v1.0/me/joinedTeams',
  '/v1.0/me/chats',
  '/v1.0/teams/',
  '/v1.0/chats/',
];

export function teamsGraphRequest(uid, pathOrUrl, options = {}) {
  return userGraphRequest(uid, pathOrUrl, { ...options, allowPrefixes: TEAMS_PREFIXES });
}

export function requireTeamsConsent(connection) {
  if (hasTeamsScopes(connection)) return;
  const error = new Error(
    'Microsoft Teams access has not been granted yet. Reconnect Microsoft from Teams or Profile to approve Teams, then try again.',
  );
  error.status = 403;
  error.code = 'teams_consent_required';
  throw error;
}

export function safeGraphId(value, label = 'ID') {
  const id = String(value || '').trim();
  if (!id || id.length > 300 || /[\x00-\x1f]/.test(id)) throw new Error(`Invalid ${label}`);
  return id;
}

/** Plain-text preview of a Teams HTML message body. */
export function messagePreview(html, limit = 200) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export function normalizeTeam(team) {
  return {
    id: team?.id || '',
    name: team?.displayName || 'Team',
    description: team?.description || '',
    webUrl: team?.webUrl || '',
  };
}

export function normalizeChannel(channel) {
  return {
    id: channel?.id || '',
    name: channel?.displayName || 'Channel',
    description: channel?.description || '',
    webUrl: channel?.webUrl || '',
    membershipType: channel?.membershipType || 'standard',
  };
}

/** A readable title for a chat, which Graph often leaves unnamed. */
export function normalizeChat(chat, selfIds = []) {
  const self = new Set(selfIds.filter(Boolean).map((value) => String(value).toLowerCase()));
  const others = (chat?.members || [])
    .filter((member) => {
      const id = String(member?.userId || '').toLowerCase();
      const email = String(member?.email || '').toLowerCase();
      return !(self.has(id) || self.has(email));
    })
    .map((member) => member?.displayName || member?.email || 'Unknown')
    .filter(Boolean);
  const topic = chat?.topic || '';
  return {
    id: chat?.id || '',
    topic,
    name: topic || (others.length ? others.join(', ') : 'Chat'),
    chatType: chat?.chatType || 'oneOnOne',
    webUrl: chat?.webUrl || '',
    lastUpdatedAt: chat?.lastUpdatedDateTime || chat?.createdDateTime || null,
    members: others,
  };
}

export function normalizeTeamsMessage(message) {
  const from = message?.from?.user || message?.from?.application || null;
  return {
    id: message?.id || '',
    createdAt: message?.createdDateTime || null,
    editedAt: message?.lastEditedDateTime || null,
    deleted: Boolean(message?.deletedDateTime),
    subject: message?.subject || '',
    importance: message?.importance || 'normal',
    from: from ? { id: from.id || '', name: from.displayName || 'Unknown' } : null,
    body: {
      type: message?.body?.contentType || 'html',
      content: message?.body?.content || '',
    },
    preview: messagePreview(message?.body?.content),
    attachments: (message?.attachments || []).map((attachment) => ({
      id: attachment?.id || '',
      name: attachment?.name || 'attachment',
      contentType: attachment?.contentType || '',
      contentUrl: attachment?.contentUrl || '',
    })),
    replyCount: Array.isArray(message?.replies) ? message.replies.length : 0,
    webUrl: message?.webUrl || '',
  };
}

/** Graph rejects raw HTML from clients; send plain text as escaped HTML. */
export function outgoingMessageBody(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('Message text is required');
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
  return { contentType: 'html', content: escaped.slice(0, 28_000) };
}
