// Charter Flight Support acknowledgement. Pure helpers: no Firebase, no mail
// transport. The bind email and the broker notice omit Skyway's premium.
// The ops notice includes the CFS cost. A second identical submit does not
// send another email once both notices for that revision have been recorded.

import { coverageLevelLabel, fmtMoney } from './aog-recovery.js';
import { normalizeTripId } from './trip-id.js';

export const ACK_TOKEN_TTL_MS = 45 * 24 * 60 * 60 * 1000;
export const OPS_ACK_TO = 'charters@flyskyway.com';

const HUNDRED = new Set(['purchased_100', 'gifted_100', 'complimentary_100']);

export function requestedCoveragePercent(level) {
  if (level === 'included_50') return 50;
  if (HUNDRED.has(level)) return 100;
  return null;
}

export function ackTokenUsable(record, nowMs = Date.now()) {
  if (!record?.ackTokenHash) {
    return { ok: false, status: 404, error: 'This acknowledgement link is not valid' };
  }
  const expires = Date.parse(record.ackTokenExpiresAt || '');
  if (!Number.isFinite(expires) || nowMs > expires) {
    return { ok: false, status: 410, error: 'This acknowledgement link has expired' };
  }
  return { ok: true };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label, value) {
  return `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${escapeHtml(label)}</td>`
    + `<td style="padding:4px 0;color:#0f172a">${escapeHtml(value || '—')}</td></tr>`;
}

function shell(title, inner) {
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#0f172a">`
    + `<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#64748b">Skyway Aviation · Charter Flight Support</div>`
    + `<h1 style="font-size:20px;margin:8px 0 16px">${escapeHtml(title)}</h1>`
    + inner
    + `</div>`;
}

function moneyFromCents(cents) {
  if (!Number.isInteger(cents)) return '—';
  return fmtMoney(cents / 100);
}

function parseDollars(value, { required, label }) {
  const raw = String(value ?? '').trim().replace(/[$,\s]/g, '');
  if (!raw) {
    if (!required) return { ok: true, cents: null };
    return { ok: false, error: `${label} is required` };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, error: `${label} must be a USD amount` };
  }
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isInteger(cents) || cents < 0 || cents > 100_000_000) {
    return { ok: false, error: `${label} is out of range` };
  }
  return { ok: true, cents };
}

function parsePercent(value) {
  const raw = String(value ?? '').trim().replace(/%$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { ok: false, error: 'Accepted coverage percent is required' };
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { ok: false, error: 'Accepted coverage percent must be from 0 to 100' };
  }
  return { ok: true, percent };
}

export function validateAcknowledgement(input = {}, record = {}) {
  const name = String(input.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 120) {
    return { ok: false, error: 'Enter the name of the person acknowledging coverage' };
  }
  const email = String(input.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    return { ok: false, error: 'Enter a valid email address' };
  }
  const cost = parseDollars(input.cfsCost, { required: true, label: 'CFS cost' });
  if (!cost.ok) return cost;
  const percent = parsePercent(input.acceptedCoveragePercent);
  if (!percent.ok) return percent;
  const limit = parseDollars(input.coverageLimit, { required: false, label: 'Coverage limit' });
  if (!limit.ok) return limit;
  const reference = String(input.reference || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const notes = String(input.notes || '').trim().slice(0, 1000);
  const requested = requestedCoveragePercent(record.coverageLevel);
  const tripTotalCents = Number.isInteger(record.tripTotalCents)
    ? record.tripTotalCents
    : (Number.isFinite(Number(record.tripTotal)) ? Math.round(Number(record.tripTotal) * 100) : null);
  const premiumCents = Number.isInteger(record.premiumCents) ? record.premiumCents : null;
  const shortfallPercent = requested != null && percent.percent < requested;
  const shortfallLimit = limit.cents != null && tripTotalCents != null && limit.cents < tripTotalCents;
  const fields = {
    name,
    email,
    cfsCostCents: cost.cents,
    acceptedCoveragePercent: percent.percent,
    acceptedCoverageLimitCents: limit.cents,
    reference,
    notes,
    requestedCoveragePercent: requested,
    shortfallPercent,
    shortfallLimit,
    shortfall: shortfallPercent || shortfallLimit,
    cfsMarginCents: premiumCents == null ? null : premiumCents - cost.cents,
    tripTotalCents,
  };
  return { ok: true, fields, fingerprint: acknowledgementFingerprint(fields) };
}

export function acknowledgementFingerprint(fields) {
  return [
    fields.name,
    fields.email,
    fields.cfsCostCents,
    fields.acceptedCoveragePercent,
    fields.acceptedCoverageLimitCents ?? '',
    fields.reference,
    fields.notes,
  ].join('|');
}

function storedFields(existing) {
  return {
    name: existing.cfsConfirmedByName || '',
    email: existing.cfsConfirmedByEmail || '',
    cfsCostCents: existing.cfsCostCents,
    acceptedCoveragePercent: existing.acceptedCoveragePercent,
    acceptedCoverageLimitCents: Number.isInteger(existing.acceptedCoverageLimitCents) ? existing.acceptedCoverageLimitCents : null,
    reference: existing.cfsReference || '',
    notes: existing.cfsNotes || '',
    requestedCoveragePercent: existing.cfsRequestedPercent ?? requestedCoveragePercent(existing.coverageLevel),
    shortfall: existing.cfsShortfall === true,
    shortfallPercent: existing.cfsShortfallPercent === true,
    shortfallLimit: existing.cfsShortfallLimit === true,
    cfsMarginCents: Number.isInteger(existing.cfsMarginCents) ? existing.cfsMarginCents : null,
  };
}

function noticesDone(existing, revision) {
  const opsDone = Number(existing.cfsOpsNotifiedRevision) === revision;
  const brokerAddress = existing.brokerEmail || existing.checkoutEmail;
  const brokerDone = !brokerAddress || Number(existing.cfsBrokerNotifiedRevision) === revision;
  return opsDone && brokerDone;
}

/**
 * Decide whether this submit is a no-op, an email retry, or a new acknowledgement.
 * Callers persist `update` inside a transaction before sending mail.
 */
export function planCfsAcknowledgement(existing = {}, input = {}, now = new Date()) {
  const validated = validateAcknowledgement(input, existing);
  if (!validated.ok) return validated;
  const revision = Number(existing.cfsRevision) || 0;
  const same = revision > 0 && validated.fingerprint === existing.cfsFingerprint;
  if (same && noticesDone(existing, revision)) {
    return { ok: true, kind: 'unchanged', revision, fields: storedFields(existing) };
  }
  if (same) {
    return { ok: true, kind: 'resend', revision, fields: storedFields(existing) };
  }
  const confirmedAt = now.toISOString();
  const next = revision + 1;
  const { fields } = validated;
  return {
    ok: true,
    kind: 'update',
    revision: next,
    confirmedAt,
    fields,
    fingerprint: validated.fingerprint,
    detail: acknowledgementDetail(fields),
    patch: {
      cfsStatus: 'cfs_confirmed',
      cfsConfirmedAt: confirmedAt,
      cfsConfirmedByName: fields.name,
      cfsConfirmedByEmail: fields.email,
      cfsCostCents: fields.cfsCostCents,
      cfsMarginCents: fields.cfsMarginCents,
      acceptedCoveragePercent: fields.acceptedCoveragePercent,
      acceptedCoverageLimitCents: fields.acceptedCoverageLimitCents,
      cfsReference: fields.reference,
      cfsNotes: fields.notes,
      cfsRequestedPercent: fields.requestedCoveragePercent,
      cfsShortfall: fields.shortfall,
      cfsShortfallPercent: fields.shortfallPercent,
      cfsShortfallLimit: fields.shortfallLimit,
      cfsRevision: next,
      cfsFingerprint: validated.fingerprint,
    },
  };
}

export function acknowledgementDetail(fields) {
  const limit = fields.acceptedCoverageLimitCents == null ? '' : ` Limit ${moneyFromCents(fields.acceptedCoverageLimitCents)}.`;
  const short = fields.shortfall ? ' Accepted coverage is below what was requested.' : '';
  return `Accepted ${fields.acceptedCoveragePercent}% (requested ${fields.requestedCoveragePercent ?? '—'}%). CFS cost ${moneyFromCents(fields.cfsCostCents)}.${limit}${short}`.slice(0, 500);
}

export function legStamp(fields, confirmedAt, legIds, tripId) {
  return {
    status: 'cfs_confirmed',
    confirmedAt,
    tripId: tripId || '',
    acceptedCoveragePercent: fields.acceptedCoveragePercent,
    acceptedCoverageLimitCents: fields.acceptedCoverageLimitCents,
    reference: fields.reference || '',
    shortfall: fields.shortfall === true,
    requestedCoveragePercent: fields.requestedCoveragePercent,
    legIds: legIds || [],
  };
}

function tripRows(record) {
  const dates = record.datesLabel || [record.departDate, record.returnDate].filter(Boolean).join(' – ');
  return [
    row('Trip ID', normalizeTripId(record.tripId) || record.tripId),
    row('Aircraft', record.aircraftType),
    row('Tail', record.tail),
    row('Route', record.route),
    row('Dates', dates),
    row('Legs', record.legCount ? String(record.legCount) : ''),
    row('Broker', record.brokerCompany),
    row('Coverage requested', coverageLevelLabel(record.coverageLevel)),
    row('Contract trip total', fmtMoney(record.tripTotal)),
  ].join('');
}

export function bindLetterContent(record, { ackUrl, attachmentNotes } = {}) {
  const subject = `AOG coverage bind request — ${normalizeTripId(record.tripId) || record.tripId || 'trip'} ${record.tail || ''}`.trim();
  const html = shell('Bind request', `
    <p>Please bind AOG mechanical recovery coverage for the trip below.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">${tripRows(record)}</table>
    <p style="font-size:13px;color:#334155">${escapeHtml(attachmentNotes || '')}</p>
    <p><a href="${escapeHtml(ackUrl || '')}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px">Acknowledge coverage</a></p>
    <p style="font-size:12px;color:#64748b">This link is unique to this trip and expires. Use it to confirm the coverage you are binding.</p>
  `);
  const text = [
    'AOG coverage bind request',
    `Trip ID: ${normalizeTripId(record.tripId) || record.tripId || '—'}`,
    `Aircraft: ${record.aircraftType || '—'}`,
    `Tail: ${record.tail || '—'}`,
    `Route: ${record.route || '—'}`,
    `Dates: ${record.datesLabel || '—'}`,
    `Legs: ${record.legCount || '—'}`,
    `Broker: ${record.brokerCompany || '—'}`,
    `Coverage requested: ${coverageLevelLabel(record.coverageLevel)}`,
    `Contract trip total: ${fmtMoney(record.tripTotal)}`,
    attachmentNotes || '',
    `Acknowledge coverage: ${ackUrl || ''}`,
  ].join('\n');
  return { subject, html, text };
}

function acceptedLine(fields) {
  const limit = fields.acceptedCoverageLimitCents == null
    ? ''
    : ` up to ${moneyFromCents(fields.acceptedCoverageLimitCents)}`;
  return `${fields.acceptedCoveragePercent}%${limit}`;
}

export function cfsOpsLetter(record, fields) {
  const tripId = normalizeTripId(record.tripId) || record.tripId || 'trip';
  const subject = `CFS acknowledged AOG coverage — ${tripId}`;
  const flags = [];
  if (fields.shortfallPercent) flags.push(`Accepted coverage is below the requested ${fields.requestedCoveragePercent}%.`);
  if (fields.shortfallLimit) flags.push('The dollar coverage limit is below the contract trip total.');
  const flagHtml = flags.length
    ? `<p style="background:#fef3c7;border:1px solid #f59e0b;padding:10px 12px"><strong>Accepted coverage is below what was requested.</strong> ${escapeHtml(flags.join(' '))}</p>`
    : '';
  const html = shell('Charter Flight Support acknowledged coverage', `
    ${flagHtml}
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">
      ${tripRows(record)}
      ${row('Confirmed by', `${fields.name} · ${fields.email}`)}
      ${row('CFS cost', moneyFromCents(fields.cfsCostCents))}
      ${row('Accepted coverage', acceptedLine(fields))}
      ${row('Reference', fields.reference)}
      ${row('Notes', fields.notes)}
    </table>
  `);
  const text = [
    'Charter Flight Support acknowledged AOG coverage.',
    flags.length ? `Accepted coverage is below what was requested. ${flags.join(' ')}` : '',
    `Trip ID: ${tripId}`,
    `Route: ${record.route || '—'}`,
    `Dates: ${record.datesLabel || '—'}`,
    `Confirmed by: ${fields.name} <${fields.email}>`,
    `CFS cost: ${moneyFromCents(fields.cfsCostCents)}`,
    `Accepted coverage: ${acceptedLine(fields)}`,
    fields.reference ? `Reference: ${fields.reference}` : '',
    fields.notes ? `Notes: ${fields.notes}` : '',
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}

export function cfsBrokerLetter(record, fields) {
  const tripId = normalizeTripId(record.tripId) || record.tripId || 'trip';
  const subject = `AOG recovery coverage accepted — trip ${tripId}`;
  const html = shell('AOG recovery coverage has been accepted', `
    <p>Charter Flight Support has accepted AOG recovery coverage for this trip.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">
      ${row('Trip ID', tripId)}
      ${row('Route', record.route)}
      ${row('Dates', record.datesLabel || [record.departDate, record.returnDate].filter(Boolean).join(' – '))}
      ${row('Accepted coverage', acceptedLine(fields))}
    </table>
  `);
  const text = [
    'AOG recovery coverage has been accepted by Charter Flight Support.',
    `Trip ID: ${tripId}`,
    `Route: ${record.route || '—'}`,
    `Dates: ${record.datesLabel || '—'}`,
    `Accepted coverage: ${acceptedLine(fields)}`,
  ].join('\n');
  return { subject, html, text };
}

export function publicCfsView(record = {}) {
  const tripId = normalizeTripId(record.tripId) || '';
  const acknowledged = record.cfsStatus === 'cfs_confirmed';
  return {
    tripId,
    brokerCompany: record.brokerCompany || '',
    tail: record.tail || '',
    aircraftType: record.aircraftType || '',
    route: record.route || '',
    datesLabel: record.datesLabel || '',
    legCount: Number.isInteger(record.legCount) ? record.legCount : null,
    tripTotal: record.tripTotal ?? null,
    coverageLevel: record.coverageLevel || '',
    coverageLabel: coverageLevelLabel(record.coverageLevel),
    requestedCoveragePercent: requestedCoveragePercent(record.coverageLevel),
    acknowledgement: acknowledged ? {
      name: record.cfsConfirmedByName || '',
      email: record.cfsConfirmedByEmail || '',
      cfsCost: Number.isInteger(record.cfsCostCents) ? (record.cfsCostCents / 100).toFixed(2) : '',
      acceptedCoveragePercent: record.acceptedCoveragePercent,
      coverageLimit: Number.isInteger(record.acceptedCoverageLimitCents) ? (record.acceptedCoverageLimitCents / 100).toFixed(2) : '',
      reference: record.cfsReference || '',
      notes: record.cfsNotes || '',
      confirmedAt: record.cfsConfirmedAt || '',
      shortfall: record.cfsShortfall === true,
      requestedCoveragePercent: record.cfsRequestedPercent ?? requestedCoveragePercent(record.coverageLevel),
    } : null,
  };
}
