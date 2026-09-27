// Reporting shape for AOG recovery. Amounts are integer cents plus a currency.
// Instants are UTC ISO strings here; the server stores those same instants as
// Firestore Timestamps as well. This module does not import Firebase.

import { emailDomain } from './aog-recovery.js';
import { normalizeTripId } from './trip-id.js';

export const COVERAGE_CURRENCY = 'usd';
export const COVERAGE_VALUE_MULTIPLIER = 2;

const HUNDRED_COVERAGE = new Set(['purchased_100', 'gifted_100', 'complimentary_100']);

export function isHundredCoverage(level) {
  return HUNDRED_COVERAGE.has(level);
}

/** 100% coverage is twice the contract trip total. Included 50% has no dollar limit here. */
export function coverageLimitCentsFor(tripTotalCents, coverageLevel) {
  if (!isHundredCoverage(coverageLevel)) return null;
  return hundredCoverageLimitCents(tripTotalCents);
}

/** Dollar limit of the 100% option, from the contract trip total. */
export function hundredCoverageLimitCents(tripTotalCents) {
  if (!Number.isInteger(tripTotalCents)) return null;
  const limit = tripTotalCents * COVERAGE_VALUE_MULTIPLIER;
  return Number.isSafeInteger(limit) ? limit : null;
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
  const coverageLimitCents = coverageLimitCentsFor(tripTotalCents, coverageLevel);
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
    coverageLimitCents,
    coverageMultiplier: coverageLimitCents == null ? null : COVERAGE_VALUE_MULTIPLIER,
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
  if (type === 'broker_backfilled' || type === 'broker_mismatch' || type === 'cfs_acknowledged') {
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
