// Findings on duty-periods-v2 and the administrator fixes for them.
//
// The planner never writes. Every fix returns the before snapshot, the after
// document, and a patch. Flight time is not invented: merge keeps the larger
// recorded total, trim and delete do not add hours, and linking a partner
// only changes the crew designation that the 8-hour / 10-hour split reads.

import { flightBuckets, restOutlook } from './duty-crew-change.js';
import { evaluateCurrent } from './duty-legality.js';
import { EXTENDED_REST_TIER_3_MS, LIMITS } from './duty-limits.js';

/** Firestore rejects undefined. Drop those keys from duty patches and audit docs. */
export function omitUndefined(value) {
  if (Array.isArray(value)) return value.map((item) => omitUndefined(item));
  if (!value || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    out[key] = omitUndefined(child);
  }
  return out;
}

const MS_HOUR = 3600 * 1000;
const MS_DAY = 24 * MS_HOUR;
const MERGE_MAX_MS = 18 * MS_HOUR;

export function hours(ms) {
  return Number.isFinite(ms) ? ms / MS_HOUR : 0;
}

export function fmtHours(ms, digits = 1) {
  return `${hours(ms).toFixed(digits)}h`;
}

export function durationMs(period, now = Date.now()) {
  if (!Number.isFinite(period?.dutyOnAt)) return 0;
  const end = Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : now;
  return Math.max(0, end - period.dutyOnAt);
}

export function confirmationCounts(period) {
  return !period.confirmStatus
    || period.confirmStatus === 'self-attested'
    || period.confirmStatus === 'admin-attested';
}

export function periodEnd(period, now) {
  return Number.isFinite(period?.dutyOffAt) ? period.dutyOffAt : now;
}

export function isSuperseded(period) {
  return period?.recordStatus === 'superseded' || period?.confirmStatus === 'superseded';
}

export function findOverlaps(periods, now = Date.now()) {
  const ids = new Set();
  const byPilot = new Map();
  (periods || []).forEach((period) => {
    if (!period?.pilotUid || !Number.isFinite(period.dutyOnAt) || isSuperseded(period)) return;
    if (!byPilot.has(period.pilotUid)) byPilot.set(period.pilotUid, []);
    byPilot.get(period.pilotUid).push(period);
  });
  byPilot.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.dutyOnAt - b.dutyOnAt || String(a.id).localeCompare(String(b.id)));
    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i];
      const aEnd = periodEnd(a, now);
      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j];
        if (b.dutyOnAt >= aEnd) break;
        const bEnd = periodEnd(b, now);
        if (b.dutyOnAt < aEnd && bEnd > a.dutyOnAt) {
          ids.add(a.id);
          ids.add(b.id);
        }
      }
    }
  });
  return ids;
}

export function overlapPairs(periods, now = Date.now()) {
  const pairs = [];
  const byPilot = new Map();
  (periods || []).forEach((period) => {
    if (!period?.pilotUid || !Number.isFinite(period.dutyOnAt) || isSuperseded(period)) return;
    if (!byPilot.has(period.pilotUid)) byPilot.set(period.pilotUid, []);
    byPilot.get(period.pilotUid).push(period);
  });
  byPilot.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.dutyOnAt - b.dutyOnAt || String(a.id).localeCompare(String(b.id)));
    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i];
      const aEnd = periodEnd(a, now);
      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j];
        if (b.dutyOnAt >= aEnd) break;
        const bEnd = periodEnd(b, now);
        const overlapMs = Math.min(aEnd, bEnd) - b.dutyOnAt;
        if (overlapMs > 0) pairs.push({ a, b, overlapMs });
      }
    }
  });
  return pairs;
}

export function counterparts(period, periods, now = Date.now()) {
  if (!period) return [];
  return overlapPairs(periods, now)
    .filter((pair) => pair.a.id === period.id || pair.b.id === period.id)
    .map((pair) => ({
      other: pair.a.id === period.id ? pair.b : pair.a,
      overlapMs: pair.overlapMs,
    }));
}

export function recordIssues(period, periodById, overlapIds, now = Date.now()) {
  const issues = [];
  if (!period || isSuperseded(period)) return issues;
  const duty = durationMs(period, now);
  const buckets = flightBuckets(period);
  const add = (code, label, tone = 'warning', kind = 'compliance') => {
    const approval = period.findingApprovals?.[code] || null;
    issues.push({
      code,
      label,
      tone,
      kind,
      approved: approval?.status === 'approved',
      approval,
    });
  };

  if (!Number.isFinite(period.dutyOnAt)) add('MISSING_ON', 'Missing duty-on time', 'danger', 'data');
  if (period.status === 'off' && !Number.isFinite(period.dutyOffAt)) {
    add('MISSING_OFF', 'Closed record has no duty-off time', 'danger', 'data');
  }
  if (Number.isFinite(period.dutyOffAt) && period.dutyOffAt <= period.dutyOnAt) {
    add('INVALID_TIME', 'Duty-off is not after duty-on', 'danger', 'data');
  }
  if (overlapIds.has(period.id)) add('OVERLAP', 'Overlaps another record for this pilot', 'danger', 'data');
  if (period.confirmStatus === 'pending') add('PENDING', `${period.role || 'Crew'} confirmation pending`, 'warning');
  if (period.confirmStatus === 'declined') add('DECLINED', 'Pilot declined paired duty', 'danger');
  if (confirmationCounts(period) && period.fitForDuty !== true) {
    add('FIT', 'Fit-for-duty attestation missing', 'danger');
  }
  if (confirmationCounts(period) && !Number.isFinite(period.priorRestMs)) {
    add('REST_MISSING', 'Prior rest not recorded', 'warning', 'data');
  } else if (confirmationCounts(period) && period.priorRestMs < LIMITS.REST_REQUIRED_BEFORE_MS) {
    add('REST_LOW', `Prior rest ${fmtHours(period.priorRestMs)} below 10h`, 'danger');
  }
  if (period.assignmentType === 'regular' && duty > LIMITS.REGULAR_DUTY_MAX_MS) {
    add('OVER_14', `Regular duty ${fmtHours(duty)} exceeds 14h`, 'danger');
  }
  if (period.status === 'on' && duty > 16 * MS_HOUR) {
    add('OPEN_LONG', `Duty still open after ${fmtHours(duty)}`, 'danger', 'data');
  }
  if (buckets.singleMs > LIMITS.SINGLE_PILOT_FLIGHT_MAX_MS) {
    add('FLIGHT_LIMIT', `${fmtHours(buckets.singleMs)} single-pilot flight exceeds 8h`, 'danger');
    if (!period.excursionReason) add('NO_EXCURSION_REASON', 'Flight-time excursion has no reason', 'danger', 'data');
  }
  if (buckets.twoMs > LIMITS.TWO_PILOT_FLIGHT_MAX_MS) {
    add('FLIGHT_LIMIT_TWO', `${fmtHours(buckets.twoMs)} two-pilot flight exceeds 10h`, 'danger');
    if (!period.excursionReason) add('NO_EXCURSION_REASON', 'Flight-time excursion has no reason', 'danger', 'data');
  }
  if (period.overrideStatus === 'requested') add('OVERRIDE_PENDING', 'Override awaiting approval', 'danger');
  if (period.overrideStatus === 'approved' && !period.overrideApprovedBy) {
    add('OVERRIDE_AUDIT', 'Approved override missing approver', 'danger', 'data');
  }
  if (period.partnerPeriodId) {
    const partner = periodById.get(period.partnerPeriodId);
    if (!partner || isSuperseded(partner)) add('ORPHAN_PAIR', 'Linked partner record not found', 'danger', 'data');
    else if (partner.partnerPeriodId !== period.id) {
      const historical = Array.isArray(partner.crewSegments)
        && partner.crewSegments.some((segment) => segment.partnerPeriodId === period.id);
      if (!historical) add('ONE_WAY_PAIR', 'Partner link is not reciprocal', 'danger', 'data');
    }
  } else if ((period.crewType === 'two' || period.awaitingPartner === true) && period.status === 'on') {
    add('NO_LINKED_CREW', 'Paired duty has no linked crew', 'warning', 'data');
  }
  if (!period.pilotUid || !period.pilotName) add('PILOT', 'Pilot identity incomplete', 'danger', 'data');
  if (!period.location) add('LOCATION', 'Location missing', 'warning', 'data');
  if (!period.role) add('ROLE', 'PIC/SIC role missing', 'warning', 'data');
  if (!['single', 'two'].includes(period.crewType)) add('CREW_TYPE', 'Crew type missing or invalid', 'warning', 'data');
  if (!['regular', 'unscheduled'].includes(period.assignmentType)) {
    add('ASSIGNMENT', 'Assignment type missing or invalid', 'warning', 'data');
  }
  return issues;
}

export function issuesFor(periods, now = Date.now()) {
  const live = (periods || []).filter((period) => !isSuperseded(period));
  const byId = new Map(live.map((period) => [period.id, period]));
  const overlaps = findOverlaps(live, now);
  const map = new Map();
  live.forEach((period) => map.set(period.id, recordIssues(period, byId, overlaps, now)));
  return map;
}

export function fixKindForIssue(code) {
  switch (code) {
    case 'OVERLAP': return 'overlap';
    case 'MISSING_OFF': return 'set-off';
    case 'OVER_14':
    case 'OPEN_LONG':
    case 'INVALID_TIME': return 'edit-times';
    case 'FLIGHT_LIMIT':
    case 'NO_LINKED_CREW':
    case 'ORPHAN_PAIR': return 'link';
    case 'ONE_WAY_PAIR': return 'reciprocal';
    case 'DECLINED': return 'override-declined';
    default: return null;
  }
}

function fail(error, status = 400) {
  return { ok: false, status, error };
}

function clone(period) {
  return period ? JSON.parse(JSON.stringify(period)) : period;
}

function auditEntry({ by, at, field, from, to, reason }) {
  return {
    by: by || 'admin',
    at,
    field,
    from: from ?? null,
    to: to ?? null,
    reason,
    note: reason,
  };
}

function withEdit(period, entry) {
  return {
    ...period,
    updatedAt: entry.at,
    adminEdits: [...(Array.isArray(period.adminEdits) ? period.adminEdits : []), entry],
  };
}

function diffPatch(before, after) {
  const patch = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.delete('id');
  for (const key of keys) {
    if (JSON.stringify(before?.[key]) === JSON.stringify(after?.[key])) continue;
    patch[key] = after?.[key] === undefined ? null : after[key];
  }
  return omitUndefined(patch);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const VOLATILE_PATCH_KEYS = new Set([
  'updatedAt',
  'adminEdits',
  'over14VerifiedAt',
  'over14VerifiedBy',
  'overrideApprovedAt',
  'overrideApprovedBy',
]);

export function planFingerprint(plan) {
  return (plan?.writes || [])
    .map((write) => {
      const patch = { ...write.patch };
      for (const key of VOLATILE_PATCH_KEYS) delete patch[key];
      return `${write.id}:${stable(patch)}`;
    })
    .sort()
    .join('\n');
}

function finish(kind, working, touched, originals, { summary, warnings = [], actorName, now, reason, detail }) {
  const ids = [...touched];
  const before = ids.map((id) => ({ id, data: clone(originals.get(id)) }));
  const after = ids.map((id) => {
    const data = clone(working.get(id));
    delete data.id;
    return { id, data };
  });
  const writes = after.map((row) => ({
    id: row.id,
    patch: diffPatch(originals.get(row.id), { id: row.id, ...row.data }),
  })).filter((write) => Object.keys(write.patch).length > 0);
  const plan = {
    ok: true,
    kind,
    summary,
    warnings,
    detail: detail || summary,
    changes: ids.map((id) => ({
      id,
      pilotUid: working.get(id)?.pilotUid || originals.get(id)?.pilotUid || null,
      pilotName: working.get(id)?.pilotName || originals.get(id)?.pilotName || null,
      action: kind,
    })),
    writes,
    before,
    after,
    actorName,
    at: now,
    reason,
  };
  plan.fingerprint = planFingerprint(plan);
  return plan;
}

function limitSnapshot(pilotUid, periods, at) {
  const mine = periods.filter((period) => period.pilotUid === pilotUid && !isSuperseded(period) && period.confirmStatus !== 'declined');
  const offs = mine.map((period) => period.dutyOffAt).filter(Number.isFinite);
  const when = offs.length ? Math.max(...offs) + MS_HOUR : at;
  const windowStart = when - MS_DAY;
  const legal = evaluateCurrent(mine, [], when, 'two');
  const rest = restOutlook(mine, when);
  let singleMs = 0;
  let twoMs = 0;
  for (const period of mine) {
    if (!Number.isFinite(period.dutyOnAt) || period.dutyOnAt < windowStart || period.dutyOnAt >= when) continue;
    const buckets = flightBuckets(period);
    singleMs += buckets.singleMs;
    twoMs += buckets.twoMs;
  }
  return {
    status: legal.status,
    singleFlightMs: singleMs,
    twoFlightMs: twoMs,
    restRequiredMs: rest.requiredMs,
    extendedRest16: rest.requiredMs >= EXTENDED_REST_TIER_3_MS,
    singlePilotFlag: legal.checks.some((check) => check.code === 'FT_24H_SINGLE' && check.severity === 'block'),
  };
}

function retagPaired(period, partner) {
  if (!Array.isArray(period.crewSegments) || period.crewSegments.length === 0) return period.crewSegments;
  return period.crewSegments.map((segment) => {
    if (segment.crewType === 'two' && segment.partnerUid && segment.partnerUid !== partner.pilotUid) return segment;
    return {
      ...segment,
      crewType: 'two',
      awaitingReplacement: false,
      partnerPeriodId: partner.id,
      partnerUid: partner.pilotUid,
      partnerName: partner.pilotName || segment.partnerName || null,
    };
  });
}

function retagUnlinked(period, partnerId) {
  if (!Array.isArray(period.crewSegments) || period.crewSegments.length === 0) return period.crewSegments;
  return period.crewSegments.map((segment) => {
    if (segment.partnerPeriodId && segment.partnerPeriodId !== partnerId) return segment;
    return {
      ...segment,
      crewType: 'single',
      awaitingReplacement: false,
      partnerPeriodId: null,
      partnerUid: null,
      partnerName: null,
    };
  });
}

function linkPair(left, right, entry) {
  const nextLeft = withEdit({
    ...left,
    crewType: 'two',
    partnerPeriodId: right.id,
    partnerUid: right.pilotUid,
    partnerName: right.pilotName || null,
    awaitingPartner: false,
    crewSegments: retagPaired(left, right),
  }, { ...entry, field: 'linkPartner', from: { partnerPeriodId: left.partnerPeriodId || null, crewType: left.crewType || null }, to: { partnerPeriodId: right.id, crewType: 'two' } });
  const nextRight = withEdit({
    ...right,
    crewType: 'two',
    partnerPeriodId: left.id,
    partnerUid: left.pilotUid,
    partnerName: left.pilotName || null,
    awaitingPartner: false,
    crewSegments: retagPaired(right, left),
  }, { ...entry, field: 'linkPartner', from: { partnerPeriodId: right.partnerPeriodId || null, crewType: right.crewType || null }, to: { partnerPeriodId: left.id, crewType: 'two' } });
  return [nextLeft, nextRight];
}

function clearLink(period, partner, entry) {
  return withEdit({
    ...period,
    partnerPeriodId: period.partnerPeriodId === partner?.id ? null : (period.partnerPeriodId || null),
    partnerUid: period.partnerPeriodId === partner?.id ? null : (period.partnerUid || null),
    partnerName: period.partnerPeriodId === partner?.id ? null : (period.partnerName || null),
    awaitingPartner: false,
    crewType: period.partnerPeriodId === partner?.id ? 'single' : (period.crewType || 'single'),
    crewSegments: retagUnlinked(period, partner?.id),
  }, {
    ...entry,
    field: 'unlinkPartner',
    from: { partnerPeriodId: period.partnerPeriodId || null, crewType: period.crewType || null },
    to: { partnerPeriodId: null, crewType: 'single' },
  });
}

function requireReason(reason) {
  const text = String(reason || '').trim();
  if (!text) return null;
  return text.slice(0, 1000);
}

function liveMap(periods) {
  const map = new Map();
  (periods || []).forEach((period) => {
    if (period?.id) map.set(period.id, clone(period));
  });
  return map;
}

function applyTimes(period, dutyOnAt, dutyOffAt, entry, { over14Verified, now }) {
  if (!Number.isFinite(dutyOnAt)) return fail('A duty-on time is required.');
  if (dutyOffAt != null && (!Number.isFinite(dutyOffAt) || dutyOffAt <= dutyOnAt)) {
    return fail('Duty-off must be after duty-on.');
  }
  const end = dutyOffAt ?? now;
  const over14 = end - dutyOnAt > LIMITS.REGULAR_DUTY_MAX_MS;
  if (over14 && over14Verified !== true) {
    return fail('This window still exceeds 14 hours. Confirm that the duty really ran that long, or choose a shorter window.');
  }
  return withEdit({
    ...period,
    dutyOnAt,
    dutyOffAt: dutyOffAt ?? null,
    status: dutyOffAt == null ? 'on' : 'off',
    over14,
    over14VerifiedAt: over14 ? entry.at : null,
    over14VerifiedBy: over14 ? entry.by : null,
    over14VerificationSource: over14 ? 'admin-finding-fix' : null,
  }, {
    ...entry,
    field: 'dutyTimes',
    from: { dutyOnAt: period.dutyOnAt ?? null, dutyOffAt: period.dutyOffAt ?? null, status: period.status || null },
    to: { dutyOnAt, dutyOffAt: dutyOffAt ?? null, status: dutyOffAt == null ? 'on' : 'off' },
  });
}

function supersede(period, keeper, entry) {
  return withEdit({
    ...period,
    recordStatus: 'superseded',
    supersededBy: keeper?.id || null,
    status: 'off',
  }, {
    ...entry,
    field: 'deleteDuplicate',
    from: { recordStatus: period.recordStatus || null, status: period.status || null },
    to: { recordStatus: 'superseded', supersededBy: keeper?.id || null },
  });
}

/**
 * Plan one administrator fix. `periods` is the current ledger. Nothing here
 * is written until the API confirms the same fingerprint.
 */
export function planFindingFix({
  kind,
  periods = [],
  periodId,
  otherId,
  dropId,
  partnerPeriodId,
  pilotUid,
  dutyOnAt,
  dutyOffAt,
  over14Verified = false,
  force = false,
  reason,
  actorName = 'admin',
  now = Date.now(),
}) {
  const reasonText = requireReason(reason);
  if (!reasonText) return fail('A reason is required.');
  const originals = liveMap(periods);
  const working = liveMap(periods);
  const entry = { by: actorName, at: now, reason: reasonText };
  const touched = new Set();
  const warnings = [];

  const take = (id) => {
    const period = working.get(id);
    if (!period || isSuperseded(period)) return null;
    return period;
  };

  if (kind === 'fix-overlaps') {
    if (!pilotUid) return fail('Choose a pilot.');
    const steps = bulkOverlapSteps([...working.values()].filter((period) => period.pilotUid === pilotUid), now);
    warnings.push(...steps.warnings);
    if (steps.actions.length === 0) {
      return fail(steps.warnings[0] || 'No automatic overlap repair is available for this pilot.');
    }
    for (const action of steps.actions) {
      const sub = planFindingFix({
        ...action,
        periods: [...working.values()],
        reason: reasonText,
        actorName,
        now,
        force: true,
      });
      if (!sub.ok) {
        warnings.push(sub.error);
        continue;
      }
      for (const row of sub.after) {
        working.set(row.id, { id: row.id, ...row.data });
        touched.add(row.id);
      }
    }
    if (touched.size === 0) return fail(warnings[0] || 'No overlap could be repaired automatically.');
    const plan = finish(kind, working, touched, originals, {
      summary: `Overlap repair for ${working.get([...touched][0])?.pilotName || 'pilot'}: ${steps.actions.length} change${steps.actions.length === 1 ? '' : 's'}.`,
      warnings,
      actorName,
      now,
      reason: reasonText,
    });
    plan.bulkActions = steps.actions.map((action) => ({
      kind: action.kind,
      periodId: action.periodId,
      otherId: action.otherId || null,
      dropId: action.dropId || null,
    }));
    return plan;
  }

  const period = take(periodId);
  if (!period && kind !== 'undo') return fail('Duty record not found.');

  if (kind === 'merge' || kind === 'trim' || kind === 'delete-duplicate') {
    const other = take(otherId);
    if (!other) return fail('The overlapping record was not found.');
    if (other.pilotUid !== period.pilotUid) return fail('Overlap repair only applies to the same pilot.');
    const overlap = Math.min(periodEnd(period, now), periodEnd(other, now)) - Math.max(period.dutyOnAt, other.dutyOnAt);
    if (!(overlap > 0)) return fail('Those records do not overlap.');
    const earlier = period.dutyOnAt <= other.dutyOnAt ? period : other;
    const later = earlier === period ? other : period;

    if (kind === 'merge') {
      const on = Math.min(period.dutyOnAt, other.dutyOnAt);
      const eitherOpen = !Number.isFinite(period.dutyOffAt) || !Number.isFinite(other.dutyOffAt);
      const off = eitherOpen ? null : Math.max(period.dutyOffAt, other.dutyOffAt);
      const union = (off ?? now) - on;
      if (union > MERGE_MAX_MS && force !== true) {
        return fail('These duty windows differ by more than 18 hours. Correct the times or delete one record instead of merging.');
      }
      const keeper = (dropId && dropId === period.id) ? other : (dropId && dropId === other.id) ? period : earlier;
      const dropped = keeper === period ? other : period;
      const flight = Math.max(Number(period.flightTimeMs) || 0, Number(other.flightTimeMs) || 0);
      const merged = withEdit({
        ...keeper,
        dutyOnAt: on,
        dutyOffAt: off,
        status: off == null ? 'on' : 'off',
        flightTimeMs: flight,
        crewType: keeper.crewType === 'two' || dropped.crewType === 'two' ? 'two' : (keeper.crewType || 'single'),
        tail: keeper.tail || dropped.tail || null,
        over14: ((off ?? now) - on) > LIMITS.REGULAR_DUTY_MAX_MS,
      }, {
        ...entry,
        field: 'mergeDuty',
        from: { dutyOnAt: keeper.dutyOnAt, dutyOffAt: keeper.dutyOffAt ?? null, flightTimeMs: keeper.flightTimeMs || 0 },
        to: { dutyOnAt: on, dutyOffAt: off, flightTimeMs: flight, mergedFrom: dropped.id },
      });
      working.set(keeper.id, merged);
      working.set(dropped.id, supersede(dropped, keeper, entry));
      touched.add(keeper.id);
      touched.add(dropped.id);
      return finish(kind, working, touched, originals, {
        summary: `Merged ${dropped.id} into ${keeper.id}. Flight time kept at ${fmtHours(flight)} (the larger recorded total).`,
        actorName,
        now,
        reason: reasonText,
      });
    }

    if (kind === 'trim') {
      if (!Number.isFinite(earlier.dutyOffAt)) {
        return fail('Set a duty-off on the earlier record before trimming, or delete the duplicate.');
      }
      if (later.dutyOnAt >= earlier.dutyOffAt) return fail('Those records do not overlap.');
      if (Number.isFinite(later.dutyOffAt) && earlier.dutyOffAt >= later.dutyOffAt) {
        return fail('The later record sits inside the earlier one. Delete that duplicate, or merge.');
      }
      const trimmed = applyTimes(later, earlier.dutyOffAt, Number.isFinite(later.dutyOffAt) ? later.dutyOffAt : null, {
        ...entry,
        field: 'trimOverlap',
      }, { over14Verified: true, now });
      if (trimmed.ok === false) return trimmed;
      working.set(later.id, trimmed);
      touched.add(later.id);
      return finish(kind, working, touched, originals, {
        summary: `Trimmed ${later.pilotName || 'the later record'} so duty starts when the earlier record ends. Flight time was not changed.`,
        actorName,
        now,
        reason: reasonText,
      });
    }

    const victim = take(dropId);
    if (!victim || (victim.id !== period.id && victim.id !== other.id)) {
      return fail('Choose which duplicate to delete.');
    }
    const keeper = victim.id === period.id ? other : period;
    working.set(victim.id, supersede(victim, keeper, entry));
    touched.add(victim.id);
    return finish(kind, working, touched, originals, {
      summary: `Removed ${victim.pilotName || 'the duplicate'} ${victim.id} from the live ledger. The other record is unchanged.`,
      actorName,
      now,
      reason: reasonText,
    });
  }

  if (kind === 'set-off' || kind === 'edit-times') {
    const on = kind === 'set-off' ? period.dutyOnAt : Number(dutyOnAt);
    if (dutyOffAt == null || dutyOffAt === '') return fail('A duty-off time is required.');
    const off = Number(dutyOffAt);
    const next = applyTimes(period, on, off, entry, { over14Verified, now });
    if (next.ok === false) return next;
    working.set(period.id, next);
    touched.add(period.id);
    return finish(kind, working, touched, originals, {
      summary: kind === 'set-off'
        ? `Set duty-off for ${period.pilotName || 'the pilot'}.`
        : `Corrected duty times for ${period.pilotName || 'the pilot'}.`,
      actorName,
      now,
      reason: reasonText,
    });
  }

  if (kind === 'link' || kind === 'reciprocal' || kind === 'swap') {
    const partnerId = kind === 'reciprocal' ? period.partnerPeriodId : partnerPeriodId;
    const partner = take(partnerId);
    if (!partner) return fail('Choose the partner duty record.');
    if (partner.id === period.id) return fail('A record cannot be linked to itself.');
    if (partner.pilotUid === period.pilotUid) return fail('Link a different pilot. Overlapping records for the same pilot are an overlap, not a crew.');
    if (kind === 'reciprocal' && partner.partnerPeriodId === period.id) {
      return fail('That link is already reciprocal.');
    }
    if (partner.partnerPeriodId && partner.partnerPeriodId !== period.id && kind !== 'swap') {
      return fail('That pilot is already linked to a different record. Unlink them or swap.');
    }
    if (kind === 'swap' || (period.partnerPeriodId && period.partnerPeriodId !== partner.id)) {
      const previous = take(period.partnerPeriodId);
      if (previous && previous.id !== partner.id) {
        working.set(previous.id, clearLink(previous, period, entry));
        touched.add(previous.id);
      }
    }
    if (kind === 'swap' && partner.partnerPeriodId && partner.partnerPeriodId !== period.id) {
      const previous = take(partner.partnerPeriodId);
      if (previous) {
        working.set(previous.id, clearLink(previous, partner, entry));
        touched.add(previous.id);
      }
    }
    const [nextPeriod, nextPartner] = linkPair(working.get(period.id), working.get(partner.id), entry);
    working.set(period.id, nextPeriod);
    working.set(partner.id, nextPartner);
    touched.add(period.id);
    touched.add(partner.id);
    const afterPeriods = [...working.values()];
    const limits = [period.pilotUid, partner.pilotUid].map((uid) => ({
      pilotUid: uid,
      before: limitSnapshot(uid, [...originals.values()], now),
      after: limitSnapshot(uid, afterPeriods, now),
    }));
    const plan = finish(kind, working, touched, originals, {
      summary: kind === 'reciprocal'
        ? `Made the crew link reciprocal for ${period.pilotName || 'the pilot'} and ${partner.pilotName || 'the partner'}.`
        : `Linked ${period.pilotName || 'the pilot'} with ${partner.pilotName || 'the partner'} as a paired crew.`,
      actorName,
      now,
      reason: reasonText,
    });
    plan.limits = limits;
    return plan;
  }

  if (kind === 'unlink') {
    const partner = period.partnerPeriodId ? take(period.partnerPeriodId) : null;
    working.set(period.id, clearLink(period, partner || { id: period.partnerPeriodId }, entry));
    touched.add(period.id);
    if (partner && partner.partnerPeriodId === period.id) {
      working.set(partner.id, clearLink(partner, period, entry));
      touched.add(partner.id);
    }
    return finish(kind, working, touched, originals, {
      summary: `Unlinked ${period.pilotName || 'the pilot'}${partner ? ` from ${partner.pilotName}` : ''}. Single-pilot limits apply to the unlinked time.`,
      warnings: ['Unlinking reapplies the 8-hour single-pilot flight limit to this record.'],
      actorName,
      now,
      reason: reasonText,
    });
  }

  if (kind === 'override-declined') {
    if (period.confirmStatus !== 'declined') return fail('This record is not a declined paired duty.');
    const next = withEdit({
      ...period,
      confirmStatus: 'admin-attested',
      overrideStatus: 'approved',
      overrideApprovedBy: actorName,
      overrideApprovedAt: now,
      overrideApprovalNotes: reasonText,
      declinedReason: period.declinedReason || null,
    }, {
      ...entry,
      field: 'overrideDeclined',
      from: { confirmStatus: 'declined', overrideStatus: period.overrideStatus || null },
      to: { confirmStatus: 'admin-attested', overrideStatus: 'approved' },
    });
    working.set(period.id, next);
    touched.add(period.id);
    return finish(kind, working, touched, originals, {
      summary: `Admin override accepted the declined duty for ${period.pilotName || 'the pilot'}.`,
      actorName,
      now,
      reason: reasonText,
    });
  }

  return fail('Unknown duty fix.');
}

function bulkOverlapSteps(periods, now) {
  const warnings = [];
  const actions = [];
  const blocked = new Set();
  periods.forEach((period) => {
    if (durationMs(period, now) > MS_DAY) {
      blocked.add(period.id);
      warnings.push(`${period.pilotName || 'A pilot'} ${period.id} spans ${fmtHours(durationMs(period, now))}. Correct that clock before automatic overlap repair.`);
    }
  });
  const pairs = overlapPairs(periods, now).filter((pair) => !blocked.has(pair.a.id) && !blocked.has(pair.b.id));
  const used = new Set();
  for (const pair of pairs) {
    if (used.has(pair.a.id) || used.has(pair.b.id)) continue;
    const earlier = pair.a.dutyOnAt <= pair.b.dutyOnAt ? pair.a : pair.b;
    const later = earlier === pair.a ? pair.b : pair.a;
    const earlierEnd = periodEnd(earlier, now);
    const laterEnd = periodEnd(later, now);
    const contained = later.dutyOnAt >= earlier.dutyOnAt && laterEnd <= earlierEnd;
    const sameTail = earlier.tail && later.tail && earlier.tail === later.tail;
    if (contained && sameTail) {
      const drop = (Number(later.flightTimeMs) || 0) <= (Number(earlier.flightTimeMs) || 0) ? later : earlier;
      actions.push({ kind: 'delete-duplicate', periodId: earlier.id, otherId: later.id, dropId: drop.id });
      used.add(earlier.id);
      used.add(later.id);
      continue;
    }
    if (Number.isFinite(earlier.dutyOffAt) && later.dutyOnAt < earlier.dutyOffAt && (!Number.isFinite(later.dutyOffAt) || earlier.dutyOffAt < later.dutyOffAt)) {
      actions.push({ kind: 'trim', periodId: earlier.id, otherId: later.id });
      used.add(earlier.id);
      used.add(later.id);
    }
  }
  return { actions, warnings };
}

export function applyPlanToPeriods(periods, plan) {
  if (!plan?.ok) return periods;
  const map = new Map((periods || []).map((period) => [period.id, period]));
  for (const row of plan.after || []) map.set(row.id, { id: row.id, ...row.data });
  for (const row of plan.records || []) map.set(row.id, row);
  return [...map.values()];
}

export function undoPlan(audit, { reason, actorName = 'admin', now = Date.now() } = {}) {
  const reasonText = requireReason(reason);
  if (!reasonText) return fail('A reason is required.');
  if (!audit || !Array.isArray(audit.before)) return fail('That fix has no snapshot to restore.');
  if (audit.undoneAt) return fail('That fix was already undone.');
  const writes = audit.before.map((row) => ({
    id: row.id,
    data: omitUndefined(row.data || {}),
  }));
  return {
    ok: true,
    kind: 'undo',
    summary: `Undo ${audit.kind || audit.action || 'fix'} from ${audit.byName || 'an admin'}.`,
    reason: reasonText,
    actorName,
    at: now,
    restores: audit.id || null,
    writes,
    before: audit.after || [],
    after: audit.before,
  };
}

export function etParts(ms, timeZone = 'America/New_York') {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  if (map.hour === '24') map.hour = '00';
  return map;
}

export function utcMsToEtInput(ms) {
  if (!Number.isFinite(ms)) return '';
  const parts = etParts(ms);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function etInputToUtcMs(value) {
  if (!value) return null;
  const [dateStr, timeStr] = value.split('T');
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  if ([year, month, day, hour, minute].some((part) => !Number.isFinite(part))) return null;
  const candidate = Date.UTC(year, month - 1, day, hour, minute);
  const parts = etParts(candidate);
  const rendered = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  return candidate + (desired - rendered);
}

export function easternDayKey(ms) {
  const parts = etParts(ms);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dutyTimeline(periods, now = Date.now()) {
  const live = (periods || []).filter((period) => !isSuperseded(period) && Number.isFinite(period.dutyOnAt));
  const days = new Map();
  for (const period of live) {
    const start = period.dutyOnAt;
    const end = periodEnd(period, now);
    let cursor = start;
    while (cursor < end) {
      const key = easternDayKey(cursor);
      const parts = etParts(cursor);
      const dayStart = etInputToUtcMs(`${key}T00:00`);
      const dayEnd = dayStart + MS_DAY;
      if (!days.has(key)) days.set(key, { day: key, label: `${parts.month}/${parts.day}`, slices: [] });
      const sliceStart = Math.max(start, dayStart);
      const sliceEnd = Math.min(end, dayEnd);
      days.get(key).slices.push({
        id: period.id,
        pilotName: period.pilotName || '',
        tail: period.tail || '',
        start: (sliceStart - dayStart) / MS_DAY,
        end: (sliceEnd - dayStart) / MS_DAY,
        dutyOnAt: period.dutyOnAt,
        dutyOffAt: period.dutyOffAt ?? null,
      });
      cursor = dayEnd;
      if (cursor <= sliceStart) break;
    }
  }
  for (const day of days.values()) {
    day.slices.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
    day.slices.forEach((slice, index) => {
      slice.overlap = day.slices.some((other, otherIndex) => (
        otherIndex !== index && other.start < slice.end && other.end > slice.start
      ));
    });
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}
