// Rebuild crew links from the published tail + trip schedule.
//
// This planner never writes. It does not invent duty-on, duty-off, or flight
// time. A missing counterpart record is reported, not created. Ambiguous
// overlaps are skipped. The only fields a confirmed apply may change are the
// crew link, the paired designation, and (when every stored segment was
// mislabeled single-pilot or awaiting) the segment crew type — plus an
// audit entry.

import { buildCrewDayPairings, crewNamesMatch, toMillis } from './crew-day.js';
import {
  etDayBounds,
  flightBuckets,
  restOutlook,
  snapshotDuty,
} from './duty-crew-change.js';
import { evaluateCurrent } from './duty-legality.js';
import { EXTENDED_REST_TIER_3_MS } from './duty-limits.js';

const PAD_MS = 90 * 60 * 1000;
const AMBIGUOUS_MS = 15 * 60 * 1000;
const HOUR = 3600 * 1000;

function parseDay(day) {
  const match = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), key: match[0] };
}

function usable(period) {
  return Boolean(
    period
    && period.recordStatus !== 'superseded'
    && period.confirmStatus !== 'superseded'
    && period.confirmStatus !== 'declined',
  );
}

function uidOf(user) {
  return user?.uid || user?.id || null;
}

export function matchSchedulePilot(crewName, users) {
  const hits = (users || []).filter((user) => (
    uidOf(user)
    && [user.name, user.displayName, user.jetinsightName].some((candidate) => crewNamesMatch(candidate, crewName))
  ));
  if (hits.length === 1) return { user: hits[0], reason: 'name' };
  if (hits.length > 1) return { user: null, reason: 'ambiguous-user' };
  return { user: null, reason: 'no-user-match' };
}

function spanOf(pairing) {
  let start = Infinity;
  let end = -Infinity;
  for (const leg of pairing.legs || []) {
    const legStart = toMillis(leg.start ?? leg.info?.start);
    const legEnd = toMillis(leg.end ?? leg.info?.end) ?? legStart;
    if (legStart != null) start = Math.min(start, legStart);
    if (legEnd != null) end = Math.max(end, legEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    const parsed = parseDay(pairing.day);
    if (!parsed) return null;
    return etDayBounds(parsed.year, parsed.month, parsed.day);
  }
  return { start: start - PAD_MS, end: end + PAD_MS };
}

function overlapMs(period, span, now) {
  if (!period || !Number.isFinite(period.dutyOnAt) || !span) return 0;
  const off = Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : now;
  return Math.max(0, Math.min(off, span.end) - Math.max(period.dutyOnAt, span.start));
}

function bestPeriod(candidates, span, now) {
  const scored = candidates
    .map((period) => ({ period, overlap: overlapMs(period, span, now) }))
    .filter((row) => row.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || String(a.period.id).localeCompare(String(b.period.id)));
  if (scored.length === 0) return { period: null, reason: 'no-overlapping-duty' };
  if (scored.length > 1 && scored[0].overlap - scored[1].overlap < AMBIGUOUS_MS) {
    return { period: null, reason: 'ambiguous-duty-overlap' };
  }
  return { period: scored[0].period, reason: 'overlap' };
}

function dayInScope(dayKey, scope) {
  if (scope.kind === 'day') return dayKey === scope.day;
  const start = scope.startDay;
  const end = scope.endDay || scope.startDay;
  return dayKey >= start && dayKey <= end;
}

function validateScope(scope) {
  if (!scope || !['day', 'range', 'pilot'].includes(scope.kind)) {
    return 'Choose a day, a date range, or a pilot.';
  }
  if (scope.kind === 'day') {
    if (!parseDay(scope.day)) return 'A day scope needs a YYYY-MM-DD date.';
    return null;
  }
  if (!parseDay(scope.startDay) || !parseDay(scope.endDay || scope.startDay)) {
    return 'A date range needs start and end dates (YYYY-MM-DD).';
  }
  if ((scope.endDay || scope.startDay) < scope.startDay) return 'The end date is before the start date.';
  if (scope.kind === 'pilot' && !scope.pilotUid) return 'Choose a pilot.';
  return null;
}

function retagSegments(period, partner) {
  if (!Array.isArray(period.crewSegments) || period.crewSegments.length === 0) return null;
  const hasRealTwo = period.crewSegments.some((segment) => (
    segment.crewType === 'two' && segment.awaitingReplacement !== true && segment.partnerUid
  ));
  if (hasRealTwo) return null;
  return period.crewSegments.map((segment) => ({
    ...segment,
    crewType: 'two',
    awaitingReplacement: false,
    partnerPeriodId: partner.id,
    partnerUid: partner.pilotUid,
    partnerName: partner.pilotName || segment.partnerName || null,
  }));
}

function limitSummary(pilotUid, periods, at) {
  const mine = periods.filter((period) => usable(period) && period.pilotUid === pilotUid);
  const legal = evaluateCurrent(mine, [], at, 'two');
  let singleMs = 0;
  let twoMs = 0;
  for (const period of mine) {
    if (!Number.isFinite(period.dutyOnAt)) continue;
    if (period.dutyOnAt < at - 24 * HOUR || period.dutyOnAt >= at) continue;
    const buckets = flightBuckets(period);
    singleMs += buckets.singleMs;
    twoMs += buckets.twoMs;
  }
  const rest = restOutlook(mine, at);
  return {
    status: legal.status,
    blocked: legal.blockers.map((check) => check.code),
    singleFlightMs: singleMs,
    twoFlightMs: twoMs,
    restRequiredMs: rest.requiredMs,
    restBlocked: Boolean(rest.blocked),
    singlePilotFlag: legal.checks.some((check) => check.code === 'FT_24H_SINGLE' && check.severity === 'block'),
    extendedRest16: rest.requiredMs >= EXTENDED_REST_TIER_3_MS,
  };
}

function evalInstant(periods, now) {
  const offs = periods.map((period) => period.dutyOffAt).filter(Number.isFinite);
  if (offs.length === 0) return now;
  return Math.max(...offs) + HOUR;
}

function scheduleNote(pairing) {
  const tails = (pairing.tails || []).filter(Boolean).join(', ') || 'unspecified tail';
  return `Schedule ${pairing.day} pairs ${pairing.picName} (PIC) and ${pairing.sicName} (SIC) on ${tails}.`;
}

/**
 * Dry-run a schedule resync.
 * `reason` is the administrator's note and is copied onto every audit entry.
 */
export function planScheduleResync({
  periods = [],
  trips = [],
  users = [],
  scope,
  timeZone = 'America/New_York',
  now = Date.now(),
  actorName = 'admin',
  reason,
}) {
  const reasonText = String(reason || '').trim();
  if (!reasonText) return { ok: false, status: 400, error: 'A reason is required before crew links can be resynced.' };
  const scopeError = validateScope(scope);
  if (scopeError) return { ok: false, status: 400, error: scopeError };

  const pairings = buildCrewDayPairings(trips, { timeZone }).filter((pairing) => dayInScope(pairing.day, scope));
  const warnings = [];
  const desired = new Map();

  for (const pairing of pairings) {
    const picMatch = matchSchedulePilot(pairing.picName, users);
    const sicMatch = matchSchedulePilot(pairing.sicName, users);
    const picUid = uidOf(picMatch.user);
    const sicUid = uidOf(sicMatch.user);
    if (scope.kind === 'pilot' && picUid !== scope.pilotUid && sicUid !== scope.pilotUid) {
      const selected = users.find((user) => uidOf(user) === scope.pilotUid);
      const named = selected && (
        crewNamesMatch(pairing.picName, selected.name || selected.displayName || selected.jetinsightName)
        || crewNamesMatch(pairing.sicName, selected.name || selected.displayName || selected.jetinsightName)
      );
      if (!named) continue;
    }
    if (!picMatch.user || !sicMatch.user) {
      warnings.push({
        pairingId: pairing.id,
        day: pairing.day,
        reason: !picMatch.user ? picMatch.reason : sicMatch.reason,
        detail: `${pairing.picName} / ${pairing.sicName}`,
      });
      continue;
    }
    if (picUid === sicUid) {
      warnings.push({ pairingId: pairing.id, day: pairing.day, reason: 'pair-resolved-to-same-user', detail: picUid });
      continue;
    }
    const span = spanOf(pairing);
    const picBest = bestPeriod(periods.filter((period) => usable(period) && period.pilotUid === picUid), span, now);
    const sicBest = bestPeriod(periods.filter((period) => usable(period) && period.pilotUid === sicUid), span, now);
    if (!picBest.period || !sicBest.period) {
      warnings.push({
        pairingId: pairing.id,
        day: pairing.day,
        reason: !picBest.period ? `pic-${picBest.reason}` : `sic-${sicBest.reason}`,
        detail: `${pairing.picName} / ${pairing.sicName}`,
      });
      continue;
    }
    const consider = (period, partner) => {
      const prev = desired.get(period.id);
      if (prev && prev.spanEnd > (span?.end || 0)) return;
      desired.set(period.id, {
        period,
        partner,
        spanEnd: span?.end || 0,
        scheduleReason: scheduleNote(pairing),
      });
    };
    consider(picBest.period, sicBest.period);
    consider(sicBest.period, picBest.period);
  }

  const applied = periods.map((period) => ({ ...period }));
  const byApplied = new Map(applied.map((period) => [period.id, period]));
  const changes = [];
  const writes = [];

  for (const want of desired.values()) {
    const period = want.period;
    const partner = want.partner;
    const segments = retagSegments(period, partner);
    const linkDiffers = period.partnerPeriodId !== partner.id
      || period.crewType !== 'two'
      || period.awaitingPartner === true;
    if (!linkDiffers && !segments) continue;

    const patch = {
      crewType: 'two',
      partnerPeriodId: partner.id,
      awaitingPartner: false,
      updatedAt: now,
    };
    if (segments) patch.crewSegments = segments;
    const before = snapshotDuty(period);
    const after = snapshotDuty({ ...period, ...patch });
    const note = `${reasonText} ${want.scheduleReason} Duty-on, duty-off, and flight time were not changed.`;
    patch.adminEdits = [
      ...(Array.isArray(period.adminEdits) ? period.adminEdits : []),
      {
        by: actorName || 'admin',
        at: now,
        field: 'scheduleResync',
        from: before,
        to: after,
        reason: reasonText,
        note,
      },
    ];
    const target = byApplied.get(period.id);
    if (target) Object.assign(target, patch, {
      dutyOnAt: period.dutyOnAt,
      dutyOffAt: period.dutyOffAt ?? null,
      flightTimeMs: period.flightTimeMs,
    });
    changes.push({
      id: period.id,
      pilotUid: period.pilotUid,
      pilotName: period.pilotName || null,
      tail: period.tail || null,
      before,
      after,
      timesUnchanged: true,
      flightUnchanged: true,
      reason: note,
    });
    writes.push({ op: 'update', id: period.id, patch });
  }

  const touchedPilots = [...new Set(changes.map((change) => change.pilotUid))];
  for (const pilotUid of touchedPilots) {
    const originals = periods.filter((period) => period.pilotUid === pilotUid);
    const next = applied.filter((period) => period.pilotUid === pilotUid);
    const at = evalInstant(next.length ? next : originals, now);
    const limitsBefore = limitSummary(pilotUid, periods, at);
    const limitsAfter = limitSummary(pilotUid, applied, at);
    for (const change of changes) {
      if (change.pilotUid !== pilotUid) continue;
      change.limitsBefore = limitsBefore;
      change.limitsAfter = limitsAfter;
      change.evaluatedAt = at;
    }
  }

  const fingerprint = changes
    .map((change) => `${change.id}:${change.after.crewType}:${change.after.partnerPeriodId}`)
    .sort()
    .join('|');

  return {
    ok: true,
    changes,
    writes,
    warnings,
    fingerprint,
    summary: {
      pairings: pairings.length,
      changes: changes.length,
      warnings: warnings.length,
      pilots: touchedPilots.length,
    },
  };
}
