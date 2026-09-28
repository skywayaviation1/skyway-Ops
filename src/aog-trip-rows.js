// One row per trip id for the AOG Coverage page. Legs come from the
// in-app schedule (iCal + manual trips) and from trip-state. Coverage
// records are overlaid. A trip with no coverage row is 50% included.

import { contractIsOnTrip } from './charter-contract.js';
import { coverageLimitCentsFor, includedCoveragePatch, isHundredCoverage, multiplierOr, tripTotalCentsOf, DEFAULT_INCLUDED_MULTIPLIER, DEFAULT_UPGRADE_MULTIPLIER } from './aog-reporting.js';
import { normalizeTripId } from './trip-id.js';
import {
  coverageLevelLabel,
  fmtMoney,
  isComplimentaryDomain,
  paymentStatusLabel,
  premiumLabel,
} from './aog-recovery.js';

export const TRIP_PAGE_SIZE = 40;
export const RECENT_DAYS = 14;

const HUNDRED = new Set(['purchased_100', 'gifted_100', 'complimentary_100']);
const LEVEL_RANK = {
  purchased_100: 4,
  gifted_100: 3,
  complimentary_100: 2,
  included_50: 1,
};

export function nyDay(value) {
  if (value == null || value === '') return '';
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
}

export function legsFromScheduleTrips(trips) {
  if (!Array.isArray(trips)) return [];
  return trips.map((trip) => ({
    uid: String(trip?.uid || ''),
    tripId: normalizeTripId(trip?.info?.tripCode || trip?.tripCode || trip?.info?.tripId),
    start: trip?.start instanceof Date ? trip.start.toISOString() : (trip?.start || ''),
    end: trip?.end instanceof Date ? trip.end.toISOString() : (trip?.end || ''),
    tail: String(trip?.info?.tail || '').trim().toUpperCase(),
    from: String(trip?.info?.from || '').trim().toUpperCase(),
    to: String(trip?.info?.to || '').trim().toUpperCase(),
    aircraft: String(trip?.info?.aircraft || trip?.info?.aircraftType || '').trim(),
    customer: String(trip?.info?.customer || trip?.info?.broker || '').trim(),
    brokerEmail: String(trip?.info?.brokerEmail || trip?.info?.broker || '').trim().toLowerCase(),
    brokerPhone: String(trip?.info?.brokerPhone || '').trim(),
    contractAttached: false,
  })).filter((leg) => leg.uid);
}

export function mergeScheduleLegs(clientLegs, serverLegs) {
  const byUid = new Map();
  const put = (leg) => {
    if (!leg?.uid) return;
    const prev = byUid.get(leg.uid);
    if (!prev) {
      byUid.set(leg.uid, { ...leg });
      return;
    }
    const next = { ...prev };
    for (const [key, value] of Object.entries(leg)) {
      if (value === '' || value == null || value === false) continue;
      next[key] = value;
    }
    next.contractAttached = Boolean(prev.contractAttached || leg.contractAttached);
    next.tripId = leg.tripId || prev.tripId || '';
    byUid.set(leg.uid, next);
  };
  for (const leg of clientLegs || []) put(leg);
  for (const leg of serverLegs || []) put(leg);
  return [...byUid.values()];
}

function groupKey(leg) {
  const tripId = normalizeTripId(leg.tripId);
  if (tripId) return `trip:${tripId}`;
  return `leg:${leg.uid}`;
}

function earliest(members, field) {
  const stamps = members.map((leg) => leg[field]).filter(Boolean).sort();
  return stamps[0] || '';
}

function latest(members, field) {
  const stamps = members.map((leg) => leg[field]).filter(Boolean).sort();
  return stamps[stamps.length - 1] || '';
}

function routeOf(members) {
  const ordered = [...members].sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const points = [];
  for (const leg of ordered) {
    const from = String(leg.from || '').trim().toUpperCase();
    const to = String(leg.to || '').trim().toUpperCase();
    if (from && points[points.length - 1] !== from) points.push(from);
    if (to && points[points.length - 1] !== to) points.push(to);
  }
  return {
    route: points.join(' → '),
    routeFrom: points[0] || '',
    routeTo: points[points.length - 1] || '',
  };
}

function firstText(members, field) {
  for (const leg of members) {
    const value = String(leg[field] || '').trim();
    if (value) return value;
  }
  return '';
}

function coverageMatches(row, record) {
  const tripId = String(row.tripId || '').toUpperCase();
  const recordTrip = String(record?.tripId || '').toUpperCase();
  if (tripId && recordTrip && tripId === recordTrip) return true;
  const uids = new Set(row.legUids || []);
  if (record?.linkedTripUid && uids.has(record.linkedTripUid)) return true;
  return (record?.linkedTripUids || []).some((uid) => uids.has(uid));
}

function pickCoverage(matches) {
  if (!matches.length) return null;
  return [...matches].sort((a, b) => {
    const rank = (LEVEL_RANK[b.coverageLevel] || 0) - (LEVEL_RANK[a.coverageLevel] || 0);
    if (rank) return rank;
    return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  })[0];
}

function datesLabel(departDay, returnDay, coverage) {
  if (coverage?.datesLabel) return coverage.datesLabel;
  if (departDay && returnDay && departDay !== returnDay) return `${departDay} – ${returnDay}`;
  return departDay || returnDay || '';
}

export function buildTripRows(legs, records = []) {
  const groups = new Map();
  for (const leg of legs || []) {
    const key = groupKey(leg);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(leg);
  }
  const rows = [];
  for (const [key, members] of groups) {
    const ordered = [...members].sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const tripId = key.startsWith('trip:') ? key.slice(5) : '';
    const routing = routeOf(ordered);
    const departAt = earliest(ordered, 'start');
    const returnAt = latest(ordered, 'end') || latest(ordered, 'start');
    const departDay = nyDay(departAt);
    const returnDay = nyDay(returnAt);
    const row = {
      groupKey: key,
      tripId,
      legUids: ordered.map((leg) => leg.uid).filter(Boolean),
      legs: ordered.map((leg) => ({
        id: leg.uid || '',
        from: leg.from || '',
        to: leg.to || '',
        departAt: leg.start || '',
        tail: leg.tail || '',
      })),
      legCount: ordered.length,
      departAt,
      departDay,
      returnDay,
      route: routing.route,
      routeFrom: routing.routeFrom,
      routeTo: routing.routeTo,
      tail: firstText(ordered, 'tail'),
      aircraft: firstText(ordered, 'aircraft'),
      brokerCompany: firstText(ordered, 'customer'),
      brokerEmail: firstText(ordered, 'brokerEmail'),
      brokerPhone: firstText(ordered, 'brokerPhone'),
      contractStatus: ordered.some((leg) => leg.contractAttached) ? 'attached' : 'missing',
      tripTotal: null,
      coverageLevel: 'included_50',
      premium: null,
      paymentStatus: 'not_required',
      offerSentAt: '',
      bindEmailSentAt: '',
      cfsStatus: '',
      cfsConfirmedAt: '',
      cfsConfirmedByName: '',
      cfsConfirmedByEmail: '',
      cfsCostCents: null,
      cfsMarginCents: null,
      acceptedCoveragePercent: null,
      coverageLimitCents: null,
      coverageMultiplier: null,
      cfsReference: '',
      premiumCents: null,
      coverageId: '',
      electionContractPath: '',
      charterContractPath: '',
      upgradeAvailable: false,
      needsReview: false,
      uncertainFields: [],
      parserNotes: [],
    };
    const coverage = pickCoverage((records || []).filter((record) => coverageMatches(row, record)));
    if (coverage) {
      row.coverageId = coverage.id || '';
      row.brokerCompany = coverage.brokerCompany || row.brokerCompany;
      row.brokerEmail = coverage.brokerEmail || coverage.checkoutEmail || row.brokerEmail;
      row.tail = coverage.tail || row.tail;
      row.aircraft = coverage.aircraftType || row.aircraft;
      row.route = coverage.route || row.route;
      row.routeFrom = coverage.routeFrom || coverage.origin || row.routeFrom;
      row.routeTo = coverage.routeTo || coverage.destination || row.routeTo;
      row.tripTotal = coverage.tripTotal ?? null;
      row.coverageLevel = coverage.coverageLevel || 'included_50';
      row.premium = coverage.premium ?? null;
      row.paymentStatus = coverage.paymentStatus || 'not_required';
      row.offerSentAt = coverage.offerSentAt || coverage.coveredNoticeSentAt || coverage.includedNoticeSentAt || '';
      row.bindEmailSentAt = coverage.bindEmailSentAt || '';
      row.cfsStatus = coverage.cfsStatus || '';
      row.cfsConfirmedAt = coverage.cfsConfirmedAt || '';
      row.cfsConfirmedByName = coverage.cfsConfirmedByName || '';
      row.cfsConfirmedByEmail = coverage.cfsConfirmedByEmail || '';
      row.cfsCostCents = Number.isInteger(coverage.cfsCostCents) ? coverage.cfsCostCents : null;
      row.premiumCents = Number.isInteger(coverage.premiumCents) ? coverage.premiumCents : null;
      row.cfsMarginCents = Number.isInteger(coverage.cfsMarginCents)
        ? coverage.cfsMarginCents
        : (row.premiumCents != null && row.cfsCostCents != null ? row.premiumCents - row.cfsCostCents : null);
      row.acceptedCoveragePercent = coverage.cfsStatus === 'cfs_confirmed' ? 100 : (coverage.acceptedCoveragePercent ?? null);
      const economics = includedCoveragePatch(coverage);
      const priced = economics ? { ...coverage, ...economics } : coverage;
      row.coverageLimitCents = Number.isInteger(priced.coverageLimitCents)
        ? priced.coverageLimitCents
        : coverageLimitCentsFor(tripTotalCentsOf(priced), priced.coverageLevel, priced);
      row.coverageMultiplier = row.coverageLimitCents == null
        ? null
        : multiplierOr(
          priced.coverageMultiplier,
          isHundredCoverage(priced.coverageLevel) ? DEFAULT_UPGRADE_MULTIPLIER : DEFAULT_INCLUDED_MULTIPLIER,
        );
      row.cfsReference = coverage.cfsReference || '';
      row.electionContractPath = coverage.electionContractPath || '';
      row.charterContractPath = coverage.charterContractPath || '';
      row.upgradeAvailable = coverage.upgradeAvailable === true;
      row.needsReview = coverage.needsReview === true;
      row.uncertainFields = coverage.uncertainFields || [];
      row.parserNotes = coverage.parserNotes || [];
      if (contractIsOnTrip(coverage.contractAttachStatus) || row.contractStatus === 'attached') {
        row.contractStatus = 'attached';
      }
    }
    row.datesLabel = datesLabel(departDay, returnDay, coverage);
    rows.push(row);
  }
  return rows;
}

function lastLegDay(row) {
  return row.returnDay || row.departDay || '';
}

function inWindow(row, windowName, { from, to, now }) {
  const today = nyDay(now);
  const end = lastLegDay(row);
  const depart = row.departDay || '';
  if (windowName === 'all') return true;
  if (windowName === 'past') return Boolean(end) && end < today;
  if (windowName === 'range') {
    if (!depart) return false;
    if (from && depart < from) return false;
    if (to && depart > to) return false;
    return true;
  }
  return Boolean(end) && end >= today;
}

export function filterTripRows(rows, {
  search = '',
  window: windowName = 'current',
  from = '',
  to = '',
  contract = '',
  level = '',
  payment = '',
  aircraft = '',
  broker = '',
  cfs = '',
  now = new Date(),
} = {}) {
  const needle = String(search || '').trim().toLowerCase();
  const filtered = (rows || []).filter((row) => {
    if (!inWindow(row, windowName || 'current', { from, to, now })) return false;
    if (contract && row.contractStatus !== contract) return false;
    if (level && row.coverageLevel !== level) return false;
    if (payment && row.paymentStatus !== payment) return false;
    if (cfs === 'awaiting' && !(row.bindEmailSentAt && row.cfsStatus !== 'cfs_confirmed')) return false;
    if (cfs === 'confirmed' && row.cfsStatus !== 'cfs_confirmed') return false;
    if (aircraft && row.aircraft !== aircraft) return false;
    if (broker && row.brokerCompany !== broker) return false;
    if (!needle) return true;
    const haystack = [row.tripId, row.brokerCompany, row.brokerEmail, row.tail, row.aircraft, row.route, row.datesLabel]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
  const dir = windowName === 'past' ? -1 : 1;
  filtered.sort((a, b) => {
    const left = a.departDay || '9999-99-99';
    const right = b.departDay || '9999-99-99';
    if (left === right) return String(a.tripId).localeCompare(String(b.tripId));
    return left < right ? -dir : dir;
  });
  return filtered;
}

export function pageOfRows(rows, page, pageSize = TRIP_PAGE_SIZE) {
  const size = Math.max(1, pageSize);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(0, page), pages - 1);
  const start = current * size;
  return {
    page: current,
    pages,
    total,
    start,
    rows: rows.slice(start, start + size),
  };
}

export function distinctValues(rows, key) {
  return [...new Set((rows || []).map((row) => String(row[key] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function tripRowCsv(rows) {
  const header = [
    'Trip ID', 'Dates', 'Route', 'Tail', 'Aircraft', 'Broker company', 'Broker email',
    'Charter contract', 'Trip total', 'Coverage level', 'Premium', 'Payment status',
    'Offer sent', 'Bound to CFS', 'CFS confirmed', 'Accepted coverage percent',
    'Coverage limit cents', 'CFS cost cents', 'Margin cents',
  ];
  const lines = (rows || []).map((row) => [
    row.tripId,
    row.datesLabel,
    row.route,
    row.tail,
    row.aircraft,
    row.brokerCompany,
    row.brokerEmail,
    row.contractStatus === 'attached' ? 'attached' : 'missing',
    row.tripTotal == null ? '' : row.tripTotal,
    coverageLevelLabel(row.coverageLevel),
    premiumLabel({ coverageLevel: row.coverageLevel, premium: row.premium }),
    paymentStatusLabel(row.paymentStatus),
    row.offerSentAt || '',
    row.bindEmailSentAt || '',
    row.cfsStatus === 'cfs_confirmed' ? (row.cfsConfirmedAt || 'confirmed') : '',
    row.acceptedCoveragePercent ?? '',
    row.coverageLimitCents ?? '',
    row.cfsCostCents ?? '',
    row.cfsMarginCents ?? '',
  ].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\n');
}

export function rowsEligibleForComplimentary(rows, domain, now = new Date()) {
  const today = nyDay(now);
  return (rows || []).filter((row) => {
    if (!row.tripId || String(row.groupKey || '').startsWith('leg:')) return false;
    if (!isComplimentaryDomain(row.brokerEmail, [domain])) return false;
    if (!row.departDay || row.departDay < today) return false;
    if (HUNDRED.has(row.coverageLevel)) return false;
    return true;
  });
}

export function moneyOrDash(value) {
  if (value == null || value === '') return '—';
  return fmtMoney(value);
}
