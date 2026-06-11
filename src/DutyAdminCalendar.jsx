// src/DutyAdminCalendar.jsx
//
// =====================================================================
// ADMIN DUTY CALENDAR — month grid showing all pilots' duty by day
// =====================================================================
//
// This is the top-level admin Duty tab. Pilots never see it (gating
// happens in App.jsx). The component is read-only at the calendar
// level — all editing happens in DutyDayDetail, opened by clicking a
// day cell.
//
// Data: subscribes to subscribeRecentForAllPilots(365) to pull a full
// year of records (per RETENTION_DAYS in firebase-duty-v2.js). The
// calendar's navigation lets admin step backward/forward through months.
// Periods that cross midnight count as duty on BOTH days for the
// calendar marker — the bubble is rendered on whichever day's detail
// view is open.
//
// Each day cell shows:
//   - Date number
//   - Up to 4 pilot initials (those with duty touching this day)
//   - "+N" suffix if more than 4 pilots had duty
//   - Small red dot if any overlapping records exist on this day
//      (potential data error to inspect/fix)
//   - Cyan border on today's cell
//
// Click a day → opens DutyDayDetail modal for that date.

import React, { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { ChevronLeft, ChevronRight, AlertTriangle, Loader2, Calendar } from 'lucide-react';
import { subscribeRecentForAllPilots, RETENTION_DAYS } from './firebase-duty-v2.js';

// Lazy because day detail is heavy (timeline + edit modals) and most
// calendar visits won't open it.
const DutyDayDetail = lazy(() => import('./DutyDayDetail.jsx'));

const MS_DAY = 24 * 3600 * 1000;

// Format a Date as YYYY-MM-DD using LOCAL date parts (so day boundaries
// match the user's wall clock).
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Get the local-day key for a ms timestamp.
function keyForMs(ms) {
  return localDateKey(new Date(ms));
}

// Build the set of date keys a duty period touches. A period that
// starts at 23:00 and ends at 03:00 next day belongs to BOTH days.
function dayKeysForPeriod(period) {
  const out = new Set();
  if (!period?.dutyOnAt) return out;
  const start = new Date(period.dutyOnAt);
  start.setHours(0, 0, 0, 0);
  const endMs = period.dutyOffAt || Date.now();
  const cur = new Date(start);
  while (cur.getTime() <= endMs) {
    out.add(localDateKey(cur));
    cur.setDate(cur.getDate() + 1);
    if (cur.getTime() - start.getTime() > 30 * MS_DAY) break; // safety
  }
  return out;
}

// Pilot initials (up to 2 letters). Falls back to "?" if no name.
function initialsOf(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Detect overlapping pairs WITHIN A SINGLE PILOT. Returns a Set of
// period IDs that participate in at least one overlap.
function findOverlappingIds(periods) {
  const byPilot = new Map();
  for (const p of periods) {
    if (!p.pilotUid) continue;
    if (!byPilot.has(p.pilotUid)) byPilot.set(p.pilotUid, []);
    byPilot.get(p.pilotUid).push(p);
  }
  const ids = new Set();
  for (const list of byPilot.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.dutyOnAt || 0) - (b.dutyOnAt || 0));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const aEnd = a.dutyOffAt || Date.now();
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (b.dutyOnAt >= aEnd) break;
        const bEnd = b.dutyOffAt || Date.now();
        if (b.dutyOnAt < aEnd && bEnd > a.dutyOnAt) {
          ids.add(a.id);
          ids.add(b.id);
        }
      }
    }
  }
  return ids;
}

// =====================================================================
// Main component
// =====================================================================

export default function DutyAdminCalendar({ currentUser, users = [] }) {
  // Periods pull — full retention window (365 days), client-filtered
  // to the displayed month. The subscription gives us live updates as
  // records change so the calendar refreshes immediately after edits.
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const unsub = subscribeRecentForAllPilots(RETENTION_DAYS, (list) => {
      setPeriods(list);
      setLoading(false);
    });
    return () => unsub && unsub();
  }, []);

  // Month navigation — `viewMonth` is the first of the displayed month.
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return d;
  });

  const monthLabel = useMemo(() => viewMonth.toLocaleDateString([], {
    month: 'long', year: 'numeric',
  }), [viewMonth]);

  // Build the 6-row × 7-col day grid for this month. First cell is the
  // Sunday of the week containing day 1 (may be in the prior month).
  const grid = useMemo(() => {
    const firstOfMonth = new Date(viewMonth);
    const firstDayOfWeek = firstOfMonth.getDay(); // 0 = Sunday
    const start = new Date(firstOfMonth);
    start.setDate(start.getDate() - firstDayOfWeek);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      cells.push(d);
    }
    return cells;
  }, [viewMonth]);

  // Group periods by local-day-key for fast lookup per cell.
  const periodsByDay = useMemo(() => {
    const m = new Map();
    for (const p of periods) {
      for (const key of dayKeysForPeriod(p)) {
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(p);
      }
    }
    return m;
  }, [periods]);

  const overlappingIds = useMemo(() => findOverlappingIds(periods), [periods]);

  // Selected day for the detail modal
  const [selectedDay, setSelectedDay] = useState(null);

  // Today's key for "today highlight" + range bound
  const todayKey = localDateKey(new Date());

  // Step backward/forward by month, clamped to the retention window
  const goPrev = () => {
    const d = new Date(viewMonth);
    d.setMonth(d.getMonth() - 1);
    setViewMonth(d);
  };
  const goNext = () => {
    const d = new Date(viewMonth);
    d.setMonth(d.getMonth() + 1);
    setViewMonth(d);
  };
  const goToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0); d.setDate(1);
    setViewMonth(d);
  };

  return (
    <div className="w-full max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-cyan-400" />
          <h2 className="text-base tracking-widest text-cyan-300"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            DUTY CALENDAR
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={goPrev} className="p-1.5 border border-slate-700 text-slate-400 hover:border-cyan-400 hover:text-cyan-300">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={goToday}
            className="px-3 py-1 text-[10px] tracking-widest text-slate-400 border border-slate-700 hover:text-cyan-300 hover:border-cyan-400"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            TODAY
          </button>
          <div className="w-44 text-center text-sm tracking-widest text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {monthLabel}
          </div>
          <button onClick={goNext} className="p-1.5 border border-slate-700 text-slate-400 hover:border-cyan-400 hover:text-cyan-300">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {loading && (
        <div className="border border-slate-800 bg-slate-900/30 p-6 text-center text-slate-500"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
          LOADING {RETENTION_DAYS} DAYS OF DUTY RECORDS…
        </div>
      )}

      {!loading && (
        <>
          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((d) => (
              <div key={d} className="text-center py-1 text-[9px] tracking-widest text-slate-500"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {d}
              </div>
            ))}
          </div>

          {/* 6×7 day grid */}
          <div className="grid grid-cols-7 gap-1">
            {grid.map((day, idx) => {
              const inMonth = day.getMonth() === viewMonth.getMonth();
              const key = localDateKey(day);
              const isToday = key === todayKey;
              const dayPeriods = periodsByDay.get(key) || [];
              const hasOverlap = dayPeriods.some((p) => overlappingIds.has(p.id));

              // Deduplicate pilots for the cell display
              const pilotNames = [];
              const seen = new Set();
              for (const p of dayPeriods) {
                if (!p.pilotUid || seen.has(p.pilotUid)) continue;
                seen.add(p.pilotUid);
                pilotNames.push(p.pilotName || '(unknown)');
              }
              const initials = pilotNames.slice(0, 4).map(initialsOf);
              const extra = pilotNames.length - 4;

              return (
                <button
                  key={idx}
                  onClick={() => setSelectedDay(day)}
                  className={`relative min-h-[88px] sm:min-h-[100px] border text-left p-1.5 transition ${
                    isToday
                      ? 'border-cyan-400 bg-cyan-500/5'
                      : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 hover:border-slate-700'
                  } ${inMonth ? '' : 'opacity-40'}`}
                >
                  {/* Date number */}
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-xs ${isToday ? 'text-cyan-300 font-bold' : 'text-slate-400'}`}
                      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {day.getDate()}
                    </span>
                    {hasOverlap && (
                      <AlertTriangle className="w-3 h-3 text-red-400" title="Overlapping records on this day — inspect" />
                    )}
                  </div>

                  {/* Pilot initials chips */}
                  {initials.length > 0 && (
                    <div className="flex flex-wrap gap-0.5">
                      {initials.map((ini, i) => (
                        <span key={i}
                          className="inline-block px-1 py-0.5 text-[9px] tracking-widest bg-cyan-500/15 text-cyan-200 border border-cyan-500/30"
                          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                          {ini}
                        </span>
                      ))}
                      {extra > 0 && (
                        <span className="inline-block px-1 py-0.5 text-[9px] tracking-widest text-slate-400"
                          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                          +{extra}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap items-center gap-4 text-[10px] tracking-widest text-slate-500"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border border-cyan-500/30 bg-cyan-500/15" />
              PILOT ON DUTY
            </div>
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3 text-red-400" />
              OVERLAPPING RECORDS
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border border-cyan-400" />
              TODAY
            </div>
            <div className="ml-auto text-slate-600">
              {periods.length} records · {RETENTION_DAYS}-day window
            </div>
          </div>
        </>
      )}

      {/* Day detail modal */}
      {selectedDay && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85">
            <div className="text-cyan-300 text-xs tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              LOADING DAY DETAIL…
            </div>
          </div>
        }>
          <DutyDayDetail
            day={selectedDay}
            allPeriods={periods}
            users={users}
            currentUser={currentUser}
            onClose={() => setSelectedDay(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
