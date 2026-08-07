// Delegated mail operations for the signed-in employee's own work mailbox.

import {
  escapeHtml,
  extractContacts,
  graphRecipients,
  normalizeMessage,
} from './_charter-mail.js';
import {
  authorizeApprovedUser,
  personalSignatureHtml,
  publicUserMailbox,
  readUserMailbox,
  userGraphRequest,
} from './_user-mail.js';

const CONTACT_SELECT = 'from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime';

async function contacts(uid, caller, connection) {
  const [inbox, sent] = await Promise.all([
    userGraphRequest(
      uid,
      `/me/mailFolders/inbox/messages?$top=200&$orderby=receivedDateTime%20desc&$select=${encodeURIComponent(CONTACT_SELECT)}`,
    ).catch(() => ({ value: [] })),
    userGraphRequest(
      uid,
      `/me/mailFolders/sentitems/messages?$top=200&$orderby=sentDateTime%20desc&$select=${encodeURIComponent(CONTACT_SELECT)}`,
    ).catch(() => ({ value: [] })),
  ]);
  const self = [connection?.mail, connection?.userPrincipalName, caller?.email];
  return { contacts: extractContacts([...(inbox.value || []), ...(sent.value || [])], self) };
}

function commentHtml(text, signatureHtmlValue) {
  const escaped = escapeHtml(text).replace(/\r?\n/g, '<br>');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${escaped}</div>${signatureHtmlValue}`;
}

const MESSAGE_SELECT = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'from', 'sender',
  'toRecipients', 'ccRecipients', 'bccRecipients', 'receivedDateTime',
  'sentDateTime', 'createdDateTime', 'lastModifiedDateTime', 'bodyPreview',
  'isRead', 'isDraft', 'hasAttachments', 'importance', 'flag',
  'parentFolderId', 'webLink',
].join(',');

function safeId(value, label = 'ID') {
  const id = String(value || '').trim();
  if (!id || id.length > 2000 || /[\x00-\x1f]/.test(id)) throw new Error(`Invalid ${label}`);
  return id;
}

function encodeNext(url) {
  return url ? Buffer.from(url, 'utf8').toString('base64url') : null;
}

function decodeNext(token) {
  if (!token) return null;
  const url = Buffer.from(String(token), 'base64url').toString('utf8');
  const parsed = new URL(url);
  if (parsed.origin !== 'https://graph.microsoft.com') throw new Error('Invalid page token');
  return url;
}

async function folders(uid, parentId = null, depth = 0) {
  if (depth > 5) return [];
  const suffix = parentId
    ? `/me/mailFolders/${encodeURIComponent(parentId)}/childFolders`
    : '/me/mailFolders';
  let next = `${suffix}?includeHiddenFolders=true&$top=100&$select=id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount,isHidden`;
  const all = [];
  while (next) {
    // eslint-disable-next-line no-await-in-loop
    const page = await userGraphRequest(uid, next);
    all.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  const result = [];
  for (const folder of all) {
    const item = {
      id: folder.id,
      name: folder.displayName || 'Folder',
      parentFolderId: folder.parentFolderId || null,
      childCount: Number(folder.childFolderCount || 0),
      total: Number(folder.totalItemCount || 0),
      unread: Number(folder.unreadItemCount || 0),
      hidden: folder.isHidden === true,
      children: [],
    };
    if (item.childCount > 0) {
      // eslint-disable-next-line no-await-in-loop
      item.children = await folders(uid, item.id, depth + 1);
    }
    result.push(item);
  }
  return result;
}

async function messages(uid, body) {
  const nextUrl = decodeNext(body.next);
  let page;
  if (nextUrl) {
    page = await userGraphRequest(uid, nextUrl);
  } else {
    const folderId = safeId(body.folderId || 'inbox', 'folder ID');
    const search = String(body.search || '').trim().slice(0, 200);
    const base = `/me/mailFolders/${encodeURIComponent(folderId)}/messages`;
    page = search
      ? await userGraphRequest(
        uid,
        `${base}?$search=${encodeURIComponent(`"${search.replace(/"/g, '')}"`)}&$top=50&$select=${encodeURIComponent(MESSAGE_SELECT)}`,
        { headers: { ConsistencyLevel: 'eventual' } },
      )
      : await userGraphRequest(
        uid,
        `${base}?$top=50&$orderby=receivedDateTime%20desc&$select=${encodeURIComponent(MESSAGE_SELECT)}`,
      );
  }
  return {
    messages: (page.value || []).map((message) => normalizeMessage(message)),
    next: encodeNext(page['@odata.nextLink']),
  };
}

function attachments(values) {
  const result = [];
  let total = 0;
  for (const item of Array.isArray(values) ? values : []) {
    const contentBytes = String(item?.contentBase64 || '');
    const bytes = Math.floor(contentBytes.length * 0.75);
    total += bytes;
    if (!contentBytes || bytes > 2 * 1024 * 1024) throw new Error('Each attachment must be 2 MB or smaller');
    result.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: String(item.name || 'attachment').replace(/[^\w.\- ()]/g, '_').slice(0, 120),
      contentType: String(item.contentType || 'application/octet-stream').slice(0, 100),
      contentBytes,
    });
  }
  if (total > 3 * 1024 * 1024) throw new Error('Attachments must total 3 MB or less');
  return result;
}

async function send(uid, body, caller, connection) {
  const to = graphRecipients(body.to);
  if (!to.length) throw new Error('At least one recipient is required');
  const subject = String(body.subject || '').trim().slice(0, 500);
  if (!subject) throw new Error('Subject is required');
  await userGraphRequest(uid, '/me/sendMail', {
    method: 'POST',
    body: JSON.stringify({
      message: {
        subject,
        body: {
          contentType: 'HTML',
          content: String(body.html || '').slice(0, 200_000)
            + personalSignatureHtml(caller, connection.mail || caller.email),
        },
        toRecipients: to,
        ccRecipients: graphRecipients(body.cc),
        bccRecipients: graphRecipients(body.bcc),
        importance: ['low', 'normal', 'high'].includes(body.importance) ? body.importance : 'normal',
        attachments: attachments(body.attachments),
      },
      saveToSentItems: true,
    }),
  });
  return { sent: true };
}

async function reply(uid, body, caller, connection) {
  const id = safeId(body.messageId, 'message ID');
  const mode = ['reply', 'replyAll', 'forward'].includes(body.mode) ? body.mode : 'reply';
  const text = String(body.text || '').trim().slice(0, 100_000);
  if (!text) throw new Error('Reply text is required');
  const extraTo = graphRecipients(body.to);
  const extraCc = graphRecipients(body.cc);
  const extraBcc = graphRecipients(body.bcc);
  const files = attachments(body.attachments);
  const needsDraft = files.length > 0 || extraCc.length > 0 || extraBcc.length > 0;
  const signature = personalSignatureHtml(caller, connection.mail || caller.email);

  if (!needsDraft) {
    const textSignature = caller.emailSignature || `${caller.name}\nSkyway Aviation\n${connection.mail || caller.email}`;
    const payload = { comment: `${text}\n\n${textSignature}` };
    if (mode === 'forward') {
      payload.toRecipients = extraTo;
      if (!payload.toRecipients.length) throw new Error('Forward recipient is required');
    }
    await userGraphRequest(uid, `/me/messages/${encodeURIComponent(id)}/${mode}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return { sent: true };
  }

  const createPath = mode === 'forward' ? 'createForward' : mode === 'replyAll' ? 'createReplyAll' : 'createReply';
  const draft = await userGraphRequest(uid, `/me/messages/${encodeURIComponent(id)}/${createPath}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const draftId = draft.id;
  const current = await userGraphRequest(
    uid,
    `/me/messages/${encodeURIComponent(draftId)}?$select=body,toRecipients,ccRecipients,bccRecipients`,
  );
  const patch = {
    body: {
      contentType: 'HTML',
      content: `${commentHtml(text, signature)}<br><br>${current.body?.content || ''}`,
    },
  };
  if (mode === 'forward') {
    if (!extraTo.length) throw new Error('Forward recipient is required');
    patch.toRecipients = extraTo;
  } else if (extraTo.length) {
    patch.toRecipients = [...(current.toRecipients || []), ...extraTo];
  }
  if (extraCc.length) patch.ccRecipients = [...(current.ccRecipients || []), ...extraCc];
  if (extraBcc.length) patch.bccRecipients = [...(current.bccRecipients || []), ...extraBcc];
  await userGraphRequest(uid, `/me/messages/${encodeURIComponent(draftId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  for (const attachment of files) {
    // eslint-disable-next-line no-await-in-loop
    await userGraphRequest(uid, `/me/messages/${encodeURIComponent(draftId)}/attachments`, {
      method: 'POST',
      body: JSON.stringify(attachment),
    });
  }
  await userGraphRequest(uid, `/me/messages/${encodeURIComponent(draftId)}/send`, { method: 'POST' });
  return { sent: true };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const caller = await authorizeApprovedUser(req.body?.idToken);
    const action = req.body?.action || 'status';
    const connection = await readUserMailbox(caller.uid);
    if (action === 'status') {
      res.status(200).json({ ok: true, ...publicUserMailbox(connection) });
      return;
    }
    if (!connection) {
      res.status(409).json({ error: 'Work mailbox is not connected', connected: false });
      return;
    }
    let result;
    if (action === 'folders') {
      result = { folders: await folders(caller.uid) };
    } else if (action === 'messages') {
      result = await messages(caller.uid, req.body || {});
    } else if (action === 'message') {
      const id = safeId(req.body?.messageId, 'message ID');
      const raw = await userGraphRequest(
        caller.uid,
        // contentId is specific to fileAttachment and cannot be selected on
        // Graph's base attachment collection during a heterogeneous expand.
        `/me/messages/${encodeURIComponent(id)}?$select=${encodeURIComponent(`${MESSAGE_SELECT},body,uniqueBody`)}&$expand=attachments($select=id,name,contentType,size,isInline)`,
        { headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"' } },
      );
      if (!raw.isRead) {
        await userGraphRequest(caller.uid, `/me/messages/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ isRead: true }),
        });
      }
      result = { message: normalizeMessage(raw, true) };
    } else if (action === 'contacts') {
      result = await contacts(caller.uid, caller, connection);
    } else if (action === 'send') {
      result = await send(caller.uid, req.body || {}, caller, connection);
    } else if (action === 'reply') {
      result = await reply(caller.uid, req.body || {}, caller, connection);
    } else if (action === 'delete') {
      const id = safeId(req.body?.messageId, 'message ID');
      const moved = await userGraphRequest(caller.uid, `/me/messages/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ destinationId: 'deleteditems' }),
      });
      result = { deleted: true, message: normalizeMessage(moved) };
    } else if (action === 'flag') {
      const id = safeId(req.body?.messageId, 'message ID');
      const flagStatus = ['flagged', 'complete', 'notFlagged'].includes(req.body?.flagStatus)
        ? req.body.flagStatus
        : 'flagged';
      await userGraphRequest(caller.uid, `/me/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ flag: { flagStatus } }),
      });
      result = { updated: true, flagStatus };
    } else if (action === 'markRead') {
      const id = safeId(req.body?.messageId, 'message ID');
      await userGraphRequest(caller.uid, `/me/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isRead: req.body?.isRead !== false }),
      });
      result = { updated: true };
    } else if (action === 'move') {
      const id = safeId(req.body?.messageId, 'message ID');
      const destinationId = safeId(req.body?.destinationId, 'folder ID');
      const moved = await userGraphRequest(caller.uid, `/me/messages/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ destinationId }),
      });
      result = { moved: true, message: normalizeMessage(moved) };
    } else if (action === 'createFolder') {
      const name = String(req.body?.name || '').trim().slice(0, 100);
      if (!name) throw new Error('Folder name required');
      const parentId = req.body?.parentId ? safeId(req.body.parentId, 'folder ID') : null;
      const path = parentId
        ? `/me/mailFolders/${encodeURIComponent(parentId)}/childFolders`
        : '/me/mailFolders';
      const folder = await userGraphRequest(caller.uid, path, {
        method: 'POST',
        body: JSON.stringify({ displayName: name }),
      });
      result = { folder: { id: folder.id, name: folder.displayName } };
    } else {
      throw new Error('Unknown mailbox action');
    }
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[user-mail]', err);
    res.status(err.status || 500).json({ error: err.message || 'Work mailbox request failed' });
  }
}
