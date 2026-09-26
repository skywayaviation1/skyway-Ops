// Scheduled scan of charters@flyskyway.com for broker checkout mail that
// includes a signed charter contract. Vercel cron calls GET about every 10
// minutes. Ops can POST { idToken } to run the same scan from the coverage tab.
//
// Each Graph message id is stored once. Messages that are not checkouts are
// marked skipped so they are not parsed again. Checkout extraction lives in
// api/_aog-checkout-parser.js.

import { graphRequest, isSharedMailConfigured, mailboxUpn } from './_charter-mail.js';
import { htmlToText, parseCheckoutEmail } from './_aog-checkout-parser.js';
import {
  authorizeOps,
  coverageIdForMessage,
  ingestParsedCheckout,
  knownAircraftNames,
  loadSettings,
  markMessageProcessed,
  messageAlreadyProcessed,
  publicBaseUrl,
  readJson,
  recoveryDb,
} from './_aog-recovery.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const LOOKBACK_DAYS = 21;
const MAX_MESSAGES = 25;

function cronAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

async function listCandidateMessages() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const upn = encodeURIComponent(mailboxUpn());
  const select = 'id,subject,from,receivedDateTime,hasAttachments';
  const filtered = `/users/${upn}/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc&$select=${select}&$filter=hasAttachments eq true and receivedDateTime ge ${since}`;
  const collected = [];
  try {
    let url = filtered;
    for (let page = 0; page < 4 && url && collected.length < 100; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const data = await graphRequest(url);
      if (Array.isArray(data.value)) collected.push(...data.value);
      url = data['@odata.nextLink'] || '';
    }
    return collected;
  } catch (err) {
    console.warn('[aog-recovery] filtered inbox list failed, retrying without filter:', err.message);
    const data = await graphRequest(`/users/${upn}/mailFolders/inbox/messages?$top=40&$select=${select}`);
    return Array.isArray(data.value) ? data.value : [];
  }
}

async function loadPdf(messageId) {
  const upn = encodeURIComponent(mailboxUpn());
  const id = encodeURIComponent(messageId);
  const listed = await graphRequest(`/users/${upn}/messages/${id}/attachments`);
  const attachments = Array.isArray(listed.value) ? listed.value : [];
  const pdfs = attachments.filter((item) => {
    const name = String(item.name || '');
    const type = String(item.contentType || '');
    return /\.pdf$/i.test(name) || type === 'application/pdf';
  });
  if (pdfs.length === 0) return { pdfs: [], buffer: null, filename: '' };
  const preferred = pdfs.find((item) => /charter|contract|agreement/i.test(item.name || '')) || pdfs[0];
  let buffer = null;
  if (preferred.contentBytes) {
    buffer = Buffer.from(preferred.contentBytes, 'base64');
  } else if (preferred.id) {
    const response = await graphRequest(
      `/users/${upn}/messages/${id}/attachments/${encodeURIComponent(preferred.id)}/$value`,
      { raw: true },
    );
    buffer = Buffer.from(await response.arrayBuffer());
  }
  return {
    pdfs,
    buffer,
    filename: preferred.name || 'charter-contract.pdf',
  };
}

export async function scanInbox({ db, baseUrl }) {
  if (!isSharedMailConfigured()) {
    const error = new Error('Microsoft Graph mailbox credentials are not configured');
    error.status = 503;
    throw error;
  }
  const settings = await loadSettings(db);
  const messages = await listCandidateMessages();
  const summary = { examined: 0, recorded: 0, skipped: 0, duplicate: 0, errors: 0 };
  for (const message of messages) {
    if (!message?.id || message.hasAttachments === false) continue;
    if (await messageAlreadyProcessed(db, message.id)) continue;
    if (summary.examined >= MAX_MESSAGES) break;
    summary.examined += 1;
    try {
      const full = await graphRequest(
        `/users/${encodeURIComponent(mailboxUpn())}/messages/${encodeURIComponent(message.id)}?$select=id,subject,from,body,receivedDateTime,hasAttachments`,
      );
      const files = await loadPdf(message.id);
      const parsed = parseCheckoutEmail({
        subject: full.subject || message.subject || '',
        from: full.from?.emailAddress?.address || message.from?.emailAddress?.address || '',
        bodyText: htmlToText(full.body?.content || ''),
        attachmentNames: files.pdfs.map((item) => item.name || 'attachment.pdf'),
        hasPdf: files.pdfs.length > 0,
      }, { knownAircraft: knownAircraftNames(settings) });
      if (!parsed.isCheckout) {
        await markMessageProcessed(db, message.id, { outcome: 'skipped', subject: String(full.subject || '').slice(0, 140) });
        summary.skipped += 1;
        continue;
      }
      const result = await ingestParsedCheckout(db, {
        messageId: message.id,
        parsed,
        pdfBuffer: files.buffer,
        pdfFilename: files.filename,
        settings,
        baseUrl,
      });
      await markMessageProcessed(db, message.id, {
        outcome: result.outcome,
        coverageId: result.coverageId || coverageIdForMessage(message.id),
        subject: String(full.subject || '').slice(0, 140),
      });
      summary[result.outcome] = (summary[result.outcome] || 0) + 1;
    } catch (err) {
      summary.errors += 1;
      console.error('[aog-recovery] message failed', message.id, err.message);
      await markMessageProcessed(db, message.id, { outcome: 'error', error: String(err.message || err).slice(0, 300) }).catch(() => {});
    }
  }
  return summary;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    if (req.method === 'POST') {
      const body = readJson(req);
      await authorizeOps(body.idToken);
    } else if (!cronAuthorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const summary = await scanInbox({ db: recoveryDb(), baseUrl: publicBaseUrl(req) });
    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Scan failed' });
  }
}
