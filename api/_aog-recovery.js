// Server-side AOG recovery coverage: Firestore, mailbox ingest, election
// storage, and the emails that must pass through the notify test-mode switch.
// Card charges go through api/_aog-stripe.js. This file never sees card data.

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import admin from 'firebase-admin';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { applyNotifyTestMode } from './_notify-test-mode.js';
import { deliverNotification, isInternalAddress } from './_email-transport.js';
import { graphRequest, isSharedMailConfigured, mailboxUpn } from './_charter-mail.js';
import { extractUncompressedPdfText, parseCheckoutEmail } from './_aog-checkout-parser.js';
import { renderElectionPdf } from './_aog-election-pdf.js';
import {
  AOG_COVERAGE_TERMS_TEXT,
  AOG_COVERAGE_TERMS_VERSION,
} from '../src/aog-recovery-terms.js';
import {
  ACK_TOKEN_TTL_MS,
  OPS_ACK_TO,
  ackTokenUsable,
  bindLetterContent,
  cfsBrokerLetter,
  cfsOpsLetter,
  coverageValueText,
  legStamp,
  planCfsAcknowledgement,
  publicCfsView,
} from '../src/aog-cfs.js';
import {
  CFS_BIND_CC,
  CFS_BIND_TO,
  DEFAULT_RATES,
  buildCoverageDraft,
  classifyCheckout,
  coverageLevelLabel,
  domainRecordsFromList,
  fmtMoney,
  isComplimentaryDomain,
  matchCoverageToTrips,
  normalizeRateTable,
  premiumLabel,
  quotePremium,
  readDomainRecords,
  cfsStaffFromList,
  readCfsStaff,
} from '../src/aog-recovery.js';
import { buildTripRows, nyDay, rowsEligibleForComplimentary } from '../src/aog-trip-rows.js';
import { normalizeTripId } from '../src/trip-id.js';
import {
  brokerBackfillDetail,
  brokerMismatchDetail,
  planBrokerBackfill,
} from '../src/broker-backfill.js';
import {
  contractStoragePath,
  contractVersionPath,
  matchContractToTrips,
  planContractWrite,
  shouldAttachCharterContract,
} from '../src/charter-contract.js';
import { comparisonHtml, comparisonText } from '../src/aog-offer-copy.js';
import { coverageEvent, coverageLimitCentsFor, coverageTierCents, dollarsFromCents, isHundredCoverage, multiplierOr, reportingFacts, requireCoverageMultiplier, tripTotalCentsOf, DEFAULT_INCLUDED_MULTIPLIER, DEFAULT_UPGRADE_MULTIPLIER } from '../src/aog-reporting.js';

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
  const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw && usingEmulator) {
    appSingleton = admin.initializeApp({
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'skyway-ops-app',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || BUCKET_FALLBACK,
    });
    return appSingleton;
  }
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

function localStorageRoot() {
  return process.env.AOG_LOCAL_STORAGE || '';
}

async function writeLocal(storagePath, buffer) {
  const full = path.join(localStorageRoot(), storagePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
}

async function readLocal(storagePath) {
  return fs.readFile(path.join(localStorageRoot(), storagePath));
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
    const checkRevoked = !process.env.FIREBASE_AUTH_EMULATOR_HOST;
    decoded = await admin.auth(getAdmin()).verifyIdToken(idToken, checkRevoked);
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

export function asUtc(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  return '';
}

/** Reporting fields plus the dollar copies the current screens already read. */
export function reportingPatch(input = {}) {
  const facts = reportingFacts({
    ...input,
    departAtUtc: input.departAtUtc || asUtc(input.departAt) || input.departDate,
    returnAtUtc: input.returnAtUtc || asUtc(input.returnAt) || input.returnDate,
  });
  const now = new Date();
  const createdRaw = input.createdAt?.toDate ? input.createdAt.toDate() : (input.createdAt ? new Date(input.createdAt) : now);
  const created = createdRaw instanceof Date && !Number.isNaN(createdRaw.getTime()) ? createdRaw : now;
  return {
    ...facts,
    tripTotal: dollarsFromCents(facts.tripTotalCents),
    premium: dollarsFromCents(facts.premiumCents),
    checkoutEmail: facts.brokerEmail || input.checkoutEmail || '',
    routeFrom: facts.origin || input.routeFrom || '',
    routeTo: facts.destination || input.routeTo || '',
    departAt: facts.departAtUtc ? Timestamp.fromDate(new Date(facts.departAtUtc)) : null,
    returnAt: facts.returnAtUtc ? Timestamp.fromDate(new Date(facts.returnAtUtc)) : null,
    createdAt: Timestamp.fromDate(created),
    createdAtUtc: created.toISOString(),
    updatedAt: Timestamp.fromDate(now),
    updatedAtUtc: now.toISOString(),
  };
}

export function charterContractDataPatch(input = {}) {
  const facts = reportingFacts(input);
  const receivedAtUtc = asUtc(input.receivedAt) || asUtc(input.source?.receivedAt) || '';
  return {
    currency: facts.currency,
    tripTotalCents: facts.tripTotalCents,
    tripId: facts.tripId,
    brokerCompany: facts.brokerCompany,
    brokerEmail: facts.brokerEmail,
    brokerDomain: facts.brokerDomain,
    aircraftType: facts.aircraftType,
    tail: facts.tail,
    origin: facts.origin,
    destination: facts.destination,
    legCount: facts.legCount,
    departAt: facts.departAtUtc ? Timestamp.fromDate(new Date(facts.departAtUtc)) : null,
    departAtUtc: facts.departAtUtc,
    returnAt: facts.returnAtUtc ? Timestamp.fromDate(new Date(facts.returnAtUtc)) : null,
    returnAtUtc: facts.returnAtUtc,
    receivedAt: receivedAtUtc ? Timestamp.fromDate(new Date(receivedAtUtc)) : null,
    receivedAtUtc,
  };
}

/** Create-only. A second call with the same event id does not rewrite history. */
export async function appendCoverageEvent(db, coverageId, input) {
  const event = coverageEvent({ ...input, atUtc: input.atUtc || new Date().toISOString() });
  const ref = db.collection(COLLECTION).doc(String(coverageId)).collection('coverageEvents').doc(event.id);
  try {
    await ref.create({
      ...event,
      coverageId: String(coverageId),
      at: Timestamp.fromDate(new Date(event.atUtc)),
    });
    return { appended: true, id: event.id };
  } catch (err) {
    const already = err?.code === 6 || err?.code === 'already-exists' || /already exists/i.test(String(err?.message || ''));
    if (already) return { appended: false, id: event.id };
    throw err;
  }
}

export async function loadSettings(db = recoveryDb()) {
  const snap = await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).get();
  const data = snap.exists ? snap.data() || {} : {};
  const domainRecords = readDomainRecords(data);
  return {
    rates: Array.isArray(data.rates) && data.rates.length ? data.rates : DEFAULT_RATES.map((row) => ({ ...row })),
    complimentaryDomains: domainRecords.map((row) => row.domain),
    domainRecords,
    includedMultiplier: multiplierOr(data.includedMultiplier, DEFAULT_INCLUDED_MULTIPLIER),
    upgradeMultiplier: multiplierOr(data.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER),
    cfsStaff: readCfsStaff(data),
    updatedAt: data.updatedAt || '',
    updatedBy: data.updatedBy || '',
  };
}

export async function saveSettings(db, {
  rates,
  complimentaryDomains,
  complimentaryDomainRecords,
  includedMultiplier,
  upgradeMultiplier,
  cfsStaff,
  actor,
} = {}) {
  const existing = await loadSettings(db);
  const now = new Date().toISOString();
  const domainInput = complimentaryDomainRecords || complimentaryDomains;
  const domainRecords = domainInput
    ? domainRecordsFromList(domainInput, {
      previous: existing.domainRecords,
      actorEmail: actor?.email || '',
      now,
    })
    : existing.domainRecords;
  const next = {
    rates: rates ? normalizeRateTable(rates) : existing.rates,
    complimentaryDomains: domainRecords.map((row) => row.domain),
    complimentaryDomainRecords: domainRecords,
    includedMultiplier: includedMultiplier == null
      ? existing.includedMultiplier
      : requireCoverageMultiplier(includedMultiplier, '50% multiplier'),
    upgradeMultiplier: upgradeMultiplier == null
      ? existing.upgradeMultiplier
      : requireCoverageMultiplier(upgradeMultiplier, '100% multiplier'),
    cfsStaff: cfsStaff == null
      ? existing.cfsStaff
      : cfsStaffFromList(cfsStaff, { previous: existing.cfsStaff, actorEmail: actor?.email || '', now }),
    updatedAt: now,
    updatedBy: actor?.email || '',
  };
  await db.collection(CONFIG_DOC[0]).doc(CONFIG_DOC[1]).set(next, { merge: true });
  return { ...next, domainRecords };
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
    tripCode: normalizeTripId(sheet.tripCode),
    customer: sheet.client || data.brokerCompany || data.customer || '',
    brokerEmail: data.brokerEmail || '',
    brokerPhone: data.brokerPhone || '',
    brokerCompany: data.brokerCompany || sheet.client || '',
    brokerDomain: data.brokerDomain || '',
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
    ['Coverage', isHundredCoverage(record.coverageLevel) ? '100%' : '50% included'],
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

function brokerLetterBody(record, intro, url) {
  const compare = comparisonText(record);
  const html = `
    <p>${intro}</p>
    ${comparisonHtml(record)}
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">${detailRows(record)}</table>
    ${url ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px">Review and elect 100% coverage</a></p>` : ''}
  `;
  return { html, text: `${intro}\n${compare}\n${url || ''}`.trim() };
}

export function offerLetter(record, url) {
  const subject = `AOG coverage for trip ${record.tripId || record.tail || ''}`.trim();
  const body = brokerLetterBody(
    record,
    '50% AOG recovery coverage is included with the charter at no charge. 100% is the upgrade. The premium is the only amount charged. The trip itself is not charged.',
    url,
  );
  const html = shell('50% is included. 100% is available.', `${body.html}<p style="font-size:12px;color:#64748b">This link is unique to this trip. If you do nothing, you stay at the included 50%.</p>`);
  return { subject, html, text: body.text };
}

export function includedOnlyLetter(record) {
  const subject = `AOG coverage for trip ${record.tripId || record.tail || ''} — 50% included`.trim();
  const body = brokerLetterBody(
    record,
    '50% AOG recovery coverage is included with the charter at no charge. 100% is not offered for this aircraft until a premium rate is published.',
    '',
  );
  return { subject, html: shell('50% AOG coverage is included', body.html), text: body.text };
}

export function coveredLetter(record) {
  const subject = `You are covered at 100% AOG — trip ${record.tripId || record.tail || ''}`.trim();
  const body = brokerLetterBody(
    record,
    'This trip is covered at 100% AOG recovery. 50% is what the charter includes. There is no premium to pay.',
    '',
  );
  return { subject, html: shell('You are covered at 100%', body.html), text: body.text };
}

export function bindLetter(record, attachmentNotes, ackUrl) {
  return bindLetterContent(record, { ackUrl, attachmentNotes });
}

export function brokerPaidLetter(record) {
  const subject = `AOG coverage confirmed — trip ${record.tripId || record.tail || ''}`.trim();
  const body = brokerLetterBody(
    record,
    `Payment of the premium was received. This trip is covered at 100%. Premium paid: ${fmtMoney(record.premium)}. The trip total was not charged.`,
    '',
  );
  return { subject, html: shell('100% coverage is confirmed', body.html), text: body.text };
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

export async function savePdf(storagePath, buffer) {
  if (localStorageRoot()) {
    await writeLocal(storagePath, buffer);
    return;
  }
  await storageBucket().file(storagePath).save(buffer, {
    resumable: false,
    contentType: 'application/pdf',
    metadata: { contentType: 'application/pdf', cacheControl: 'private, max-age=0' },
  });
}

function storageDownloadUrl(path, token) {
  const bucket = process.env.FIREBASE_STORAGE_BUCKET || BUCKET_FALLBACK;
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

async function saveContractPdf(storagePath, buffer) {
  if (localStorageRoot()) {
    await writeLocal(storagePath, buffer);
    return `local://${encodeURIComponent(storagePath)}`;
  }
  const token = crypto.randomUUID();
  await storageBucket().file(storagePath).save(buffer, {
    resumable: false,
    contentType: 'application/pdf',
    metadata: {
      contentType: 'application/pdf',
      cacheControl: 'private, max-age=3600',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return storageDownloadUrl(storagePath, token);
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
export async function writeCharterContract(db, { legs, pdfBuffer, filename, source, tripKey, facts }) {
  const targets = (legs || []).filter((leg) => leg?.id);
  if (!targets.length || !pdfBuffer?.length) {
    return { contractAttachStatus: 'unmatched', contractLegIds: [] };
  }
  const fingerprint = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const key = normalizeTripId(tripKey) || normalizeTripId(targets.find((leg) => leg.tripCode)?.tripCode) || 'unkeyed';
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
      if (localStorageRoot()) await writeLocal(versionPath, await readLocal(existing.path));
      else await storageBucket().file(existing.path).copy(storageBucket().file(versionPath));
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

  const charterContractData = charterContractDataPatch({
    ...(facts || {}),
    legCount: facts?.legCount || targets.length,
    source,
    receivedAt: source?.receivedAt,
  });
  await Promise.all(targets.map((leg) => db.collection('trip-state').doc(sanitizeKey(leg.id)).set({
    charterContract: contract,
    charterContractData,
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
  const tripKey = normalizeTripId(legs.find((leg) => leg.tripCode)?.tripCode) || normalizeTripId(parsed?.tripId);
  return writeCharterContract(db, {
    legs,
    pdfBuffer,
    filename,
    source,
    tripKey,
    facts: { ...parsed, legCount: legs.length },
  });
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

export async function readPdf(storagePath) {
  if (localStorageRoot()) return readLocal(storagePath);
  const [buffer] = await storageBucket().file(storagePath).download();
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
  const tiers = coverageTierCents(record);
  const includedValueLabel = Number.isInteger(tiers.includedCents) ? `up to ${fmtMoney(tiers.includedCents / 100)}` : '';
  const upgradeValueLabel = Number.isInteger(tiers.upgradeCents) ? `up to ${fmtMoney(tiers.upgradeCents / 100)}` : '';
  const premiumLabelText = fmtMoney(record.premium);
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
    includedMultiplier: tiers.includedMultiplier,
    upgradeMultiplier: tiers.upgradeMultiplier,
    includedValueLabel,
    upgradeValueLabel,
    includedLine: includedValueLabel ? `Included: 50%, ${includedValueLabel}` : 'Included: 50%',
    upgradeLine: payable
      ? `Upgrade: 100%, ${upgradeValueLabel}, premium ${premiumLabelText}`
      : (isHundredCoverage(record.coverageLevel)
        ? `Upgrade: 100%, ${upgradeValueLabel}, premium ${premiumLabelText}`
        : 'Upgrade: 100% is not offered for this aircraft'),
    coverageValueLabel: upgradeValueLabel,
    premium: record.premium ?? null,
    ratePercent: record.ratePercent ?? null,
    coverageLevel: record.coverageLevel || 'included_50',
    coverageLabel: isHundredCoverage(record.coverageLevel) ? '100%' : '50% included',
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
  const coverageLimitCents = Number.isInteger(data.coverageLimitCents)
    ? data.coverageLimitCents
    : coverageLimitCentsFor(tripTotalCentsOf(data), data.coverageLevel, {
      includedMultiplier: data.includedMultiplier,
      upgradeMultiplier: data.upgradeMultiplier,
    });
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
    createdAt: asUtc(data.createdAtUtc || data.createdAt),
    updatedAt: asUtc(data.updatedAtUtc || data.updatedAt),
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
    currency: data.currency || 'usd',
    tripTotalCents: Number.isInteger(data.tripTotalCents) ? data.tripTotalCents : null,
    includedMultiplier: multiplierOr(data.includedMultiplier, DEFAULT_INCLUDED_MULTIPLIER),
    upgradeMultiplier: multiplierOr(data.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER),
    coverageLimitCents,
    coverageMultiplier: coverageLimitCents == null
      ? null
      : multiplierOr(data.coverageMultiplier, isHundredCoverage(data.coverageLevel) ? DEFAULT_UPGRADE_MULTIPLIER : DEFAULT_INCLUDED_MULTIPLIER),
    cfsReminder24SentAt: data.cfsReminder24SentAt || '',
    cfsReminderDepartSentAt: data.cfsReminderDepartSentAt || '',
    cfsReminderDue: data.cfsReminderDue === true,
    brokerEmail: data.brokerEmail || data.checkoutEmail || '',
    brokerDomain: data.brokerDomain || '',
    origin: data.origin || data.routeFrom || '',
    destination: data.destination || data.routeTo || '',
    legCount: Number.isInteger(data.legCount) ? data.legCount : null,
    electionSource: data.electionSource ?? null,
    departAtUtc: data.departAtUtc || asUtc(data.departAt),
    returnAtUtc: data.returnAtUtc || asUtc(data.returnAt),
    stripeCheckoutSessionId: data.stripeCheckoutSessionId || '',
    stripePaymentIntentId: data.stripePaymentIntentId || '',
    stripeEventId: data.stripeEventId || '',
    stripeRefundId: data.stripeRefundId || '',
    cfsStatus: data.cfsStatus || '',
    cfsConfirmedAt: data.cfsConfirmedAt || '',
    cfsConfirmedByName: data.cfsConfirmedByName || '',
    cfsConfirmedByEmail: data.cfsConfirmedByEmail || '',
    cfsCostCents: Number.isInteger(data.cfsCostCents) ? data.cfsCostCents : null,
    cfsMarginCents: Number.isInteger(data.cfsMarginCents) ? data.cfsMarginCents : null,
    acceptedCoveragePercent: data.cfsStatus === 'cfs_confirmed' ? 100 : (data.acceptedCoveragePercent ?? null),
    cfsReference: data.cfsReference || '',
    cfsNotes: data.cfsNotes || '',
    cfsRevision: Number(data.cfsRevision) || 0,
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

export async function findByAckToken(db, token) {
  const hash = hashOfferToken(token);
  if (!hash) return null;
  const snap = await db.collection(COLLECTION).where('ackTokenHash', '==', hash).limit(1).get();
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
      await appendCoverageEvent(db, id, {
        type: 'offer_sent',
        force,
        atUtc: patch.offerSentAt,
        ...record,
        paymentStatus: 'offer_pending',
        amountCents: record.premiumCents,
        actor: record.checkoutEmail || '',
      }).catch((err) => errors.push(`offer event: ${err.message}`));
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
    if (!record.electionContractPath) notes.push('Signed election contract: not on file.');
    if (!record.charterContractPath) notes.push('Charter contract: not on file.');
    else notes.push('Charter contract is attached.');
    const token = newOfferToken();
    const origin = String(baseUrl || '').replace(/\/$/, '');
    const ackUrl = `${origin}/cfs?ack=${encodeURIComponent(token)}`;
    const letter = bindLetterContent(record, { ackUrl, portalUrl: `${origin}/cfs`, attachmentNotes: notes.join(' ') });
    const sent = await sendRecoveryEmail({
      to: CFS_BIND_TO,
      cc: CFS_BIND_CC,
      subject: letter.subject,
      html: letter.html,
      text: letter.text,
      attachments: [election.file, charter.file].filter(Boolean),
    });
    if (sent.ok) {
      patch.bindEmailSentAt = new Date().toISOString();
      patch.ackTokenHash = hashOfferToken(token);
      patch.ackTokenExpiresAt = new Date(Date.now() + ACK_TOKEN_TTL_MS).toISOString();
      await appendCoverageEvent(db, id, {
        type: 'bound',
        force,
        atUtc: patch.bindEmailSentAt,
        ...record,
        amountCents: record.premiumCents,
        actor: record.electedBy || record.checkoutEmail || '',
      }).catch((err) => errors.push(`bind event: ${err.message}`));
    } else errors.push(sent.error || 'bind email failed');
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

async function claimNotice(db, ref, revision, field, previous) {
  let claimed = false;
  await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() || {};
    if (Number(current.cfsRevision) !== revision) return;
    if (Number(current[field]) === revision) return;
    claimed = true;
    tx.set(ref, { [field]: revision }, { merge: true });
  });
  return {
    claimed,
    async rollback() {
      if (!claimed) return;
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data() || {};
        if (Number(current.cfsRevision) === revision && Number(current[field]) === revision) {
          tx.set(ref, { [field]: previous }, { merge: true });
        }
      });
    },
  };
}

async function stampConfirmedLegs(db, record, fields, confirmedAt) {
  const ids = new Set([...(record.contractLegIds || []), ...(record.linkedTripUids || [])].map((id) => String(id || '')).filter(Boolean));
  const code = normalizeTripId(record.tripId);
  if (code) {
    try {
      const snap = await db.collection('trip-state').where('tripSheetData.tripCode', '==', code).limit(40).get();
      snap.docs.forEach((docSnap) => ids.add(docSnap.id));
    } catch (err) {
      console.warn('[aog-recovery] trip legs for CFS confirmation were not listed:', err.message);
    }
  }
  const payload = legStamp(fields, confirmedAt, [...ids], normalizeTripId(record.tripId));
  await Promise.all([...ids].map((id) => db.collection('trip-state').doc(id).set({ aogCfs: payload }, { merge: true })));
}

export async function syncConfirmedCoverageValue(db, record) {
  if (record?.cfsStatus !== 'cfs_confirmed') return;
  const coverageLimitCents = Number.isInteger(record.coverageLimitCents)
    ? record.coverageLimitCents
    : coverageLimitCentsFor(tripTotalCentsOf(record), record.coverageLevel, {
      includedMultiplier: record.includedMultiplier,
      upgradeMultiplier: record.upgradeMultiplier,
    });
  await stampConfirmedLegs(db, record, {
    acceptedCoveragePercent: 100,
    coverageLimitCents,
    reference: record.cfsReference || '',
  }, record.cfsConfirmedAt || new Date().toISOString());
}

async function sendAckNotices(db, ref, revision) {
  const data = (await ref.get()).data() || {};
  if (Number(data.cfsRevision) !== revision) return { ok: true, skipped: true };
  const fields = {
    name: data.cfsConfirmedByName,
    email: data.cfsConfirmedByEmail,
    cfsCostCents: data.cfsCostCents,
    acceptedCoveragePercent: 100,
    coverageLimitCents: Number.isInteger(data.coverageLimitCents)
      ? data.coverageLimitCents
      : coverageLimitCentsFor(tripTotalCentsOf(data), data.coverageLevel, {
        includedMultiplier: data.includedMultiplier,
        upgradeMultiplier: data.upgradeMultiplier,
      }),
    reference: data.cfsReference || '',
    notes: data.cfsNotes || '',
  };
  const errors = [];
  if (Number(data.cfsOpsNotifiedRevision) !== revision) {
    const claim = await claimNotice(db, ref, revision, 'cfsOpsNotifiedRevision', Number(data.cfsOpsNotifiedRevision) || 0);
    if (claim.claimed) {
      const letter = cfsOpsLetter(data, fields);
      let sent;
      try {
        sent = await sendRecoveryEmail({ to: OPS_ACK_TO, subject: letter.subject, html: letter.html, text: letter.text });
      } catch (err) {
        sent = { ok: false, error: err.message || 'ops notice failed' };
      }
      if (!sent.ok) {
        await claim.rollback();
        errors.push(sent.error || 'ops notice failed');
      }
    }
  }
  const broker = data.brokerEmail || data.checkoutEmail || '';
  if (!broker) {
    if (Number(data.cfsBrokerNotifiedRevision) !== revision) {
      await claimNotice(db, ref, revision, 'cfsBrokerNotifiedRevision', Number(data.cfsBrokerNotifiedRevision) || 0);
    }
  } else if (Number(data.cfsBrokerNotifiedRevision) !== revision) {
    const claim = await claimNotice(db, ref, revision, 'cfsBrokerNotifiedRevision', Number(data.cfsBrokerNotifiedRevision) || 0);
    if (claim.claimed) {
      const letter = cfsBrokerLetter(data);
      let sent;
      try {
        sent = await sendRecoveryEmail({ to: broker, subject: letter.subject, html: letter.html, text: letter.text });
      } catch (err) {
        sent = { ok: false, error: err.message || 'broker notice failed' };
      }
      if (!sent.ok) {
        await claim.rollback();
        errors.push(sent.error || 'broker notice failed');
      }
    }
  }
  const error = errors.join('; ');
  if (error) await ref.set({ cfsEmailError: error }, { merge: true });
  else await ref.set({ cfsEmailError: '' }, { merge: true });
  return { ok: errors.length === 0, error };
}

export async function acknowledgeCfs(db, ref, input, now = new Date()) {
  let outcome;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const error = new Error('This acknowledgement link is not valid');
      error.status = 404;
      throw error;
    }
    const data = snap.data() || {};
    const usable = ackTokenUsable(data, now.getTime());
    if (!usable.ok) {
      const error = new Error(usable.error);
      error.status = usable.status;
      throw error;
    }
    const plan = planCfsAcknowledgement(data, input, now);
    if (!plan.ok) {
      const error = new Error(plan.error);
      error.status = 400;
      throw error;
    }
    outcome = plan;
    if (plan.kind !== 'update') return;
    tx.set(ref, plan.patch, { merge: true });
    const event = coverageEvent({
      type: 'cfs_acknowledged',
      atUtc: new Date(now.getTime() + plan.revision).toISOString(),
      amountCents: plan.fields.cfsCostCents,
      actor: plan.fields.email,
      detail: plan.detail,
      tripId: data.tripId,
      brokerEmail: data.brokerEmail || data.checkoutEmail,
      aircraftType: data.aircraftType,
      tail: data.tail,
      coverageLevel: data.coverageLevel,
      paymentStatus: data.paymentStatus,
    });
    tx.create(ref.collection('coverageEvents').doc(event.id), {
      ...event,
      coverageId: ref.id,
      at: Timestamp.fromDate(new Date(event.atUtc)),
    });
  });
  if (outcome.kind === 'update') {
    const fresh = (await ref.get()).data() || {};
    await stampConfirmedLegs(db, fresh, outcome.fields, outcome.confirmedAt);
  }
  let email = { ok: true, error: '' };
  if (outcome.kind === 'update' || outcome.kind === 'resend') {
    email = await sendAckNotices(db, ref, outcome.revision);
  }
  const saved = (await ref.get()).data() || {};
  return {
    ok: true,
    unchanged: outcome.kind === 'unchanged',
    updated: outcome.kind === 'update',
    emailError: email.error || '',
    coverage: publicCfsView(saved),
  };
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
  const legCount = match?.status === 'linked' ? match.matches.length : undefined;
  const record = {
    ...draft,
    ...reportingPatch({
      ...draft,
      legCount,
      includedMultiplier: settings?.includedMultiplier,
      upgradeMultiplier: settings?.upgradeMultiplier,
      createdAt: existing.exists ? (existing.data().createdAt || now) : now,
    }),
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
    if (record.contractLegIds?.length) {
      try {
        await backfillTripBroker(db, {
          legIds: record.contractLegIds,
          incoming: parsed,
          coverageId: id,
          actor: contractSource.sender || '',
        });
      } catch (err) {
        console.warn('[aog-recovery] broker backfill skipped:', err.message);
      }
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
    updatedAt: Timestamp.fromDate(new Date(signedAt)),
    updatedAtUtc: signedAt,
  }, { merge: true });
  await appendCoverageEvent(db, recordRef.id, {
    type: 'contract_signed',
    atUtc: signedAt,
    ...record,
    actor: name,
    amountCents: Number.isInteger(record.premiumCents) ? record.premiumCents : null,
  });
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

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function pdfBufferFromBody(body) {
  const raw = String(body?.pdfBase64 || '');
  const b64 = raw.includes(',') ? raw.split(',').pop() : raw;
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== '%PDF-') {
    throw httpError('Upload a PDF charter contract', 400);
  }
  if (buffer.length > 6_000_000) throw httpError('Contract PDF must be under 6 MB', 400);
  return buffer;
}

export function previewUploadedContract({ pdfBuffer, filename, text }) {
  const extracted = extractUncompressedPdfText(pdfBuffer);
  const clientText = String(text || '').trim();
  const body = /trip\s*total|charter\s*total|trip\s*id/i.test(extracted) ? extracted : (clientText || extracted);
  const parsed = parseCheckoutEmail({
    subject: 'Charter contract',
    from: '',
    bodyText: body,
    attachmentText: body,
    attachmentNames: [filename || 'charter-contract.pdf'],
    hasPdf: true,
  });
  return parsed;
}

export async function backfillTripBroker(db, { legIds, incoming, coverageId, actor } = {}) {
  const ids = [...new Set((legIds || []).map((id) => sanitizeKey(id)).filter(Boolean))];
  const plans = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection('trip-state').doc(id).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const sheet = data.tripSheetData || {};
    const plan = planBrokerBackfill({
      brokerCompany: data.brokerCompany || sheet.client || data.customer || '',
      brokerEmail: data.brokerEmail || '',
      brokerPhone: data.brokerPhone || '',
      brokerDomain: data.brokerDomain || '',
    }, incoming || {});
    const write = { updatedAt: Date.now() };
    if (plan.patch.brokerEmail) write.brokerEmail = plan.patch.brokerEmail;
    if (plan.patch.brokerPhone) write.brokerPhone = plan.patch.brokerPhone;
    if (plan.patch.brokerDomain) write.brokerDomain = plan.patch.brokerDomain;
    if (plan.patch.brokerCompany) {
      write.brokerCompany = plan.patch.brokerCompany;
      if (!sheet.client) write['tripSheetData.client'] = plan.patch.brokerCompany;
    }
    if (plan.mismatches.length) write.brokerMismatch = plan.mismatches;
    if (Object.keys(write).length > 1) {
      const ref = db.collection('trip-state').doc(id);
      if (snap.exists) {
        // eslint-disable-next-line no-await-in-loop
        await ref.update(write);
      } else {
        const created = { ...write };
        if (created['tripSheetData.client']) {
          created.tripSheetData = { client: created['tripSheetData.client'] };
          delete created['tripSheetData.client'];
        }
        // eslint-disable-next-line no-await-in-loop
        await ref.set(created);
      }
    }
    plans.push(plan);
  }
  if (coverageId) {
    const filled = [...new Set(plans.flatMap((plan) => plan.filled))];
    const mismatches = plans.flatMap((plan) => plan.mismatches);
    const atUtc = new Date().toISOString();
    if (filled.length) {
      await appendCoverageEvent(db, coverageId, {
        type: 'broker_backfilled',
        atUtc,
        actor: actor || '',
        detail: brokerBackfillDetail({ filled }),
        tripId: normalizeTripId(incoming?.tripId),
      });
    }
    if (mismatches.length) {
      await appendCoverageEvent(db, coverageId, {
        type: 'broker_mismatch',
        atUtc,
        actor: actor || '',
        detail: brokerMismatchDetail(mismatches),
        tripId: normalizeTripId(incoming?.tripId),
      });
    }
  }
  return plans;
}

export async function listScheduleLegs(db) {
  const legs = [];
  const state = await db.collection('trip-state').limit(2000).get();
  state.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const meta = data.tripMeta || {};
    const sheet = data.tripSheetData || {};
    const facts = data.charterContractData || {};
    const contract = data.charterContract || {};
    legs.push({
      uid: docSnap.id,
      tripId: normalizeTripId(sheet.tripCode) || normalizeTripId(facts.tripId),
      start: meta.start || facts.departAtUtc || asUtc(facts.departAt) || '',
      end: facts.returnAtUtc || asUtc(facts.returnAt) || '',
      tail: String(meta.tail || facts.tail || sheet.tail || '').trim().toUpperCase(),
      from: String(meta.from || facts.origin || '').trim().toUpperCase(),
      to: String(meta.to || facts.destination || '').trim().toUpperCase(),
      aircraft: String(facts.aircraftType || sheet.aircraftType || '').trim(),
      customer: String(sheet.client || facts.brokerCompany || data.customer || '').trim(),
      brokerEmail: String(data.brokerEmail || facts.brokerEmail || '').trim().toLowerCase(),
      brokerPhone: String(data.brokerPhone || '').trim(),
      contractAttached: Boolean(contract.path || contract.fingerprint),
    });
  });
  const manual = await db.collection('manual-trips').limit(500).get();
  manual.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const info = data.info || {};
    legs.push({
      uid: String(data.uid || docSnap.id),
      tripId: normalizeTripId(data.tripCode || info.tripCode || info.tripId),
      start: data.start || '',
      end: data.end || '',
      tail: String(info.tail || data.tail || '').trim().toUpperCase(),
      from: String(info.from || '').trim().toUpperCase(),
      to: String(info.to || '').trim().toUpperCase(),
      aircraft: String(info.aircraft || info.aircraftType || '').trim(),
      customer: String(info.customer || info.broker || '').trim(),
      brokerEmail: String(info.brokerEmail || info.broker || data.brokerEmail || '').trim().toLowerCase(),
      brokerPhone: String(info.brokerPhone || data.brokerPhone || '').trim(),
      contractAttached: false,
    });
  });
  return { legs, truncated: state.size >= 2000 };
}

export async function listCoverageRecords(db, limit = 500) {
  const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((docSnap) => serializeCoverage(docSnap.id, docSnap.data()));
}

async function findCoverageForTrip(db, tripId, legUids) {
  const id = String(tripId || '').trim().toUpperCase();
  if (id) {
    const byTrip = await db.collection(COLLECTION).where('tripId', '==', id).limit(5).get();
    if (!byTrip.empty) return byTrip.docs[0];
  }
  for (const uid of (legUids || []).slice(0, 8)) {
    // eslint-disable-next-line no-await-in-loop
    const linked = await db.collection(COLLECTION).where('linkedTripUid', '==', uid).limit(1).get();
    if (!linked.empty) return linked.docs[0];
  }
  return null;
}

export async function ensureTripLegs(db, tripId, legUids, fields = {}) {
  const code = normalizeTripId(tripId);
  if (!code) return [];
  let legs = await resolveTripLegs(db, code);
  if (legs.length) return legs;
  const ids = [...new Set((legUids || []).map((id) => sanitizeKey(id)).filter(Boolean))].slice(0, 30);
  if (!ids.length) return [];
  await Promise.all(ids.map(async (id) => {
    const ref = db.collection('trip-state').doc(id);
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const sheet = data.tripSheetData || {};
    const meta = data.tripMeta || {};
    if (!snap.exists) {
      await ref.set({
        tripSheetData: {
          tripCode: code,
          tail: fields.tail || '',
          aircraftType: fields.aircraftType || '',
        },
        tripMeta: {
          tail: fields.tail || '',
          from: fields.routeFrom || '',
          to: fields.routeTo || '',
          start: fields.departDate || '',
        },
      });
      return;
    }
    const patch = {};
    if (!normalizeTripId(sheet.tripCode)) patch['tripSheetData.tripCode'] = code;
    if (!sheet.tail && fields.tail) patch['tripSheetData.tail'] = fields.tail;
    if (!sheet.aircraftType && fields.aircraftType) patch['tripSheetData.aircraftType'] = fields.aircraftType;
    if (!meta.tail && fields.tail) patch['tripMeta.tail'] = fields.tail;
    if (!meta.from && fields.routeFrom) patch['tripMeta.from'] = fields.routeFrom;
    if (!meta.to && fields.routeTo) patch['tripMeta.to'] = fields.routeTo;
    if (!meta.start && fields.departDate) patch['tripMeta.start'] = fields.departDate;
    if (Object.keys(patch).length) await ref.update(patch);
  }));
  return resolveTripLegs(db, code);
}

function reviewedParsed(fields, tripId) {
  const totalRaw = fields?.tripTotal;
  const tripTotal = totalRaw === '' || totalRaw == null ? null : Number(totalRaw);
  const routeFrom = String(fields?.routeFrom || '').trim().toUpperCase().slice(0, 8);
  const routeTo = String(fields?.routeTo || '').trim().toUpperCase().slice(0, 8);
  const departDate = String(fields?.departDate || '').trim().slice(0, 40);
  const returnDate = String(fields?.returnDate || '').trim().slice(0, 40);
  return {
    isCheckout: true,
    parserVersion: 'provisional-1',
    tripId: normalizeTripId(fields?.tripId || tripId),
    brokerCompany: String(fields?.brokerCompany || '').trim().slice(0, 120),
    checkoutEmail: String(fields?.checkoutEmail || fields?.brokerEmail || '').trim().toLowerCase().slice(0, 160),
    tail: String(fields?.tail || '').trim().toUpperCase().slice(0, 16),
    aircraftType: String(fields?.aircraftType || '').trim().slice(0, 80),
    routeFrom,
    routeTo,
    route: [routeFrom, routeTo].filter(Boolean).join(' → '),
    departDate,
    returnDate,
    datesLabel: [departDate, returnDate].filter(Boolean).join(' – '),
    tripTotal: Number.isFinite(tripTotal) ? Math.round(tripTotal * 100) / 100 : null,
    brokerPhone: String(fields?.brokerPhone || '').trim().slice(0, 40),
    uncertainFields: Array.isArray(fields?.uncertainFields) ? fields.uncertainFields : [],
    notes: ['Uploaded by ops'],
  };
}

export async function saveUploadedContract(db, { pdfBuffer, filename, tripId, legUids, fields, actor, baseUrl }) {
  const code = normalizeTripId(tripId || fields?.tripId);
  if (!code) throw httpError('Trip ID must be 6 or 7 letters and digits', 400);
  const parsed = reviewedParsed(fields, code);
  const legs = await ensureTripLegs(db, code, legUids, parsed);
  if (!legs.length) throw httpError('No legs found for that trip', 404);
  const settings = await loadSettings(db);
  const existing = await findCoverageForTrip(db, code, legs.map((leg) => leg.id));
  const existingData = existing?.data() || {};
  const paid = existingData.paymentStatus === 'paid' || existingData.coverageLevel === 'purchased_100';
  const source = {
    messageId: '',
    receivedAt: new Date().toISOString(),
    sender: parsed.checkoutEmail || actor?.email || '',
    uploadedBy: actor?.email || '',
    origin: 'ops-upload',
  };
  const attached = await writeCharterContract(db, {
    legs,
    pdfBuffer,
    filename: filename || 'charter-contract.pdf',
    source,
    tripKey: code,
    facts: { ...parsed, legCount: legs.length },
  });
  const coverageId = existing?.id || `up_${crypto.createHash('sha256').update(code.toUpperCase()).digest('hex').slice(0, 24)}`;
  await backfillTripBroker(db, {
    legIds: (attached.contractLegIds || []).length ? attached.contractLegIds : legs.map((leg) => leg.id),
    incoming: parsed,
    coverageId,
    actor: actor?.email || '',
  });
  const ref = db.collection(COLLECTION).doc(coverageId);
  const storagePath = `aog-recovery/${coverageId}/charter-contract.pdf`;
  await savePdf(storagePath, pdfBuffer);

  if (paid) {
    const patch = {
      charterContractPath: storagePath,
      charterContractFilename: filename || 'charter-contract.pdf',
      contractAttachStatus: attached.contractAttachStatus || '',
      contractLegIds: attached.contractLegIds || [],
      contractFingerprint: attached.contractFingerprint || '',
      contractSource: source,
      contractCandidateTripUids: [],
      contractAmbiguous: false,
      updatedAt: new Date().toISOString(),
    };
    await ref.set(patch, { merge: true });
    const saved = { ...existingData, ...patch, id: coverageId };
    return { record: serializeCoverage(coverageId, saved), contractOnly: true, emailError: '' };
  }

  const match = { status: 'linked', matches: legs, ambiguous: false };
  const draft = buildCoverageDraft({ parsed, settings, match, messageId: '' });
  draft.source = existingData.source || 'ops_upload';
  draft.addedBy = actor?.email || '';
  const now = new Date().toISOString();
  const record = {
    ...existingData,
    ...draft,
    ...reportingPatch({
      ...draft,
      legCount: legs.length,
      brokerEmail: draft.checkoutEmail,
      includedMultiplier: settings?.includedMultiplier,
      upgradeMultiplier: settings?.upgradeMultiplier,
      createdAt: existingData.createdAt || now,
    }),
    charterContractPath: storagePath,
    charterContractFilename: filename || 'charter-contract.pdf',
    contractAttachStatus: attached.contractAttachStatus || '',
    contractLegIds: attached.contractLegIds || [],
    contractFingerprint: attached.contractFingerprint || '',
    contractSource: source,
    contractCandidateTripUids: [],
    contractAmbiguous: false,
    contractAttachError: '',
    emailsToSend: draft.emailsToSend,
  };
  await ref.set(record, { merge: true });
  const sent = await dispatchCoverageEmails(db, coverageId, {
    ...record,
    offerSentAt: '',
    includedNoticeSentAt: '',
    coveredNoticeSentAt: '',
    bindEmailSentAt: existingData.bindEmailSentAt && record.coverageLevel !== 'complimentary_100' ? existingData.bindEmailSentAt : '',
  }, { baseUrl });
  const fresh = await ref.get();
  return {
    record: serializeCoverage(coverageId, fresh.data() || record),
    contractOnly: false,
    emailError: sent.error || '',
  };
}

export async function listCoverageEvents(db, coverageId) {
  const snap = await db.collection(COLLECTION).doc(String(coverageId)).collection('coverageEvents').orderBy('at', 'desc').limit(50).get();
  return snap.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      id: docSnap.id,
      type: data.type || '',
      at: data.atUtc || asUtc(data.at),
      amountCents: Number.isInteger(data.amountCents) ? data.amountCents : null,
      currency: data.currency || 'usd',
      actor: data.actor || '',
      detail: data.detail || '',
      coverageLevel: data.coverageLevel || '',
      paymentStatus: data.paymentStatus || '',
    };
  });
}

const AT_HUNDRED = new Set(['purchased_100', 'gifted_100', 'complimentary_100']);

export async function complimentaryCandidates(db, domain, now = new Date()) {
  const { legs } = await listScheduleLegs(db);
  const records = await listCoverageRecords(db);
  const rows = buildTripRows(legs, records);
  return rowsEligibleForComplimentary(rows, domain, now).map((row) => ({
    tripId: row.tripId,
    datesLabel: row.datesLabel,
    route: row.route,
    tail: row.tail,
    brokerEmail: row.brokerEmail,
    coverageLevel: row.coverageLevel,
  }));
}

export async function applyComplimentaryDomain(db, { domain, tripIds, actor, baseUrl, now = new Date() }) {
  const settings = await loadSettings(db);
  if (!settings.complimentaryDomains.includes(domain)) {
    throw httpError('Add the domain before applying it', 400);
  }
  const today = nyDay(now);
  const { legs } = await listScheduleLegs(db);
  const wanted = [...new Set((tripIds || []).map((id) => String(id || '').trim().toUpperCase()).filter(Boolean))].slice(0, 40);
  const applied = [];
  const skipped = [];
  for (const tripId of wanted) {
    const rowLegs = legs.filter((leg) => String(leg.tripId || '').trim().toUpperCase() === tripId);
    const email = String(rowLegs.find((leg) => leg.brokerEmail)?.brokerEmail || '').toLowerCase();
    const depart = rowLegs.map((leg) => leg.start).filter(Boolean).sort()[0] || '';
    const departDay = nyDay(depart);
    if (!rowLegs.length) {
      skipped.push({ tripId, reason: 'Trip is not on the schedule' });
      continue;
    }
    if (!isComplimentaryDomain(email, [domain])) {
      skipped.push({ tripId, reason: 'Broker email is not on that domain' });
      continue;
    }
    if (!departDay || departDay < today) {
      skipped.push({ tripId, reason: 'Trip is not upcoming' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const existing = await findCoverageForTrip(db, tripId, rowLegs.map((leg) => leg.uid));
    const data = existing?.data() || {};
    if (AT_HUNDRED.has(data.coverageLevel) || data.paymentStatus === 'paid') {
      skipped.push({ tripId, reason: 'Already at 100%' });
      continue;
    }
    const first = rowLegs[0];
    const last = rowLegs[rowLegs.length - 1];
    const parsed = reviewedParsed({
      tripId,
      brokerCompany: data.brokerCompany || first.customer || '',
      checkoutEmail: email,
      tail: data.tail || first.tail || '',
      aircraftType: data.aircraftType || first.aircraft || '',
      routeFrom: data.routeFrom || first.from || '',
      routeTo: data.routeTo || last.to || '',
      departDate: departDay,
      returnDate: nyDay(last.end || last.start),
      tripTotal: data.tripTotal ?? null,
    }, tripId);
    const action = classifyCheckout(parsed, settings);
    if (action.coverageLevel !== 'complimentary_100') {
      skipped.push({ tripId, reason: 'Domain did not classify as complimentary' });
      continue;
    }
    const coverageId = existing?.id || `up_${crypto.createHash('sha256').update(tripId).digest('hex').slice(0, 24)}`;
    const record = {
      ...data,
      source: data.source || 'complimentary_domain',
      ...actionFields(parsed, action, actor),
      linkedTripUid: rowLegs[0].uid,
      linkedTripUids: rowLegs.map((leg) => leg.uid),
      matchStatus: 'linked',
      emailsToSend: action.emails,
      charterContractPath: data.charterContractPath || '',
      charterContractFilename: data.charterContractFilename || '',
      electionContractPath: data.electionContractPath || '',
      createdAt: data.createdAt || new Date().toISOString(),
    };
    Object.assign(record, reportingPatch({
      ...record,
      legCount: rowLegs.length,
      brokerEmail: email,
      includedMultiplier: settings?.includedMultiplier,
      upgradeMultiplier: settings?.upgradeMultiplier,
    }));
    // eslint-disable-next-line no-await-in-loop
    await db.collection(COLLECTION).doc(coverageId).set(record, { merge: true });
    // eslint-disable-next-line no-await-in-loop
    const sent = await dispatchCoverageEmails(db, coverageId, {
      ...record,
      coveredNoticeSentAt: '',
      bindEmailSentAt: '',
    }, { baseUrl });
    applied.push({ tripId, coverageId, emailError: sent.error || '' });
  }
  return { applied, skipped };
}

function actionFields(parsed, action, actor) {
  return {
    tripId: parsed.tripId,
    brokerCompany: parsed.brokerCompany,
    checkoutEmail: parsed.checkoutEmail,
    tail: parsed.tail,
    aircraftType: action.matchedAircraftType || parsed.aircraftType,
    route: parsed.route,
    routeFrom: parsed.routeFrom,
    routeTo: parsed.routeTo,
    departDate: parsed.departDate,
    returnDate: parsed.returnDate,
    datesLabel: parsed.datesLabel,
    tripTotal: parsed.tripTotal,
    coverageLevel: action.coverageLevel,
    paymentStatus: action.paymentStatus,
    premium: action.premium,
    premiumCents: action.premiumCents,
    ratePercent: action.ratePercent,
    upgradeAvailable: false,
    electedBy: action.electedBy || '',
    addedBy: actor?.email || '',
    needsReview: parsed.tripTotal == null,
  };
}

export { COLLECTION, PROCESSED, classifyCheckout };
