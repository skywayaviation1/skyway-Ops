// src/manifest-duty-link.js
//
// =====================================================================
// MANIFEST <-> DUTY LINK HELPERS
// =====================================================================
//
// Pure-function helpers (no React, no Firestore) for tying duty-period
// records to load manifests. Used by the manifest auto-fill UI.
//
// Two responsibilities:
//   1. Match a manifest's tail+date to candidate duty periods
//   2. Format a duty period's data into the strings the manifest
//      free-text fields expect (24h HHMM time, HH:MM durations, etc.)
//
// All time interpretations happen via Intl.DateTimeFormat so timezones
// behave correctly. The caller chooses whether to format in Zulu or
// a specific named timezone.

const MS_HR = 3600 * 1000;
const MS_DAY = 24 * MS_HR;

// =====================================================================
// MATCHING
// =====================================================================

/**
 * Convert a manifest's date string (YYYY-MM-DD) to a UTC ms range
 * representing that calendar day in the given timezone. Pads ±12h on
 * each side so a duty period whose dutyOnAt is near a TZ boundary
 * still lands in the candidate set.
 *
 * Returns { startMs, endMs }. The caller passes this to
 * fetchPeriodsByTailInRange.
 *
 * If timeZone is null/undefined, uses the browser's local TZ.
 */
export function manifestDateToMsRange(dateStr, timeZone) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { startMs: 0, endMs: 0 };
  }
  // Parse the local day's midnight in the chosen TZ. We compute UTC ms
  // for "YYYY-MM-DD 00:00 in TZ" by first guessing as UTC then
  // adjusting by the TZ offset at that moment.
  const [y, m, d] = dateStr.split('-').map(Number);
  let midnightMs;
  if (!timeZone) {
    midnightMs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  } else {
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    const offsetMin = getOffsetMin(new Date(guess), timeZone);
    midnightMs = guess - offsetMin * 60000;
  }
  // Pad ±12h to absorb any TZ-interpretation ambiguity
  return {
    startMs: midnightMs - 12 * MS_HR,
    endMs: midnightMs + MS_DAY + 12 * MS_HR,
  };
}

// Internal — same algorithm as TzAwareInput's getTzOffsetMin
function getOffsetMin(date, timeZone) {
  if (!timeZone) return -date.getTimezoneOffset();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  const hour = o.hour === '24' ? 0 : parseInt(o.hour, 10);
  const asIfUtc = Date.UTC(+o.year, +o.month - 1, +o.day,
    hour, +o.minute, +o.second);
  return (asIfUtc - date.getTime()) / 60000;
}

/**
 * Filter a list of fetched periods (from fetchPeriodsByTailInRange) to
 * those whose dutyOnAt falls within the manifest's calendar day in the
 * given timezone. The ±12h padding from manifestDateToMsRange means
 * the raw fetch may include adjacent-day periods — this narrows to
 * the exact day.
 *
 * Returns the same array shape, sorted by dutyOnAt ASC.
 */
export function filterToManifestDate(periods, dateStr, timeZone) {
  if (!Array.isArray(periods) || !dateStr) return [];
  return periods.filter(p => {
    if (!Number.isFinite(p.dutyOnAt)) return false;
    return periodDateKey(p.dutyOnAt, timeZone) === dateStr;
  });
}

/**
 * Convert a UTC ms to YYYY-MM-DD in the given timezone.
 * Used by filterToManifestDate.
 */
export function periodDateKey(ms, timeZone) {
  if (!Number.isFinite(ms)) return '';
  if (!timeZone) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}`;
}

// =====================================================================
// FORMATTING — DUTY PERIOD -> MANIFEST FIELD STRINGS
// =====================================================================
//
// Output shape:
//   {
//     dutyTimeIn:    string — HHMM in chosen TZ, e.g. "1330"
//     dutyTimeOut:   string — HHMM in chosen TZ, e.g. "2330"
//     dutyTimeTotal: string — HH:MM duration, e.g. "10:00"
//     timeTotal:     string — decimal hours from flightTimeMs, e.g. "5.2"
//   }
// Empty string for any field that can't be computed (e.g. dutyOffAt
// missing on an open period → dutyTimeOut and totals all ''.)
//
// Options:
//   timeZone: IANA TZ name or null (browser local). Affects HHMM display
//             of dutyOnAt/Off only. Durations and flight time are
//             timezone-independent.
//   timeStyle: 'HHMM' (default, e.g. "1330") or 'HH:MM' (e.g. "13:30")
//              or 'HHMMZ' (e.g. "1330Z" — explicit zulu suffix, used
//              when timeZone is 'UTC')

export function formatManifestFields(period, options = {}) {
  const { timeZone = null, timeStyle = 'HHMM' } = options;
  if (!period) {
    return { dutyTimeIn: '', dutyTimeOut: '', dutyTimeTotal: '', timeTotal: '' };
  }
  const dutyTimeIn = period.dutyOnAt ? formatTime(period.dutyOnAt, timeZone, timeStyle) : '';
  const dutyTimeOut = period.dutyOffAt ? formatTime(period.dutyOffAt, timeZone, timeStyle) : '';
  const dutyTimeTotal = (Number.isFinite(period.dutyOnAt) && Number.isFinite(period.dutyOffAt))
    ? formatDurationHHMM(period.dutyOffAt - period.dutyOnAt)
    : '';
  const timeTotal = Number.isFinite(period.flightTimeMs)
    ? formatDecimalHours(period.flightTimeMs)
    : '';
  return { dutyTimeIn, dutyTimeOut, dutyTimeTotal, timeTotal };
}

/**
 * Format a UTC ms as HHMM (or HH:MM) in the given timezone.
 * Examples:
 *   formatTime(t, null, 'HHMM')       => "0830"  (browser local)
 *   formatTime(t, 'America/New_York', 'HHMM')   => "0830"
 *   formatTime(t, 'UTC', 'HHMMZ')               => "1330Z"
 */
export function formatTime(ms, timeZone, style = 'HHMM') {
  if (!Number.isFinite(ms)) return '';
  let hh, mm;
  if (!timeZone) {
    const d = new Date(ms);
    hh = String(d.getHours()).padStart(2, '0');
    mm = String(d.getMinutes()).padStart(2, '0');
  } else {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date(ms));
    const o = {};
    for (const p of parts) o[p.type] = p.value;
    hh = o.hour === '24' ? '00' : o.hour;
    mm = o.minute;
  }
  if (style === 'HH:MM') return `${hh}:${mm}`;
  if (style === 'HHMMZ') return `${hh}${mm}Z`;
  return `${hh}${mm}`;
}

/**
 * Format a duration in ms as HH:MM. Used for DUTY TIME TOTAL.
 * Negative or zero durations return '00:00'.
 */
export function formatDurationHHMM(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const totalMin = Math.round(ms / 60000);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Format a duration in ms as decimal hours rounded to 1 decimal place.
 * Used for TIME TOTAL (flight time). Matches the convention pilots use
 * in flight logs and most Part 135 forms.
 */
export function formatDecimalHours(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0';
  return (ms / MS_HR).toFixed(1);
}
