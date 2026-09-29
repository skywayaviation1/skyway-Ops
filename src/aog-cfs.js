// Charter Flight Support acknowledgement. Pure helpers: no Firebase, no mail
// transport. The bind email and the broker notice omit Skyway's premium.
// The ops notice includes the CFS cost. A second identical submit does not
// send another email once both notices for that revision have been recorded.

import { fmtMoney } from './aog-recovery.js';
import { emailButton, emailShell } from './aog-mail-layout.js';
import { comparisonHtml, comparisonText } from './aog-offer-copy.js';
import {
  DEFAULT_UPGRADE_MULTIPLIER,
  hundredCoverageLimitCents,
  isHundredCoverage,
  multiplierOr,
  tripTotalCentsOf,
} from './aog-reporting.js';
import { normalizeTripId } from './trip-id.js';

export const ACK_TOKEN_TTL_MS = 45 * 24 * 60 * 60 * 1000;
export const OPS_ACK_TO = 'charters@flyskyway.com';
export const ACCEPTED_COVERAGE_PERCENT = 100;

/** "up to $40,000.00" for a $20,000 contract at the 2× upgrade. Empty when the trip total is unknown. */
export function coverageValueText(record = {}) {
  const stored = isHundredCoverage(record.coverageLevel) && Number.isInteger(record.coverageLimitCents)
    ? record.coverageLimitCents
    : null;
  const cents = stored ?? hundredCoverageLimitCents(
    tripTotalCentsOf(record),
    multiplierOr(record.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER),
  );
  if (!Number.isInteger(cents) || cents <= 0) return '';
  return `up to ${fmtMoney(cents / 100)}`;
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
  const font = "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
  return `<tr><td style="padding:4px 12px 4px 0;${font}font-size:13px;line-height:1.4;color:#64748b">${escapeHtml(label)}</td>`
    + `<td style="padding:4px 0;${font}font-size:14px;line-height:1.4;color:#0f172a">${escapeHtml(value || '—')}</td></tr>`;
}

function shell(title, inner) {
  return emailShell({
    kicker: 'Skyway Aviation · Charter Flight Support',
    headline: title,
    body: inner,
    coBrand: true,
  });
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
  const reference = String(input.reference || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const notes = String(input.notes || '').trim().slice(0, 1000);
  const tripTotalCents = tripTotalCentsOf(record);
  const premiumCents = Number.isInteger(record.premiumCents) ? record.premiumCents : null;
  const upgradeMultiplier = multiplierOr(record.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER);
  const coverageLimitCents = hundredCoverageLimitCents(tripTotalCents, upgradeMultiplier);
  const fields = {
    name,
    email,
    cfsCostCents: cost.cents,
    acceptedCoveragePercent: ACCEPTED_COVERAGE_PERCENT,
    coverageLimitCents,
    upgradeMultiplier,
    reference,
    notes,
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
    fields.reference,
    fields.notes,
  ].join('|');
}

function storedFields(existing) {
  return {
    name: existing.cfsConfirmedByName || '',
    email: existing.cfsConfirmedByEmail || '',
    cfsCostCents: existing.cfsCostCents,
    acceptedCoveragePercent: ACCEPTED_COVERAGE_PERCENT,
    coverageLimitCents: Number.isInteger(existing.coverageLimitCents)
      ? existing.coverageLimitCents
      : hundredCoverageLimitCents(
        tripTotalCentsOf(existing),
        multiplierOr(existing.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER),
      ),
    upgradeMultiplier: multiplierOr(existing.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER),
    reference: existing.cfsReference || '',
    notes: existing.cfsNotes || '',
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
      acceptedCoveragePercent: ACCEPTED_COVERAGE_PERCENT,
      coverageLimitCents: fields.coverageLimitCents,
      coverageMultiplier: fields.coverageLimitCents == null ? null : fields.upgradeMultiplier,
      cfsReminderDue: false,
      cfsReference: fields.reference,
      cfsNotes: fields.notes,
      cfsShortfall: false,
      cfsRevision: next,
      cfsFingerprint: validated.fingerprint,
    },
  };
}

export function acknowledgementDetail(fields) {
  const limit = fields.coverageLimitCents == null ? '' : ` Coverage value: up to ${moneyFromCents(fields.coverageLimitCents)}.`;
  return `Accepted 100%.${limit} CFS cost ${moneyFromCents(fields.cfsCostCents)}.`.slice(0, 500);
}

export function legStamp(fields, confirmedAt, legIds, tripId) {
  return {
    status: 'cfs_confirmed',
    confirmedAt,
    tripId: tripId || '',
    acceptedCoveragePercent: ACCEPTED_COVERAGE_PERCENT,
    coverageLimitCents: Number.isInteger(fields.coverageLimitCents) ? fields.coverageLimitCents : null,
    reference: fields.reference || '',
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
    row('Coverage', '100%'),
    row('Contract trip total', fmtMoney(record.tripTotal)),
    row('Coverage value', coverageValueText(record) ? `Coverage value: ${coverageValueText(record)}` : 'pending trip total'),
  ].join('');
}

export function bindLetterContent(record, { ackUrl, portalUrl, attachmentNotes } = {}) {
  const portal = portalUrl || String(ackUrl || '').replace(/[?#].*$/, '').replace(/\/aog-cfs$/, '/cfs');
  const subject = `AOG coverage bind request — ${normalizeTripId(record.tripId) || record.tripId || 'trip'} ${record.tail || ''}`.trim();
  const font = "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
  const html = shell('Bind request', `
    <p style="${font}font-size:15px;line-height:1.4;color:#14202b">Please bind AOG mechanical recovery coverage for the trip below.</p>
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">${tripRows(record)}</table>
    <p style="${font}font-size:13px;line-height:1.4;color:#334155">${escapeHtml(attachmentNotes || '')}</p>
    ${emailButton(ackUrl, 'Acknowledge coverage')}
    <p style="${font}font-size:13px;line-height:1.4"><a href="${escapeHtml(portal || '')}" style="${font}color:#0b6e6a;text-decoration:none">Open the CFS portal</a> for every other trip.</p>
    <p style="${font}font-size:12px;line-height:1.4;color:#64748b">The acknowledge link is unique to this trip and works without signing in. It expires.</p>
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
    'Coverage: 100%',
    `Contract trip total: ${fmtMoney(record.tripTotal)}`,
    `Coverage value: ${coverageValueText(record) || '—'}`,
    attachmentNotes || '',
    `Acknowledge coverage: ${ackUrl || ''}`,
    `Open the CFS portal: ${portal || ''}`,
  ].join('\n');
  return { subject, html, text };
}

export function cfsOpsLetter(record, fields) {
  const tripId = normalizeTripId(record.tripId) || record.tripId || 'trip';
  const subject = `CFS acknowledged AOG coverage — ${tripId}`;
  const html = shell('Charter Flight Support acknowledged coverage', `
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">
      ${tripRows(record)}
      ${row('Confirmed by', `${fields.name} · ${fields.email}`)}
      ${row('CFS cost', moneyFromCents(fields.cfsCostCents))}
      ${row('Reference', fields.reference)}
      ${row('Notes', fields.notes)}
    </table>
  `);
  const text = [
    'Charter Flight Support acknowledged AOG coverage.',
    `Trip ID: ${tripId}`,
    `Route: ${record.route || '—'}`,
    `Dates: ${record.datesLabel || '—'}`,
    'Coverage: 100%',
    `Contract trip total: ${fmtMoney(record.tripTotal)}`,
    `Coverage value: ${coverageValueText(record) || '—'}`,
    `Confirmed by: ${fields.name} <${fields.email}>`,
    `CFS cost: ${moneyFromCents(fields.cfsCostCents)}`,
    fields.reference ? `Reference: ${fields.reference}` : '',
    fields.notes ? `Notes: ${fields.notes}` : '',
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}

export function cfsBrokerLetter(record) {
  const tripId = normalizeTripId(record.tripId) || record.tripId || 'trip';
  const subject = `AOG recovery coverage accepted — trip ${tripId}`;
  const html = shell('AOG recovery coverage has been accepted', `
    <p style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.4;color:#14202b">Charter Flight Support has accepted 100% AOG recovery coverage for this trip.</p>
    ${comparisonHtml(record)}
    <table style="border-collapse:collapse;font-size:14px;margin:16px 0">
      ${row('Trip ID', tripId)}
      ${row('Route', record.route)}
      ${row('Dates', record.datesLabel || [record.departDate, record.returnDate].filter(Boolean).join(' – '))}
      ${row('Coverage', '100%')}
      ${row('Contract trip total', fmtMoney(record.tripTotal))}
      ${row('Coverage value', coverageValueText(record))}
    </table>
  `);
  const text = [
    'AOG recovery coverage has been accepted by Charter Flight Support.',
    comparisonText(record),
    `Trip ID: ${tripId}`,
    `Route: ${record.route || '—'}`,
    `Dates: ${record.datesLabel || '—'}`,
    'Coverage: 100%',
    `Contract trip total: ${fmtMoney(record.tripTotal)}`,
    `Coverage value: ${coverageValueText(record) || '—'}`,
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
    coverage: '100%',
    acceptedCoveragePercent: ACCEPTED_COVERAGE_PERCENT,
    coverageValueLabel: coverageValueText(record),
    acknowledgement: acknowledged ? {
      name: record.cfsConfirmedByName || '',
      email: record.cfsConfirmedByEmail || '',
      cfsCost: Number.isInteger(record.cfsCostCents) ? (record.cfsCostCents / 100).toFixed(2) : '',
      acceptedCoveragePercent: ACCEPTED_COVERAGE_PERCENT,
      reference: record.cfsReference || '',
      notes: record.cfsNotes || '',
      confirmedAt: record.cfsConfirmedAt || '',
    } : null,
  };
}
