// Charter Flight Support portal. Pure helpers: no Firebase. The projection
// is the only trip shape CFS is allowed to see.

import { fmtMoney } from './aog-recovery.js';
import { cfsStaffAllows } from './aog-recovery.js';
import {
  DEFAULT_UPGRADE_MULTIPLIER,
  isHundredCoverage,
  limitCentsForMultiplier,
  multiplierOr,
  tripTotalCentsOf,
} from './aog-reporting.js';
import { normalizeTripId } from './trip-id.js';

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const CFS_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;
export const REMINDER_AFTER_BIND_MS = 24 * 60 * 60 * 1000;
export const REMINDER_BEFORE_DEPART_MS = 24 * 60 * 60 * 1000;
export const URGENT_WINDOW_MS = 72 * 60 * 60 * 1000;
export const PORTAL_PAGE_SIZE = 20;

export const CFS_EVENT_TYPES = new Set(['bound', 'cfs_acknowledged', 'cfs_reminder_sent', 'cfs_portal_opened']);

const DETAIL_FORBIDDEN = /premium|gifted by skyway|complimentary|margin|rate percent|broker email|passenger/i;

export function isCfsVisibleRecord(record) {
  return isHundredCoverage(record?.coverageLevel);
}

export function magicLinkDecision(email, staff) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 160) {
    return { ok: false, status: 400, error: 'Enter a valid email address' };
  }
  if (!cfsStaffAllows(normalized, staff)) return { ok: true, send: false, email: normalized };
  return { ok: true, send: true, email: normalized };
}

export function magicLinkPayload({ emulator = false, link = '' } = {}) {
  return emulator && link ? { ok: true, devLink: link } : { ok: true };
}

function moneyUpTo(cents) {
  if (!Number.isInteger(cents)) return '';
  return `up to ${fmtMoney(cents / 100)}`;
}

export function cfsLimitCents(record = {}) {
  if (Number.isInteger(record.coverageLimitCents)) return record.coverageLimitCents;
  return limitCentsForMultiplier(
    tripTotalCentsOf(record),
    multiplierOr(record.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER),
  );
}

export function departMs(record = {}) {
  const raw = record.departAt || record.departAtUtc || record.departDate || '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function portalStatus(record = {}, now = new Date()) {
  if (record.paymentStatus === 'refunded' || record.cancelled === true) return 'cancelled';
  const end = Date.parse(record.returnAtUtc || record.returnAt || record.returnDate || record.departAtUtc || record.departDate || '');
  const confirmed = record.cfsStatus === 'cfs_confirmed';
  if (confirmed && Number.isFinite(end) && end < now.getTime()) return 'flown';
  if (confirmed) return 'confirmed';
  return 'awaiting';
}

export function isUrgent(record = {}, now = new Date()) {
  if (portalStatus(record, now) !== 'awaiting') return false;
  const depart = departMs(record);
  if (!Number.isFinite(depart)) return false;
  const until = depart - now.getTime();
  return until >= 0 && until <= URGENT_WINDOW_MS;
}

export function cfsLegProjection(leg = {}) {
  return {
    from: String(leg.from || '').slice(0, 8),
    to: String(leg.to || '').slice(0, 8),
    departAt: String(leg.start || leg.departAt || '').slice(0, 40),
    arriveAt: String(leg.end || leg.arriveAt || '').slice(0, 40),
    tail: String(leg.tail || '').replace(/\s+/g, '').toUpperCase().slice(0, 12),
  };
}

function fallbackLegs(record) {
  const from = record.routeFrom || record.origin || '';
  const to = record.routeTo || record.destination || '';
  if (!from && !to && !record.departDate && !record.departAtUtc) return [];
  return [cfsLegProjection({
    from,
    to,
    start: record.departAtUtc || record.departDate || '',
    end: record.returnAtUtc || record.returnDate || '',
    tail: record.tail || '',
  })];
}

/** CFS-safe trip. Returns null for 50% and anything else CFS must not see. */
export function cfsTripProjection(record = {}, legs = []) {
  if (!isCfsVisibleRecord(record)) return null;
  const coverageLimitCents = cfsLimitCents(record);
  const projected = (Array.isArray(legs) && legs.length ? legs : fallbackLegs(record))
    .map(cfsLegProjection)
    .filter((leg) => leg.from || leg.to || leg.departAt);
  const tripTotalCents = tripTotalCentsOf(record);
  return {
    id: String(record.id || ''),
    tripId: normalizeTripId(record.tripId) || '',
    aircraftType: String(record.aircraftType || '').slice(0, 80),
    tail: String(record.tail || '').slice(0, 12),
    route: String(record.route || '').slice(0, 80),
    datesLabel: String(record.datesLabel || '').slice(0, 80),
    departAt: String(record.departAtUtc || record.departDate || '').slice(0, 40),
    returnAt: String(record.returnAtUtc || record.returnDate || '').slice(0, 40),
    legCount: projected.length || (Number.isInteger(record.legCount) ? record.legCount : null),
    legs: projected,
    brokerCompany: String(record.brokerCompany || '').slice(0, 160),
    tripTotalCents,
    tripTotalLabel: fmtMoney(record.tripTotal ?? (tripTotalCents == null ? null : tripTotalCents / 100)),
    coverage: '100%',
    coverageLimitCents,
    coverageMultiplier: coverageLimitCents == null
      ? null
      : multiplierOr(record.coverageMultiplier, multiplierOr(record.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER)),
    coverageValueLabel: moneyUpTo(coverageLimitCents),
    hasContract: Boolean(record.charterContractPath),
    bindRequestedAt: String(record.bindEmailSentAt || '').slice(0, 40),
    status: portalStatus(record),
    urgent: isUrgent(record),
    reminderDue: record.cfsStatus !== 'cfs_confirmed' && Boolean(record.cfsReminder24SentAt || record.cfsReminderDepartSentAt),
    acknowledgement: record.cfsStatus === 'cfs_confirmed' ? {
      name: String(record.cfsConfirmedByName || '').slice(0, 120),
      email: String(record.cfsConfirmedByEmail || '').slice(0, 160),
      cfsCostCents: Number.isInteger(record.cfsCostCents) ? record.cfsCostCents : null,
      cfsCostLabel: Number.isInteger(record.cfsCostCents) ? fmtMoney(record.cfsCostCents / 100) : '',
      reference: String(record.cfsReference || '').slice(0, 80),
      notes: String(record.cfsNotes || '').slice(0, 1000),
      confirmedAt: String(record.cfsConfirmedAt || '').slice(0, 40),
      revision: Number(record.cfsRevision) || 0,
    } : null,
  };
}

export function cfsEventProjection(event = {}) {
  if (!CFS_EVENT_TYPES.has(event.type)) return null;
  const detail = String(event.detail || '').replace(DETAIL_FORBIDDEN, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    id: String(event.id || ''),
    type: String(event.type),
    at: String(event.atUtc || event.at || '').slice(0, 40),
    detail,
  };
}

export function projectionLeaks(view) {
  const blob = JSON.stringify(view);
  return DETAIL_FORBIDDEN.test(blob);
}

export function dashboardSummary(trips, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const awaiting = trips.filter((trip) => trip.status === 'awaiting');
  const confirmedMonth = trips.filter((trip) => String(trip.acknowledgement?.confirmedAt || '').startsWith(month));
  const boundValueCents = confirmedMonth.reduce((sum, trip) => sum + (trip.coverageLimitCents || 0), 0);
  const upcomingFlights = trips.filter((trip) => trip.status === 'confirmed' && departMs(trip) >= now.getTime()).length;
  const needsAction = [...awaiting].sort((a, b) => departMs(a) - departMs(b));
  return {
    awaiting: awaiting.length,
    confirmedThisMonth: confirmedMonth.length,
    boundValueCents,
    boundValueLabel: fmtMoney(boundValueCents / 100),
    upcomingFlights,
    needsAction,
  };
}

function includes(hay, needle) {
  return String(hay || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

export function filterPortalTrips(trips, query = {}) {
  const status = String(query.status || '').trim();
  const q = String(query.q || '').trim().toLowerCase();
  const tail = String(query.tail || '').trim().toLowerCase();
  const aircraft = String(query.aircraft || '').trim().toLowerCase();
  const airport = String(query.airport || '').trim().toLowerCase();
  const broker = String(query.broker || '').trim().toLowerCase();
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim();
  return (trips || []).filter((trip) => {
    if (status && status !== 'all' && trip.status !== status) return false;
    if (tail && !includes(trip.tail, tail)) return false;
    if (aircraft && !includes(trip.aircraftType, aircraft)) return false;
    if (broker && !includes(trip.brokerCompany, broker)) return false;
    if (airport && !includes(trip.route, airport) && !(trip.legs || []).some((leg) => includes(leg.from, airport) || includes(leg.to, airport))) return false;
    if (q && ![trip.tripId, trip.tail, trip.aircraftType, trip.route, trip.brokerCompany].some((value) => includes(value, q))) return false;
    const depart = String(trip.departAt || '').slice(0, 10);
    if (from && depart && depart < from) return false;
    if (to && depart && depart > to) return false;
    return true;
  });
}

export function sortPortalTrips(trips, sort = 'depart') {
  const rows = [...(trips || [])];
  rows.sort((a, b) => {
    if (sort === 'trip') return String(a.tripId).localeCompare(String(b.tripId));
    if (sort === 'status') return String(a.status).localeCompare(String(b.status)) || (departMs(a) - departMs(b));
    return departMs(a) - departMs(b);
  });
  return rows;
}

export function pagePortalTrips(trips, page = 1, size = PORTAL_PAGE_SIZE) {
  const total = trips.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * size;
  return { rows: trips.slice(start, start + size), page: current, pages, total };
}

export function statementFor(trips, month) {
  const key = String(month || '').slice(0, 7);
  const rows = (trips || []).filter((trip) => trip.status !== 'cancelled' && String(trip.acknowledgement?.confirmedAt || '').startsWith(key));
  const coverageLimitCents = rows.reduce((sum, trip) => sum + (trip.coverageLimitCents || 0), 0);
  const cfsCostCents = rows.reduce((sum, trip) => sum + (trip.acknowledgement?.cfsCostCents || 0), 0);
  return { month: key, rows, coverageLimitCents, cfsCostCents };
}

export function statementCsv(statement) {
  const header = ['Trip ID', 'Tail', 'Aircraft', 'Route', 'Dates', 'Coverage', 'Coverage value cents', 'CFS cost cents', 'Reference', 'Confirmed'];
  const lines = [header.join(',')];
  for (const trip of statement.rows) {
    const cells = [
      trip.tripId,
      trip.tail,
      trip.aircraftType,
      trip.route,
      trip.datesLabel,
      '100%',
      trip.coverageLimitCents ?? '',
      trip.acknowledgement?.cfsCostCents ?? '',
      trip.acknowledgement?.reference || '',
      trip.acknowledgement?.confirmedAt || '',
    ].map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`);
    lines.push(cells.join(','));
  }
  lines.push(`"Totals","","","","","","${statement.coverageLimitCents}","${statement.cfsCostCents}","",""`);
  return lines.join('\n');
}

function pdfEscape(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** One-page text PDF so CFS can attach the statement to an invoice. */
export function statementPdf(statement) {
  const lines = [
    `Charter Flight Support statement ${statement.month || ''}`,
    'Skyway Aviation x Charter Flight Support',
    '',
    ...statement.rows.slice(0, 28).map((trip) => {
      const value = Number.isInteger(trip.coverageLimitCents) ? fmtMoney(trip.coverageLimitCents / 100) : '—';
      const cost = trip.acknowledgement?.cfsCostLabel || '—';
      return `${trip.tripId}  ${trip.tail}  ${trip.route}  100%  ${value}  CFS ${cost}`;
    }),
    '',
    `Coverage value total ${fmtMoney((statement.coverageLimitCents || 0) / 100)}`,
    `CFS cost total ${fmtMoney((statement.cfsCostCents || 0) / 100)}`,
  ];
  const content = lines.map((line, index) => `BT /F1 10 Tf 48 ${760 - index * 14} Td (${pdfEscape(line)}) Tj ET`).join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
    `4 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream\nendobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
  ];
  let body = '%PDF-1.4\n';
  const xref = [0];
  for (const object of objects) {
    xref.push(body.length);
    body += object;
  }
  const start = body.length;
  body += `xref\n0 ${xref.length}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i < xref.length; i += 1) body += `${String(xref[i]).padStart(10, '0')} 00000 n \n`;
  body += `trailer << /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(body);
}

export function planCfsReminders(record = {}, now = new Date()) {
  if (!isCfsVisibleRecord(record)) return [];
  if (record.cfsStatus === 'cfs_confirmed' || record.paymentStatus === 'refunded' || record.cancelled === true) return [];
  const plans = [];
  const bindAt = Date.parse(record.bindEmailSentAt || '');
  if (Number.isFinite(bindAt) && now.getTime() - bindAt >= REMINDER_AFTER_BIND_MS && !record.cfsReminder24SentAt) {
    plans.push({ kind: 'bind_24h', field: 'cfsReminder24SentAt' });
  }
  const depart = Date.parse(record.departAtUtc || record.departDate || '');
  if (Number.isFinite(depart)) {
    const until = depart - now.getTime();
    if (until > 0 && until <= REMINDER_BEFORE_DEPART_MS && !record.cfsReminderDepartSentAt) {
      plans.push({ kind: 'depart_24h', field: 'cfsReminderDepartSentAt' });
    }
  }
  return plans;
}
