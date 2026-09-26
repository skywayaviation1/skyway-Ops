// Server-side AOG recovery coverage: Firestore, mailbox ingest, election
// storage, and the emails that must pass through the notify test-mode switch.
// Card charges go through api/_aog-stripe.js. This file never sees card data.

import crypto from 'crypto';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { applyNotifyTestMode } from './_notify-test-mode.js';
import { deliverNotification, isInternalAddress } from './_email-transport.js';
import { graphRequest, isSharedMailConfigured, mailboxUpn } from './_charter-mail.js';
import { parseCheckoutEmail } from './_aog-checkout-parser.js';
import { renderElectionPdf } from './_aog-election-pdf.js';
import {
  AOG_COVERAGE_TERMS_TEXT,
  AOG_COVERAGE_TERMS_VERSION,
} from '../src/aog-recovery-terms.js';
import {
  CFS_BIND_CC,
  CFS_BIND_TO,
  DEFAULT_RATES,
  buildCoverageDraft,
  classifyCheckout,
  coverageLevelLabel,
  fmtMoney,
  matchCoverageToTrips,
  normalizeDomains,
  normalizeRateTable,
  premiumLabel,
  quotePremium,
} from '../src/aog-recovery.js';
import {
  contractStoragePath,
  contractVersionPath,
  matchContractToTrips,
  planContractWrite,
  shouldAttachCharterContract,
} from '../src/charter-contract.js';

const COLLECTION = 'aogRecovery';
const CONFIG_DOC = ['aogRecoveryConfig', 'settings'];
const PROCESSED = 'aogRecoveryProcessed';
const BUCKET_FALLBACK = 'skyway-ops-app.firebasestorage.app';

let appSingleton = null;

export function getAdmin() {
  if (appSingleton) return appSingleton;
  if (admin.apps.length) {
    appSingleton = admin.app();
    return appSingleton;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  appSingleton = admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || BUCKET_FALLBACK,
  });
  return appSingleton;
}

export function recoveryDb() {
  return getFirestore(getAdmin(), 'appusers');
}

function storageBucket() {
  const name = process.env.FIREBASE_STORAGE_BUCKET || BUCKET_FALLBACK;
  return getStorage(getAdmin()).bucket(name);
}

export function readJson(req) {
  let body = req.body;
  if (typeof body === 'string') {
    body = JSON.parse(body);
  }
  return body && typeof body === 'object' ? body : {};
}

export function requestClient(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
    .split(',')[0]
    .trim();
  return {
    ip: forwarded || req.socket?.remoteAddress || '',
    userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
  };
}

export function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if (!host) return 'https://skyway-ops.vercel.app';
  const proto = host.includes('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
}

export async function authorizeOps(idToken) {
  if (!idToken) {
    const error = new Error('Sign-in required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = await admin.auth(getAdmin()).verifyIdToken(idToken, true);
  } catch {
    const error = new Error('Invalid or revoked session');
    error.status = 401;
    throw error;
  }
  const snap = await recoveryDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (
    !snap.exists
    || !['ops', 'admin'].includes(profile.role)
    || profile.active === false
    || profile.approved !== true
  ) {
    const error = new Error('Ops access required');
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    email: String(decoded.email || profile.email || '').toLowerCase(),
    name: profile.name || decoded.name || decoded.email || 'Skyway Ops',
    role: profile.role,
  };
}

export function newOfferToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashOfferToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function processedDocId(messageId) {
  return crypto.createHash('sha256').update(String(messageId || '')).digest('hex');
}

export function coverageIdForMessage(messageId) {
  return `in_${processedDocId(messageId).slice(0, 24)}`;
}

function sanitizeKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

export async function loadSettings(db = recoveryDb()) {
  const snap = await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).get();
  const data = snap.exists ? snap.data() || {} : {};
  return {
    rates: Array.isArray(data.rates) && data.rates.length ? data.rates : DEFAULT_RATES.map((row) => ({ ...row })),
    complimentaryDomains: Array.isArray(data.complimentaryDomains) ? data.complimentaryDomains : [],
    updatedAt: data.updatedAt || '',
    updatedBy: data.updatedBy || '',
  };
}

export async function saveSettings(db, { rates, complimentaryDomains, actor }) {
  const next = {
    rates: normalizeRateTable(rates),
    complimentaryDomains: normalizeDomains(complimentaryDomains),
    updatedAt: new Date().toISOString(),
    updatedBy: actor?.email || '',
  };
  await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).set(next, { merge: true });
  return next;
}

function tripFromState(docSnap) {
  const data = docSnap.data() || {};
  const meta = data.tripMeta || {};
  const sheet = data.tripSheetData || {};
  return {
    id: docSnap.id,
    tail: meta.tail || sheet.tail || '',
    from: meta.from || '',
    to: meta.to || '',
    start: meta.start || '',
    tripCode: sheet.tripCode || '',
    customer: sheet.client || data.customer || '',
    brokerEmail: data.brokerEmail || '',
  };
}

export async function loadTripCandidates(db, parsed) {
  const found = new Map();
  const add = (docSnap) => {
    if (docSnap?.exists) found.set(docSnap.id, tripFromState(docSnap));
  };
  if (parsed?.tripId) {
    add(await db.collection('trip-state').doc(sanitizeKey(parsed.tripId)).get());
    try {
      const byCode = await db.collection('trip-state')
        .where('tripSheetData.tripCode', '==', parsed.tripId)
        .limit(20)
        .get();
      byCode.docs.forEach(add);
    } catch (err) {
      console.warn('[aog-recovery] trip code lookup skipped:', err.message);
    }
  }
  if (parsed?.tail) {
    try {
      const byTail = await db.collection('trip-state')
        .where('tripMeta.tail', '==', String(parsed.tail).toUpperCase())
        .limit(40)
        .get();
      byTail.docs.forEach(add);
    } catch (err) {
      console.warn('[aog-recovery] tail lookup skipped:', err.message);
    }
  }
  return [...found.values()];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function detailRows(record) {
  const rows = [
    ['Trip ID', record.tripId],
    ['Tail', record.tail],
    ['Aircraft', record.aircraftType],
    ['Dates', record.datesLabel || [record.departDate, record.returnDate].filter(Boolean).join(' – ')],
    ['Route', record.route],
    ['Trip total', fmtMoney(record.tripTotal)],
    ['Coverage', coverageLevelLabel(record.coverageLevel)],
    ['Premium', premiumLabel(record)],
  ];
  return rows.map(([label, value]) => (
    `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${escapeHtml(label)}</td>`
    + `<td style="padding:4px 0;color:#0f172a">${escapeHtml(value || '—')}</td></tr>`
  )).join('');
}

function shell(title, inner) {
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#0f172a">`
    + `<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#64748b">Skyway Aviation · Charter Flight Support</div>`
    + `<h1 style="font-size:20px;margin:8px 0 16px">${escapeHtml(title)}</h1>`
    + inner
    + `</div>`;
}

export function offerLetter(record, url) {
  const subject = `AOG coverage for trip ${record.tripId || record.tail || ''}`.trim();
  const html = shell('50% is included. 100% is available.', `
    <p>Your charter includes <strong>50%</strong> AOG mechanical recovery coverage at no charge. No action is required to keep that coverage.</p>
    <p><strong>100%</strong> coverage is available for <strong>${escapeHtml(fmtMoney(record.premium))}</strong> (${escapeHtml(String(record.ratePercent))}% of the trip total). That amount is the premium only. The trip itself is not charged.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">${detailRows(record)}</table>
    <p><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px">Review and elect 100% coverage</a></p>
    <p style="font-size:12px;color:#64748b">This link is unique to this trip. If you do nothing, you stay at the included 50%.</p>
  `);
  const text = `50% AOG coverage is included.\n100% is available for ${fmtMoney(record.premium)}.\nThe premium is the only amount charged.\n\n${url}\n`;
  return { subject, html, text };
}

export function includedOnlyLetter(record) {
  const subject = `AOG coverage for trip ${record.tripId || record.tail || ''} — 50% included`.trim();
  const html = shell('50% AOG coverage is included', `
    <p>Your charter includes <strong>50%</strong> AOG mechanical recovery coverage at no charge.</p>
    <p>100% coverage is not available for this aircraft type until Skyway publishes a premium rate for it.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">${detailRows(record)}</table>
  `);
  const text = `50% AOG coverage is included for this trip. 100% coverage is not offered for this aircraft type.\n`;
  return { subject, html, text };
}

export function coveredLetter(record) {
  const subject = `You are covered at 100% AOG — trip ${record.tripId || record.tail || ''}`.trim();
  const html = shell('You are covered at 100%', `
    <p>This trip is recorded at <strong>100%</strong> AOG mechanical recovery coverage at no charge to you.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">${detailRows(record)}</table>
    <p style="font-size:12px;color:#64748b">Coverage level: ${escapeHtml(coverageLevelLabel(record.coverageLevel))}. Premium: complimentary.</p>
  `);
  const text = `You are covered at 100% AOG mechanical recovery coverage for this trip. Premium: complimentary.\n`;
  return { subject, html, text };
}

export function bindLetter(record, attachmentNotes) {
  const subject = `AOG coverage bind request — ${record.tripId || 'trip'} ${record.tail || ''}`.trim();
  const html = shell('Bind request', `
    <p>Please bind 100% AOG mechanical recovery coverage for the trip below.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">
      ${detailRows(record)}
      <tr><td style="padding:4px 12px 4px 0;color:#64748b">Who elected it</td><td>${escapeHtml(record.electedBy || '—')}</td></tr>
    </table>
    <p style="font-size:13px;color:#334155">${escapeHtml(attachmentNotes || '')}</p>
  `);
  const text = [
    'AOG coverage bind request',
    `Trip ID: ${record.tripId || '—'}`,
    `Tail: ${record.tail || '—'}`,
    `Aircraft: ${record.aircraftType || '—'}`,
    `Dates: ${record.datesLabel || '—'}`,
    `Route: ${record.route || '—'}`,
    `Trip total: ${fmtMoney(record.tripTotal)}`,
    `Coverage: ${coverageLevelLabel(record.coverageLevel)}`,
    `Premium: ${premiumLabel(record)}`,
    `Who elected it: ${record.electedBy || '—'}`,
    attachmentNotes || '',
  ].join('\n');
  return { subject, html, text };
}

export function brokerPaidLetter(record) {
  const subject = `AOG coverage confirmed — trip ${record.tripId || record.tail || ''}`.trim();
  const html = shell('100% coverage is confirmed', `
    <p>Payment of the premium was received. This trip is covered at <strong>100%</strong>. The amount paid was the premium only.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">${detailRows(record)}</table>
  `);
  const text = `Your 100% AOG coverage is confirmed. Premium paid: ${fmtMoney(record.premium)}. The trip total was not charged.\n`;
  return { subject, html, text };
}

async function sendViaResend({ to, cc, subject, html, attachments }) {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY missing' };
  const body = {
    from: process.env.OPS_FROM_EMAIL || 'Skyway Ops <noreply@send.flyskyway.com>',
    reply_to: process.env.OPS_REPLY_TO || 'charters@flyskyway.com',
    to,
    subject: String(subject || '').slice(0, 250),
    html,
  };
  if (cc?.length) body.cc = cc;
  if (attachments?.length) {
    body.attachments = attachments.map((file) => ({
      filename: file.filename,
      content: Buffer.isBuffer(file.content) ? file.content.toString('base64') : String(file.content),
    }));
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    return { ok: false, error: `Resend ${response.status}: ${detail.slice(0, 180)}` };
  }
  return { ok: true };
}

async function sendViaGraph({ to, cc, subject, html, attachments }) {
  if (!to.length) return { ok: false, error: 'no graph recipients' };
  if (!isSharedMailConfigured()) return { ok: false, error: 'Microsoft Graph mail is not configured' };
  await graphRequest(`/users/${encodeURIComponent(mailboxUpn())}/sendMail`, {
    method: 'POST',
    body: JSON.stringify({
      message: {
        subject: String(subject || '').slice(0, 255),
        body: { contentType: 'HTML', content: html },
        toRecipients: to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: (cc || []).map((address) => ({ emailAddress: { address } })),
        attachments: (attachments || []).map((file) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: file.filename,
          contentType: file.contentType || 'application/pdf',
          contentBytes: Buffer.isBuffer(file.content) ? file.content.toString('base64') : String(file.content),
        })),
      },
      saveToSentItems: false,
    }),
  });
  return { ok: true };
}

function splitAddresses(addresses) {
  const internal = [];
  const external = [];
  for (const address of addresses) {
    if (isInternalAddress(address)) internal.push(address);
    else external.push(address);
  }
  return { internal, external };
}

/**
 * Every AOG recovery email goes through the test-mode switch first.
 * Attachments are delivered on both the Graph (tenant) and Resend (everyone
 * else) copies. Without attachments, the shared transport does the split.
 */
export async function sendRecoveryEmail({ to, cc, bcc, subject, text, html, attachments }) {
  const safe = applyNotifyTestMode({ to, cc, bcc, subject, text, html });
  const files = (Array.isArray(attachments) ? attachments : []).filter((file) => file?.filename && file?.content);
  if (files.length === 0) {
    const result = await deliverNotification({
      to: safe.to,
      cc: safe.cc,
      subject: safe.subject,
      html: safe.html || `<pre>${escapeHtml(safe.text)}</pre>`,
    });
    return { ok: Boolean(result.ok), error: result.error || null, testMode: safe.testMode, intended: safe.intended };
  }

  const toSplit = splitAddresses(safe.to);
  const ccSplit = splitAddresses(safe.cc);
  const errors = [];
  const jobs = [];
  const externalTo = toSplit.external.length ? toSplit.external : ccSplit.external;
  const externalCc = toSplit.external.length ? ccSplit.external : [];
  if (externalTo.length) jobs.push(sendViaResend({ to: externalTo, cc: externalCc, subject: safe.subject, html: safe.html, attachments: files }));
  const internalTo = toSplit.internal.length ? toSplit.internal : ccSplit.internal;
  const internalCc = toSplit.internal.length ? ccSplit.internal : [];
  if (internalTo.length) {
    jobs.push(sendViaGraph({ to: internalTo, cc: internalCc, subject: safe.subject, html: safe.html, attachments: files })
      .catch(async (err) => {
        const fallback = await sendViaResend({ to: internalTo, cc: internalCc, subject: safe.subject, html: safe.html, attachments: files });
        if (fallback.ok) return fallback;
        return { ok: false, error: err.message || fallback.error };
      }));
  }
  const results = await Promise.all(jobs);
  for (const result of results) if (!result.ok) errors.push(result.error || 'send failed');
  return {
    ok: errors.length === 0 && jobs.length > 0,
    error: errors.join('; ') || (jobs.length ? null : 'no recipients'),
    testMode: safe.testMode,
    intended: safe.intended,
  };
}

export async function savePdf(path, buffer) {
  await storageBucket().file(path).save(buffer, {
    resumable: false,
    contentType: 'application/pdf',
    metadata: { contentType: 'application/pdf', cacheControl: 'private, max-age=0' },
  });
}

function storageDownloadUrl(path, token) {
  const bucket = process.env.FIREBASE_STORAGE_BUCKET || BUCKET_FALLBACK;
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

async function saveContractPdf(path, buffer) {
  const token = crypto.randomUUID();
  await storageBucket().file(path).save(buffer, {
    resumable: false,
    contentType: 'application/pdf',
    metadata: {
      contentType: 'application/pdf',
      cacheControl: 'private, max-age=3600',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return storageDownloadUrl(path, token);
}

async function legsSharingTripCode(db, matches) {
  const byId = new Map((matches || []).filter((leg) => leg?.id).map((leg) => [leg.id, leg]));
  const codes = [...new Set([...byId.values()].map((leg) => leg.tripCode).filter(Boolean))];
  for (const code of codes) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection('trip-state').where('tripSheetData.tripCode', '==', code).limit(30).get();
    snap.docs.forEach((docSnap) => {
      if (!byId.has(docSnap.id)) byId.set(docSnap.id, tripFromState(docSnap));
    });
  }
  return [...byId.values()];
}

async function currentContract(db, legs) {
  for (const leg of legs) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection('trip-state').doc(sanitizeKey(leg.id)).get();
    const contract = snap.exists ? snap.data()?.charterContract : null;
    if (contract?.fingerprint) return contract;
  }
  return null;
}

/**
 * Write one charter PDF onto every leg. The same bytes are not uploaded again.
 * A different PDF replaces the current object and copies the previous file
 * under versions/ before the overwrite.
 */
export async function writeCharterContract(db, { legs, pdfBuffer, filename, source, tripKey }) {
  const targets = (legs || []).filter((leg) => leg?.id);
  if (!targets.length || !pdfBuffer?.length) {
    return { contractAttachStatus: 'unmatched', contractLegIds: [] };
  }
  const fingerprint = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const key = tripKey || targets.find((leg) => leg.tripCode)?.tripCode || targets[0].id;
  const path = contractStoragePath(key);
  const attachedAt = new Date().toISOString();
  const existing = await currentContract(db, targets);
  const versionPath = existing?.fingerprint ? contractVersionPath(key, existing.fingerprint) : '';
  const plan = planContractWrite({
    existing,
    versionPath,
    incoming: {
      fingerprint,
      filename: filename || 'charter-contract.pdf',
      path,
      sizeBytes: pdfBuffer.length,
      source,
      attachedAt,
    },
  });

  let contract = plan.contract;
  if (plan.action === 'replaced' && existing?.path && versionPath && existing.path !== versionPath) {
    try {
      await storageBucket().file(existing.path).copy(storageBucket().file(versionPath));
    } catch (err) {
      console.warn('[aog-recovery] previous charter contract was not copied:', err.message);
      const versions = contract.versions || [];
      const last = versions[versions.length - 1];
      if (last) {
        last.preserved = false;
        last.path = '';
      }
    }
  }
  if (plan.action !== 'unchanged') {
    const url = await saveContractPdf(path, pdfBuffer);
    contract = { ...contract, url, path };
  }

  await Promise.all(targets.map((leg) => db.collection('trip-state').doc(sanitizeKey(leg.id)).set({
    charterContract: contract,
    updatedAt: Date.now(),
  }, { merge: true })));

  return {
    contractAttachStatus: plan.action === 'skip' ? 'unmatched' : plan.action,
    contractLegIds: targets.map((leg) => leg.id),
    contractFingerprint: fingerprint,
  };
}

export async function attachCheckoutContract(db, { parsed, trips, pdfBuffer, filename, source }) {
  if (!shouldAttachCharterContract({ isCheckout: true, hasPdf: Boolean(pdfBuffer?.length) })) {
    return { contractAttachStatus: '' };
  }
  const match = matchContractToTrips(parsed, trips);
  if (match.status !== 'linked') {
    return {
      contractAttachStatus: 'unmatched',
      contractLegIds: [],
      contractCandidateTripUids: (match.matches || []).map((trip) => trip.id).filter(Boolean),
      contractAmbiguous: match.ambiguous === true,
    };
  }
  let legs = match.matches;
  try {
    legs = await legsSharingTripCode(db, match.matches);
  } catch (err) {
    console.warn('[aog-recovery] sibling leg lookup skipped:', err.message);
  }
  const tripKey = legs.find((leg) => leg.tripCode)?.tripCode || parsed?.tripId || legs[0].id;
  return writeCharterContract(db, { legs, pdfBuffer, filename, source, tripKey });
}

export async function resolveTripLegs(db, tripUid) {
  const raw = String(tripUid || '').trim();
  if (!raw) return [];
  const found = new Map();
  const add = (docSnap) => {
    if (docSnap?.exists) found.set(docSnap.id, tripFromState(docSnap));
  };
  add(await db.collection('trip-state').doc(sanitizeKey(raw)).get());
  const pullCode = async (code) => {
    const snap = await db.collection('trip-state').where('tripSheetData.tripCode', '==', code).limit(30).get();
    snap.docs.forEach(add);
  };
  try {
    await pullCode(raw);
    const codes = [...new Set([...found.values()].map((leg) => leg.tripCode).filter(Boolean))];
    for (const code of codes) {
      if (code === raw) continue;
      // eslint-disable-next-line no-await-in-loop
      await pullCode(code);
    }
  } catch (err) {
    console.warn('[aog-recovery] trip lookup skipped:', err.message);
  }
  return [...found.values()];
}

export async function readPdf(path) {
  const [buffer] = await storageBucket().file(path).download();
  return buffer;
}

const GRAPH_ATTACHMENT_LIMIT = 3_000_000;

export async function pdfAttachment(path, filename) {
  if (!path) return { file: null, note: '' };
  try {
    const buffer = await readPdf(path);
    if (buffer.length > GRAPH_ATTACHMENT_LIMIT) {
      return { file: null, note: `${filename} is on file in Skyway but was too large to attach.` };
    }
    return { file: { filename, content: buffer, contentType: 'application/pdf' }, note: '' };
  } catch (err) {
    return { file: null, note: `${filename} could not be attached (${err.message}).` };
  }
}

export function publicCoverageView(record) {
  const payable = record.upgradeAvailable === true
    && record.coverageLevel === 'included_50'
    && record.paymentStatus !== 'paid';
  return {
    tripId: record.tripId || '',
    brokerCompany: record.brokerCompany || '',
    tail: record.tail || '',
    aircraftType: record.aircraftType || '',
    route: record.route || '',
    datesLabel: record.datesLabel || '',
    departDate: record.departDate || '',
    returnDate: record.returnDate || '',
    tripTotal: record.tripTotal ?? null,
    premium: record.premium ?? null,
    ratePercent: record.ratePercent ?? null,
    coverageLevel: record.coverageLevel || 'included_50',
    coverageLabel: coverageLevelLabel(record.coverageLevel),
    paymentStatus: record.paymentStatus || '',
    upgradeAvailable: payable,
    signed: Boolean(record.signedAt),
    signedName: record.signedName || '',
    termsVersion: AOG_COVERAGE_TERMS_VERSION,
    termsText: AOG_COVERAGE_TERMS_TEXT,
    needsReview: record.needsReview === true,
  };
}

export function serializeCoverage(id, data = {}) {
  return {
    id,
    source: data.source || '',
    tripId: data.tripId || '',
    brokerCompany: data.brokerCompany || '',
    checkoutEmail: data.checkoutEmail || '',
    tail: data.tail || '',
    aircraftType: data.aircraftType || '',
    route: data.route || '',
    routeFrom: data.routeFrom || '',
    routeTo: data.routeTo || '',
    departDate: data.departDate || '',
    returnDate: data.returnDate || '',
    datesLabel: data.datesLabel || '',
    itinerary: data.itinerary || '',
    tripTotal: data.tripTotal ?? null,
    coverageLevel: data.coverageLevel || 'included_50',
    premium: data.premium ?? null,
    premiumCents: data.premiumCents ?? null,
    ratePercent: data.ratePercent ?? null,
    paymentStatus: data.paymentStatus || '',
    upgradeAvailable: data.upgradeAvailable === true,
    upgradeBlockReason: data.upgradeBlockReason || '',
    stripeReference: data.stripeReference || '',
    electedBy: data.electedBy || '',
    uncertainFields: data.uncertainFields || [],
    parserNotes: data.parserNotes || [],
    needsReview: data.needsReview === true,
    matchStatus: data.matchStatus || 'unmatched',
    matchAmbiguous: data.matchAmbiguous === true,
    linkedTripUid: data.linkedTripUid || '',
    linkedTripUids: data.linkedTripUids || [],
    electionContractPath: data.electionContractPath || '',
    charterContractPath: data.charterContractPath || '',
    charterContractFilename: data.charterContractFilename || '',
    offerSentAt: data.offerSentAt || '',
    includedNoticeSentAt: data.includedNoticeSentAt || '',
    coveredNoticeSentAt: data.coveredNoticeSentAt || '',
    bindEmailSentAt: data.bindEmailSentAt || '',
    brokerConfirmSentAt: data.brokerConfirmSentAt || '',
    signedAt: data.signedAt || '',
    signedName: data.signedName || '',
    emailError: data.emailError || '',
    createdAt: data.createdAt || '',
    updatedAt: data.updatedAt || '',
    parserVersion: data.parserVersion || '',
    graphMessageId: data.graphMessageId || '',
    addedBy: data.addedBy || '',
    contractAttachStatus: data.contractAttachStatus || '',
    contractLegIds: data.contractLegIds || [],
    contractFingerprint: data.contractFingerprint || '',
    contractCandidateTripUids: data.contractCandidateTripUids || [],
    contractAmbiguous: data.contractAmbiguous === true,
    contractSource: data.contractSource || null,
    contractAttachError: data.contractAttachError || '',
  };
}

export async function findByToken(db, token) {
  const hash = hashOfferToken(token);
  if (!hash) return null;
  const snap = await db.collection(COLLECTION).where('offerTokenHash', '==', hash).limit(1).get();
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { id: docSnap.id, ref: docSnap.ref, data: docSnap.data() || {} };
}

async function sendLetter(record, letter, extra = {}) {
  return sendRecoveryEmail({ ...letter, ...extra });
}

export async function dispatchCoverageEmails(db, id, record, { baseUrl, force = false } = {}) {
  const ref = db.collection(COLLECTION).doc(id);
  const patch = { updatedAt: new Date().toISOString() };
  const errors = [];
  const emails = record.emailsToSend || [];

  if (emails.includes('broker_offer') && record.checkoutEmail && (force || !record.offerSentAt)) {
    const token = newOfferToken();
    const url = `${baseUrl}/aog-coverage?token=${encodeURIComponent(token)}`;
    const letter = offerLetter(record, url);
    const sent = await sendLetter(record, letter, { to: record.checkoutEmail });
    if (sent.ok) {
      patch.offerTokenHash = hashOfferToken(token);
      patch.offerSentAt = new Date().toISOString();
      patch.paymentStatus = 'offer_pending';
    } else errors.push(sent.error || 'offer email failed');
  }

  if (emails.includes('broker_included_only') && record.checkoutEmail && (force || !record.includedNoticeSentAt)) {
    const sent = await sendLetter(record, includedOnlyLetter(record), { to: record.checkoutEmail });
    if (sent.ok) patch.includedNoticeSentAt = new Date().toISOString();
    else errors.push(sent.error || 'included notice failed');
  }

  if (emails.includes('broker_covered') && record.checkoutEmail && (force || !record.coveredNoticeSentAt)) {
    const sent = await sendLetter(record, coveredLetter(record), { to: record.checkoutEmail });
    if (sent.ok) patch.coveredNoticeSentAt = new Date().toISOString();
    else errors.push(sent.error || 'covered notice failed');
  }

  if (emails.includes('cfs_bind') && (force || !record.bindEmailSentAt)) {
    const election = await pdfAttachment(record.electionContractPath, 'aog-election.pdf');
    const charter = await pdfAttachment(record.charterContractPath, record.charterContractFilename || 'charter-contract.pdf');
    const notes = [election.note, charter.note].filter(Boolean);
    if (!record.electionContractPath) notes.push('Signed election contract: not signed (complimentary or gifted by Skyway).');
    if (!record.charterContractPath) notes.push('Charter contract: not on file.');
    const letter = bindLetter(record, notes.join(' '));
    const sent = await sendRecoveryEmail({
      to: CFS_BIND_TO,
      cc: CFS_BIND_CC,
      subject: letter.subject,
      html: letter.html,
      text: letter.text,
      attachments: [election.file, charter.file].filter(Boolean),
    });
    if (sent.ok) patch.bindEmailSentAt = new Date().toISOString();
    else errors.push(sent.error || 'bind email failed');
  }

  if (emails.includes('broker_paid') && record.checkoutEmail && (force || !record.brokerConfirmSentAt)) {
    const sent = await sendLetter(record, brokerPaidLetter(record), { to: record.checkoutEmail });
    if (sent.ok) patch.brokerConfirmSentAt = new Date().toISOString();
    else errors.push(sent.error || 'broker confirmation failed');
  }

  patch.emailError = errors.join('; ');
  await ref.set(patch, { merge: true });
  return { ok: errors.length === 0, error: patch.emailError, patch };
}

export async function ingestParsedCheckout(db, { messageId, parsed, pdfBuffer, pdfFilename, settings, baseUrl, source }) {
  if (!parsed?.isCheckout) {
    return { outcome: 'skipped', skipReason: parsed?.skipReason || 'not a checkout' };
  }
  const id = coverageIdForMessage(messageId);
  const ref = db.collection(COLLECTION).doc(id);
  const existing = await ref.get();
  if (existing.exists && existing.data()?.offerSentAt) {
    return { outcome: 'duplicate', coverageId: id };
  }
  if (existing.exists && existing.data()?.bindEmailSentAt && existing.data()?.coverageLevel !== 'included_50') {
    return { outcome: 'duplicate', coverageId: id };
  }

  const trips = await loadTripCandidates(db, parsed);
  const match = matchCoverageToTrips(parsed, trips);
  const draft = buildCoverageDraft({ parsed, settings, match, messageId });
  const now = new Date().toISOString();
  const record = {
    ...draft,
    createdAt: existing.exists ? (existing.data().createdAt || now) : now,
    updatedAt: now,
  };

  const contractSource = source || {
    messageId: messageId || '',
    receivedAt: '',
    sender: parsed?.checkoutEmail || '',
  };
  record.contractSource = contractSource;
  if (pdfBuffer?.length) {
    const path = `aog-recovery/${id}/charter-contract.pdf`;
    await savePdf(path, pdfBuffer);
    record.charterContractPath = path;
    record.charterContractFilename = pdfFilename || 'charter-contract.pdf';
    try {
      const attached = await attachCheckoutContract(db, {
        parsed,
        trips,
        pdfBuffer,
        filename: record.charterContractFilename,
        source: contractSource,
      });
      record.contractAttachStatus = attached.contractAttachStatus || '';
      record.contractLegIds = attached.contractLegIds || [];
      record.contractFingerprint = attached.contractFingerprint || '';
      record.contractCandidateTripUids = attached.contractCandidateTripUids || [];
      record.contractAmbiguous = attached.contractAmbiguous === true;
    } catch (err) {
      console.error('[aog-recovery] charter contract was not attached to the trip', err.message);
      record.contractAttachStatus = 'error';
      record.contractAttachError = String(err.message || err).slice(0, 300);
    }
  }

  await ref.set(record, { merge: true });
  await dispatchCoverageEmails(db, id, record, { baseUrl });
  return { outcome: 'recorded', coverageId: id, needsReview: record.needsReview };
}

export async function markMessageProcessed(db, messageId, outcome) {
  await db.collection(PROCESSED).doc(processedDocId(messageId)).set({
    messageId: String(messageId).slice(0, 400),
    ...outcome,
    processedAt: new Date().toISOString(),
  }, { merge: true });
}

export async function messageAlreadyProcessed(db, messageId) {
  const snap = await db.collection(PROCESSED).doc(processedDocId(messageId)).get();
  if (!snap.exists) return false;
  return snap.data()?.outcome === 'recorded' || snap.data()?.outcome === 'skipped' || snap.data()?.outcome === 'duplicate';
}

export function knownAircraftNames(settings) {
  const names = [];
  for (const row of settings?.rates || DEFAULT_RATES) {
    names.push(row.aircraftType, ...(row.aliases || []));
  }
  return names;
}

export async function applySignature(db, recordRef, record, { fullName, agreed, ip, userAgent }) {
  if (agreed !== true) {
    const error = new Error('Check the agreement box to elect coverage');
    error.status = 400;
    throw error;
  }
  if (record.coverageLevel !== 'included_50' || record.upgradeAvailable !== true) {
    const error = new Error('This trip is not open for a paid upgrade');
    error.status = 400;
    throw error;
  }
  if (record.paymentStatus === 'paid') {
    const error = new Error('This coverage is already paid');
    error.status = 409;
    throw error;
  }
  const name = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (name.length < 5 || !name.includes(' ')) {
    const error = new Error('Type your first and last name');
    error.status = 400;
    throw error;
  }
  const signedAt = new Date().toISOString();
  const signature = {
    fullName: name,
    agreed: true,
    signedAt,
    ip: String(ip || '').slice(0, 80),
    userAgent: String(userAgent || '').slice(0, 300),
    termsVersion: AOG_COVERAGE_TERMS_VERSION,
    premium: record.premium,
  };
  const pdf = await renderElectionPdf({ record: { ...record, id: recordRef.id }, signature });
  const path = `aog-recovery/${recordRef.id}/aog-election.pdf`;
  await savePdf(path, pdf);
  await recordRef.set({
    signedName: name,
    signedAt,
    signedIp: signature.ip,
    signedUserAgent: signature.userAgent,
    termsVersion: AOG_COVERAGE_TERMS_VERSION,
    electionContractPath: path,
    updatedAt: signedAt,
  }, { merge: true });
  return { signedAt, path };
}

export async function recomputeOffer(record, settings) {
  const quote = quotePremium({
    aircraftType: record.aircraftType,
    tripTotal: record.tripTotal,
    rates: settings.rates,
  });
  if (!quote.eligible) {
    return {
      upgradeAvailable: false,
      premium: null,
      premiumCents: null,
      ratePercent: null,
      paymentStatus: quote.reason === 'no_rate' ? 'unavailable' : 'not_required',
      upgradeBlockReason: quote.reason,
      aircraftType: record.aircraftType,
    };
  }
  return {
    upgradeAvailable: true,
    premium: quote.premium,
    premiumCents: quote.premiumCents,
    ratePercent: quote.ratePercent,
    paymentStatus: record.offerSentAt ? 'offer_pending' : 'not_required',
    upgradeBlockReason: '',
    aircraftType: quote.aircraftType,
    coverageLevel: 'included_50',
  };
}

export function assertMutable(record) {
  if (record.paymentStatus === 'paid' || record.coverageLevel === 'purchased_100') {
    const error = new Error('Paid coverage can no longer be edited');
    error.status = 409;
    throw error;
  }
}

export { COLLECTION, PROCESSED, classifyCheckout };
