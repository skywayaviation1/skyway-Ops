// src/app-timezone.js
//
// =====================================================================
// APP-WIDE TIMEZONE OVERRIDE
// =====================================================================
//
// Lets the user (especially admin) decide what timezone the entire app
// should "act like it's in," regardless of where their browser
// physically is.
//
// Why this exists: the app's date logic (banner clock, "today"
// defaults on date pickers, date-comparison for manifest matching,
// etc.) defaults to the browser's reported local TZ. When an admin is
// traveling — say, vacationing in Japan while their pilots fly in
// Florida — the browser reports JST and the app shows JST dates. The
// admin keeps mentally converting, mis-typing times, and entering
// wrong dates.
//
// With an override set, all "today"-flavored operations interpret the
// current moment in the chosen TZ. Date-formatting helpers can read
// the override and format accordingly.
//
// Scope: this module ONLY governs DATE-OF-RECORD interpretation and
// the banner clock. It does NOT override the per-field TzAwareInput
// (those have their own persisted TZ picker). It does NOT migrate
// existing stored timestamps — those are UTC ms and remain correct.
//
// =====================================================================

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'skyway-app-tz';
const CHANGE_EVENT = 'skyway-app-tz-change';

// Same option set as TzAwareInput so the menus feel consistent.
export const APP_TZ_OPTIONS = [
  { value: 'browser',              label: 'Browser local' },
  { value: 'America/New_York',     label: 'ET (Eastern)' },
  { value: 'America/Chicago',      label: 'CT (Central)' },
  { value: 'America/Denver',       label: 'MT (Mountain)' },
  { value: 'America/Los_Angeles',  label: 'PT (Pacific)' },
  { value: 'America/Anchorage',    label: 'AK (Alaska)' },
  { value: 'Pacific/Honolulu',     label: 'HI (Hawaii)' },
  { value: 'UTC',                  label: 'UTC (Zulu)' },
];

// =====================================================================
// Get/set persistence
// =====================================================================

/**
 * Returns the IANA timezone the app is currently configured to act
 * "as if" it's in. Returns null when no override is set (caller should
 * fall back to browser local behavior).
 */
export function getAppTimezone() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v !== 'browser' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Persist the override. Pass null or 'browser' to clear.
 * Dispatches a window event so other live components re-render.
 */
export function setAppTimezone(tz) {
  try {
    if (!tz || tz === 'browser') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, tz);
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // ignore — Safari private mode etc.
  }
}

// =====================================================================
// React hook
// =====================================================================

/**
 * Reactive accessor. Returns [tz, setTz] where `tz` is the current
 * override (or null for browser local) and `setTz` is the setter.
 *
 * Reactive both to in-tab updates (via the custom event) and to
 * cross-tab updates (via the native storage event). So flipping the
 * override in one tab updates the clock in all open tabs immediately.
 */
export function useAppTimezone() {
  const [tz, setTzState] = useState(() => getAppTimezone());

  useEffect(() => {
    const refresh = () => setTzState(getAppTimezone());
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const setTz = (next) => {
    setAppTimezone(next);
    setTzState(next === 'browser' ? null : next);
  };

  return [tz, setTz];
}

// =====================================================================
// Display helpers
// =====================================================================

/**
 * Friendly label for the current effective TZ. Returns the IANA name
 * when an override is set; otherwise returns the browser's reported
 * local zone. Used in the banner switcher.
 */
export function getEffectiveTzLabel(tz) {
  const effective = tz || getAppTimezone();
  if (effective) return effective;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'local'; }
}

/**
 * Short TZ abbreviation (EDT, JST, etc.) at the given moment.
 * Uses the app-tz override if `tz` is omitted.
 */
export function getTzAbbr(ms, tz) {
  const effective = tz === undefined ? getAppTimezone() : tz;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: effective || undefined,
      timeZoneName: 'short',
    });
    return fmt.formatToParts(new Date(ms || Date.now()))
      .find(p => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

/**
 * "YYYY-MM-DD" in the effective TZ. The string the manifest form (and
 * similar date-only contexts) uses to identify "today's operational
 * date." When an admin overrides to ET, this returns the ET calendar
 * date even though their browser may be in JST.
 */
export function todayInAppTz(tz) {
  const effective = tz === undefined ? getAppTimezone() : tz;
  return dateKeyInTz(Date.now(), effective);
}

/**
 * "YYYY-MM-DD" for a given UTC ms in a TZ. Null TZ = browser local.
 */
export function dateKeyInTz(ms, timeZone) {
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

/**
 * Format a UTC ms as "h:mm AM/PM" in the effective TZ.
 */
export function formatClockInAppTz(ms, tz) {
  const effective = tz === undefined ? getAppTimezone() : tz;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: effective || undefined,
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

/**
 * Format a UTC ms as the banner's "DD MON YYYY" date string in the
 * effective TZ. Mirrors the existing fmtDateZ helper but TZ-aware.
 */
export function formatBannerDateInAppTz(ms, tz) {
  const effective = tz === undefined ? getAppTimezone() : tz;
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  if (!effective) {
    // No override: use UTC for "Z" date (matches existing behavior).
    // For browser local instead, swap to getDate/Month/FullYear.
    const d = new Date(ms);
    return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: effective,
    day: '2-digit', month: 'numeric', year: 'numeric',
  });
  const parts = fmt.formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return `${o.day} ${MONTHS[parseInt(o.month, 10) - 1]} ${o.year}`;
}
