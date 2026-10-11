// Live crew-board grouping for the administrator duty panel.
// Pure: no Firestore, no clock reads except the `now` the caller passes.

import { flightBuckets } from './duty-crew-change.js';
import { LIMITS } from './duty-limits.js';

function isOpenDuty(period) {
  return Boolean(
    period
    && period.status === 'on'
    && period.recordStatus !== 'superseded'
    && period.confirmStatus !== 'declined'
    && period.confirmStatus !== 'superseded',
  );
}

/**
 * Group open duty records into crews. A crew is two periods that point at
 * each other. Everyone else is shown alone, including a paired designation
 * whose partner link is missing or one-way.
 */
export function groupLiveCrew(periods) {
  const open = (periods || []).filter(isOpenDuty);
  const byId = new Map(open.map((period) => [period.id, period]));
  const used = new Set();
  const crews = [];
  for (const period of open) {
    if (used.has(period.id)) continue;
    const partner = period.partnerPeriodId ? byId.get(period.partnerPeriodId) : null;
    const reciprocal = Boolean(partner && partner.partnerPeriodId === period.id);
    if (partner && reciprocal) {
      used.add(period.id);
      used.add(partner.id);
      crews.push({
        id: [period.id, partner.id].sort().join('::'),
        members: [period, partner],
        tail: period.tail || partner.tail || null,
        linked: true,
        brokenLink: false,
      });
    } else {
      used.add(period.id);
      crews.push({
        id: period.id,
        members: [period],
        tail: period.tail || null,
        linked: false,
        brokenLink: Boolean(period.partnerPeriodId),
      });
    }
  }
  return crews;
}

/** Duty and flight time left on one open record, using segment buckets. */
export function crewLimitSnapshot(period, now = Date.now()) {
  const end = Number.isFinite(period?.dutyOffAt) ? period.dutyOffAt : now;
  const elapsedMs = Number.isFinite(period?.dutyOnAt) ? Math.max(0, end - period.dutyOnAt) : 0;
  const buckets = flightBuckets(period || {});
  const paired = period?.crewType === 'two' || period?.awaitingPartner === true || buckets.twoMs > 0;
  const flightLimitMs = paired && buckets.singleMs === 0
    ? LIMITS.TWO_PILOT_FLIGHT_MAX_MS
    : (buckets.twoMs > 0 && buckets.singleMs > 0
      ? LIMITS.TWO_PILOT_FLIGHT_MAX_MS
      : (period?.crewType === 'single' ? LIMITS.SINGLE_PILOT_FLIGHT_MAX_MS : LIMITS.TWO_PILOT_FLIGHT_MAX_MS));
  const flightMs = buckets.singleMs + buckets.twoMs;
  const dutyLimitMs = period?.assignmentType === 'regular' ? LIMITS.REGULAR_DUTY_MAX_MS : null;
  return {
    elapsedMs,
    remainingDutyMs: dutyLimitMs == null ? null : dutyLimitMs - elapsedMs,
    flightMs,
    flightLimitMs,
    remainingFlightMs: flightLimitMs - flightMs,
    singleMs: buckets.singleMs,
    twoMs: buckets.twoMs,
    pairedDesignation: period?.crewType === 'two' || period?.awaitingPartner === true,
  };
}
