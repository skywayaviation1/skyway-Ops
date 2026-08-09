// Microsoft Teams operations for the signed-in employee.

import {
  authorizeApprovedUser,
  hasTeamsScopes,
  isUserMailConfigured,
  readUserMailbox,
} from './_user-mail.js';
import {
  normalizeChannel,
  normalizeChat,
  normalizeDriveItem,
  normalizeTeam,
  normalizeTeamsMessage,
  outgoingMessageBody,
  requireTeamsConsent,
  safeGraphId,
  teamsGraphRequest,
} from './_teams.js';

const MESSAGE_TOP = 30;

async function joinedTeams(uid) {
  const page = await teamsGraphRequest(uid, '/me/joinedTeams?$select=id,displayName,description,webUrl');
  return (page.value || []).map(normalizeTeam).sort((a, b) => a.name.localeCompare(b.name));
}

async function channels(uid, teamId) {
  const page = await teamsGraphRequest(
    uid,
    `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName,description,webUrl,membershipType`,
  );
  return (page.value || []).map(normalizeChannel).sort((a, b) => {
    if (a.name.toLowerCase() === 'general') return -1;
    if (b.name.toLowerCase() === 'general') return 1;
    return a.name.localeCompare(b.name);
  });
}

async function chats(uid, connection) {
  const page = await teamsGraphRequest(
    uid,
    '/me/chats?$expand=members&$top=25&$orderby=lastMessagePreview/createdDateTime%20desc',
  ).catch(() => teamsGraphRequest(uid, '/me/chats?$expand=members&$top=25'));
  const self = [connection?.graphUserId, connection?.mail, connection?.userPrincipalName];
  return (page.value || []).map((chat) => normalizeChat(chat, self));
}

async function channelMessages(uid, teamId, channelId) {
  const page = await teamsGraphRequest(
    uid,
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${MESSAGE_TOP}&$expand=replies`,
  );
  return (page.value || [])
    .map(normalizeTeamsMessage)
    .filter((message) => !message.deleted)
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

async function channelFiles(uid, teamId, channelId) {
  const folder = await teamsGraphRequest(
    uid,
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/filesFolder`,
  );
  const driveId = folder?.parentReference?.driveId;
  if (!driveId || !folder?.id) return { files: [], driveId: driveId || '', folderId: folder?.id || '' };
  const page = await teamsGraphRequest(
    uid,
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folder.id)}/children?$top=200&$select=id,name,size,file,folder,webUrl,lastModifiedDateTime,lastModifiedBy,parentReference`,
  );
  return {
    files: (page.value || []).map(normalizeDriveItem),
    driveId,
    folderId: folder.id,
  };
}

async function driveChildren(uid, driveId, itemId) {
  const page = await teamsGraphRequest(
    uid,
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children?$top=200&$select=id,name,size,file,folder,webUrl,lastModifiedDateTime,lastModifiedBy,parentReference`,
  );
  return { files: (page.value || []).map(normalizeDriveItem), driveId, folderId: itemId };
}

async function chatMessages(uid, chatId) {
  const page = await teamsGraphRequest(
    uid,
    `/chats/${encodeURIComponent(chatId)}/messages?$top=${MESSAGE_TOP}`,
  );
  return (page.value || [])
    .map(normalizeTeamsMessage)
    .filter((message) => !message.deleted)
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const caller = await authorizeApprovedUser(req.body?.idToken);
    const action = req.body?.action || 'status';
    const connection = await readUserMailbox(caller.uid);

    if (action === 'status') {
      res.status(200).json({
        ok: true,
        configured: isUserMailConfigured(),
        connected: Boolean(connection),
        teamsEnabled: hasTeamsScopes(connection),
        account: connection?.mail || connection?.userPrincipalName || caller.email,
        displayName: connection?.displayName || caller.name,
      });
      return;
    }

    if (!connection) {
      res.status(409).json({
        error: 'Connect Microsoft to use Teams',
        connected: false,
        teamsEnabled: false,
      });
      return;
    }
    requireTeamsConsent(connection);

    let result;
    if (action === 'overview') {
      const [teams, chatList] = await Promise.all([
        joinedTeams(caller.uid).catch(() => []),
        chats(caller.uid, connection).catch(() => []),
      ]);
      result = { teams, chats: chatList };
    } else if (action === 'channels') {
      result = { channels: await channels(caller.uid, safeGraphId(req.body?.teamId, 'team ID')) };
    } else if (action === 'channelMessages') {
      result = {
        messages: await channelMessages(
          caller.uid,
          safeGraphId(req.body?.teamId, 'team ID'),
          safeGraphId(req.body?.channelId, 'channel ID'),
        ),
      };
    } else if (action === 'channelFiles') {
      result = await channelFiles(
        caller.uid,
        safeGraphId(req.body?.teamId, 'team ID'),
        safeGraphId(req.body?.channelId, 'channel ID'),
      );
    } else if (action === 'driveChildren') {
      result = await driveChildren(
        caller.uid,
        safeGraphId(req.body?.driveId, 'drive ID'),
        safeGraphId(req.body?.itemId, 'folder ID'),
      );
    } else if (action === 'chatMessages') {
      result = { messages: await chatMessages(caller.uid, safeGraphId(req.body?.chatId, 'chat ID')) };
    } else if (action === 'sendChannelMessage') {
      const teamId = safeGraphId(req.body?.teamId, 'team ID');
      const channelId = safeGraphId(req.body?.channelId, 'channel ID');
      const sent = await teamsGraphRequest(
        caller.uid,
        `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
        { method: 'POST', body: JSON.stringify({ body: outgoingMessageBody(req.body?.text) }) },
      );
      result = { sent: true, message: normalizeTeamsMessage(sent) };
    } else if (action === 'sendChannelReply') {
      const teamId = safeGraphId(req.body?.teamId, 'team ID');
      const channelId = safeGraphId(req.body?.channelId, 'channel ID');
      const messageId = safeGraphId(req.body?.messageId, 'message ID');
      const sent = await teamsGraphRequest(
        caller.uid,
        `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`,
        { method: 'POST', body: JSON.stringify({ body: outgoingMessageBody(req.body?.text) }) },
      );
      result = { sent: true, message: normalizeTeamsMessage(sent) };
    } else if (action === 'sendChatMessage') {
      const chatId = safeGraphId(req.body?.chatId, 'chat ID');
      const sent = await teamsGraphRequest(
        caller.uid,
        `/chats/${encodeURIComponent(chatId)}/messages`,
        { method: 'POST', body: JSON.stringify({ body: outgoingMessageBody(req.body?.text) }) },
      );
      result = { sent: true, message: normalizeTeamsMessage(sent) };
    } else {
      throw new Error('Unknown Teams action');
    }
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[teams]', err);
    res.status(err.status || 500).json({
      error: err.message || 'Teams request failed',
      code: err.code || null,
    });
  }
}
