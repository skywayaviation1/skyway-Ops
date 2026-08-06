// Shared charters@ mailbox operations for admin and sales.

import crypto from 'crypto';
import {
  authorizeMailboxCaller,
  escapeHtml,
  graphRecipients,
  graphRequest,
  isSharedMailConfigured,
  mailDb,
  mailboxPath,
  mailboxUpn,
  normalizeMessage,
  signatureHtml,
} from './_charter-mail.js';

const MESSAGE_SELECT = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'from', 'sender',
  'toRecipients', 'ccRecipients', 'bccRecipients', 'receivedDateTime',
  'sentDateTime', 'createdDateTime', 'lastModifiedDateTime', 'bodyPreview',
  'isRead', 'isDraft', 'hasAttachments', 'importance', 'flag',
  'parentFolderId', 'webLink',
].join(',');

function linkId(messageId) {
  return crypto.createHash('sha256').update(String(messageId)).digest('hex');
}

function safeFolderId(value) {
  const id = String(value || 'inbox').trim();
  if (!id || id.length > 1000 || /[\x00-\x1f]/.test(id)) throw new Error('Invalid folder ID');
  return id;
}

function safeMessageId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 2000 || /[\x00-\x1f]/.test(id)) throw new Error('Invalid message ID');
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
  if (!parsed.pathname.startsWith('/v1.0/users/')) throw new Error('Invalid page token');
  return url;
}

async function linksFor(messages) {
  if (!messages.length) return new Map();
  const db = mailDb();
  const refs = messages.map((message) => db.collection('charter-mail-links').doc(linkId(message.id)));
  const conversationRefs = messages.map((message) => (
    db.collection('charter-mail-conversations').doc(linkId(message.conversationId || message.id))
  ));
  const snapshots = await db.getAll(...refs, ...conversationRefs);
  const map = new Map();
  snapshots.slice(0, refs.length).forEach((snap) => {
    if (snap.exists) map.set(snap.data().messageId, snap.data());
  });
  snapshots.slice(refs.length).forEach((snap, index) => {
    if (snap.exists && !map.has(messages[index].id)) {
      map.set(messages[index].id, { ...snap.data(), inheritedFromConversation: true });
    }
  });
  return map;
}

async function listFoldersRecursive(parentId = null, depth = 0) {
  if (depth > 5) return [];
  const suffix = parentId
    ? `/mailFolders/${encodeURIComponent(parentId)}/childFolders`
    : '/mailFolders';
  let nextUrl = `${mailboxPath(suffix)}?includeHiddenFolders=true&$top=100&$select=id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount,isHidden`;
  const folders = [];
  while (nextUrl) {
    // eslint-disable-next-line no-await-in-loop
    const page = await graphRequest(nextUrl);
    folders.push(...(page.value || []));
    nextUrl = page['@odata.nextLink'] || null;
  }
  const result = [];
  for (const folder of folders) {
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
      item.children = await listFoldersRecursive(item.id, depth + 1);
    }
    result.push(item);
  }
  return result;
}

async function listMessages(body) {
  const nextUrl = decodeNext(body.next);
  let data;
  if (nextUrl) {
    data = await graphRequest(nextUrl);
  } else {
    const folderId = safeFolderId(body.folderId || 'inbox');
    const search = String(body.search || '').trim().slice(0, 200);
    const base = mailboxPath(`/mailFolders/${encodeURIComponent(folderId)}/messages`);
    if (search) {
      const query = `"${search.replace(/"/g, '')}"`;
      data = await graphRequest(
        `${base}?$search=${encodeURIComponent(query)}&$top=50&$select=${encodeURIComponent(MESSAGE_SELECT)}`,
        { headers: { ConsistencyLevel: 'eventual' } },
      );
    } else {
      data = await graphRequest(
        `${base}?$top=50&$orderby=receivedDateTime%20desc&$select=${encodeURIComponent(MESSAGE_SELECT)}`,
      );
    }
  }
  const messages = (data.value || []).map((message) => normalizeMessage(message));
  const links = await linksFor(messages);
  return {
    messages: messages.map((message) => ({
      ...message,
      filing: links.get(message.id) || null,
    })),
    next: encodeNext(data['@odata.nextLink']),
  };
}

function attachmentPayloads(values) {
  const attachments = [];
  let total = 0;
  for (const item of Array.isArray(values) ? values : []) {
    const contentBytes = String(item?.contentBase64 || '');
    const bytes = Math.floor(contentBytes.length * 0.75);
    total += bytes;
    if (!contentBytes || bytes > 2 * 1024 * 1024) {
      throw new Error('Each attachment must be 2 MB or smaller');
    }
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: String(item.name || 'attachment').replace(/[^\w.\- ()]/g, '_').slice(0, 120),
      contentType: String(item.contentType || 'application/octet-stream').slice(0, 100),
      contentBytes,
    });
  }
  if (total > 3 * 1024 * 1024) throw new Error('Attachments must total 3 MB or less');
  return attachments;
}

async function sendMessage(body, caller) {
  const to = graphRecipients(body.to);
  if (!to.length) throw new Error('At least one recipient is required');
  const subject = String(body.subject || '').trim().slice(0, 500);
  if (!subject) throw new Error('Subject is required');
  const content = String(body.html || '').slice(0, 200_000) + signatureHtml(caller);
  const message = {
    subject,
    body: { contentType: 'HTML', content },
    toRecipients: to,
    ccRecipients: graphRecipients(body.cc),
    bccRecipients: graphRecipients(body.bcc),
    importance: ['low', 'normal', 'high'].includes(body.importance) ? body.importance : 'normal',
    attachments: attachmentPayloads(body.attachments),
  };
  await graphRequest(mailboxPath('/sendMail'), {
    method: 'POST',
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  return { sent: true };
}

async function replyMessage(body, caller) {
  const messageId = safeMessageId(body.messageId);
  const action = ['reply', 'replyAll', 'forward'].includes(body.mode) ? body.mode : 'reply';
  const text = String(body.text || '').trim().slice(0, 100_000);
  if (!text) throw new Error('Reply text is required');
  const signature = caller.emailSignature || `${caller.name}\nSkyway Aviation\n${mailboxUpn()}`;
  const payload = { comment: `${text}\n\n${signature}` };
  if (action === 'forward') {
    payload.toRecipients = graphRecipients(body.to);
    if (!payload.toRecipients.length) throw new Error('Forward recipient is required');
  }
  await graphRequest(mailboxPath(`/messages/${encodeURIComponent(messageId)}/${action}`), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return { sent: true };
}

async function fileToTrip(body, caller) {
  const messageId = safeMessageId(body.messageId);
  const tripUid = String(body.tripUid || '').trim().slice(0, 300);
  if (!tripUid) throw new Error('Trip is required');
  const payload = {
    messageId,
    tripUid,
    conversationId: String(body.conversationId || '').slice(0, 500),
    subject: String(body.subject || '').slice(0, 500),
    from: body.from || null,
    receivedAt: body.receivedAt || null,
    filedAt: Date.now(),
    filedBy: caller.uid,
    filedByName: caller.name,
  };
  await mailDb().collection('charter-mail-links').doc(linkId(messageId)).set(payload);
  if (payload.conversationId) {
    await mailDb().collection('charter-mail-conversations')
      .doc(linkId(payload.conversationId))
      .set({
        conversationId: payload.conversationId,
        tripUid,
        subject: payload.subject,
        filedAt: payload.filedAt,
        filedBy: caller.uid,
        filedByName: caller.name,
      });
  }
  return payload;
}

async function listTripMessages(body) {
  const tripUid = String(body.tripUid || '').trim().slice(0, 300);
  if (!tripUid) throw new Error('tripUid required');
  const [messageSnap, conversationSnap] = await Promise.all([
    mailDb().collection('charter-mail-links').where('tripUid', '==', tripUid).limit(100).get(),
    mailDb().collection('charter-mail-conversations').where('tripUid', '==', tripUid).limit(100).get(),
  ]);
  const items = [];
  const seen = new Set();
  for (const link of messageSnap.docs) {
    const filing = link.data();
    try {
      // eslint-disable-next-line no-await-in-loop
      const raw = await graphRequest(
        `${mailboxPath(`/messages/${encodeURIComponent(filing.messageId)}`)}?$select=${encodeURIComponent(MESSAGE_SELECT)}`,
      );
      items.push({ ...normalizeMessage(raw), filing });
      seen.add(raw.id);
    } catch (err) {
      items.push({
        id: filing.messageId,
        subject: filing.subject || 'Message unavailable',
        from: filing.from || null,
        receivedAt: filing.receivedAt || null,
        unavailable: true,
        filing,
      });
    }
  }
  for (const conversationDoc of conversationSnap.docs) {
    const filing = conversationDoc.data();
    if (!filing.conversationId) continue;
    try {
      const filter = `conversationId eq '${String(filing.conversationId).replace(/'/g, "''")}'`;
      // eslint-disable-next-line no-await-in-loop
      const page = await graphRequest(
        `${mailboxPath('/messages')}?$top=100&$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(MESSAGE_SELECT)}`,
      );
      for (const raw of page.value || []) {
        if (seen.has(raw.id)) continue;
        items.push({ ...normalizeMessage(raw), filing: { ...filing, inheritedFromConversation: true } });
        seen.add(raw.id);
      }
    } catch (err) {
      console.warn('[charter-mail] conversation expansion failed', err.message);
    }
  }
  items.sort((a, b) => (
    new Date(b.receivedAt || b.sentAt || b.createdAt || 0)
    - new Date(a.receivedAt || a.sentAt || a.createdAt || 0)
  ));
  return { messages: items };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const caller = await authorizeMailboxCaller(req.body?.idToken);
    const action = req.body?.action || 'status';
    let result;
    if (action === 'status') {
      if (!isSharedMailConfigured()) {
        result = {
          connected: false,
          configured: false,
          mailbox: mailboxUpn(),
          setupHint: 'Set MICROSOFT_MAIL_TENANT_ID, MICROSOFT_MAIL_CLIENT_ID, and MICROSOFT_MAIL_CLIENT_SECRET on the deployment, then reopen Shared inbox.',
        };
      } else {
        const user = await graphRequest(`${mailboxPath()}?$select=displayName,mail,userPrincipalName`);
        result = {
          connected: true,
          configured: true,
          mailbox: user.mail || user.userPrincipalName || mailboxUpn(),
          displayName: user.displayName || 'Charter Sales',
        };
      }
    } else if (action === 'folders') {
      result = { folders: await listFoldersRecursive() };
    } else if (action === 'messages') {
      result = await listMessages(req.body || {});
    } else if (action === 'message') {
      const id = safeMessageId(req.body?.messageId);
      const raw = await graphRequest(
        `${mailboxPath(`/messages/${encodeURIComponent(id)}`)}?$select=${encodeURIComponent(`${MESSAGE_SELECT},body,uniqueBody`)}&$expand=attachments($select=id,name,contentType,size,isInline,contentId)`,
        { headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"' } },
      );
      const [filing] = await Promise.all([
        mailDb().collection('charter-mail-links').doc(linkId(id)).get(),
        raw.isRead ? Promise.resolve() : graphRequest(mailboxPath(`/messages/${encodeURIComponent(id)}`), {
          method: 'PATCH',
          body: JSON.stringify({ isRead: true }),
        }),
      ]);
      result = { message: { ...normalizeMessage(raw, true), filing: filing.exists ? filing.data() : null } };
    } else if (action === 'send') {
      result = await sendMessage(req.body || {}, caller);
    } else if (action === 'reply') {
      result = await replyMessage(req.body || {}, caller);
    } else if (action === 'markRead') {
      const id = safeMessageId(req.body?.messageId);
      await graphRequest(mailboxPath(`/messages/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        body: JSON.stringify({ isRead: req.body?.isRead !== false }),
      });
      result = { updated: true };
    } else if (action === 'move') {
      const id = safeMessageId(req.body?.messageId);
      const destinationId = safeFolderId(req.body?.destinationId);
      const moved = await graphRequest(mailboxPath(`/messages/${encodeURIComponent(id)}/move`), {
        method: 'POST',
        body: JSON.stringify({ destinationId }),
      });
      const filingRef = mailDb().collection('charter-mail-links').doc(linkId(id));
      const filing = await filingRef.get();
      if (filing.exists && moved.id && moved.id !== id) {
        await mailDb().collection('charter-mail-links').doc(linkId(moved.id)).set({
          ...filing.data(),
          messageId: moved.id,
          movedAt: Date.now(),
        });
        await filingRef.delete();
      }
      result = { moved: true, message: normalizeMessage(moved) };
    } else if (action === 'createFolder') {
      const name = String(req.body?.name || '').trim().slice(0, 100);
      if (!name) throw new Error('Folder name required');
      const parentId = req.body?.parentId ? safeFolderId(req.body.parentId) : null;
      const path = parentId
        ? mailboxPath(`/mailFolders/${encodeURIComponent(parentId)}/childFolders`)
        : mailboxPath('/mailFolders');
      const folder = await graphRequest(path, {
        method: 'POST',
        body: JSON.stringify({ displayName: name }),
      });
      result = { folder: { id: folder.id, name: folder.displayName } };
    } else if (action === 'fileTrip') {
      result = { filing: await fileToTrip(req.body || {}, caller) };
    } else if (action === 'unfileTrip') {
      const id = safeMessageId(req.body?.messageId);
      const ref = mailDb().collection('charter-mail-links').doc(linkId(id));
      const snap = await ref.get();
      const conversationId = snap.exists
        ? snap.data().conversationId
        : String(req.body?.conversationId || '').trim();
      if (conversationId) {
        await mailDb().collection('charter-mail-conversations')
          .doc(linkId(conversationId))
          .delete();
      }
      await ref.delete();
      result = { unfiled: true };
    } else if (action === 'tripMessages') {
      result = await listTripMessages(req.body || {});
    } else {
      throw new Error('Unknown mailbox action');
    }
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[charter-mail]', err);
    res.status(err.status || 500).json({ error: err.message || 'Shared mailbox request failed' });
  }
}
