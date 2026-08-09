// Streams one shared-mailbox attachment through an authenticated server route.

import {
  authorizeMailboxCaller,
  graphRequest,
  mailboxPath,
} from './_charter-mail.js';

function safeId(value, label) {
  const id = String(value || '').trim();
  if (!id || id.length > 2000 || /[\x00-\x1f]/.test(id)) {
    throw new Error(`Invalid ${label}`);
  }
  return id;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    await authorizeMailboxCaller(req.body?.idToken);
    const messageId = safeId(req.body?.messageId, 'message ID');
    const attachmentId = safeId(req.body?.attachmentId, 'attachment ID');
    const response = await graphRequest(
      mailboxPath(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`),
      { raw: true },
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 20 * 1024 * 1024) {
      res.status(413).json({ error: 'Attachment is larger than the 20 MB in-app download limit' });
      return;
    }
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));
    res.status(200).send(buffer);
  } catch (err) {
    console.error('[charter-mail-attachment]', err);
    res.status(err.status || 500).json({ error: err.message || 'Attachment download failed' });
  }
}
