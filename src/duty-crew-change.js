// Crew-change planning and segment-aware Part 135 flight-time limits.
//
// A linked duty-off used to close both pilots. That is correct only when the
// whole crew is done. A crew change ends the pilot who is leaving and leaves
// the pilot who is staying on the original duty-on time, then links the
// replacement. Flight time is judged per segment: time flown with two pilots
// counts against the 10-hour two-pilot limit in 14 CFR 135.267(b), not the
// 8-hour single-pilot limit. Rest after an excursion still follows 135.267(d)
// (11 / 12 / 16 hours). No new regulatory numbers are introduced.

import {
  EXTENDED_REST_TIER_1_MS,
  EXTENDED_REST_TIER_2_MS,
  EXTENDED_REST_TIER_3_MS,
  LIMITS,
  MS_PER_DAY,
  MS_PER_HR,
  REST_REQUIRED_BEFORE_MS,
  SINGLE_PILOT_FLIGHT_MAX_MS,
  TWO_PILOT_FLIGHT_MAX_MS,
  WARN_AT_FRACTION,
} from './duty-limits.js';

export const OCT1_CORRECTION_KEY = '2026-10-01-paired-crew-change';
const CONTINUITY_GAP_MS = 6 * MS_PER_HR;
const SHORT_GAP_MS = 2 * MS_PER_HR;
const PARTNER_CLOSE_NOTE = /crew-synced duty off|closed automatically when/i;

function audit({ by, at, field, from, to, note }) {
  return {
    by: by || 'unknown',
    at,
    field,
    from: from ?? null,
    to: to ?? null,
    note: note || null,
  };
}

function appendAudit(period, entry) {
  const prior = Array.isArray(period?.adminEdits) ? period.adminEdits : [];
  return [...prior, entry];
}

function otherRole(role) {
  const upper = String(role || '').toUpperCase();
  if (upper === 'PIC') return 'SIC';
  if (upper === 'SIC') return 'PIC';
  return 'SIC';
}

export function wasClosedByPartnerDutyOff(period) {
  if (!period || period.status === 'on') return false;
  if (period.closedByPartner === true) return true;
  if (period.closedByPartner === false) return false;
  const edits = Array.isArray(period.adminEdits) ? period.adminEdits : [];
  return edits.some((entry) => PARTNER_CLOSE_NOTE.test(String(entry?.note || '')));
}

export function segmentCountsAs(segment) {
  // 'awaiting' is a gap with no second pilot recorded yet, so it is not
  // two-pilot time. An explicit crewType of 'two' is two-pilot time,
  // including legacy paired records that predate segments.
  if (segment?.crewType === 'two') return 'two';
  return 'single';
}

export function segmentsOf(period) {
  if (Array.isArray(period?.crewSegments) && period.crewSegments.length > 0) {
    return period.crewSegments;
  }
  return [{
    id: `seg_${period?.dutyOnAt || 0}_${period?.crewType === 'two' ? 'two' : 'single'}`,
    crewType: period?.crewType === 'two' ? 'two' : 'single',
    partnerPeriodId: period?.partnerPeriodId || null,
    partnerUid: period?.partnerUid || null,
    partnerName: period?.partnerName || null,
    role: period?.role || null,
    startedAt: period?.dutyOnAt ?? null,
    endedAt: Number.isFinite(period?.dutyOffAt) ? period.dutyOffAt : null,
    flightTimeMs: Number(period?.flightTimeMs) || 0,
  }];
}

/**
 * Split one duty's flight time by the crew that actually flew it.
 * Two-pilot segments never enter the single-pilot bucket.
 * If segment flight times were not recorded and every segment is two-pilot
 * (or none is explicitly single), the period total counts as two-pilot.
 * An unsplit mix of explicit single and two-pilot segments counts as single,
 * because inventing a split could hide an 8-hour exceedance.
 */
export function flightBuckets(period) {
  const segments = segmentsOf(period);
  const explicit = segments.reduce(
    (sum, segment) => sum + Math.max(0, Number(segment.flightTimeMs) || 0),
    0,
  );
  const total = Math.max(0, Number(period?.flightTimeMs) || 0);
  const counts = segments.map(segmentCountsAs);
  const explicitSingle = segments.some((segment) => segment.crewType === 'single');
  const anyTwo = counts.includes('two');

  if (explicit === 0 && total > 0) {
    if (explicitSingle && anyTwo) {
      return { singleMs: total, twoMs: 0, source: 'unsplit-mixed-counted-as-single' };
    }
    if (!anyTwo) {
      return { singleMs: total, twoMs: 0, source: 'period-total-all-single-pilot' };
    }
    return { singleMs: 0, twoMs: total, source: 'period-total-no-explicit-single' };
  }

  let singleMs = 0;
  let twoMs = 0;
  segments.forEach((segment, index) => {
    const ms = Math.max(0, Number(segment.flightTimeMs) || 0);
    if (counts[index] === 'two') twoMs += ms;
    else singleMs += ms;
  });
  if (total > explicit) {
    const remainder = total - explicit;
    const openIndex = segments.findIndex((segment) => segment.endedAt == null);
    const target = openIndex >= 0 ? counts[openIndex] : counts[counts.length - 1];
    if (target === 'two') twoMs += remainder;
    else singleMs += remainder;
  }
  return { singleMs, twoMs, source: 'segments' };
}

export function extendedRestForPeriod(period) {
  const buckets = flightBuckets(period || {});
  const singleOver = buckets.singleMs - SINGLE_PILOT_FLIGHT_MAX_MS;
  const twoOver = buckets.twoMs - TWO_PILOT_FLIGHT_MAX_MS;
  let worstOver = 0;
  let which = null;
  if (singleOver > worstOver) {
    worstOver = singleOver;
    which = 'single';
  }
  if (twoOver > worstOver) {
    worstOver = twoOver;
    which = 'two';
  }
  if (worstOver <= 0) {
    return {
      requiredMs: REST_REQUIRED_BEFORE_MS,
      rule: '14 CFR 135.267(b)',
      extendedReason: null,
      overMs: 0,
      exceededCrew: null,
      buckets,
    };
  }
  const limitMs = which === 'two' ? TWO_PILOT_FLIGHT_MAX_MS : SINGLE_PILOT_FLIGHT_MAX_MS;
  const crewLabel = which === 'two' ? 'two-pilot' : 'single-pilot';
  let requiredMs = EXTENDED_REST_TIER_3_MS;
  let band = '>60 min flight-time excursion';
  if (worstOver <= 30 * 60 * 1000) {
    requiredMs = EXTENDED_REST_TIER_1_MS;
    band = '0–30 min flight-time excursion';
  } else if (worstOver <= 60 * 60 * 1000) {
    requiredMs = EXTENDED_REST_TIER_2_MS;
    band = '31–60 min flight-time excursion';
  }
  return {
    requiredMs,
    rule: '14 CFR 135.267(d)',
    extendedReason: `${band} over the ${limitMs / MS_PER_HR}h ${crewLabel} limit in 14 CFR 135.267(b)`,
    overMs: worstOver,
    exceededCrew: which,
    buckets,
  };
}

function bucketCheck({ code, crewLabel, totalMs, limitMs, exclusionNote }) {
  if (!(totalMs > 0)) return null;
  const hrs = totalMs / MS_PER_HR;
  const limitHrs = limitMs / MS_PER_HR;
  const details = {
    totalMs,
    limitMs,
    rule: '14 CFR 135.267(b)',
    crew: crewLabel,
  };
  if (totalMs > limitMs) {
    return {
      ok: false,
      severity: 'block',
      code,
      message: `${crewLabel} flight time in this 24h window: ${hrs.toFixed(1)}h exceeds the ${limitHrs}h limit. ${exclusionNote}14 CFR 135.267(b).`,
      details,
    };
  }
  if (totalMs > limitMs * WARN_AT_FRACTION) {
    return {
      ok: true,
      severity: 'warn',
      code,
      message: `${crewLabel} flight time in this 24h window: ${hrs.toFixed(1)}h of ${limitHrs}h. Approaching the 14 CFR 135.267(b) limit. ${exclusionNote}`,
      details,
    };
  }
  return {
    ok: true,
    severity: 'info',
    code,
    message: `${crewLabel} flight time in this 24h window: ${hrs.toFixed(1)}h / ${limitHrs}h. 14 CFR 135.267(b). ${exclusionNote}`,
    details,
  };
}

/**
 * 14 CFR 135.267(b), evaluated separately for each crew composition.
 * A period counts when its duty-on falls inside the 24h window — the same
 * simplification the rest of this engine already uses. Each period's flight
 * time is then split by segment. Two-pilot time is not added to the
 * single-pilot total. Outside commercial flying is added to both buckets
 * because it is flight time regardless of the Skyway crew.
 */
export function flightTimeChecks(periods, atTime, outsideFlying = []) {
  const windowEnd = atTime;
  const windowStart = atTime - MS_PER_DAY;
  let singleMs = 0;
  let twoMs = 0;
  for (const period of periods || []) {
    if (!period || !Number.isFinite(period.dutyOnAt)) continue;
    if (period.recordStatus === 'superseded' || period.confirmStatus === 'superseded') continue;
    if (period.dutyOnAt < windowStart || period.dutyOnAt >= windowEnd) continue;
    const buckets = flightBuckets(period);
    singleMs += buckets.singleMs;
    twoMs += buckets.twoMs;
  }
  for (const outside of outsideFlying || []) {
    if (!outside || !Number.isFinite(outside.startAt) || !outside.flightTimeMs) continue;
    if (outside.startAt < windowStart || outside.startAt >= windowEnd) continue;
    singleMs += outside.flightTimeMs;
    twoMs += outside.flightTimeMs;
  }
  const checks = [
    bucketCheck({
      code: 'FT_24H_SINGLE',
      crewLabel: 'Single-pilot',
      totalMs: singleMs,
      limitMs: SINGLE_PILOT_FLIGHT_MAX_MS,
      exclusionNote: 'Two-pilot segment time is not counted against this 8-hour limit. ',
    }),
    bucketCheck({
      code: 'FT_24H_TWO',
      crewLabel: 'Two-pilot',
      totalMs: twoMs,
      limitMs: TWO_PILOT_FLIGHT_MAX_MS,
      exclusionNote: 'Single-pilot segment time is not counted against this 10-hour limit. ',
    }),
  ].filter(Boolean);
  if (checks.length === 0) {
    return [{
      ok: true,
      severity: 'info',
      code: 'FT_24H',
      message: 'No flight time in the current 24h window. 14 CFR 135.267(b).',
      details: { rule: '14 CFR 135.267(b)', windowStart, windowEnd },
    }];
  }
  return checks;
}

export function restOutlook(periods, atTime) {
  const usable = (periods || []).filter((period) => (
    period
    && period.recordStatus !== 'superseded'
    && period.confirmStatus !== 'superseded'
    && period.confirmStatus !== 'declined'
    && period.confirmStatus !== 'pending'
    && Number.isFinite(period.dutyOffAt)
    && period.dutyOffAt <= atTime
  ));
  const last = usable.sort((a, b) => b.dutyOffAt - a.dutyOffAt)[0];
  if (!last) {
    return {
      requiredMs: REST_REQUIRED_BEFORE_MS,
      actualRestMs: null,
      blocked: false,
      rule: '14 CFR 135.267(b)',
      extendedReason: null,
      overMs: 0,
    };
  }
  const requirement = extendedRestForPeriod(last);
  const actualRestMs = atTime - last.dutyOffAt;
  return {
    ...requirement,
    actualRestMs,
    blocked: actualRestMs < requirement.requiredMs,
    dutyOffAt: last.dutyOffAt,
    flightTimeMs: last.flightTimeMs ?? 0,
    crewType: last.crewType || null,
  };
}

function cloneSegments(period) {
  return segmentsOf(period).map((segment) => ({ ...segment }));
}

function closeOpenSegment(segments, endedAt, periodFlightTotal) {
  const next = segments.map((segment) => ({ ...segment }));
  const open = [...next].reverse().find((segment) => segment.endedAt == null);
  if (!open) return next;
  const closedSum = next.reduce(
    (sum, segment) => sum + (segment.endedAt != null ? (Number(segment.flightTimeMs) || 0) : 0),
    0,
  );
  open.endedAt = endedAt;
  if (Number.isFinite(periodFlightTotal)) {
    open.flightTimeMs = Math.max(0, periodFlightTotal - closedSum);
  }
  return next;
}

function openSegment({ crewType, partnerPeriodId, partnerUid, partnerName, role, startedAt }) {
  return {
    id: `seg_${startedAt}_${crewType}_${partnerUid || 'none'}`,
    crewType,
    partnerPeriodId: partnerPeriodId || null,
    partnerUid: partnerUid || null,
    partnerName: partnerName || null,
    role: role || null,
    startedAt,
    endedAt: null,
    flightTimeMs: 0,
  };
}

export function resolveDutyEndScope({ hasOpenPartner, replacement, scope }) {
  const replacing = Boolean(replacement?.pilotUid);
  if (!hasOpenPartner) {
    if (scope === 'crew') {
      return {
        ok: false,
        status: 400,
        code: 'no-open-partner',
        error: 'There is no partner on duty to end with you.',
      };
    }
    return { ok: true, scope: 'self', reason: 'no-open-partner' };
  }
  if (replacing) {
    if (scope === 'crew') {
      return {
        ok: false,
        status: 400,
        code: 'crew-change-keeps-partner-on',
        error: 'A crew change ends only your duty. The pilot who is staying stays on duty with the original duty-on time.',
      };
    }
    return { ok: true, scope: 'self', reason: 'crew-change-defaults-to-own-duty' };
  }
  if (scope === 'self' || scope === 'crew') {
    return { ok: true, scope, reason: 'explicit' };
  }
  return {
    ok: false,
    status: 400,
    code: 'end-scope-required',
    error: 'Choose whether to end only your duty or the whole crew.',
  };
}

function periodOver14(period, dutyOffAt) {
  return Number.isFinite(period?.dutyOnAt)
    && Number.isFinite(dutyOffAt)
    && (dutyOffAt - period.dutyOnAt) > LIMITS.REGULAR_DUTY_MAX_MS;
}

function replacementPeriodId(replacement, joinAt, openPeriod) {
  if (openPeriod?.id) return openPeriod.id;
  return `${replacement.pilotUid}_${joinAt}`;
}

function blankDutyFields(source, extras) {
  return {
    excursionReason: null,
    overrideStatus: 'none',
    overrideRequestedBy: null,
    overrideRequestedAt: null,
    overrideRequestReason: null,
    overrideApprovedBy: null,
    overrideApprovedAt: null,
    overrideApprovalNotes: null,
    declinedAt: null,
    declinedReason: null,
    over14: false,
    over14VerifiedAt: null,
    over14VerifiedBy: null,
    over14VerificationSource: null,
    closedByPartner: false,
    awaitingPartner: false,
    recordStatus: null,
    ...extras,
    location: source.location || '',
    tail: source.tail || null,
    tripId: source.tripId || null,
    assignmentType: source.assignmentType || 'regular',
  };
}

/**
 * Plan a duty-off.
 * scope 'crew' closes the linked partner as well.
 * A replacement (crew change) forces scope 'self': the partner's dutyOnAt
 * is preserved, their period stays open, and the replacement is linked.
 */
export function planDutyOff({
  period,
  partner = null,
  dutyOffAt,
  flightTimeMs,
  excursionReason = null,
  scope,
  replacement = null,
  replacementOpenPeriod = null,
  actorName,
  now = Date.now(),
  over14Verified = false,
}) {
  if (!period?.id) return { ok: false, status: 400, error: 'period required' };
  if (period.status !== 'on') {
    return { ok: false, status: 409, code: 'already-closed', error: 'Duty period is already closed.' };
  }
  if (!Number.isFinite(dutyOffAt) || dutyOffAt <= period.dutyOnAt) {
    return { ok: false, status: 400, error: 'dutyOffAt must be after dutyOnAt' };
  }
  const partnerOpen = Boolean(
    partner?.id
    && partner.status === 'on'
    && partner.confirmStatus !== 'declined',
  );
  const decision = resolveDutyEndScope({
    hasOpenPartner: partnerOpen,
    replacement,
    scope,
  });
  if (!decision.ok) return decision;
  if (replacement?.pilotUid && replacement.pilotUid === period.pilotUid) {
    return { ok: false, status: 400, error: 'A pilot cannot replace themselves.' };
  }
  if (replacement?.pilotUid && partner && replacement.pilotUid === partner.pilotUid) {
    return { ok: false, status: 400, error: 'The replacement is already the linked partner.' };
  }
  if (
    replacementOpenPeriod?.partnerPeriodId
    && replacementOpenPeriod.partnerPeriodId !== partner?.id
    && replacementOpenPeriod.status === 'on'
  ) {
    return {
      ok: false,
      status: 409,
      error: 'The replacement is already paired with another pilot.',
    };
  }

  const closingPartner = decision.scope === 'crew' && partnerOpen;
  const initiatorOver14 = periodOver14(period, dutyOffAt);
  const partnerOffAt = closingPartner && dutyOffAt <= partner.dutyOnAt
    ? partner.dutyOnAt + 1
    : dutyOffAt;
  const partnerOver14 = closingPartner && periodOver14(partner, partnerOffAt);
  if ((initiatorOver14 || partnerOver14) && over14Verified !== true) {
    return {
      ok: false,
      status: 400,
      code: 'over14-verification-required',
      error: 'Confirm that this duty period actually exceeded 14 hours before ending duty',
    };
  }

  const ft = Number.isFinite(flightTimeMs) ? flightTimeMs : (Number(period.flightTimeMs) || 0);
  const callerSegments = closeOpenSegment(cloneSegments(period), dutyOffAt, ft);
  const callerNote = replacement?.pilotUid
    ? `Crew change: ended own duty so ${replacement.pilotName || 'the replacement'} can join. The other pilot's duty was not ended.`
    : decision.scope === 'self'
      ? 'Ended own duty only. Linked partner was left on duty.'
      : `Whole-crew duty off confirmed by ${actorName || 'pilot'}. Both pilots were intended to end.`;

  const writes = [{
    op: 'update',
    id: period.id,
    patch: {
      dutyOffAt,
      flightTimeMs: ft,
      excursionReason: excursionReason || period.excursionReason || null,
      status: 'off',
      over14: initiatorOver14,
      over14VerifiedAt: initiatorOver14 ? now : null,
      over14VerifiedBy: initiatorOver14 ? (actorName || period.pilotName || 'pilot') : null,
      over14VerificationSource: initiatorOver14 ? 'pilot-duty-off' : null,
      closedByPartner: false,
      endedScope: decision.scope,
      crewSegments: callerSegments,
      updatedAt: now,
      adminEdits: appendAudit(period, audit({
        by: actorName || period.pilotName || 'pilot',
        at: now,
        field: 'endDuty',
        from: { status: 'on', dutyOffAt: null, dutyOnAt: period.dutyOnAt, crewType: period.crewType || null },
        to: { status: 'off', dutyOffAt, dutyOnAt: period.dutyOnAt, endedScope: decision.scope },
        note: callerNote,
      })),
    },
  }];

  if (closingPartner) {
    const partnerSegments = closeOpenSegment(
      cloneSegments(partner),
      partnerOffAt,
      Number(partner.flightTimeMs) || 0,
    );
    writes.push({
      op: 'update',
      id: partner.id,
      patch: {
        dutyOffAt: partnerOffAt,
        status: 'off',
        over14: partnerOver14,
        over14VerifiedAt: partnerOver14 ? now : null,
        over14VerifiedBy: partnerOver14 ? (actorName || period.pilotName || 'pilot') : null,
        over14VerificationSource: partnerOver14 ? 'whole-crew-duty-off' : null,
        closedByPartner: false,
        endedScope: 'crew',
        crewSegments: partnerSegments,
        updatedAt: now,
        adminEdits: appendAudit(partner, audit({
          by: actorName || period.pilotName || 'pilot',
          at: now,
          field: 'endDuty',
          from: { status: 'on', dutyOffAt: null, dutyOnAt: partner.dutyOnAt },
          to: { status: 'off', dutyOffAt: partnerOffAt, dutyOnAt: partner.dutyOnAt, endedScope: 'crew' },
          note: `Whole-crew duty off confirmed by ${actorName || period.pilotName || 'pilot'}. Both pilots were intended to end.`,
        })),
      },
    });
  }

  if (decision.scope === 'self' && partnerOpen) {
    const joinAt = dutyOffAt;
    const replacementId = replacement?.pilotUid
      ? replacementPeriodId(replacement, joinAt, replacementOpenPeriod)
      : null;
    let partnerSegments = closeOpenSegment(
      cloneSegments(partner),
      joinAt,
      Number(partner.flightTimeMs) || 0,
    );
    if (replacementId) {
      partnerSegments = [
        ...partnerSegments,
        openSegment({
          crewType: 'two',
          partnerPeriodId: replacementId,
          partnerUid: replacement.pilotUid,
          partnerName: replacement.pilotName || null,
          role: partner.role || null,
          startedAt: Math.max(joinAt, Number(replacementOpenPeriod?.dutyOnAt) || joinAt),
        }),
      ];
    } else {
      partnerSegments = [
        ...partnerSegments,
        openSegment({
          crewType: 'awaiting',
          partnerPeriodId: null,
          partnerUid: null,
          partnerName: null,
          role: partner.role || null,
          startedAt: joinAt,
        }),
      ];
    }
    writes.push({
      op: 'update',
      id: partner.id,
      patch: {
        dutyOnAt: partner.dutyOnAt,
        dutyOffAt: null,
        status: 'on',
        crewType: 'two',
        partnerPeriodId: replacementId,
        awaitingPartner: !replacementId,
        closedByPartner: false,
        crewSegments: partnerSegments,
        updatedAt: now,
        adminEdits: appendAudit(partner, audit({
          by: actorName || period.pilotName || 'pilot',
          at: now,
          field: 'crewChange',
          from: {
            status: 'on',
            dutyOnAt: partner.dutyOnAt,
            dutyOffAt: null,
            partnerPeriodId: partner.partnerPeriodId || period.id,
            crewType: partner.crewType || null,
          },
          to: {
            status: 'on',
            dutyOnAt: partner.dutyOnAt,
            dutyOffAt: null,
            partnerPeriodId: replacementId,
            crewType: 'two',
          },
          note: replacementId
            ? `${actorName || period.pilotName || 'A pilot'} went off duty. This duty continues from the original duty-on, now paired with ${replacement.pilotName || 'the replacement'}.`
            : `${actorName || period.pilotName || 'A pilot'} went off duty. This duty stays open from the original duty-on until a replacement is linked.`,
        })),
      },
    });

    if (replacement?.pilotUid && replacementOpenPeriod?.id) {
      const partnerRole = otherRole(partner.role);
      let segments = cloneSegments(replacementOpenPeriod);
      if (segments.some((segment) => segment.endedAt == null)) {
        segments = closeOpenSegment(segments, joinAt, Number(replacementOpenPeriod.flightTimeMs) || 0);
      }
      segments.push(openSegment({
        crewType: 'two',
        partnerPeriodId: partner.id,
        partnerUid: partner.pilotUid,
        partnerName: partner.pilotName || null,
        role: replacement.role || replacementOpenPeriod.role || partnerRole,
        startedAt: joinAt,
      }));
      writes.push({
        op: 'update',
        id: replacementOpenPeriod.id,
        patch: {
          dutyOnAt: replacementOpenPeriod.dutyOnAt,
          crewType: 'two',
          partnerPeriodId: partner.id,
          awaitingPartner: false,
          crewSegments: segments,
          updatedAt: now,
          adminEdits: appendAudit(replacementOpenPeriod, audit({
            by: actorName || 'pilot',
            at: now,
            field: 'relink',
            from: {
              dutyOnAt: replacementOpenPeriod.dutyOnAt,
              crewType: replacementOpenPeriod.crewType || null,
              partnerPeriodId: replacementOpenPeriod.partnerPeriodId || null,
            },
            to: {
              dutyOnAt: replacementOpenPeriod.dutyOnAt,
              crewType: 'two',
              partnerPeriodId: partner.id,
            },
            note: 'Joined a crew change. Original duty-on time preserved.',
          })),
        },
      });
    } else if (replacement?.pilotUid) {
      const role = replacement.role || otherRole(partner.role);
      const created = blankDutyFields(partner, {
        id: replacementId,
        pilotUid: replacement.pilotUid,
        pilotName: replacement.pilotName || 'Unknown',
        role,
        crewType: 'two',
        fitForDuty: null,
        priorRestMs: null,
        dutyOnAt: joinAt,
        dutyOffAt: null,
        flightTimeMs: 0,
        confirmStatus: 'pending',
        partnerPeriodId: partner.id,
        pendingCreatedBy: period.pilotUid || null,
        confirmedAt: null,
        crewSegments: [openSegment({
          crewType: 'two',
          partnerPeriodId: partner.id,
          partnerUid: partner.pilotUid,
          partnerName: partner.pilotName || null,
          role,
          startedAt: joinAt,
        })],
        adminEdits: [audit({
          by: actorName || period.pilotName || 'pilot',
          at: now,
          field: 'crewChange',
          from: null,
          to: { status: 'on', dutyOnAt: joinAt, crewType: 'two', partnerPeriodId: partner.id },
          note: `Joined ${partner.pilotName || 'the remaining pilot'} at a crew change. Their original duty-on was not changed.`,
        })],
        createdAt: now,
        updatedAt: now,
        status: 'on',
      });
      writes.push({ op: 'create', id: replacementId, doc: created });
    }
  }

  return {
    ok: true,
    scope: decision.scope,
    scopeReason: decision.reason,
    initiatorOver14,
    partnerOver14: Boolean(partnerOver14),
    writes,
  };
}

/**
 * Link a new partner onto a duty that is still open, or onto a duty a
 * partner's paired duty-off closed by mistake. The stayer's dutyOnAt does
 * not move. A single-pilot period becomes paired from joinAt forward; flight
 * time already recorded stays on the single-pilot segment.
 */
export function planRelink({
  stayer,
  partnerUser,
  partnerOpenPeriod = null,
  joinAt,
  actorName,
  now = Date.now(),
}) {
  if (!stayer?.id) return { ok: false, status: 400, error: 'period required' };
  if (!partnerUser?.pilotUid) return { ok: false, status: 400, error: 'replacement pilot required' };
  if (partnerUser.pilotUid === stayer.pilotUid) {
    return { ok: false, status: 400, error: 'A pilot cannot pair with themselves.' };
  }
  if (!Number.isFinite(joinAt) || joinAt < stayer.dutyOnAt) {
    return { ok: false, status: 400, error: 'Replacement join time must be at or after the original duty-on.' };
  }
  if (
    partnerOpenPeriod?.partnerPeriodId
    && partnerOpenPeriod.partnerPeriodId !== stayer.id
    && partnerOpenPeriod.crewType === 'two'
    && partnerOpenPeriod.status === 'on'
  ) {
    return { ok: false, status: 409, error: 'That pilot is already paired with someone else.' };
  }

  const resuming = stayer.status !== 'on';
  if (resuming && !wasClosedByPartnerDutyOff(stayer)) {
    return {
      ok: false,
      status: 409,
      code: 'not-partner-closed',
      error: 'This duty was not ended by a partner. Start a new duty period instead of reopening it.',
    };
  }

  const partnerId = replacementPeriodId(partnerUser, joinAt, partnerOpenPeriod);
  let segments = cloneSegments(stayer);
  if (segments.some((segment) => segment.endedAt == null)) {
    segments = closeOpenSegment(segments, joinAt, Number(stayer.flightTimeMs) || 0);
  }
  segments.push(openSegment({
    crewType: 'two',
    partnerPeriodId: partnerId,
    partnerUid: partnerUser.pilotUid,
    partnerName: partnerUser.pilotName || null,
    role: stayer.role || null,
    startedAt: joinAt,
  }));

  const from = {
    status: stayer.status,
    dutyOnAt: stayer.dutyOnAt,
    dutyOffAt: stayer.dutyOffAt ?? null,
    crewType: stayer.crewType || null,
    partnerPeriodId: stayer.partnerPeriodId || null,
  };
  const writes = [{
    op: 'update',
    id: stayer.id,
    patch: {
      status: 'on',
      dutyOnAt: stayer.dutyOnAt,
      dutyOffAt: null,
      crewType: 'two',
      partnerPeriodId: partnerId,
      awaitingPartner: false,
      closedByPartner: false,
      resumedAt: resuming ? now : (stayer.resumedAt || null),
      resumedFromDutyOffAt: resuming ? (stayer.dutyOffAt ?? null) : (stayer.resumedFromDutyOffAt || null),
      crewSegments: segments,
      updatedAt: now,
      adminEdits: appendAudit(stayer, audit({
        by: actorName || stayer.pilotName || 'pilot',
        at: now,
        field: resuming ? 'resumeContinuousDuty' : 'relink',
        from,
        to: {
          status: 'on',
          dutyOnAt: stayer.dutyOnAt,
          dutyOffAt: null,
          crewType: 'two',
          partnerPeriodId: partnerId,
        },
        note: resuming
          ? `Resumed one continuous duty after a partner duty-off. Original duty-on preserved and paired with ${partnerUser.pilotName || 'the new partner'}.`
          : `Paired with ${partnerUser.pilotName || 'a new partner'} without starting a new duty. Original duty-on preserved.`,
      })),
    },
  }];

  if (partnerOpenPeriod?.id) {
    let partnerSegments = cloneSegments(partnerOpenPeriod);
    if (partnerSegments.some((segment) => segment.endedAt == null)) {
      partnerSegments = closeOpenSegment(
        partnerSegments,
        joinAt,
        Number(partnerOpenPeriod.flightTimeMs) || 0,
      );
    }
    partnerSegments.push(openSegment({
      crewType: 'two',
      partnerPeriodId: stayer.id,
      partnerUid: stayer.pilotUid,
      partnerName: stayer.pilotName || null,
      role: partnerOpenPeriod.role || otherRole(stayer.role),
      startedAt: Math.max(joinAt, partnerOpenPeriod.dutyOnAt || joinAt),
    }));
    writes.push({
      op: 'update',
      id: partnerOpenPeriod.id,
      patch: {
        dutyOnAt: partnerOpenPeriod.dutyOnAt,
        crewType: 'two',
        partnerPeriodId: stayer.id,
        awaitingPartner: false,
        crewSegments: partnerSegments,
        updatedAt: now,
        adminEdits: appendAudit(partnerOpenPeriod, audit({
          by: actorName || 'pilot',
          at: now,
          field: 'relink',
          from: {
            dutyOnAt: partnerOpenPeriod.dutyOnAt,
            crewType: partnerOpenPeriod.crewType || null,
            partnerPeriodId: partnerOpenPeriod.partnerPeriodId || null,
          },
          to: {
            dutyOnAt: partnerOpenPeriod.dutyOnAt,
            crewType: 'two',
            partnerPeriodId: stayer.id,
          },
          note: 'Converted to a two-pilot crew. Original duty-on time preserved.',
        })),
      },
    });
  } else {
    const role = partnerUser.role || otherRole(stayer.role);
    writes.push({
      op: 'create',
      id: partnerId,
      doc: blankDutyFields(stayer, {
        id: partnerId,
        pilotUid: partnerUser.pilotUid,
        pilotName: partnerUser.pilotName || 'Unknown',
        role,
        crewType: 'two',
        fitForDuty: null,
        priorRestMs: null,
        dutyOnAt: joinAt,
        dutyOffAt: null,
        flightTimeMs: 0,
        confirmStatus: 'pending',
        partnerPeriodId: stayer.id,
        pendingCreatedBy: stayer.pilotUid || null,
        confirmedAt: null,
        crewSegments: [openSegment({
          crewType: 'two',
          partnerPeriodId: stayer.id,
          partnerUid: stayer.pilotUid,
          partnerName: stayer.pilotName || null,
          role,
          startedAt: joinAt,
        })],
        adminEdits: [audit({
          by: actorName || stayer.pilotName || 'pilot',
          at: now,
          field: 'relink',
          from: null,
          to: { status: 'on', dutyOnAt: joinAt, crewType: 'two', partnerPeriodId: stayer.id },
          note: `Linked onto ${stayer.pilotName || 'the on-duty pilot'}. Their original duty-on was preserved.`,
        })],
        createdAt: now,
        updatedAt: now,
        status: 'on',
      }),
    });
  }

  return { ok: true, resuming, writes };
}

export function snapshotDuty(period) {
  if (!period) return null;
  return {
    id: period.id || null,
    pilotUid: period.pilotUid || null,
    pilotName: period.pilotName || null,
    dutyOnAt: period.dutyOnAt ?? null,
    dutyOffAt: period.dutyOffAt ?? null,
    status: period.status || null,
    crewType: period.crewType || null,
    flightTimeMs: Number(period.flightTimeMs) || 0,
    partnerPeriodId: period.partnerPeriodId || null,
    recordStatus: period.recordStatus || null,
    role: period.role || null,
  };
}

export function etDayBounds(year, month, day) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const partsOf = (ms) => {
    const map = {};
    for (const part of formatter.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }
    return map;
  };
  const matches = (ms, y, m, d, hour, minute) => {
    const parts = partsOf(ms);
    return Number(parts.year) === y
      && Number(parts.month) === m
      && Number(parts.day) === d
      && Number(parts.hour) === hour
      && Number(parts.minute) === minute;
  };
  let start = null;
  const scanFrom = Date.UTC(year, month - 1, day - 1, 0, 0, 0);
  const scanTo = Date.UTC(year, month - 1, day + 1, 12, 0, 0);
  for (let t = scanFrom; t < scanTo; t += 60_000) {
    if (matches(t, year, month, day, 0, 0)) {
      start = t;
      break;
    }
  }
  if (start == null) throw new Error(`Could not resolve Eastern midnight for ${year}-${month}-${day}`);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  let end = null;
  for (let t = start + 20 * MS_PER_HR; t < start + 30 * MS_PER_HR; t += 60_000) {
    if (matches(t, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0)) {
      end = t;
      break;
    }
  }
  if (end == null) end = start + MS_PER_DAY;
  return { start, end };
}

function displayName(user) {
  return user?.name || user?.displayName || user?.jetinsightName || user?.email || user?.uid || user?.id || '';
}

function firstToken(value) {
  return String(value || '').trim().toLowerCase().split(/\s+/)[0] || '';
}

export function findPilotsByFirstName(users, firstNames) {
  const wanted = new Set(firstNames.map((name) => name.toLowerCase()));
  return (users || []).filter((user) => {
    const candidates = [user?.name, user?.displayName, user?.jetinsightName];
    return candidates.some((candidate) => wanted.has(firstToken(candidate)));
  });
}

function overlapsInterval(period, start, end, now) {
  if (!period || !Number.isFinite(period.dutyOnAt)) return false;
  const off = Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : now;
  return period.dutyOnAt < end && off > start;
}

function canMergeContinuous(sorted) {
  if (sorted.length <= 1) return true;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const prevEnd = Number.isFinite(prev.dutyOffAt) ? prev.dutyOffAt : sorted[i].dutyOnAt;
    const gap = sorted[i].dutyOnAt - prevEnd;
    if (gap <= 0) continue;
    if (wasClosedByPartnerDutyOff(prev) && gap <= CONTINUITY_GAP_MS) continue;
    if (gap <= SHORT_GAP_MS) continue;
    return false;
  }
  return true;
}

function limitsReport(periods, atTime) {
  const rest = restOutlook(periods, atTime);
  const flight = flightTimeChecks(periods, atTime);
  return {
    at: atTime,
    rest: {
      requiredMs: rest.requiredMs,
      actualRestMs: rest.actualRestMs,
      blocked: rest.blocked,
      rule: rest.rule,
      extendedReason: rest.extendedReason,
      overMs: rest.overMs,
    },
    flight: flight.map((check) => ({
      code: check.code,
      severity: check.severity,
      message: check.message,
      rule: check.details?.rule || null,
    })),
    blocked: Boolean(rest.blocked) || flight.some((check) => check.severity === 'block'),
  };
}

/**
 * Plan the Oct 1, 2026 Matt / Daniel / Kameron correction.
 * Does not write. Callers print the plan, then apply it only on request.
 */
export function planOct1CrewCorrection({
  users = [],
  periods = [],
  now = Date.now(),
  actorName = 'oct1-crew-correction',
}) {
  const day = etDayBounds(2026, 10, 1);
  const nextDay = etDayBounds(2026, 10, 2);
  const morningSignOn = nextDay.start + 8 * MS_PER_HR;
  const names = {
    matt: ['matt', 'matthew'],
    daniel: ['daniel'],
    kameron: ['kameron'],
  };
  const matches = {
    matt: findPilotsByFirstName(users, names.matt),
    daniel: findPilotsByFirstName(users, names.daniel),
    kameron: findPilotsByFirstName(users, names.kameron),
  };
  const describeUser = (user) => ({
    uid: user.uid || user.id || null,
    name: displayName(user),
    role: user.role || null,
  });
  const pilots = {
    matt: { matches: matches.matt.map(describeUser), periods: [] },
    daniel: { matches: matches.daniel.map(describeUser), periods: [] },
    kameron: { matches: matches.kameron.map(describeUser), periods: [] },
  };
  const unique = (key) => (matches[key].length === 1 ? matches[key][0] : null);
  const mattUser = unique('matt');
  const danielUser = unique('daniel');
  const kameronUser = unique('kameron');
  const uidOf = (user) => user?.uid || user?.id || null;

  const forPilot = (user) => {
    const uid = uidOf(user);
    if (!uid) return [];
    return periods
      .filter((period) => (
        period
        && period.pilotUid === uid
        && period.recordStatus !== 'superseded'
        && overlapsInterval(period, day.start, day.end, now)
      ))
      .sort((a, b) => a.dutyOnAt - b.dutyOnAt);
  };
  const mattPeriods = forPilot(mattUser);
  const danielPeriods = forPilot(danielUser);
  const kameronPeriods = forPilot(kameronUser);
  pilots.matt.periods = mattPeriods.map(snapshotDuty);
  pilots.daniel.periods = danielPeriods.map(snapshotDuty);
  pilots.kameron.periods = kameronPeriods.map(snapshotDuty);

  const base = {
    incidentDate: '2026-10-01',
    timeZone: 'America/New_York',
    dayStart: day.start,
    dayEnd: day.end,
    pilots,
    writes: [],
    changes: [],
    applicable: false,
    alreadyApplied: false,
    continuous: false,
    warnings: [],
  };

  const missing = ['matt', 'daniel', 'kameron'].filter((key) => matches[key].length !== 1);
  if (missing.length) {
    return {
      ...base,
      reason: `No records will change until each pilot matches exactly one user. Unresolved: ${missing.join(', ')}.`,
    };
  }
  if (mattPeriods.length === 0) {
    return { ...base, reason: 'No Oct 1 duty record found for Matt.' };
  }
  const already = [...mattPeriods, ...danielPeriods, ...kameronPeriods]
    .some((period) => period.correctionKey === OCT1_CORRECTION_KEY);
  if (already) {
    return {
      ...base,
      alreadyApplied: true,
      reason: 'This Oct 1 correction is already recorded. No further changes.',
    };
  }

  const continuous = canMergeContinuous(mattPeriods);
  const surviving = mattPeriods[0];
  const last = mattPeriods[mattPeriods.length - 1];
  const anyOpen = mattPeriods.some((period) => period.status === 'on' || !Number.isFinite(period.dutyOffAt));
  const dutyOffAt = anyOpen
    ? null
    : Math.max(...mattPeriods.map((period) => period.dutyOffAt).filter(Number.isFinite));
  const dutyOnAt = surviving.dutyOnAt;
  const flightTimeMs = mattPeriods.reduce((sum, period) => sum + (Number(period.flightTimeMs) || 0), 0);
  const daniel = danielPeriods[0] || null;
  const kameron = kameronPeriods[0] || null;
  let boundary = null;
  if (Number.isFinite(kameron?.dutyOnAt) && kameron.dutyOnAt > dutyOnAt && (dutyOffAt == null || kameron.dutyOnAt < dutyOffAt)) {
    boundary = kameron.dutyOnAt;
  } else if (Number.isFinite(daniel?.dutyOffAt) && daniel.dutyOffAt > dutyOnAt && (dutyOffAt == null || daniel.dutyOffAt < dutyOffAt)) {
    boundary = daniel.dutyOffAt;
  }

  const useContinuous = continuous;
  const warnings = [];
  if (!useContinuous) {
    warnings.push('Matt\'s Oct 1 times do not show one continuous duty, so the records stay separate and only the crew composition is corrected.');
  }
  if (!daniel) warnings.push('No Oct 1 duty record was found for Daniel. His times were not invented.');
  if (!kameron) warnings.push('No Oct 1 duty record was found for Kameron. A paired record will be created from the crew-change time with zero flight time, because his block time was not on file.');
  if (mattPeriods.length > 1) {
    warnings.push(`Matt's flight time is the sum of his Oct 1 records (${(flightTimeMs / MS_PER_HR).toFixed(1)}h). If the later single-pilot record already included the whole day, review that sum before apply.`);
  }

  const kameronId = kameron?.id || `${uidOf(kameronUser)}_${boundary || dutyOnAt}`;
  const danielId = daniel?.id || null;
  let firstFt = 0;
  let secondFt = 0;
  if (mattPeriods.length > 1 && boundary != null) {
    for (const period of mattPeriods) {
      if (period.dutyOnAt >= boundary) secondFt += Number(period.flightTimeMs) || 0;
      else firstFt += Number(period.flightTimeMs) || 0;
    }
  }

  const mattSegments = [];
  if (useContinuous && boundary != null) {
    mattSegments.push({
      id: `seg_${dutyOnAt}_two_${uidOf(danielUser) || 'daniel'}`,
      crewType: 'two',
      partnerPeriodId: danielId,
      partnerUid: uidOf(danielUser),
      partnerName: displayName(danielUser),
      role: surviving.role || 'SIC',
      startedAt: dutyOnAt,
      endedAt: boundary,
      flightTimeMs: mattPeriods.length > 1 ? firstFt : 0,
    });
    mattSegments.push({
      id: `seg_${boundary}_two_${uidOf(kameronUser)}`,
      crewType: 'two',
      partnerPeriodId: kameronId,
      partnerUid: uidOf(kameronUser),
      partnerName: displayName(kameronUser),
      role: surviving.role || 'SIC',
      startedAt: boundary,
      endedAt: dutyOffAt,
      flightTimeMs: mattPeriods.length > 1 ? secondFt : 0,
    });
  } else if (useContinuous) {
    mattSegments.push({
      id: `seg_${dutyOnAt}_two_${uidOf(kameronUser)}`,
      crewType: 'two',
      partnerPeriodId: kameronId,
      partnerUid: uidOf(kameronUser),
      partnerName: displayName(kameronUser),
      role: surviving.role || 'SIC',
      startedAt: dutyOnAt,
      endedAt: dutyOffAt,
      flightTimeMs: 0,
    });
  }

  const correctedMatt = useContinuous ? {
    ...surviving,
    dutyOnAt,
    dutyOffAt,
    status: dutyOffAt == null ? 'on' : 'off',
    crewType: 'two',
    flightTimeMs,
    partnerPeriodId: kameronId,
    closedByPartner: false,
    awaitingPartner: false,
    crewSegments: mattSegments,
    recordStatus: null,
    correctionKey: OCT1_CORRECTION_KEY,
  } : null;

  const beforePeriods = mattPeriods;
  const afterPeriods = useContinuous
    ? [correctedMatt]
    : mattPeriods.map((period) => ({
      ...period,
      crewType: 'two',
      correctionKey: OCT1_CORRECTION_KEY,
    }));

  const beforeMorning = limitsReport(beforePeriods, morningSignOn);
  const afterMorning = limitsReport(afterPeriods, morningSignOn);
  const beforeNow = limitsReport(beforePeriods, now);
  const afterNow = limitsReport(afterPeriods, now);
  const wrongSixteen = beforeMorning.rest.requiredMs >= EXTENDED_REST_TIER_3_MS
    && afterMorning.rest.requiredMs === REST_REQUIRED_BEFORE_MS;
  const signOnAllowed = !afterMorning.blocked;

  const changes = [];
  const writes = [];
  const note = 'Oct 1 crew-change correction. Matt stayed on a two-pilot crew, Daniel for the first part and Kameron for the rest. Actual duty and flight times were preserved. 14 CFR 135.267(b) two-pilot 10h limit; the single-pilot 8h limit and 135.267(d) 16h rest do not apply to two-pilot time.';

  if (useContinuous) {
    const excursionStill = extendedRestForPeriod(correctedMatt).overMs > 0;
    changes.push({
      id: surviving.id,
      op: 'update',
      pilotName: surviving.pilotName || displayName(mattUser),
      before: snapshotDuty(surviving),
      after: snapshotDuty(correctedMatt),
    });
    writes.push({
      op: 'update',
      id: surviving.id,
      patch: {
        dutyOnAt,
        dutyOffAt,
        status: dutyOffAt == null ? 'on' : 'off',
        crewType: 'two',
        flightTimeMs,
        partnerPeriodId: kameronId,
        closedByPartner: false,
        awaitingPartner: false,
        crewSegments: mattSegments,
        recordStatus: null,
        correctionKey: OCT1_CORRECTION_KEY,
        excursionReason: excursionStill ? (surviving.excursionReason || null) : null,
        updatedAt: now,
        adminEdits: appendAudit(surviving, audit({
          by: actorName,
          at: now,
          field: 'oct1-crew-correction',
          from: snapshotDuty(surviving),
          to: snapshotDuty(correctedMatt),
          note,
        })),
      },
    });
    for (const extra of mattPeriods.slice(1)) {
      const after = {
        ...snapshotDuty(extra),
        recordStatus: 'superseded',
      };
      changes.push({
        id: extra.id,
        op: 'update',
        pilotName: extra.pilotName || displayName(mattUser),
        before: snapshotDuty(extra),
        after,
      });
      writes.push({
        op: 'update',
        id: extra.id,
        patch: {
          recordStatus: 'superseded',
          supersededBy: surviving.id,
          correctionKey: OCT1_CORRECTION_KEY,
          updatedAt: now,
          adminEdits: appendAudit(extra, audit({
            by: actorName,
            at: now,
            field: 'oct1-crew-correction',
            from: snapshotDuty(extra),
            to: after,
            note: `Superseded by ${surviving.id} so Matt's Oct 1 duty is one continuous two-pilot period. Times on this record were kept for the audit and are excluded from legality.`,
          })),
        },
      });
    }
  } else {
    for (const period of mattPeriods) {
      const afterPeriod = { ...period, crewType: 'two', correctionKey: OCT1_CORRECTION_KEY };
      changes.push({
        id: period.id,
        op: 'update',
        pilotName: period.pilotName || displayName(mattUser),
        before: snapshotDuty(period),
        after: snapshotDuty(afterPeriod),
      });
      writes.push({
        op: 'update',
        id: period.id,
        patch: {
          crewType: 'two',
          correctionKey: OCT1_CORRECTION_KEY,
          updatedAt: now,
          adminEdits: appendAudit(period, audit({
            by: actorName,
            at: now,
            field: 'oct1-crew-correction',
            from: snapshotDuty(period),
            to: snapshotDuty(afterPeriod),
            note,
          })),
        },
      });
    }
  }

  if (daniel && daniel.partnerPeriodId !== surviving.id) {
    const after = { ...snapshotDuty(daniel), partnerPeriodId: surviving.id, crewType: 'two' };
    changes.push({
      id: daniel.id,
      op: 'update',
      pilotName: daniel.pilotName || displayName(danielUser),
      before: snapshotDuty(daniel),
      after,
    });
    writes.push({
      op: 'update',
      id: daniel.id,
      patch: {
        partnerPeriodId: surviving.id,
        crewType: daniel.crewType === 'single' ? 'two' : (daniel.crewType || 'two'),
        correctionKey: OCT1_CORRECTION_KEY,
        updatedAt: now,
        adminEdits: appendAudit(daniel, audit({
          by: actorName,
          at: now,
          field: 'oct1-crew-correction',
          from: snapshotDuty(daniel),
          to: after,
          note: 'Linked as Matt\'s partner for the first part of Oct 1. Daniel\'s duty-on, duty-off, and flight time were not changed.',
        })),
      },
    });
  } else if (daniel) {
    writes.push({
      op: 'update',
      id: daniel.id,
      patch: {
        correctionKey: OCT1_CORRECTION_KEY,
        updatedAt: now,
        adminEdits: appendAudit(daniel, audit({
          by: actorName,
          at: now,
          field: 'oct1-crew-correction',
          from: snapshotDuty(daniel),
          to: snapshotDuty(daniel),
          note: 'Reviewed for the Oct 1 crew change. Duty-on, duty-off, and flight time already matched and were left as recorded.',
        })),
      },
    });
    changes.push({
      id: daniel.id,
      op: 'update',
      pilotName: daniel.pilotName || displayName(danielUser),
      before: snapshotDuty(daniel),
      after: snapshotDuty(daniel),
    });
  }

  if (kameron) {
    const after = {
      ...snapshotDuty(kameron),
      crewType: 'two',
      partnerPeriodId: surviving.id,
    };
    changes.push({
      id: kameron.id,
      op: 'update',
      pilotName: kameron.pilotName || displayName(kameronUser),
      before: snapshotDuty(kameron),
      after,
    });
    writes.push({
      op: 'update',
      id: kameron.id,
      patch: {
        crewType: 'two',
        partnerPeriodId: surviving.id,
        correctionKey: OCT1_CORRECTION_KEY,
        updatedAt: now,
        adminEdits: appendAudit(kameron, audit({
          by: actorName,
          at: now,
          field: 'oct1-crew-correction',
          from: snapshotDuty(kameron),
          to: after,
          note: 'Linked as Matt\'s partner for the rest of Oct 1. Kameron\'s duty-on, duty-off, and flight time were not changed.',
        })),
      },
    });
  } else {
    const joinAt = boundary || dutyOnAt;
    const doc = blankDutyFields(surviving, {
      id: kameronId,
      pilotUid: uidOf(kameronUser),
      pilotName: displayName(kameronUser),
      role: otherRole(surviving.role),
      crewType: 'two',
      fitForDuty: true,
      priorRestMs: null,
      dutyOnAt: joinAt,
      dutyOffAt,
      flightTimeMs: 0,
      confirmStatus: 'admin-attested',
      partnerPeriodId: surviving.id,
      pendingCreatedBy: actorName,
      confirmedAt: now,
      correctionKey: OCT1_CORRECTION_KEY,
      crewSegments: [openSegment({
        crewType: 'two',
        partnerPeriodId: surviving.id,
        partnerUid: surviving.pilotUid,
        partnerName: surviving.pilotName || displayName(mattUser),
        role: otherRole(surviving.role),
        startedAt: joinAt,
      })],
      adminEdits: [audit({
        by: actorName,
        at: now,
        field: 'oct1-crew-correction',
        from: null,
        to: {
          dutyOnAt: joinAt,
          dutyOffAt,
          crewType: 'two',
          flightTimeMs: 0,
          partnerPeriodId: surviving.id,
        },
        note: 'Admin-attested Kameron\'s half of the Oct 1 crew change. No flight time was invented; block time stays 0 until a record of his is found.',
      })],
      createdAt: now,
      updatedAt: now,
      status: dutyOffAt == null ? 'on' : 'off',
    });
    if (dutyOffAt != null) {
      doc.crewSegments[0].endedAt = dutyOffAt;
    }
    changes.push({
      id: kameronId,
      op: 'create',
      pilotName: displayName(kameronUser),
      before: null,
      after: snapshotDuty(doc),
    });
    writes.push({ op: 'create', id: kameronId, doc });
  }

  return {
    ...base,
    applicable: writes.length > 0,
    continuous: useContinuous,
    warnings,
    reason: useContinuous
      ? 'Matt\'s Oct 1 records form one continuous two-pilot duty: Daniel, then Kameron. The single-pilot designation is removed.'
      : 'Crew composition corrected without merging duty periods.',
    flightTimeNote: 'Two-pilot segment time is limited by 14 CFR 135.267(b) to 10 hours, not the 8-hour single-pilot limit. Rest beyond 10 hours applies only under 14 CFR 135.267(d) when that limit is actually exceeded.',
    before: { morningSignOn: beforeMorning, now: beforeNow },
    after: { morningSignOn: afterMorning, now: afterNow },
    wrong16HourBlockCleared: wrongSixteen,
    signOnAllowedAt0800EtOct2: signOnAllowed,
    changes,
    writes,
  };
}
