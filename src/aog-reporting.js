// Reporting shape for AOG recovery. Amounts are integer cents plus a currency.
// Instants are UTC ISO strings here; the server stores those same instants as
// Firestore Timestamps as well. This module does not import Firebase.

import { emailDomain } from './aog-recovery.js';
import { normalizeTripId } from './trip-id.js';

export const COVERAGE_CURRENCY = 'usd';
// 50% is additional coverage on top of the trip total, so the included
// limit is 1.5×. The first default was 1×, which stored the trip total itself.
export const DEFAULT_INCLUDED_MULTIPLIER = 1.5;
export const LEGACY_INCLUDED_MULTIPLIER = 1;
export const DEFAULT_UPGRADE_MULTIPLIER = 2;
export const COVERAGE_VALUE_MULTIPLIER = DEFAULT_UPGRADE_MULTIPLIER;

const HUNDRED_COVERAGE = new Set(['purchased_100', 'gifted_100', 'complimentary_100']);

export function isHundredCoverage(level) {
  return HUNDRED_COVERAGE.has(level);
}

/** A coverage multiplier ops can edit. Invalid values fall back instead of throwing. */
export function multiplierOr(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 20) return fallback;
  return Math.round(n * 1000) / 1000;
}

/**
 * Included 50% multiplier. A stored 1× is the old default and becomes 1.5×
 * unless ops saved that 1× on purpose.
 */
export function includedMultiplierFrom(value, explicit = false) {
  if (!explicit && (value == null || value === '' || Number(value) === LEGACY_INCLUDED_MULTIPLIER)) {
    return DEFAULT_INCLUDED_MULTIPLIER;
  }
  return multiplierOr(value, DEFAULT_INCLUDED_MULTIPLIER);
}

export function requireCoverageMultiplier(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 20) {
    const error = new Error(`${label} must be greater than 0 and at most 20`);
    error.status = 400;
    throw error;
  }
  return Math.round(n * 1000) / 1000;
}

export function limitCentsForMultiplier(tripTotalCents, multiplier) {
  if (!Number.isInteger(tripTotalCents)) return null;
  const factor = multiplierOr(multiplier, null);
  if (factor == null) return null;
  const limit = Math.round(tripTotalCents * factor);
  return Number.isSafeInteger(limit) ? limit : null;
}

/**
 * Dollar limit for the coverage level on the record.
 * Included 50% uses the included multiplier (default 1.5× the trip total).
 * 100% uses the upgrade multiplier (default 2×).
 */
export function coverageLimitCentsFor(tripTotalCents, coverageLevel, multipliers = {}) {
  const included = multiplierOr(multipliers.includedMultiplier, DEFAULT_INCLUDED_MULTIPLIER);
  const upgrade = multiplierOr(multipliers.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER);
  if (isHundredCoverage(coverageLevel)) return limitCentsForMultiplier(tripTotalCents, upgrade);
  if (coverageLevel === 'included_50') return limitCentsForMultiplier(tripTotalCents, included);
  return null;
}

/** Dollar limit of the 100% option. */
export function hundredCoverageLimitCents(tripTotalCents, multiplier = DEFAULT_UPGRADE_MULTIPLIER) {
  return limitCentsForMultiplier(tripTotalCents, multiplier);
}

/** Included 50% limit and 100% upgrade limit for broker-facing comparison. */
export function coverageTierCents(record = {}) {
  const tripTotalCents = tripTotalCentsOf(record);
  const includedMultiplier = includedMultiplierFrom(record.includedMultiplier, record.includedMultiplierExplicit === true);
  const upgradeMultiplier = multiplierOr(record.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER);
  const stored = Number.isInteger(record.coverageLimitCents) ? record.coverageLimitCents : null;
  const hundred = isHundredCoverage(record.coverageLevel);
  const computedIncluded = limitCentsForMultiplier(tripTotalCents, includedMultiplier);
  const legacyIncludedLimit = !hundred
    && stored != null
    && tripTotalCents != null
    && stored === tripTotalCents
    && includedMultiplier !== LEGACY_INCLUDED_MULTIPLIER;
  return {
    includedMultiplier,
    upgradeMultiplier,
    includedCents: !hundred && stored != null && !legacyIncludedLimit ? stored : computedIncluded,
    upgradeCents: hundred && stored != null ? stored : limitCentsForMultiplier(tripTotalCents, upgradeMultiplier),
  };
}

/**
 * Patch for records still stored at the old 1× included default.
 * 100% limits stay on the upgrade multiplier. Returns null when nothing changes.
 */
export function includedCoveragePatch(record = {}) {
  if (record.includedMultiplierExplicit === true) return null;
  const includedMultiplier = includedMultiplierFrom(record.includedMultiplier, false);
  const upgradeMultiplier = multiplierOr(record.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER);
  const tripTotalCents = tripTotalCentsOf(record);
  const level = record.coverageLevel || '';
  const patch = {};
  if (Number(record.includedMultiplier) === LEGACY_INCLUDED_MULTIPLIER) {
    patch.includedMultiplier = includedMultiplier;
  }
  if (level === 'included_50' && tripTotalCents != null) {
    const limit = limitCentsForMultiplier(tripTotalCents, includedMultiplier);
    if (record.coverageLimitCents !== limit) patch.coverageLimitCents = limit;
    if (record.coverageMultiplier !== includedMultiplier) patch.coverageMultiplier = includedMultiplier;
    if (record.includedMultiplier == null) patch.includedMultiplier = includedMultiplier;
  }
  return Object.keys(patch).length ? patch : null;
}

export function tripTotalCentsOf(record = {}) {
  if (Number.isInteger(record.tripTotalCents)) return record.tripTotalCents;
  return dollarsToCents(record.tripTotal);
}

export const EVENT_TYPES = Object.freeze([
  'offer_sent',
  'contract_signed',
  'paid',
  'bound',
  'refunded',
  'broker_backfilled',
  'broker_mismatch',
  'cfs_acknowledged',
  'cfs_reminder_sent',
  'cfs_portal_opened',
]);

/** 100% was chosen by a purchase, a Skyway gift, or a complimentary domain. Included 50% is not an election. */
export function electionSourceFor(coverageLevel) {
  if (coverageLevel === 'purchased_100') return 'purchased';
  if (coverageLevel === 'gifted_100') return 'gifted';
  if (coverageLevel === 'complimentary_100') return 'complimentary_domain';
  return null;
}

export function dollarsToCents(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

/** 3-letter US codes are stored as ICAO with a K prefix. 4-letter codes are kept. */
export function toIcao(code) {
  const compact = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return '';
  if (/^[A-Z]{3}$/.test(compact)) return `K${compact}`;
  return compact;
}

export function normalizeCompanyName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function utcInstant(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

/** Airports in a chain: KAPF → KTEB → KAPF is 2 legs. */
export function legCountFromRoute(route, explicit) {
  const given = Number(explicit);
  if (Number.isInteger(given) && given > 0) return given;
  const airports = String(route || '').toUpperCase().match(/\b[A-Z0-9]{3,4}\b/g) || [];
  if (airports.length >= 2) return airports.length - 1;
  return null;
}

function paymentIntentId(reference) {
  const value = String(reference || '').trim();
  return value.startsWith('pi_') ? value : '';
}

/**
 * Canonical fields for one coverage record or one charter contract.
 * Dollar amounts on the input are converted to cents. Integer cents win when both are present.
 */
export function reportingFacts(input = {}) {
  const brokerEmail = String(input.brokerEmail || input.checkoutEmail || '').trim().toLowerCase().slice(0, 160);
  const tripTotalCents = Number.isInteger(input.tripTotalCents)
    ? input.tripTotalCents
    : dollarsToCents(input.tripTotal);
  const premiumCents = Number.isInteger(input.premiumCents)
    ? input.premiumCents
    : dollarsToCents(input.premium);
  const rate = input.ratePercent == null || input.ratePercent === '' ? null : Number(input.ratePercent);
  const coverageLevel = input.coverageLevel || 'included_50';
  const includedMultiplier = includedMultiplierFrom(input.includedMultiplier, input.includedMultiplierExplicit === true);
  const upgradeMultiplier = multiplierOr(input.upgradeMultiplier, DEFAULT_UPGRADE_MULTIPLIER);
  const coverageLimitCents = coverageLimitCentsFor(tripTotalCents, coverageLevel, { includedMultiplier, upgradeMultiplier });
  const coverageMultiplier = coverageLimitCents == null
    ? null
    : (isHundredCoverage(coverageLevel) ? upgradeMultiplier : includedMultiplier);
  return {
    currency: COVERAGE_CURRENCY,
    tripTotalCents,
    premiumCents,
    ratePercent: Number.isFinite(rate) ? rate : null,
    brokerCompany: normalizeCompanyName(input.brokerCompany),
    brokerEmail,
    brokerDomain: emailDomain(brokerEmail),
    aircraftType: String(input.aircraftType || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    tail: String(input.tail || '').replace(/\s+/g, '').toUpperCase().slice(0, 12),
    tripId: normalizeTripId(input.tripId),
    origin: toIcao(input.origin || input.routeFrom),
    destination: toIcao(input.destination || input.routeTo),
    legCount: legCountFromRoute(input.itinerary || input.route, input.legCount),
    coverageLevel,
    includedMultiplier,
    upgradeMultiplier,
    coverageLimitCents,
    coverageMultiplier,
    electionSource: input.electionSource === undefined ? electionSourceFor(coverageLevel) : input.electionSource,
    paymentStatus: String(input.paymentStatus || ''),
    stripeCheckoutSessionId: String(input.stripeCheckoutSessionId || '').slice(0, 120),
    stripePaymentIntentId: String(input.stripePaymentIntentId || paymentIntentId(input.stripeReference) || '').slice(0, 120),
    stripeEventId: String(input.stripeEventId || '').slice(0, 120),
    stripeRefundId: String(input.stripeRefundId || '').slice(0, 120),
    departAtUtc: utcInstant(input.departAtUtc || input.departDate),
    returnAtUtc: utcInstant(input.returnAtUtc || input.returnDate),
  };
}

/** Display dollars derived from canonical cents, so the two cannot be typed separately. */
export function dollarsFromCents(cents) {
  if (!Number.isInteger(cents)) return null;
  return cents / 100;
}

/**
 * Stable event document ids. offer_sent, contract_signed, and bound are one
 * row unless force is set (a resend). paid and refunded are one row per Stripe id.
 */
export function eventDocId(type, { stripePaymentIntentId, stripeEventId, stripeRefundId, atUtc, force } = {}) {
  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`Unknown coverage event: ${type}`);
  }
  if (type === 'paid') return `paid_${stripePaymentIntentId || stripeEventId || atUtc || 'unknown'}`;
  if (type === 'refunded') return `refunded_${stripeRefundId || stripeEventId || atUtc || 'unknown'}`;
  if (type === 'contract_signed') return 'contract_signed';
  if (type === 'broker_backfilled' || type === 'broker_mismatch' || type === 'cfs_acknowledged' || type === 'cfs_reminder_sent' || type === 'cfs_portal_opened') {
    return `${type}_${String(atUtc || '').replace(/[:.]/g, '')}`;
  }
  if (force) return `${type}_${String(atUtc || '').replace(/[:.]/g, '')}`;
  return type;
}

export function coverageEvent(input = {}) {
  const atUtc = utcInstant(input.atUtc || input.at) || new Date().toISOString();
  const facts = reportingFacts(input);
  const type = input.type;
  return {
    id: eventDocId(type, {
      stripePaymentIntentId: facts.stripePaymentIntentId,
      stripeEventId: facts.stripeEventId,
      stripeRefundId: facts.stripeRefundId,
      atUtc,
      force: input.force === true,
    }),
    type,
    atUtc,
    currency: COVERAGE_CURRENCY,
    amountCents: Number.isInteger(input.amountCents) ? input.amountCents : facts.premiumCents,
    tripId: facts.tripId,
    brokerDomain: facts.brokerDomain,
    aircraftType: facts.aircraftType,
    tail: facts.tail,
    coverageLevel: facts.coverageLevel,
    electionSource: facts.electionSource,
    paymentStatus: facts.paymentStatus,
    stripeCheckoutSessionId: facts.stripeCheckoutSessionId,
    stripePaymentIntentId: facts.stripePaymentIntentId,
    stripeEventId: facts.stripeEventId,
    stripeRefundId: facts.stripeRefundId,
    actor: String(input.actor || '').slice(0, 160),
    detail: String(input.detail || '').slice(0, 500),
  };
}
