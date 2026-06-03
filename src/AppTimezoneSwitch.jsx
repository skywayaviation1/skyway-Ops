// src/AppTimezoneSwitch.jsx
//
// =====================================================================
// APP TIMEZONE SWITCHER (banner widget)
// =====================================================================
//
// Renders as the banner's clock line. Click it to open a popover with
// a TZ picker. When an override is active, the line shows a small
// cyan "OVR" badge so the user always knows they're not in browser-
// local mode.
//
// Replaces the inline IIFE that previously computed the clock string.
// All clock + date rendering routes through formatClockInAppTz and
// formatBannerDateInAppTz so the displayed values match the override.
//
// Re-renders every minute on its own internal tick (separate from
// the parent's `now` prop, but accepts a passed-in `now` if the
// caller wants to drive the clock).

import React, { useState, useRef, useEffect } from 'react';
import {
  useAppTimezone,
  formatClockInAppTz,
  formatBannerDateInAppTz,
  getTzAbbr,
  getEffectiveTzLabel,
  APP_TZ_OPTIONS,
} from './app-timezone.js';

export default function AppTimezoneSwitch({ now }) {
  const [tz, setTz] = useAppTimezone();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  // Close popover when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Use the prop `now` if provided; else build our own. Either way
  // formatted in the effective TZ.
  const stamp = now instanceof Date ? now.getTime() : (now || Date.now());
  const time = formatClockInAppTz(stamp, tz);
  const date = formatBannerDateInAppTz(stamp, tz);
  const abbr = getTzAbbr(stamp, tz);
  const hasOverride = Boolean(tz);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className={`text-[10px] tracking-widest mt-1 truncate flex items-center gap-1.5 ${
          hasOverride ? 'text-cyan-300 hover:text-cyan-200' : 'text-slate-500 hover:text-slate-300'
        }`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
        title={hasOverride
          ? `App timezone override active: ${tz}. Click to change.`
          : `App is using browser local timezone (${getEffectiveTzLabel(null)}). Click to override.`
        }
      >
        <span>{time}{abbr ? ' ' + abbr : ''} · {date}</span>
        {hasOverride && (
          <span className="px-1 py-0.5 border border-cyan-400/60 text-cyan-300 text-[8px] tracking-widest leading-none">
            OVR
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 bg-slate-950 border border-slate-700 shadow-xl z-50 min-w-[260px]"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          <div className="px-3 py-2 border-b border-slate-800">
            <div className="text-[9px] tracking-widest text-slate-500">
              APP TIMEZONE OVERRIDE
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              Sets what TZ the app's "today" and banner clock use.
              Does not affect already-stored timestamps.
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {APP_TZ_OPTIONS.map(opt => {
              const isSelected = (opt.value === 'browser' && !tz)
                || (opt.value === tz);
              return (
                <button
                  key={opt.value}
                  onClick={() => { setTz(opt.value); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-[11px] tracking-widest border-b border-slate-800 last:border-b-0 ${
                    isSelected
                      ? 'bg-cyan-500/10 text-cyan-300'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  <span className="inline-block w-4">
                    {isSelected ? '✓' : ''}
                  </span>
                  {opt.label}
                </button>
              );
            })}
          </div>
          {hasOverride && (
            <div className="border-t border-slate-800 px-3 py-2">
              <button
                onClick={() => { setTz('browser'); setOpen(false); }}
                className="text-[10px] tracking-widest text-slate-400 hover:text-cyan-300"
              >
                CLEAR OVERRIDE
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
