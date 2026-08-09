// Pure matching/planning logic for paired-duty repair.
//
// Historical automation must be conservative. A missing record is annoying;
// a record attached to the wrong pilot is a compliance defect. Every resolver
// below returns a result only when the evidence identifies exactly one person
// and one period. Ambiguous cases are reported for manual review.

const MS_HOUR = 3600_000;
const LINK_TOLERANCE_MS = 30 * 60_000;

const norm = (value) => String(value || '').trim().toLowerCase();
const tail = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function tokens(value) {
  return norm(value)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((part) => part.length >= 2);
}

export function complementaryRole(role) {
  const upper = String(role || '').toUpperCase();
  if (upper === 'PIC') return 'SIC';
  if (upper === 'SIC') return 'PIC';
  return null;
}

export function eligiblePilots(users) {
  return users.filter((user) => {
    const role = norm(user.role);
    return Boolean(user.uid || user.id)
      && user.approved === true
      && user.active !== false
      && ['crew', 'pilot', 'admin', 'ops', 'chief-pilot', 'chief_pilot'].includes(role);
  });
}

/**
 * Resolve a schedule crew string to exactly one approved profile.
 * Exact `jetinsightName`/name wins. Fuzzy first+last token matching is allowed
 * only when it leaves one candidate.
 */
export function resolvePilot(crewName, users) {
  const target = norm(crewName);
  if (!target) return { user: null, reason: 'missing-name' };
  const pilots = eligiblePilots(users);
  const exact = pilots.filter((user) => (
    norm(user.jetinsightName) === target
    || norm(user.name) === target
    || norm(user.displayName) === target
  ));
  if (exact.length === 1) return { user: exact[0], reason: 'exact' };
  if (exact.length > 1) return { user: null, reason: 'ambiguous-exact' };

  const targetTokens = tokens(crewName);
  if (targetTokens.length < 2) return { user: null, reason: 'insufficient-name' };
  const first = targetTokens[0];
  const last = targetTokens[targetTokens.length - 1];
  const fuzzy = pilots.filter((user) => {
    const candidate = new Set(tokens(user.jetinsightName || user.name || user.displayName));
    return candidate.has(first) && candidate.has(last);
  });
  if (fuzzy.length === 1) return { user: fuzzy[0], reason: 'first-last' };
  return { user: null, reason: fuzzy.length ? 'ambiguous-fuzzy' : 'no-user-match' };
}

function overlaps(a, b) {
  const aStart = Number(a.dutyOnAt);
  const aEnd = Number(a.dutyOffAt ?? Date.now());
  const bStart = Number(b.dutyOnAt);
  const bEnd = Number(b.dutyOffAt ?? Date.now());
  return Number.isFinite(aStart) && Number.isFinite(aEnd)
    && Number.isFinite(bStart) && Number.isFinite(bEnd)
    && aStart < bEnd && bStart < aEnd;
}

function similarPeriod(a, b) {
  if (!a || !b || a.pilotUid === b.pilotUid) return false;
  if (tail(a.tail) && tail(b.tail) && tail(a.tail) !== tail(b.tail)) return false;
  const aRole = complementaryRole(a.role);
  if (aRole && b.role && aRole !== String(b.role).toUpperCase()) return false;
  if (Math.abs(Number(a.dutyOnAt) - Number(b.dutyOnAt)) > LINK_TOLERANCE_MS) return false;
  if (Number.isFinite(a.dutyOffAt) && Number.isFinite(b.dutyOffAt)
      && Math.abs(a.dutyOffAt - b.dutyOffAt) > 2 * MS_HOUR) return false;
  return true;
}

function tripTime(trip) {
  const raw = trip?.start;
  const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function findTripForPeriod(period, trips) {
  if (period.tripId) {
    const exact = trips.filter((trip) => String(trip.uid || trip.id) === String(period.tripId));
    if (exact.length === 1) return { trip: exact[0], reason: 'trip-id' };
    if (exact.length > 1) return { trip: null, reason: 'ambiguous-trip-id' };
  }
  const pTail = tail(period.tail);
  if (!pTail || !Number.isFinite(period.dutyOnAt)) return { trip: null, reason: 'no-trip-key' };
  const end = Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : period.dutyOnAt + 18 * MS_HOUR;
  const matches = trips.filter((trip) => {
    if (tail(trip?.info?.tail) !== pTail) return false;
    const start = tripTime(trip);
    return start != null && start >= period.dutyOnAt - 2 * MS_HOUR && start <= end + 2 * MS_HOUR;
  });
  if (matches.length === 1) return { trip: matches[0], reason: 'tail-window' };
  return { trip: null, reason: matches.length ? 'ambiguous-trip-window' : 'no-trip-match' };
}

function uidFromDeterministicPeriodId(periodId, dutyOnAt) {
  const suffix = `_${dutyOnAt}`;
  const id = String(periodId || '');
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : null;
}

function addSkip(skips, period, reason, detail = '') {
  skips.push({
    periodId: period?.id || null,
    pilotUid: period?.pilotUid || null,
    pilotName: period?.pilotName || null,
    reason,
    detail,
  });
}

/**
 * Build an idempotent backfill plan.
 *
 * Actions:
 *   link   — two existing periods clearly represent the same paired duty
 *   create — counterpart is missing; clone source timing/assignment data,
 *            then link both records
 */
export function buildDutyPairBackfillPlan({ periods = [], users = [], trips = [] }) {
  const byId = new Map(periods.map((period) => [period.id, period]));
  const byPilot = new Map();
  for (const period of periods) {
    if (!byPilot.has(period.pilotUid)) byPilot.set(period.pilotUid, []);
    byPilot.get(period.pilotUid).push(period);
  }

  const actions = [];
  const skips = [];
  const consumed = new Set();

  const planLink = (a, b, evidence) => {
    const pic = String(a.role).toUpperCase() === 'PIC' ? a : b;
    const sic = pic === a ? b : a;
    if (String(pic.role).toUpperCase() !== 'PIC' || String(sic.role).toUpperCase() !== 'SIC') {
      addSkip(skips, a, 'roles-not-complementary', `${a.role || '?'} / ${b.role || '?'}`);
      return;
    }
    actions.push({ type: 'link', picId: pic.id, sicId: sic.id, evidence });
    consumed.add(a.id);
    consumed.add(b.id);
  };

  // 0) Repair a one-way link when the referenced period exists and its facts
  // agree. This can be left by a historical partial import.
  for (const source of periods) {
    if (!source.partnerPeriodId || consumed.has(source.id)) continue;
    const target = byId.get(source.partnerPeriodId);
    if (!target || target.partnerPeriodId === source.id) continue;
    if (target.partnerPeriodId && target.partnerPeriodId !== source.id) {
      addSkip(skips, source, 'partner-linked-elsewhere', target.partnerPeriodId);
      consumed.add(source.id);
      consumed.add(target.id);
      continue;
    }
    if (similarPeriod(source, target)) planLink(source, target, 'one-way-partner-link');
    else addSkip(skips, source, 'one-way-link-facts-disagree', target.id);
  }

  // 1) Repair dangling cross-links. This is the strongest evidence because
  // the original paired start recorded the intended counterpart's exact id.
  for (const source of periods) {
    if (!source.partnerPeriodId || byId.has(source.partnerPeriodId) || consumed.has(source.id)) continue;
    const targetUid = uidFromDeterministicPeriodId(source.partnerPeriodId, source.dutyOnAt);
    const target = users.find((user) => (user.uid || user.id) === targetUid);
    const role = complementaryRole(source.role);
    if (!targetUid || !target || !role) {
      addSkip(skips, source, 'dangling-link-unresolvable', source.partnerPeriodId);
      continue;
    }
    if ((byPilot.get(targetUid) || []).some((period) => overlaps(source, period))) {
      addSkip(skips, source, 'counterpart-overlap-exists', target.name || targetUid);
      continue;
    }
    actions.push({
      type: 'create',
      sourceId: source.id,
      targetUid,
      targetName: target.name || target.displayName || target.email || targetUid,
      targetRole: role,
      targetId: source.partnerPeriodId,
      evidence: 'dangling-partner-link',
    });
    consumed.add(source.id);
  }

  // 2) Link existing unlinked complementary records when there is exactly one
  // candidate in the same tail/start-time window.
  for (const source of periods) {
    if (consumed.has(source.id) || source.partnerPeriodId || source.confirmStatus === 'declined') continue;
    const candidates = periods.filter((candidate) => (
      !consumed.has(candidate.id)
      && !candidate.partnerPeriodId
      && candidate.confirmStatus !== 'declined'
      && similarPeriod(source, candidate)
    ));
    if (candidates.length === 1) planLink(source, candidates[0], 'same-tail-and-time');
    else if (candidates.length > 1) {
      addSkip(skips, source, 'ambiguous-existing-counterpart', String(candidates.length));
      // Quarantine the whole ambiguous cluster. Otherwise each candidate sees
      // the source as its one match on the next loop and the result depends on
      // iteration order — exactly the kind of guess this planner forbids.
      consumed.add(source.id);
      candidates.forEach((candidate) => consumed.add(candidate.id));
    }
  }

  // 3) Use trip PIC/SIC assignments to create a genuinely missing period.
  for (const source of periods) {
    if (consumed.has(source.id) || source.partnerPeriodId || source.confirmStatus === 'declined') continue;
    const role = String(source.role || '').toUpperCase();
    const targetRole = complementaryRole(role);
    if (!targetRole) {
      addSkip(skips, source, 'missing-source-role');
      continue;
    }
    const { trip, reason: tripReason } = findTripForPeriod(source, trips);
    if (!trip) {
      addSkip(skips, source, tripReason);
      continue;
    }
    const crewName = targetRole === 'PIC' ? trip.info?.pic : trip.info?.sic;
    const { user: target, reason: userReason } = resolvePilot(crewName, users);
    if (!target) {
      addSkip(skips, source, userReason, crewName || '');
      continue;
    }
    const targetUid = target.uid || target.id;
    if (targetUid === source.pilotUid) {
      addSkip(skips, source, 'counterpart-resolved-to-self');
      continue;
    }
    const existingForTarget = byPilot.get(targetUid) || [];
    const overlapsExisting = existingForTarget.filter((period) => overlaps(source, period));
    if (overlapsExisting.length > 0) {
      // An existing matching period should have been linked in pass 2. Any
      // other overlap is ambiguous and must not be overwritten.
      addSkip(skips, source, 'counterpart-overlap-exists', target.name || targetUid);
      continue;
    }
    const targetId = `${targetUid}_${source.dutyOnAt}`;
    if (byId.has(targetId)) {
      addSkip(skips, source, 'target-id-exists', targetId);
      continue;
    }
    actions.push({
      type: 'create',
      sourceId: source.id,
      targetUid,
      targetName: target.name || target.displayName || target.email || targetUid,
      targetRole,
      targetId,
      tripId: trip.uid || trip.id || source.tripId || null,
      evidence: `schedule-${tripReason}`,
    });
    consumed.add(source.id);
  }

  return {
    actions,
    skips,
    summary: {
      scanned: periods.length,
      links: actions.filter((action) => action.type === 'link').length,
      creates: actions.filter((action) => action.type === 'create').length,
      skipped: skips.length,
    },
  };
}

