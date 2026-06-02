// src/TzAwareInput.jsx
//
// =====================================================================
// TIMEZONE-AWARE DATETIME INPUT
// =====================================================================
//
// Why this exists: a plain <input type="datetime-local"> parses its
// value in the BROWSER's local timezone. If an admin in Tokyo (JST)
// types "09:00" intending the pilot's EDT time, the value gets stored
// as 09:00 JST = 20:00 EDT the previous day = 13 hours earlier than
// the admin meant. The pilot then opens the app and sees "13h elapsed"
// when they should see "0h elapsed."
//
// The Date.now() math used to compute elapsed is timezone-agnostic
// (UTC ms is UTC ms regardless of where you stand) — the bug is
// strictly in the input-to-timestamp conversion.
//
// This component fixes that by:
//   1. Letting the user EXPLICITLY pick which timezone the entered
//      time should be interpreted in. Default is the browser's local
//      TZ (correct in the common case).
//   2. Persisting the last-chosen TZ in localStorage so once the admin
//      switches to ET they don't have to re-pick on every form.
//   3. Showing an "interpretation" hint below the input so the user
//      can verify what the system will actually save.
//
// DST is handled correctly because we use Intl.DateTimeFormat with the
// IANA timezone identifier — no hardcoded offsets.
//
// Usage:
//   <TzAwareDateTimeInput value={utcMs} onChange={(ms) => setX(ms)} />
//
// `value` and the `onChange` argument are always UTC milliseconds.
// The component handles all TZ conversion internally.

import React, { useState, useMemo, useCallback } from 'react';
import { Globe } from 'lucide-react';

// -----------------------------------------------------------------
// Timezone option list — these cover essentially all US Part 135
// operations. The first option ('browser') uses whatever the user's
// browser reports as resolved local zone via Intl. The remaining
// entries are stable IANA identifiers, which include DST behavior
// automatically.
// -----------------------------------------------------------------

const TZ_OPTIONS = [
  { value: 'browser', label: 'Your local',  tz: null },
  { value: 'America/New_York',    label: 'ET',  tz: 'America/New_York' },
  { value: 'America/Chicago',     label: 'CT',  tz: 'America/Chicago' },
  { value: 'America/Denver',      label: 'MT',  tz: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'PT',  tz: 'America/Los_Angeles' },
  { value: 'America/Anchorage',   label: 'AK',  tz: 'America/Anchorage' },
  { value: 'Pacific/Honolulu',    label: 'HI',  tz: 'Pacific/Honolulu' },
  { value: 'UTC',                 label: 'UTC', tz: 'UTC' },
];

// localStorage key used to remember the user's last TZ pick.
const LAST_TZ_KEY = 'skyway-tz-input-last';

// -----------------------------------------------------------------
// Helpers — all exported so they can be reused outside the component
// -----------------------------------------------------------------

/**
 * Compute the timezone offset (minutes east of UTC) for a given moment
 * and IANA timezone. Positive = east of UTC. Negative = west.
 *
 * Works by formatting the date in the target timezone, then computing
 * the difference between that "as-if-UTC" timestamp and the real UTC
 * timestamp. DST changes are picked up because Intl.DateTimeFormat
 * knows about them.
 */
export function getTzOffsetMin(date, timeZone) {
  if (!timeZone) return -date.getTimezoneOffset(); // browser local: convert sign
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  // Some platforms emit "24" instead of "00" for midnight; normalize.
  const hour = o.hour === '24' ? 0 : parseInt(o.hour, 10);
  const asIfUtc = Date.UTC(
    parseInt(o.year, 10),
    parseInt(o.month, 10) - 1,
    parseInt(o.day, 10),
    hour,
    parseInt(o.minute, 10),
    parseInt(o.second, 10),
  );
  return (asIfUtc - date.getTime()) / 60000;
}

/**
 * Convert a UTC millisecond timestamp into a "YYYY-MM-DDTHH:mm" string
 * suitable for a <input type="datetime-local"> control, interpreted in
 * the given IANA timezone. Pass timeZone=null/undefined for the
 * browser's local TZ.
 */
export function tsToInputString(ms, timeZone) {
  if (!Number.isFinite(ms)) return '';
  if (!timeZone) {
    // Browser local — same logic as the old toLocalInputValue.
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const offsetMin = getTzOffsetMin(new Date(ms), timeZone);
  // Shift the UTC ms by the offset so the "UTC" methods on the
  // resulting Date read out as the local time in `timeZone`.
  const shifted = new Date(ms + offsetMin * 60000);
  const pad = n => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/**
 * Inverse of tsToInputString: take a "YYYY-MM-DDTHH:mm" string the
 * user typed and a target IANA timezone, return the corresponding UTC
 * millisecond timestamp.
 */
export function inputStringToTs(s, timeZone) {
  if (!s) return null;
  if (!timeZone) {
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mn, sec] = m;
  // First guess — pretend the local time is UTC. This is wrong by
  // exactly the offset, which we'll measure below.
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mn, +(sec || 0));
  // Compute the offset for that approximate moment. Note: at DST
  // transitions, the offset between "guess as UTC" and the true UTC
  // can be slightly off, but a single re-computation around the
  // adjusted value resolves it in all real-world cases.
  const offsetMin1 = getTzOffsetMin(new Date(guess), timeZone);
  const adjusted1 = guess - offsetMin1 * 60000;
  const offsetMin2 = getTzOffsetMin(new Date(adjusted1), timeZone);
  return guess - offsetMin2 * 60000;
}

/**
 * Format a UTC ms timestamp as a short, human-readable string in the
 * target timezone — used in the "interpretation hint" line.
 */
export function formatInTz(ms, timeZone) {
  if (!Number.isFinite(ms)) return '';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZoneName: 'short',
  });
  return fmt.format(new Date(ms));
}

// localStorage persistence — wrapped in try/catch because Safari
// private mode disables it, and we'd rather have no persistence than
// a runtime crash.
function readLastTz() {
  try { return localStorage.getItem(LAST_TZ_KEY) || 'browser'; }
  catch { return 'browser'; }
}
function writeLastTz(v) {
  try { localStorage.setItem(LAST_TZ_KEY, v); } catch { /* ignore */ }
}

// -----------------------------------------------------------------
// The component
// -----------------------------------------------------------------

/**
 * <TzAwareDateTimeInput value={utcMs} onChange={(ms)=>{}} />
 *
 * Props:
 *   value: number — UTC ms timestamp (null/undefined for empty)
 *   onChange: (newUtcMs: number) => void
 *   className: optional extra classes for the input
 *   compact: optional boolean — hides the interpretation hint to save
 *     vertical space (suitable for nested admin panels)
 */
export default function TzAwareDateTimeInput({ value, onChange, className = '', compact = false }) {
  const [tzKey, setTzKey] = useState(() => readLastTz());

  // Resolve the IANA tz id for the currently selected option.
  const selected = TZ_OPTIONS.find(o => o.value === tzKey) || TZ_OPTIONS[0];
  const tz = selected.tz;

  // The string shown in the datetime-local input.
  const inputStr = useMemo(
    () => tsToInputString(value, tz),
    [value, tz]
  );

  // Resolve the browser's reported local zone for display in the
  // "Your local" option label.
  const browserZone = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
    catch { return 'local'; }
  }, []);

  const handleStrChange = useCallback((e) => {
    const ms = inputStringToTs(e.target.value, tz);
    onChange(ms);
  }, [tz, onChange]);

  const handleTzChange = useCallback((e) => {
    const newKey = e.target.value;
    setTzKey(newKey);
    writeLastTz(newKey);
    // IMPORTANT: don't call onChange. The stored UTC value doesn't
    // change just because the user picked a different display TZ —
    // only the displayed string changes. If we re-called onChange
    // with a converted value we'd corrupt the underlying timestamp.
  }, []);

  // Hint line: shows what UTC moment the input string resolves to and
  // what that moment looks like in each common TZ. This is the user's
  // verification step before submitting.
  const hint = useMemo(() => {
    if (!Number.isFinite(value)) return null;
    return formatInTz(value, tz);
  }, [value, tz]);

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input
          type="datetime-local"
          value={inputStr}
          onChange={handleStrChange}
          className={`flex-1 bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400 ${className}`}
        />
        <select
          value={tzKey}
          onChange={handleTzChange}
          title="Timezone the entered time is interpreted in. Defaults to your browser's local zone."
          className="bg-slate-950/80 border border-slate-700 px-2 py-2 text-[11px] text-slate-200 focus:outline-none focus:border-cyan-400 shrink-0"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {TZ_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.value === 'browser' ? `${o.label} (${browserZone})` : o.label}
            </option>
          ))}
        </select>
      </div>
      {!compact && hint && (
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <Globe className="w-3 h-3 shrink-0" />
          <span>Stored as: {hint}</span>
        </div>
      )}
    </div>
  );
}
