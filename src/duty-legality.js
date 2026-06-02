// src/duty-legality.js
//
// =====================================================================
// PART 135 DUTY/REST LEGALITY ENGINE
// =====================================================================
//
// REGULATORY BASIS
//   14 CFR § 135.265 (Flight time limitations and rest requirements:
//                     Scheduled operations) — Skyway operates unscheduled,
//                     so 135.265 mostly does NOT apply, EXCEPT subsection
//                     (c) which is the quarterly 24-hour rest rule that
//                     applies to ALL Part 135 ops regardless of scheduling.
//   14 CFR § 135.267 (Flight time limitations and rest requirements:
//                     Unscheduled one- and two-pilot crews) — THIS IS
//                     SKYWAY'S CORE RULE. Almost all Skyway flying is
//                     governed by 135.267.
//
// HOW 135.267 IS STRUCTURED
//   135.267(a) — Applies to unscheduled passenger-carrying ops where
//                the operator is paid for OR arranges a flight which is
//                not scheduled.
//   135.267(b) — The "unscheduled assignment" path:
//                  - Single pilot: max 8 hours flight time in any
//                    24 consecutive hours.
//                  - Two pilots with rest provisions: max 10 hours
//                    flight time in any 24 consecutive hours.
//                  - 10 consecutive hours of rest in the 24 hours
//                    BEFORE the planned completion of the assignment.
//   135.267(c) — Optional "regular assigned duty period" path:
//                  - Duty period of up to 14 hours, plus required
//                    rest before and after.
//                  - Duty period + rest must total at least 24 hours.
//                  - Flight time still limited to 8/10 hours.
//   135.267(d) — Extended rest if flight time exceeded due to
//                circumstances outside the pilot/operator's control:
//                  - 0–30 min over → 11 hours rest
//                  - 31–60 min over → 12 hours rest
//                  - 60+ min over   → 16 hours rest
//                NOTE: Excursions only permitted if outside control.
//                Pilot-caused excursions are violations, not allowed.
//   135.265(c) — Quarterly rest: each crewmember must have AT LEAST
//                13 rest periods of 24 consecutive hours during any
//                calendar quarter.
//
// HONEST CAVEATS — read these before relying on this engine
//   1. This is a software engineer's interpretation of the regs, NOT
//      a lawyer's. Skyway's DO/CP MUST review.
//   2. The engine assumes Skyway operates under 135.267, not 135.265
//      (i.e. unscheduled). If Skyway has any scheduled service, this
//      engine does NOT compute correctly for those legs.
//   3. "Flight time" here means actual block time (wheels rolling).
//      The engine cannot distinguish flight time from duty time — it
//      relies on the recorded value being correct.
//   4. "Commercial flying outside the company" (FAR aggregate-flight-
//      time rules) is not auto-tracked. Pilots must self-report. If
//      a pilot flies for another operator and doesn't enter it, the
//      engine will say legal when it isn't.
//   5. "Free from duty" is interpreted liberally — any duty-state
//      record with status='off' counts as rest. Edge cases (standby
//      at FBO, company transportation that's not local, "on call"
//      status) are NOT distinguished. If those situations apply,
//      the duty period should be recorded as on-duty, not rest.
//   6. Time zone handling: all timestamps are unix epoch milliseconds
//      (UTC). The "24 consecutive hours" is computed as ±86,400,000 ms.
//      Calendar-quarter boundaries use the SERVER's local time, which
//      could differ from a pilot's local time by up to a day at
//      quarter boundaries. This is unlikely to affect a real ramp
//      check but is a known limitation.
//   7. The engine is CONSERVATIVE — if data is missing or ambiguous,
//      it errs on the side of flagging the situation rather than
//      passing it. This means false-positive warnings are expected.
//
// =====================================================================

// ---- Constants ----

const MS_PER_HR = 3600 * 1000;
const MS_PER_DAY = 24 * MS_PER_HR;

// Flight time limits
const SINGLE_PILOT_FLIGHT_MAX_MS = 8 * MS_PER_HR;
const TWO_PILOT_FLIGHT_MAX_MS = 10 * MS_PER_HR;

// Rest requirements
const REST_REQUIRED_BEFORE_MS = 10 * MS_PER_HR;     // 135.267(b)
const REGULAR_DUTY_MAX_MS = 14 * MS_PER_HR;          // 135.267(c)

// Extended rest after flight-time excursion (135.267(d))
const EXTENDED_REST_TIER_1_MS = 11 * MS_PER_HR;   // 0-30 min over
const EXTENDED_REST_TIER_2_MS = 12 * MS_PER_HR;   // 31-60 min over
const EXTENDED_REST_TIER_3_MS = 16 * MS_PER_HR;   // 60+ min over

// Quarterly 24h rest days (135.265(c))
const QUARTERLY_24H_REST_DAYS_REQUIRED = 13;

// Warning thresholds — these aren't regulatory; they're our "approaching
// the limit" indicators so dispatch sees a yellow warning before red.
const WARN_AT_FRACTION = 0.85;   // 85% of any limit fires a warning

export const LIMITS = {
  SINGLE_PILOT_FLIGHT_MAX_MS,
  TWO_PILOT_FLIGHT_MAX_MS,
  REST_REQUIRED_BEFORE_MS,
  REGULAR_DUTY_MAX_MS,
  EXTENDED_REST_TIER_1_MS,
  EXTENDED_REST_TIER_2_MS,
  EXTENDED_REST_TIER_3_MS,
  QUARTERLY_24H_REST_DAYS_REQUIRED,
};

// ---- Period shape (input contract) ----
//
// A "period" is what's stored in Firestore. Required fields:
//   {
//     id:           string,
//     pilotUid:     string,
//     pilotName:    string,
//     dutyOnAt:     number (ms),
//     dutyOffAt:    number | null (null = still on duty),
//     flightTimeMs: number  (sum of block time for legs in this duty period;
//                            0 if no flying or duty was non-flight, e.g.
//                            maintenance ferry, training, ground duty),
//     assignmentType: 'unscheduled' | 'regular',
//     crewType:     'single' | 'two',
//     tail:         string | null,
//     tripId:       string | null,
//     role:         'PIC' | 'SIC' | null,
//     overrideStatus: 'none' | 'requested' | 'approved' | null,
//     extensionReason: string | null  (set when flight-time excursion is
//                                       claimed as "outside control")
//   }
//
// "Outside flying" is a separate input — pilots can record commercial
// flying they did for OTHER operators. Shape:
//   { startAt, endAt, flightTimeMs, source }
// This is summed into the rolling-24h check.

// ---- Helpers ----

/**
 * Compute total flight time across periods within a [windowStart, windowEnd]
 * window. Only counts periods that OVERLAP the window — partial-overlap is
 * NOT pro-rated because flight time is discrete leg time, not continuous.
 * If a duty period straddles the window edge, we count its flight time only
 * if the duty period started inside the window. This is a simplification —
 * see caveat #3.
 *
 * Returns total ms of flight time.
 */
export function flightTimeInWindow(periods, windowStart, windowEnd) {
  let total = 0;
  for (const p of periods || []) {
    if (!p || !Number.isFinite(p.dutyOnAt)) continue;
    if (p.dutyOnAt >= windowStart && p.dutyOnAt < windowEnd) {
      total += p.flightTimeMs || 0;
    }
  }
  return total;
}

/**
 * Find the most recent rest period (period with status='off' implied by
 * having dutyOffAt set) that ENDED before `t`. Returns the dutyOffAt time
 * (start of rest) and the next period's dutyOnAt (end of rest), so rest
 * length = nextOn - thisOff. If there's no next period yet (pilot is
 * currently in rest), uses `t` as the rest end.
 *
 * Returns { restStart, restEnd, restMs } or null if no rest found.
 */
export function lastRestBefore(periods, t) {
  if (!Array.isArray(periods) || periods.length === 0) return null;
  // Sort by dutyOnAt ascending, defensive copy
  const sorted = [...periods]
    .filter(p => p && Number.isFinite(p.dutyOnAt))
    .sort((a, b) => a.dutyOnAt - b.dutyOnAt);
  // Find the closed period whose dutyOffAt is <= t. Walk backwards.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    if (!Number.isFinite(p.dutyOffAt)) continue;
    if (p.dutyOffAt > t) continue;
    // This is the most recent closed period. Rest started at dutyOffAt.
    // Rest ends at the NEXT period's dutyOnAt, or `t` if none.
    const next = sorted[i + 1];
    const restStart = p.dutyOffAt;
    const restEnd = next && Number.isFinite(next.dutyOnAt) ? next.dutyOnAt : t;
    return { restStart, restEnd, restMs: restEnd - restStart };
  }
  return null;
}

/**
 * Compute calendar-quarter start/end for a given timestamp.
 * Quarters: Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec.
 * Uses the server's local timezone (see caveat #6).
 */
export function quarterRange(t = Date.now()) {
  const d = new Date(t);
  const year = d.getFullYear();
  const month = d.getMonth();
  const qStartMonth = month - (month % 3);
  const start = new Date(year, qStartMonth, 1, 0, 0, 0, 0).getTime();
  const end = new Date(year, qStartMonth + 3, 1, 0, 0, 0, 0).getTime();
  return { start, end, year, quarter: Math.floor(qStartMonth / 3) + 1 };
}

/**
 * Count 24-hour rest periods within a quarter for compliance with
 * 135.265(c). A "24-hour rest period" is defined as 24 consecutive
 * hours FREE FROM ALL DUTY. To count it, the pilot must have been
 * off-duty for at least 24 consecutive hours within the quarter.
 *
 * Algorithm: build a timeline of duty-on/duty-off events within the
 * quarter, walk through it, count gaps >= 24h. A gap that straddles a
 * quarter boundary is only counted if the >=24h is INSIDE the quarter
 * (conservative — partial credits not awarded). If a pilot is off-duty
 * at the start of the quarter and a duty starts later, the time from
 * quarter-start to that first dutyOnAt is also a candidate rest gap.
 * Similarly at the end of the quarter (using min(now, quarterEnd) as
 * the right edge of the last gap).
 *
 * Returns { count, gaps: [{start, end, ms}] }.
 */
export function quarterRestDayCount(periods, atTime = Date.now()) {
  const q = quarterRange(atTime);
  // Right edge of measurement is min(now, quarterEnd) — we don't count
  // rest in the future.
  const measureEnd = Math.min(atTime, q.end);

  // Build sorted on/off events within or overlapping the quarter
  const inQuarter = (periods || [])
    .filter(p => p && Number.isFinite(p.dutyOnAt))
    // Include periods that started before the quarter but may still be
    // on-duty into the quarter, AND periods that end inside the quarter
    .filter(p => {
      const on = p.dutyOnAt;
      const off = Number.isFinite(p.dutyOffAt) ? p.dutyOffAt : atTime;
      return off > q.start && on < q.end;
    })
    .map(p => ({
      dutyOnAt: Math.max(p.dutyOnAt, q.start),
      dutyOffAt: Number.isFinite(p.dutyOffAt)
        ? Math.min(p.dutyOffAt, measureEnd)
        : measureEnd,
    }))
    .sort((a, b) => a.dutyOnAt - b.dutyOnAt);

  const gaps = [];
  // Leading gap from quarter start to first duty
  let cursor = q.start;
  for (const p of inQuarter) {
    if (p.dutyOnAt > cursor) {
      const gap = p.dutyOnAt - cursor;
      if (gap >= MS_PER_DAY) {
        gaps.push({ start: cursor, end: p.dutyOnAt, ms: gap });
      }
    }
    cursor = Math.max(cursor, p.dutyOffAt);
  }
  // Trailing gap from last duty to measurement end
  if (cursor < measureEnd) {
    const gap = measureEnd - cursor;
    if (gap >= MS_PER_DAY) {
      gaps.push({ start: cursor, end: measureEnd, ms: gap });
    }
  }

  // Count distinct 24-hour rest periods. A single >24h gap counts as ONE
  // rest day — not multiple — because the reg requires 13 separate rest
  // periods of 24 consecutive hours, not 13 cumulative days off.
  // (Interpretation: I'm reading "13 rest periods" as 13 distinct gaps
  // each ≥24h, NOT 312 cumulative hours of rest. This is conservative;
  // some operators count differently. Verify with your DO.)
  return { count: gaps.length, gaps, quarter: q };
}

// ---- Core legality checks ----
//
// Each check returns { ok, severity, code, message, details? }
//   severity: 'info' | 'warn' | 'block'
//   code:     stable identifier for the rule (e.g. 'FT_24H', 'REST_10')
//   message:  human-readable explanation
//
// The OVERALL legality computed at the end is:
//   any 'block' → status = 'illegal'
//   any 'warn' (no block) → status = 'warning'
//   else → status = 'legal'

/**
 * Check 1: 8/10 hour flight time in any 24 consecutive hours.
 * 135.267(b)(1) — single pilot, 8h
 * 135.267(b)(2) — two pilots with rest provisions, 10h
 *
 * The reg says "during any 24 consecutive hours" — that means SLIDING
 * WINDOW, not a single fixed window. We must find the worst 24-hour
 * window across the relevant timeline and check whether it exceeds.
 *
 * Algorithm: build a list of "flight events" — each duty period's
 * flight time placed at the period's dutyOnAt (we treat flight time as
 * occurring at the period start as a simplification). Then for each
 * event, compute the sum of flight time in the 24-hour window ENDING
 * at that event's start + the event's own flight time. Track the max.
 *
 * Outside commercial flying counts toward the same window.
 */
function check_flightTime24h(periods, outsideFlying, crewType, atTime) {
  const limit = crewType === 'two'
    ? TWO_PILOT_FLIGHT_MAX_MS
    : SINGLE_PILOT_FLIGHT_MAX_MS;
  const limitHrs = limit / MS_PER_HR;

  // Combine periods + outside flying into a uniform event list
  const events = [];
  for (const p of periods || []) {
    if (!p || !Number.isFinite(p.dutyOnAt)) continue;
    if (!p.flightTimeMs) continue;
    events.push({ at: p.dutyOnAt, ms: p.flightTimeMs });
  }
  for (const o of outsideFlying || []) {
    if (!o || !Number.isFinite(o.startAt)) continue;
    if (!o.flightTimeMs) continue;
    events.push({ at: o.startAt, ms: o.flightTimeMs });
  }
  // Only events at or before atTime are relevant for "past" check.
  // For PROPOSED checks, the proposed period is already in `periods`
  // with its future dutyOnAt; we want to evaluate that future window
  // too. So we keep events even slightly in the future.
  events.sort((a, b) => a.at - b.at);

  // For each event, sum flight time of all events within the 24h
  // window ending at this event's `at + ms` (covers the event itself
  // plus everything before that ends within 24h prior to this event's
  // END time).
  //
  // Alternative interpretation: 24h ending at the event's START. The
  // reg phrasing is "during any 24 consecutive hours the total flight
  // time...may not exceed." It's a window, not anchored to events.
  // The safest interpretation is to use the SAME 24h ending at each
  // event's end time, which is what gives the worst-case sum.
  let worstWindowSum = 0;
  let worstWindowEnd = atTime;
  for (let i = 0; i < events.length; i++) {
    const windowEnd = events[i].at + events[i].ms;
    const windowStart = windowEnd - MS_PER_DAY;
    let sum = 0;
    for (let j = 0; j <= i; j++) {
      // Event flew DURING [at, at+ms]. If any part is inside [windowStart, windowEnd],
      // count its flight time. Simplification: count the WHOLE event if its
      // start <= windowEnd AND its end >= windowStart. We do not pro-rate.
      const evStart = events[j].at;
      const evEnd = events[j].at + events[j].ms;
      if (evStart < windowEnd && evEnd > windowStart) {
        sum += events[j].ms;
      }
    }
    if (sum > worstWindowSum) {
      worstWindowSum = sum;
      worstWindowEnd = windowEnd;
    }
  }

  // Also check the window ending at atTime (current moment) in case
  // there's no recent event but the user is asking "where are we now?"
  if (events.length > 0) {
    const wStart = atTime - MS_PER_DAY;
    let sum = 0;
    for (const e of events) {
      const evStart = e.at;
      const evEnd = e.at + e.ms;
      if (evStart < atTime && evEnd > wStart) sum += e.ms;
    }
    if (sum > worstWindowSum) {
      worstWindowSum = sum;
      worstWindowEnd = atTime;
    }
  }

  const hrs = worstWindowSum / MS_PER_HR;
  const details = {
    worstWindowMs: worstWindowSum,
    worstWindowEnd,
    limitMs: limit,
    crewType,
  };
  if (worstWindowSum > limit) {
    return {
      ok: false,
      severity: 'block',
      code: 'FT_24H',
      message: `Flight time in worst 24h window: ${hrs.toFixed(1)}h exceeds ${limitHrs}h ${crewType === 'two' ? 'two-pilot' : 'single-pilot'} limit. 14 CFR 135.267(b).`,
      details,
    };
  }
  if (worstWindowSum > limit * WARN_AT_FRACTION) {
    return {
      ok: true,
      severity: 'warn',
      code: 'FT_24H',
      message: `Worst 24h flight time: ${hrs.toFixed(1)}h of ${limitHrs}h (${(worstWindowSum / limit * 100).toFixed(0)}%). Approaching 135.267(b) limit.`,
      details,
    };
  }
  return {
    ok: true,
    severity: 'info',
    code: 'FT_24H',
    message: `Worst 24h flight time: ${hrs.toFixed(1)}h / ${limitHrs}h`,
    details,
  };
}

/**
 * Check 2: 10 hours rest in the 24 hours before planned completion.
 * 135.267(b)(3) — "during any 24 consecutive hours, the assignment must
 * provide at least 10 consecutive hours of rest before the planned
 * completion of the assignment."
 *
 * The interpretation: planned completion = end of the assignment being
 * proposed. The 24h window before that must contain a continuous 10h
 * rest gap. If we're EVALUATING an assignment that hasn't been recorded
 * yet, the caller passes `proposedDutyOnAt` and `proposedDutyOffAt`;
 * we then check whether the 24h before `proposedDutyOffAt` contains
 * 10h of continuous rest.
 *
 * If we're evaluating CURRENT duty state (no proposed assignment),
 * `proposedDutyOffAt` is null and we use `atTime` as the right edge.
 *
 * Extended-rest tiers (135.267(d)) increase the required rest if there
 * was a flight-time excursion in the prior duty. We check the most
 * recent CLOSED period for excursion and bump the required rest.
 */
function check_rest24h(periods, atTime, proposedDutyOffAt) {
  // Determine the assignment "completion" time we're computing toward
  const completion = Number.isFinite(proposedDutyOffAt) ? proposedDutyOffAt : atTime;

  // Determine required rest. Start at 10h; bump for prior excursion.
  let requiredMs = REST_REQUIRED_BEFORE_MS;
  let extendedReason = null;
  // Find the most recent closed period before `completion`
  const lastClosed = [...(periods || [])]
    .filter(p => p && Number.isFinite(p.dutyOnAt) && Number.isFinite(p.dutyOffAt))
    .filter(p => p.dutyOffAt <= completion)
    .sort((a, b) => b.dutyOffAt - a.dutyOffAt)[0];
  if (lastClosed) {
    const ft = lastClosed.flightTimeMs || 0;
    const limit = lastClosed.crewType === 'two'
      ? TWO_PILOT_FLIGHT_MAX_MS
      : SINGLE_PILOT_FLIGHT_MAX_MS;
    const overMs = ft - limit;
    if (overMs > 0) {
      if (overMs <= 30 * 60 * 1000) {
        requiredMs = EXTENDED_REST_TIER_1_MS;
        extendedReason = '0–30 min flight-time excursion';
      } else if (overMs <= 60 * 60 * 1000) {
        requiredMs = EXTENDED_REST_TIER_2_MS;
        extendedReason = '31–60 min flight-time excursion';
      } else {
        requiredMs = EXTENDED_REST_TIER_3_MS;
        extendedReason = '>60 min flight-time excursion';
      }
    }
  }

  // Find the largest continuous rest gap in the 24h window before completion
  const windowStart = completion - MS_PER_DAY;
  // Build occupied intervals (duty periods) inside the window
  const occupied = (periods || [])
    .filter(p => p && Number.isFinite(p.dutyOnAt))
    .map(p => ({
      start: Math.max(p.dutyOnAt, windowStart),
      end: Math.min(Number.isFinite(p.dutyOffAt) ? p.dutyOffAt : completion, completion),
    }))
    .filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start);

  // Merge overlapping intervals
  const merged = [];
  for (const i of occupied) {
    if (merged.length === 0 || merged[merged.length - 1].end < i.start) {
      merged.push({ ...i });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, i.end);
    }
  }

  // Find gaps between occupied intervals + leading/trailing gaps
  let largestGap = 0;
  let cursor = windowStart;
  for (const m of merged) {
    if (m.start > cursor) {
      largestGap = Math.max(largestGap, m.start - cursor);
    }
    cursor = m.end;
  }
  if (cursor < completion) {
    largestGap = Math.max(largestGap, completion - cursor);
  }

  const details = {
    requiredMs,
    actualLargestRestMs: largestGap,
    windowStart,
    windowEnd: completion,
    extendedReason,
  };
  const reqHrs = requiredMs / MS_PER_HR;
  const actualHrs = largestGap / MS_PER_HR;
  if (largestGap < requiredMs) {
    return {
      ok: false,
      severity: 'block',
      code: 'REST_24H',
      message: `Required ${reqHrs}h rest in 24h before completion not met. ` +
        `Largest continuous rest: ${actualHrs.toFixed(1)}h. ` +
        (extendedReason ? `Extended rest required due to ${extendedReason}. ` : '') +
        `14 CFR 135.267(b)${extendedReason ? '(d)' : ''}.`,
      details,
    };
  }
  return {
    ok: true,
    severity: 'info',
    code: 'REST_24H',
    message: `Required rest met: ${actualHrs.toFixed(1)}h ≥ ${reqHrs}h`,
    details,
  };
}

/**
 * Check 3: Regular duty period 14h max. 135.267(c).
 * Only applies when the period's assignmentType === 'regular'.
 * "Unscheduled" assignments under 135.267(b) don't have a hard duty
 * cap from the regs — they're limited by flight time + rest only.
 *
 * For ACTIVE on-duty periods, we check elapsed time. For closed periods,
 * we check the full duration.
 */
function check_dutyPeriod14h(period, atTime) {
  if (!period || !Number.isFinite(period.dutyOnAt)) {
    return { ok: true, severity: 'info', code: 'DUTY_14H', message: 'No active period.' };
  }
  if (period.assignmentType !== 'regular') {
    return {
      ok: true,
      severity: 'info',
      code: 'DUTY_14H',
      message: 'Unscheduled assignment — no 14h duty cap.',
    };
  }
  const end = Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : atTime;
  const elapsed = end - period.dutyOnAt;
  const hrs = elapsed / MS_PER_HR;
  if (elapsed > REGULAR_DUTY_MAX_MS) {
    return {
      ok: false,
      severity: 'block',
      code: 'DUTY_14H',
      message: `Regular duty period ${hrs.toFixed(1)}h exceeds 14h max. 135.267(c).`,
      details: { elapsedMs: elapsed, limitMs: REGULAR_DUTY_MAX_MS },
    };
  }
  if (elapsed > REGULAR_DUTY_MAX_MS * WARN_AT_FRACTION) {
    return {
      ok: true,
      severity: 'warn',
      code: 'DUTY_14H',
      message: `Approaching 14h regular duty limit: ${hrs.toFixed(1)}h.`,
      details: { elapsedMs: elapsed, limitMs: REGULAR_DUTY_MAX_MS },
    };
  }
  return {
    ok: true,
    severity: 'info',
    code: 'DUTY_14H',
    message: `Regular duty ${hrs.toFixed(1)}h / 14h`,
    details: { elapsedMs: elapsed, limitMs: REGULAR_DUTY_MAX_MS },
  };
}

/**
 * Check 4: Quarterly 24h rest days. 135.265(c).
 * Each crewmember must have at least 13 rest periods of 24 consecutive
 * hours in any calendar quarter. The reg applies to scheduled AND
 * unscheduled Part 135 ops (it's in 135.265 which says scheduled, but
 * 135.267(d)(3) re-cross-references and the FAA position is that the
 * quarterly 24h rest applies broadly to all 135 crewmembers).
 *
 * We check whether the pilot is ON TRACK to meet the 13-day requirement
 * by the end of the quarter. Not on track = warning, not block.
 * Genuinely missed (current count < days remaining) = warning still,
 * because the pilot might catch up — only block if the quarter has
 * ENDED and the count is still < 13.
 */
function check_quarterly13(periods, atTime) {
  const result = quarterRestDayCount(periods, atTime);
  const { count, quarter } = result;
  const daysIntoQuarter = (atTime - quarter.start) / MS_PER_DAY;
  const totalDaysInQuarter = (quarter.end - quarter.start) / MS_PER_DAY;
  const daysRemaining = totalDaysInQuarter - daysIntoQuarter;
  const stillNeeded = Math.max(0, QUARTERLY_24H_REST_DAYS_REQUIRED - count);
  const details = {
    count,
    required: QUARTERLY_24H_REST_DAYS_REQUIRED,
    quarter: `${quarter.year}-Q${quarter.quarter}`,
    daysRemainingInQuarter: Math.max(0, daysRemaining),
  };
  // If the quarter has ended and we still don't have 13 → block
  if (atTime >= quarter.end && count < QUARTERLY_24H_REST_DAYS_REQUIRED) {
    return {
      ok: false,
      severity: 'block',
      code: 'QTR_13',
      message: `Only ${count} of required 13 quarterly 24h rest days for ${quarter.year}-Q${quarter.quarter}. 135.265(c).`,
      details,
    };
  }
  // If still needed days > remaining calendar days → warn
  if (stillNeeded > daysRemaining) {
    return {
      ok: true,
      severity: 'warn',
      code: 'QTR_13',
      message: `${count} quarterly rest days so far; need ${stillNeeded} more in ${daysRemaining.toFixed(0)} days. May not achieve 13 by quarter end.`,
      details,
    };
  }
  return {
    ok: true,
    severity: 'info',
    code: 'QTR_13',
    message: `${count} quarterly rest days (need ${QUARTERLY_24H_REST_DAYS_REQUIRED} by quarter end)`,
    details,
  };
}

// ---- Top-level evaluation ----

/**
 * Evaluate legality for a pilot at a given moment.
 *
 * Inputs:
 *   periods:       all duty-periods-v2 docs for this pilot
 *   outsideFlying: all outside-flying entries for this pilot
 *   atTime:        unix ms — "as of when do we evaluate"
 *   options: {
 *     crewType: 'single' | 'two'        // assumed two-pilot if undefined
 *     proposedAssignment: {              // null if just checking current state
 *       dutyOnAt: number (ms),
 *       dutyOffAt: number (ms),
 *       flightTimeMs: number,
 *       assignmentType: 'unscheduled' | 'regular',
 *       crewType: 'single' | 'two',
 *     } | null
 *   }
 *
 * Returns:
 *   {
 *     status: 'legal' | 'warning' | 'illegal',
 *     checks: [{ ok, severity, code, message, details? }, ...],
 *     blockers: [filtered to severity='block'],
 *     warnings: [filtered to severity='warn'],
 *     summary: short text,
 *   }
 */
export function evaluateLegality(periods, outsideFlying, atTime, options = {}) {
  const safePeriods = Array.isArray(periods) ? periods : [];
  const safeOutside = Array.isArray(outsideFlying) ? outsideFlying : [];
  const proposed = options.proposedAssignment || null;
  // Crew type: if a proposed assignment specifies it, use that; otherwise
  // fall back to options.crewType, default 'two'.
  const crewType = proposed?.crewType || options.crewType || 'two';

  // For "evaluate proposed" mode, we VIRTUALLY add the proposed period to
  // the period list so the checks see the future state.
  const periodsForCheck = proposed
    ? [...safePeriods, {
        id: '_proposed_',
        pilotUid: '_proposed_',
        dutyOnAt: proposed.dutyOnAt,
        dutyOffAt: proposed.dutyOffAt,
        flightTimeMs: proposed.flightTimeMs || 0,
        assignmentType: proposed.assignmentType || 'unscheduled',
        crewType,
      }]
    : safePeriods;
  const checkTime = proposed?.dutyOffAt || atTime;

  // Active period for the 14h regular-duty check
  const activeNow = safePeriods
    .filter(p => p && p.dutyOnAt && !Number.isFinite(p.dutyOffAt))
    .sort((a, b) => b.dutyOnAt - a.dutyOnAt)[0]
    || proposed;

  const checks = [
    check_flightTime24h(periodsForCheck, safeOutside, crewType, checkTime),
    check_rest24h(periodsForCheck, atTime, proposed?.dutyOffAt),
    check_dutyPeriod14h(activeNow, checkTime),
    check_quarterly13(periodsForCheck, checkTime),
  ];

  const blockers = checks.filter(c => c.severity === 'block');
  const warnings = checks.filter(c => c.severity === 'warn');
  const status = blockers.length > 0
    ? 'illegal'
    : warnings.length > 0
      ? 'warning'
      : 'legal';
  const summary = blockers.length
    ? `ILLEGAL — ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}`
    : warnings.length
      ? `WARNING — ${warnings.length} approaching limit`
      : 'LEGAL';

  return { status, checks, blockers, warnings, summary };
}

/**
 * Convenience: evaluate the CURRENT state for a pilot (no proposed
 * assignment). Returns the same shape as evaluateLegality.
 */
export function evaluateCurrent(periods, outsideFlying, atTime = Date.now(), crewType = 'two') {
  return evaluateLegality(periods, outsideFlying, atTime, { crewType, proposedAssignment: null });
}

/**
 * Convenience: evaluate whether a PROPOSED trip assignment would be
 * legal for this pilot. Used by the dispatch pre-release check.
 *
 * proposed: {
 *   dutyOnAt, dutyOffAt, flightTimeMs,
 *   assignmentType: 'unscheduled' | 'regular',
 *   crewType: 'single' | 'two',
 * }
 */
export function evaluateProposed(periods, outsideFlying, proposed, atTime = Date.now()) {
  return evaluateLegality(periods, outsideFlying, atTime, { proposedAssignment: proposed });
}
