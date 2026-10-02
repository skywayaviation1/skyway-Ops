// Regulatory limits used by the Part 135 duty engine.
//
// These numbers are copied from the existing Skyway interpretation in
// src/duty-legality.js. Do not invent additional limits here.
//
//   14 CFR 135.267(b) — unscheduled one- and two-pilot flight time and rest
//     single pilot: 8 hours flight time in any 24 consecutive hours
//     two pilots:   10 hours flight time in any 24 consecutive hours
//     rest:         10 consecutive hours before the planned completion
//   14 CFR 135.267(c) — regular assigned duty period, 14 hours
//   14 CFR 135.267(d) — extended rest after a flight-time excursion
//     0–30 min over  → 11 hours
//     31–60 min over → 12 hours
//     more than 60   → 16 hours
//   14 CFR 135.265(c) — 13 rest periods of 24 hours in a calendar quarter

export const MS_PER_HR = 3600 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HR;

export const SINGLE_PILOT_FLIGHT_MAX_MS = 8 * MS_PER_HR;
export const TWO_PILOT_FLIGHT_MAX_MS = 10 * MS_PER_HR;
export const REST_REQUIRED_BEFORE_MS = 10 * MS_PER_HR;
export const REGULAR_DUTY_MAX_MS = 14 * MS_PER_HR;
export const EXTENDED_REST_TIER_1_MS = 11 * MS_PER_HR;
export const EXTENDED_REST_TIER_2_MS = 12 * MS_PER_HR;
export const EXTENDED_REST_TIER_3_MS = 16 * MS_PER_HR;
export const QUARTERLY_24H_REST_DAYS_REQUIRED = 13;

// Operational warning only — not a regulatory threshold.
export const WARN_AT_FRACTION = 0.85;

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
