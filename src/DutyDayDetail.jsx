// src/DutyDayDetail.jsx
//
// =====================================================================
// DAY DETAIL VIEW — full-screen modal opened from DutyAdminCalendar
// =====================================================================
//
// Shows ONE local day's duty records as a 24-hour horizontal timeline,
// one row per pilot. Each duty period is a colored bubble at its time
// position. Rest periods are the gaps between bubbles, color-coded by
// adequacy. Active periods (status === 'on', no dutyOffAt) show a
// "time remaining" pill on the right indicating how much legal duty
// time the pilot has left.
//
// Admin can:
//   - Tap any duty bubble → edit dutyOnAt / dutyOffAt / flight time /
//     tail / location / role. Each changed field becomes one
//     adminEdits[] audit entry. Calls editPeriod.
//   - Tap any rest gap → adjust the surrounding boundaries (dutyOffAt
//     of the prior period or dutyOnAt of the next).
//   - LINK CREW button → enters a 2-tap selection mode. Tap first
//     period (will be PIC), tap second (SIC). Confirms and calls
//     linkCrewPeriods.
//   - Tap a linked bubble's chain icon → unlink the pair via
//     unlinkCrewPeriods.
//   - ADD BACKFILL PERIOD → choose a pilot and create a missing
//     historical record. Calls adminAddBackfillPeriod.
//
// All data is preserved. There is no delete path from this UI — bad
// records are corrected via edit, never removed.

import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, Link2, Link2Off, AlertTriangle, ChevronRight } from 'lucide-react';
import {
  editPeriod,
  adminAddBackfillPeriod,
  linkCrewPeriods,
  unlinkCrewPeriods,
} from './firebase-duty-v2.js';

const MS_DAY = 24 * 3600 * 1000;
const MS_HR = 3600 * 1000;

// FAR 135.267(c) regular duty cap is 14 hours; 135.267(b) unscheduled
// is 10 hours. The "time left" pill uses these to compute remaining.
const DUTY_CAP_REGULAR_MS = 14 * MS_HR;
const DUTY_CAP_UNSCHEDULED_MS = 10 * MS_HR;
// Minimum required rest between consecutive duty periods. We don't
// hard-distinguish 9h-reduced rest here — the gap color thresholds
// surface anything under 10h for admin to look at.
const REST_FLOOR_OK_MS = 10 * MS_HR;
const REST_FLOOR_WARN_MS = 8 * MS_HR;

// --- helpers ---

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function msToLocalInputValue(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToMs(str) {
  if (!str) return NaN;
  const d = new Date(str);
  const t = d.getTime();
  return Number.isFinite(t) ? t : NaN;
}
function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Overlap detection within a single pilot's list of periods.
function periodsOverlap(a, b) {
  const aEnd = a.dutyOffAt || Date.now();
  const bEnd = b.dutyOffAt || Date.now();
  return a.dutyOnAt < bEnd && b.dutyOnAt < aEnd;
}

// =====================================================================
// Main component
// =====================================================================

export default function DutyDayDetail({ day, allPeriods, users = [], currentUser, onClose }) {
  const dayStart = useMemo(() => startOfLocalDay(day), [day]);
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayStartMs + MS_DAY;

  // Periods that touch this day at all
  const dayPeriods = useMemo(() => {
    const out = [];
    for (const p of (allPeriods || [])) {
      const s = p.dutyOnAt || 0;
      const e = p.dutyOffAt || Date.now();
      if (s < dayEndMs && e > dayStartMs) out.push(p);
    }
    return out;
  }, [allPeriods, dayStartMs, dayEndMs]);

  // Group by pilot. Within each group, sort chronologically.
  const pilotGroups = useMemo(() => {
    const m = new Map();
    for (const p of dayPeriods) {
      if (!p.pilotUid) continue;
      if (!m.has(p.pilotUid)) {
        m.set(p.pilotUid, {
          uid: p.pilotUid,
          name: p.pilotName || '(unknown)',
          periods: [],
        });
      }
      m.get(p.pilotUid).periods.push(p);
    }
    for (const g of m.values()) {
      g.periods.sort((a, b) => (a.dutyOnAt || 0) - (b.dutyOnAt || 0));
    }
    // Sort pilots by first duty time of the day
    return Array.from(m.values()).sort(
      (a, b) => (a.periods[0]?.dutyOnAt || 0) - (b.periods[0]?.dutyOnAt || 0)
    );
  }, [dayPeriods]);

  // Edit modal state — null or { period }
  const [editing, setEditing] = useState(null);
  // Add modal state — null or pilot pre-selection
  const [adding, setAdding] = useState(false);
  // Link-crew mode state — null | 'awaiting-first' | 'awaiting-second' | confirming
  const [linkMode, setLinkMode] = useState(null);
  const [linkFirst, setLinkFirst] = useState(null); // a period
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState('');

  const enterLinkMode = () => {
    setLinkMode('awaiting-first');
    setLinkFirst(null);
    setLinkError('');
  };
  const exitLinkMode = () => {
    setLinkMode(null);
    setLinkFirst(null);
    setLinkError('');
  };

  const onPeriodClick = (period) => {
    if (linkMode === 'awaiting-first') {
      setLinkFirst(period);
      setLinkMode('awaiting-second');
      return;
    }
    if (linkMode === 'awaiting-second') {
      if (period.id === linkFirst.id) {
        setLinkError('Pick a different period for the SIC');
        return;
      }
      if (period.pilotUid === linkFirst.pilotUid) {
        setLinkError('Both selections are the same pilot — pick a different pilot for the SIC');
        return;
      }
      // Confirm
      confirmLink(linkFirst, period);
      return;
    }
    // Normal click → open edit
    setEditing({ period });
  };

  const confirmLink = async (pic, sic) => {
    setLinkBusy(true);
    setLinkError('');
    try {
      const editedBy = currentUser?.displayName || currentUser?.name || currentUser?.uid || 'admin';
      await linkCrewPeriods(pic.id, sic.id, {
        editedBy,
        note: `Linked via day detail (${localDateKey(day)})`,
      });
      exitLinkMode();
    } catch (e) {
      setLinkError(e?.message || 'Link failed');
      setLinkBusy(false);
    }
  };

  const dayLabel = day.toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/85"
      onClick={(e) => { if (e.target === e.currentTarget && !linkMode) onClose && onClose(); }}>
      <div className="w-full max-w-5xl mx-auto bg-slate-950 border-x border-slate-800 flex flex-col max-h-screen overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 flex-shrink-0">
          <div>
            <div className="text-[10px] tracking-widest text-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DUTY DAY DETAIL
            </div>
            <div className="text-sm text-slate-100 mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {dayLabel}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Action bar */}
        <div className="px-4 py-2 border-b border-slate-800 flex flex-wrap items-center gap-2 flex-shrink-0 bg-slate-900/30">
          <button
            onClick={() => setAdding(true)}
            disabled={!!linkMode}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] tracking-widest border border-cyan-500/60 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <Plus className="w-3 h-3" />
            ADD BACKFILL
          </button>
          {!linkMode && (
            <button
              onClick={enterLinkMode}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] tracking-widest border border-slate-700 text-slate-400 hover:text-cyan-300 hover:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <Link2 className="w-3 h-3" />
              LINK CREW
            </button>
          )}
          {linkMode && (
            <div className="flex items-center gap-2 flex-1">
              <div className="text-[10px] tracking-widest text-cyan-300 px-2 py-1 bg-cyan-500/10 border border-cyan-500/40"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {linkBusy ? 'LINKING…' :
                  linkMode === 'awaiting-first' ? 'TAP THE PIC\'S DUTY PERIOD' :
                  `TAP THE SIC FOR ${linkFirst?.pilotName?.toUpperCase()}`}
              </div>
              {linkError && (
                <div className="text-[10px] text-red-300">{linkError}</div>
              )}
              <button onClick={exitLinkMode}
                disabled={linkBusy}
                className="ml-auto px-2 py-1 text-[10px] tracking-widest text-slate-400 border border-slate-700 hover:text-slate-200 disabled:opacity-50"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                CANCEL
              </button>
            </div>
          )}
        </div>

        {/* Timeline body */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3">
          {pilotGroups.length === 0 ? (
            <div className="text-sm text-slate-500 italic py-8 text-center">
              No duty records for {dayLabel}.
              {' '}Use ADD BACKFILL to create a missing record.
            </div>
          ) : (
            <>
              {/* Hour scale */}
              <div className="flex items-center gap-2 mb-2 sticky top-0 bg-slate-950 py-1 z-10">
                <div className="w-28 sm:w-32 flex-shrink-0" />
                <div className="flex-1 grid grid-cols-8 text-[9px] tracking-widest text-slate-500"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
                    <div key={h}>{String(h).padStart(2, '0')}:00</div>
                  ))}
                </div>
                <div className="w-20 sm:w-28 flex-shrink-0" />
              </div>

              {pilotGroups.map((group) => (
                <PilotRow
                  key={group.uid}
                  group={group}
                  dayStartMs={dayStartMs}
                  dayEndMs={dayEndMs}
                  onPeriodClick={onPeriodClick}
                  linkMode={linkMode}
                  linkFirstId={linkFirst?.id || null}
                />
              ))}

              {/* Legend */}
              <div className="mt-6 pt-4 border-t border-slate-800 grid gap-2 text-[10px] tracking-widest text-slate-500"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <div className="flex flex-wrap items-center gap-4">
                  <LegendChip color="bg-cyan-500/30 border-cyan-400/60" label="DUTY · ATTESTED" />
                  <LegendChip color="bg-amber-500/30 border-amber-400/60" label="PENDING" />
                  <LegendChip color="bg-purple-500/30 border-purple-400/60" label="ADMIN-ATTESTED" />
                  <LegendChip color="bg-slate-700 border-slate-600" label="DECLINED" />
                  <LegendChip color="bg-red-500/30 border-red-400" label="OVERLAP" />
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <LegendChip color="bg-emerald-500/15 border-emerald-500/40" label="REST ≥10h" />
                  <LegendChip color="bg-amber-500/15 border-amber-500/40" label="REST 8-10h" />
                  <LegendChip color="bg-red-500/15 border-red-500/40" label="REST &lt;8h" />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modals */}
      {editing && (
        <EditPeriodModal
          period={editing.period}
          currentUser={currentUser}
          onClose={() => setEditing(null)}
        />
      )}
      {adding && (
        <AddBackfillModal
          users={users}
          dayStartMs={dayStartMs}
          currentUser={currentUser}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function LegendChip({ color, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-3 h-3 border ${color}`} />
      <span>{label}</span>
    </div>
  );
}

// =====================================================================
// PilotRow — one pilot's slot on the day
// =====================================================================

function PilotRow({ group, dayStartMs, dayEndMs, onPeriodClick, linkMode, linkFirstId }) {
  const periods = group.periods;

  // Detect overlaps within this pilot's set
  const overlappingIds = useMemo(() => {
    const ids = new Set();
    for (let i = 0; i < periods.length; i++) {
      for (let j = i + 1; j < periods.length; j++) {
        if (periodsOverlap(periods[i], periods[j])) {
          ids.add(periods[i].id);
          ids.add(periods[j].id);
        }
      }
    }
    return ids;
  }, [periods]);

  // Compute rest gaps WITHIN this day for visual rendering. Each gap
  // is between two consecutive non-overlapping periods.
  const restGaps = useMemo(() => {
    const out = [];
    for (let i = 0; i < periods.length - 1; i++) {
      const prev = periods[i];
      const next = periods[i + 1];
      const prevEnd = prev.dutyOffAt || Date.now();
      if (next.dutyOnAt <= prevEnd) continue; // overlap, no rest
      // Clip rest to the visible day window
      const restStart = Math.max(prevEnd, dayStartMs);
      const restEnd = Math.min(next.dutyOnAt, dayEndMs);
      if (restEnd <= restStart) continue;
      const restDurationMs = next.dutyOnAt - prevEnd; // FULL rest duration
      out.push({
        startMs: restStart,
        endMs: restEnd,
        restDurationMs,
        prev,
        next,
      });
    }
    return out;
  }, [periods, dayStartMs, dayEndMs]);

  // Active period (status === 'on') for the "time remaining" pill
  const activePeriod = periods.find((p) => p.status === 'on');
  const activeRemaining = useMemo(() => {
    if (!activePeriod || !activePeriod.dutyOnAt) return null;
    const cap = activePeriod.assignmentType === 'unscheduled'
      ? DUTY_CAP_UNSCHEDULED_MS
      : DUTY_CAP_REGULAR_MS;
    const elapsed = Date.now() - activePeriod.dutyOnAt;
    return cap - elapsed; // can be negative if over cap
  }, [activePeriod]);

  return (
    <div className="my-2">
      <div className="flex items-start gap-2 sm:gap-3">
        {/* Pilot name */}
        <div className="w-28 sm:w-32 flex-shrink-0 pt-1 text-xs text-slate-200 truncate"
          style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {group.name}
        </div>

        {/* Timeline bar */}
        <div className="flex-1 relative h-10 bg-slate-900/60 border border-slate-800">
          {/* Hour ticks */}
          {Array.from({ length: 25 }, (_, i) => (
            <div key={i}
              className={`absolute top-0 bottom-0 border-l ${
                i === 0 || i === 24 ? 'border-slate-700' :
                i === 12 ? 'border-slate-700/60' :
                'border-slate-800/60'
              }`}
              style={{ left: `${(i / 24) * 100}%` }}
            />
          ))}

          {/* Rest gaps */}
          {restGaps.map((gap, i) => {
            const leftPct = ((gap.startMs - dayStartMs) / MS_DAY) * 100;
            const widthPct = ((gap.endMs - gap.startMs) / MS_DAY) * 100;
            const restClr = gap.restDurationMs >= REST_FLOOR_OK_MS
              ? 'bg-emerald-500/10 border-emerald-500/30'
              : gap.restDurationMs >= REST_FLOOR_WARN_MS
                ? 'bg-amber-500/10 border-amber-500/30'
                : 'bg-red-500/10 border-red-500/30';
            return (
              <div
                key={`rest_${i}`}
                title={`Rest · ${fmtElapsed(gap.restDurationMs)} (full gap from ${fmtClock(gap.prev.dutyOffAt)} to ${fmtClock(gap.next.dutyOnAt)})`}
                className={`absolute top-1 bottom-1 ${restClr} border-y border-dashed pointer-events-none`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
            );
          })}

          {/* Duty bubbles */}
          {periods.map((period) => {
            const s = Math.max(period.dutyOnAt, dayStartMs);
            const e = Math.min(period.dutyOffAt || Date.now(), dayEndMs);
            if (e <= s) return null;
            const leftPct = ((s - dayStartMs) / MS_DAY) * 100;
            const widthPct = ((e - s) / MS_DAY) * 100;
            const isOverlap = overlappingIds.has(period.id);
            const isLinkFirst = linkFirstId === period.id;
            return (
              <DutyBubble
                key={period.id}
                period={period}
                leftPct={leftPct}
                widthPct={widthPct}
                isOverlap={isOverlap}
                isLinkFirst={isLinkFirst}
                onClick={() => onPeriodClick(period)}
                linkMode={linkMode}
              />
            );
          })}
        </div>

        {/* Right-side status pill */}
        <div className="w-20 sm:w-28 flex-shrink-0 pt-1">
          {activePeriod ? (
            <ActiveRemainingPill remainingMs={activeRemaining} period={activePeriod} />
          ) : (
            <ClosedRowSummary periods={periods} />
          )}
        </div>
      </div>
    </div>
  );
}

// Active-duty time-remaining pill (countdown until 14h or 10h cap).
function ActiveRemainingPill({ remainingMs, period }) {
  const isOver = remainingMs <= 0;
  const isLow = remainingMs > 0 && remainingMs < 2 * MS_HR;
  const cls = isOver
    ? 'bg-red-500/15 border-red-500/50 text-red-200'
    : isLow
      ? 'bg-amber-500/15 border-amber-500/50 text-amber-200'
      : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300';
  const label = isOver
    ? 'OVER CAP'
    : `${fmtElapsed(remainingMs)} LEFT`;
  const capLabel = period.assignmentType === 'unscheduled' ? '10h' : '14h';
  return (
    <div className={`text-center px-1 py-1 border text-[9px] tracking-widest ${cls}`}
      style={{ fontFamily: 'JetBrains Mono, monospace' }}
      title={`Cap is ${capLabel} (${period.assignmentType})`}>
      ON DUTY<br />{label}
    </div>
  );
}

function ClosedRowSummary({ periods }) {
  const totalDuty = periods.reduce((acc, p) => {
    const e = p.dutyOffAt || Date.now();
    return acc + Math.max(0, e - (p.dutyOnAt || 0));
  }, 0);
  const totalFlight = periods.reduce((acc, p) => acc + (p.flightTimeMs || 0), 0);
  return (
    <div className="text-center px-1 py-1 border border-slate-700 bg-slate-900/50"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <div className="text-[9px] tracking-widest text-slate-500">DUTY</div>
      <div className="text-[10px] text-slate-200">{fmtElapsed(totalDuty)}</div>
      {totalFlight > 0 && (
        <div className="text-[9px] text-cyan-300 mt-0.5">FT {fmtElapsed(totalFlight)}</div>
      )}
    </div>
  );
}

// =====================================================================
// Single duty bubble — colored bar + tap-to-edit + link-mode handling
// =====================================================================

function DutyBubble({ period, leftPct, widthPct, isOverlap, isLinkFirst, onClick, linkMode }) {
  const conf = period.confirmStatus || 'self-attested';
  const colors = bubbleColors(conf, isOverlap, isLinkFirst);
  const isLinked = !!period.partnerPeriodId;

  // Bubble label: only show times if wide enough
  const widthIsWide = widthPct > 8;
  const startHHMM = new Date(period.dutyOnAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const endHHMM = period.dutyOffAt
    ? new Date(period.dutyOffAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : 'NOW';

  const title = [
    `${period.role || ''} · ${period.pilotName || ''}`.trim(),
    `${fmtClock(period.dutyOnAt)} → ${fmtClock(period.dutyOffAt)}`,
    period.tail ? `tail ${period.tail}` : null,
    period.flightTimeMs ? `flight ${fmtElapsed(period.flightTimeMs)}` : null,
    isLinked ? '🔗 linked crew' : null,
    isOverlap ? '⚠ OVERLAPS another period (same pilot)' : null,
    linkMode ? '· TAP TO SELECT FOR LINK ·' : '· tap to edit ·',
  ].filter(Boolean).join('\n');

  return (
    <button
      onClick={onClick}
      title={title}
      className={`absolute top-1 bottom-1 border-2 ${colors.bg} ${colors.border} ${colors.hover} transition flex items-center px-1 overflow-hidden`}
      style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '8px' }}
    >
      {isLinked && (
        <Link2 className={`w-3 h-3 flex-shrink-0 ${colors.text} mr-1`} />
      )}
      {widthIsWide && (
        <span className={`text-[9px] tracking-widest ${colors.text} truncate font-bold`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {startHHMM}–{endHHMM}{period.role ? ` ${period.role}` : ''}
        </span>
      )}
    </button>
  );
}

function bubbleColors(confirmStatus, isOverlap, isLinkFirst) {
  if (isLinkFirst) {
    return {
      bg: 'bg-cyan-400/40',
      border: 'border-cyan-300 ring-2 ring-cyan-200',
      text: 'text-cyan-50',
      hover: 'hover:brightness-110',
    };
  }
  if (isOverlap) {
    return {
      bg: 'bg-red-500/30',
      border: 'border-red-400',
      text: 'text-red-100',
      hover: 'hover:brightness-125',
    };
  }
  if (confirmStatus === 'pending') {
    return {
      bg: 'bg-amber-500/30',
      border: 'border-amber-400/60',
      text: 'text-amber-100',
      hover: 'hover:brightness-125',
    };
  }
  if (confirmStatus === 'declined') {
    return {
      bg: 'bg-slate-700',
      border: 'border-slate-600',
      text: 'text-slate-400',
      hover: 'hover:brightness-125',
    };
  }
  if (confirmStatus === 'admin-attested') {
    return {
      bg: 'bg-purple-500/30',
      border: 'border-purple-400/60',
      text: 'text-purple-100',
      hover: 'hover:brightness-125',
    };
  }
  return {
    bg: 'bg-cyan-500/30',
    border: 'border-cyan-400/60',
    text: 'text-cyan-100',
    hover: 'hover:brightness-125',
  };
}

// =====================================================================
// EditPeriodModal — tap a bubble to open
// =====================================================================

function EditPeriodModal({ period, currentUser, onClose }) {
  const [dutyOnStr, setDutyOnStr] = useState(msToLocalInputValue(period.dutyOnAt));
  const [dutyOffStr, setDutyOffStr] = useState(msToLocalInputValue(period.dutyOffAt));
  const [flightHours, setFlightHours] = useState(
    period.flightTimeMs ? (period.flightTimeMs / MS_HR).toFixed(1) : ''
  );
  const [tail, setTail] = useState(period.tail || '');
  const [location, setLocation] = useState(period.location || '');
  const [role, setRole] = useState(period.role || '');
  const [saving, setSaving] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [err, setErr] = useState('');

  const editedBy = currentUser?.displayName || currentUser?.name || currentUser?.uid || 'admin';

  const save = async () => {
    setErr('');
    setSaving(true);
    try {
      const onMs = localInputToMs(dutyOnStr);
      const offMs = localInputToMs(dutyOffStr);
      if (!Number.isFinite(onMs)) throw new Error('duty on time is required');
      if (!Number.isFinite(offMs)) throw new Error('duty off time is required');
      if (offMs <= onMs) throw new Error('duty off must be after duty on');
      const flightMs = flightHours === '' ? 0 : Math.round(parseFloat(flightHours) * MS_HR);
      if (!Number.isFinite(flightMs) || flightMs < 0) {
        throw new Error('flight time must be a non-negative number of hours');
      }
      if (onMs !== period.dutyOnAt) {
        await editPeriod(period.id, 'dutyOnAt', onMs, { editedBy, note: 'Admin day-detail edit' });
      }
      if (offMs !== period.dutyOffAt) {
        await editPeriod(period.id, 'dutyOffAt', offMs, { editedBy, note: 'Admin day-detail edit' });
      }
      if (flightMs !== (period.flightTimeMs || 0)) {
        await editPeriod(period.id, 'flightTimeMs', flightMs, { editedBy, note: 'Admin day-detail edit' });
      }
      const newTail = tail.trim() || null;
      if (newTail !== (period.tail || null)) {
        await editPeriod(period.id, 'tail', newTail, { editedBy, note: 'Admin day-detail edit' });
      }
      const newLoc = location.trim();
      if (newLoc !== (period.location || '')) {
        await editPeriod(period.id, 'location', newLoc, { editedBy, note: 'Admin day-detail edit' });
      }
      const newRole = role || null;
      if (newRole !== (period.role || null)) {
        await editPeriod(period.id, 'role', newRole, { editedBy, note: 'Admin day-detail edit' });
      }
      onClose();
    } catch (e) {
      setErr(e?.message || 'Save failed');
      setSaving(false);
    }
  };

  const doUnlink = async () => {
    if (!period.partnerPeriodId) return;
    if (!window.confirm('Unlink this crew pair? Both periods will stay on duty but no longer be paired.')) return;
    setUnlinking(true);
    setErr('');
    try {
      await unlinkCrewPeriods(period.id, {
        editedBy,
        note: 'Unlinked via day detail edit modal',
      });
      onClose();
    } catch (e) {
      setErr(e?.message || 'Unlink failed');
      setUnlinking(false);
    }
  };

  const elapsed = (() => {
    const a = localInputToMs(dutyOnStr);
    const b = localInputToMs(dutyOffStr);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
    return b - a;
  })();

  const editsCount = (period.adminEdits || []).length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md bg-slate-950 border border-slate-700">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div>
            <div className="text-[10px] tracking-widest text-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              EDIT DUTY PERIOD
            </div>
            <div className="text-xs text-slate-300 mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {period.pilotName}{period.partnerPeriodId && ' · LINKED PAIR'}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <Field label="DUTY ON">
            <input type="datetime-local" value={dutyOnStr}
              onChange={(e) => setDutyOnStr(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }} />
          </Field>
          <Field label="DUTY OFF (= START OF REST)">
            <input type="datetime-local" value={dutyOffStr}
              onChange={(e) => setDutyOffStr(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }} />
          </Field>
          <Field label="FLIGHT TIME (HOURS)">
            <input type="number" step="0.1" min="0" value={flightHours}
              onChange={(e) => setFlightHours(e.target.value)}
              placeholder="0.0"
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="TAIL">
              <input type="text" value={tail}
                onChange={(e) => setTail(e.target.value.toUpperCase())}
                placeholder="N444AM"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100 uppercase"
                style={{ fontFamily: 'JetBrains Mono, monospace' }} />
            </Field>
            <Field label="LOC">
              <input type="text" value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="KAPF"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }} />
            </Field>
            <Field label="ROLE">
              <select value={role} onChange={(e) => setRole(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                style={{ fontFamily: 'DM Sans, sans-serif' }}>
                <option value="">—</option>
                <option value="PIC">PIC</option>
                <option value="SIC">SIC</option>
              </select>
            </Field>
          </div>

          <div className="text-[10px] text-slate-500 tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            ELAPSED · {elapsed === null ? '—' : fmtElapsed(elapsed)}
          </div>

          {err && (
            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 px-2 py-1">
              {err}
            </div>
          )}

          {editsCount > 0 && (
            <div className="text-[10px] text-slate-500 tracking-widest pt-2 border-t border-slate-800"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {editsCount} PRIOR EDIT{editsCount === 1 ? '' : 'S'} ON RECORD
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between gap-2 flex-wrap">
          <div>
            {period.partnerPeriodId && (
              <button onClick={doUnlink} disabled={unlinking || saving}
                className="flex items-center gap-1 px-2 py-1.5 text-[10px] tracking-widest text-amber-300 border border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-50"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <Link2Off className="w-3 h-3" />
                {unlinking ? 'UNLINKING…' : 'UNLINK CREW'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-3 py-1.5 text-[10px] tracking-widest text-slate-400 border border-slate-700 hover:text-slate-200"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              CANCEL
            </button>
            <button onClick={save} disabled={saving || unlinking}
              className="px-3 py-1.5 text-[10px] tracking-widest text-cyan-300 border border-cyan-500 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {saving ? 'SAVING…' : 'SAVE CHANGES'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// AddBackfillModal — create a missing historical period for any pilot
// =====================================================================

function AddBackfillModal({ users, dayStartMs, currentUser, onClose }) {
  // Pilot picker — pull from users prop. Filter to crew-eligible users
  // if there's a role field; otherwise show everyone.
  const pilotOptions = useMemo(() => {
    return (users || [])
      .filter((u) => u.uid || u.id)
      .map((u) => ({
        uid: u.uid || u.id,
        name: u.displayName || u.name || u.email || '(unnamed)',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [users]);

  const [pilotUid, setPilotUid] = useState(pilotOptions[0]?.uid || '');
  const [dutyOnStr, setDutyOnStr] = useState(() => {
    const d = new Date(dayStartMs);
    d.setHours(6, 0, 0, 0);
    return msToLocalInputValue(d.getTime());
  });
  const [dutyOffStr, setDutyOffStr] = useState(() => {
    const d = new Date(dayStartMs);
    d.setHours(18, 0, 0, 0);
    return msToLocalInputValue(d.getTime());
  });
  const [flightHours, setFlightHours] = useState('');
  const [tail, setTail] = useState('');
  const [location, setLocation] = useState('');
  const [role, setRole] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const editedBy = currentUser?.displayName || currentUser?.name || currentUser?.uid || 'admin';

  const save = async () => {
    setErr('');
    setSaving(true);
    try {
      if (!pilotUid) throw new Error('pick a pilot');
      const pilot = pilotOptions.find((p) => p.uid === pilotUid);
      const onMs = localInputToMs(dutyOnStr);
      const offMs = localInputToMs(dutyOffStr);
      if (!Number.isFinite(onMs)) throw new Error('duty on time is required');
      if (!Number.isFinite(offMs)) throw new Error('duty off time is required');
      if (offMs <= onMs) throw new Error('duty off must be after duty on');
      const flightMs = flightHours === '' ? 0 : Math.round(parseFloat(flightHours) * MS_HR);
      if (!Number.isFinite(flightMs) || flightMs < 0) {
        throw new Error('flight time must be a non-negative number of hours');
      }
      await adminAddBackfillPeriod({
        pilotUid,
        pilotName: pilot?.name || 'Unknown',
        dutyOnAt: onMs,
        dutyOffAt: offMs,
        flightTimeMs: flightMs,
        tail: tail.trim() || null,
        location: location.trim() || '',
        role: role || null,
        editedBy,
        note: note.trim() || 'Admin backfilled via day-detail',
      });
      onClose();
    } catch (e) {
      setErr(e?.message || 'Save failed');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md bg-slate-950 border border-slate-700">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div>
            <div className="text-[10px] tracking-widest text-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              ADD BACKFILL PERIOD
            </div>
            <div className="text-xs text-slate-300 mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              Creates a closed historical record · audited
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <Field label="PILOT">
            <select value={pilotUid} onChange={(e) => setPilotUid(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {pilotOptions.length === 0 && <option value="">(no pilots)</option>}
              {pilotOptions.map((p) => (
                <option key={p.uid} value={p.uid}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="DUTY ON">
            <input type="datetime-local" value={dutyOnStr}
              onChange={(e) => setDutyOnStr(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }} />
          </Field>
          <Field label="DUTY OFF">
            <input type="datetime-local" value={dutyOffStr}
              onChange={(e) => setDutyOffStr(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }} />
          </Field>
          <Field label="FLIGHT TIME (HOURS)">
            <input type="number" step="0.1" min="0" value={flightHours}
              onChange={(e) => setFlightHours(e.target.value)}
              placeholder="0.0"
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="TAIL">
              <input type="text" value={tail}
                onChange={(e) => setTail(e.target.value.toUpperCase())}
                placeholder="N444AM"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100 uppercase"
                style={{ fontFamily: 'JetBrains Mono, monospace' }} />
            </Field>
            <Field label="LOC">
              <input type="text" value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="KAPF"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }} />
            </Field>
            <Field label="ROLE">
              <select value={role} onChange={(e) => setRole(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                style={{ fontFamily: 'DM Sans, sans-serif' }}>
                <option value="">—</option>
                <option value="PIC">PIC</option>
                <option value="SIC">SIC</option>
              </select>
            </Field>
          </div>
          <Field label="REASON / NOTE (FOR AUDIT)">
            <textarea value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Pilot flew N444AM but app crashed at duty-on; reconstructed from manifest."
              rows={2}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }} />
          </Field>

          {err && (
            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 px-2 py-1">
              {err}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-end gap-2">
          <button onClick={onClose}
            className="px-3 py-1.5 text-[10px] tracking-widest text-slate-400 border border-slate-700 hover:text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            CANCEL
          </button>
          <button onClick={save} disabled={saving}
            className="px-3 py-1.5 text-[10px] tracking-widest text-cyan-300 border border-cyan-500 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {saving ? 'SAVING…' : 'CREATE PERIOD'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[9px] tracking-widest text-slate-500 mb-1"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </div>
      {children}
    </label>
  );
}
