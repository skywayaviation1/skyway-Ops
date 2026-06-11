// src/DutyEditor.jsx
//
// =====================================================================
// DUTY TIMELINE EDITOR — admin tool to fix bad/missing duty records
// =====================================================================
//
// Full-screen modal launched from CrewBoardV2's TIMELINE button (admin
// and ops roles only). Lets the operator:
//
//   1. PICK a pilot from the existing roster
//   2. SEE that pilot's duty periods across the chosen date range as
//      colored bubbles laid out on a 24-hour timeline, one row per day.
//   3. SPOT overlapping periods — bubbles for the same pilot whose time
//      windows intersect get a red border + tooltip naming the overlap.
//      This is the "data is wrong" diagnostic: most of the time the
//      legality engine fires "illegal" because there are two duty
//      periods for the same pilot covering the same hours.
//   4. EDIT a period — tap any bubble to open an edit modal with
//      datetime-local inputs for dutyOnAt and dutyOffAt, plus a flight-
//      time input. Save calls `editPeriod` per field, which writes one
//      adminEdits[] audit entry per change.
//   5. ADD a backfill period — for pilots who flew but never started
//      duty in the app. Tap the + ADD button to open the add modal,
//      enter start/end times, save calls `adminAddBackfillPeriod`.
//
// Design notes:
//
//   - V1 is tap-to-edit, NOT drag-to-resize. Drag UX on mobile is
//     fragile and the editor's primary goal is correctness — fast and
//     reliable edits via a form, not visual finesse. We can layer drag
//     handles in a later pass.
//
//   - Time math uses local-time day boundaries (00:00 local → 24:00
//     local). A duty period that crosses midnight will render as TWO
//     adjacent bubbles, one on each day's row, with the same period
//     id. Tapping either opens the same edit modal — they're the same
//     underlying record.
//
//   - Overlap detection is per-pilot, comparing sorted start times.
//     We flag both periods in any overlapping pair so either bubble
//     surfaces the conflict.
//
//   - The editor reuses the existing `subscribePeriodsForPilot` listener
//     so saves reflect immediately. Adds are written and the next
//     snapshot drops them into the timeline.

import React, { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle, Plus, Edit3, Clock } from 'lucide-react';
import {
  subscribePeriodsForPilot,
  editPeriod,
  adminAddBackfillPeriod,
} from './firebase-duty-v2.js';

const MS_DAY = 24 * 3600 * 1000;
const MS_HR = 3600 * 1000;

// Convert ms timestamp → `YYYY-MM-DDTHH:MM` value suitable for the
// HTML5 datetime-local input. The browser will display the user's
// local time and return a local-time-interpreted string.
function msToLocalInputValue(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Convert a datetime-local input string back to ms. Returns NaN if the
// string is empty or malformed so callers can detect and refuse to save.
function localInputToMs(str) {
  if (!str) return NaN;
  const d = new Date(str);
  const t = d.getTime();
  return Number.isFinite(t) ? t : NaN;
}

// Format a ms timestamp as a short human string for tooltips.
function fmtTs(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Format elapsed ms as "Xh Ym".
function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// Detect overlapping pairs in a sorted period list. Returns a Set of
// period IDs that participate in at least one overlap. We treat any
// non-zero intersection as an overlap, regardless of duration.
function findOverlappingIds(periods) {
  const ids = new Set();
  if (!Array.isArray(periods) || periods.length < 2) return ids;
  // Sort by start time, then walk and compare each to subsequent ones
  // (not just the next — a long period could overlap multiple short ones).
  const sorted = [...periods].sort((a, b) => (a.dutyOnAt || 0) - (b.dutyOnAt || 0));
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aEnd = a.dutyOffAt || Date.now();
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.dutyOnAt >= aEnd) break; // sorted by start; no further can overlap
      const bEnd = b.dutyOffAt || Date.now();
      if (b.dutyOnAt < aEnd && bEnd > a.dutyOnAt) {
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  return ids;
}

// Build the list of local-day starts spanning a [startMs, endMs] range.
// Returns Date objects at 00:00 local of each day, inclusive.
function buildDayList(startMs, endMs) {
  const out = [];
  const cur = new Date(startMs);
  cur.setHours(0, 0, 0, 0);
  const last = new Date(endMs);
  last.setHours(0, 0, 0, 0);
  while (cur.getTime() <= last.getTime()) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// =====================================================================
// Main component
// =====================================================================

export default function DutyEditor({ currentUser, pilots = [], onClose }) {
  // Selected pilot — defaults to the first pilot in the list
  const [pilotUid, setPilotUid] = useState(pilots[0]?.uid || null);
  const pilot = useMemo(
    () => pilots.find((p) => p.uid === pilotUid) || null,
    [pilots, pilotUid],
  );

  // Date range — default is last 14 days (focuses on recent records
  // that are most likely to have data errors needing correction)
  const today0 = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }, []);
  const [startMs, setStartMs] = useState(today0 - 13 * MS_DAY);
  const [endMs, setEndMs] = useState(today0 + MS_DAY - 1);

  // Live periods for the selected pilot
  const [periods, setPeriods] = useState([]);
  useEffect(() => {
    if (!pilotUid) { setPeriods([]); return; }
    return subscribePeriodsForPilot(pilotUid, setPeriods);
  }, [pilotUid]);

  // Filter to the visible window. Include any period whose time range
  // intersects [startMs, endMs] — a period that started before the
  // window but ended inside is still relevant.
  const visible = useMemo(() => {
    return periods.filter((p) => {
      const s = p.dutyOnAt || 0;
      const e = p.dutyOffAt || Date.now();
      return s <= endMs && e >= startMs;
    });
  }, [periods, startMs, endMs]);

  const overlappingIds = useMemo(() => findOverlappingIds(periods), [periods]);

  const days = useMemo(() => buildDayList(startMs, endMs), [startMs, endMs]);

  // Modals
  const [editing, setEditing] = useState(null); // period object
  const [adding, setAdding] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/85"
      onClick={(e) => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <div className="w-full max-w-5xl mx-auto bg-slate-950 border-x border-slate-800 flex flex-col max-h-screen overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 flex-shrink-0">
          <div>
            <div className="text-[10px] tracking-widest text-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DUTY TIMELINE EDITOR
            </div>
            <div className="text-xs text-slate-400 mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              Admin · fix records, backfill missing periods, surface overlaps
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Controls */}
        <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center gap-3 flex-shrink-0">
          {/* Pilot picker */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-widest text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>PILOT</span>
            <select
              value={pilotUid || ''}
              onChange={(e) => setPilotUid(e.target.value || null)}
              className="bg-slate-900 border border-slate-700 px-2 py-1 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              {pilots.length === 0 && <option value="">(no pilots)</option>}
              {pilots.map((p) => (
                <option key={p.uid} value={p.uid}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Date range */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-widest text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>FROM</span>
            <input
              type="date"
              value={msToLocalInputValue(startMs).slice(0, 10)}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const d = new Date(v + 'T00:00');
                if (!isNaN(d.getTime())) setStartMs(d.getTime());
              }}
              className="bg-slate-900 border border-slate-700 px-2 py-1 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
            <span className="text-[10px] tracking-widest text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>TO</span>
            <input
              type="date"
              value={msToLocalInputValue(endMs).slice(0, 10)}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const d = new Date(v + 'T23:59');
                if (!isNaN(d.getTime())) setEndMs(d.getTime());
              }}
              className="bg-slate-900 border border-slate-700 px-2 py-1 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </div>

          {/* Add button */}
          <button
            onClick={() => setAdding(true)}
            disabled={!pilotUid}
            className="flex items-center gap-1.5 px-3 py-1 text-[10px] tracking-widest border border-cyan-500/60 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Plus className="w-3 h-3" />
            ADD PERIOD
          </button>

          {/* Overlap count badge */}
          {overlappingIds.size > 0 && (
            <div className="flex items-center gap-1.5 text-[10px] tracking-widest text-red-300"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <AlertTriangle className="w-3 h-3" />
              {overlappingIds.size / 2} OVERLAP{overlappingIds.size > 2 ? 'S' : ''} IN RECORD
            </div>
          )}
        </div>

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {!pilot && (
            <div className="text-sm text-slate-500 italic py-8 text-center">
              Pick a pilot to see their duty timeline.
            </div>
          )}

          {pilot && (
            <>
              {/* Hour scale */}
              <div className="flex items-center gap-2 mb-2 sticky top-0 bg-slate-950 py-1 z-10">
                <div className="w-24 flex-shrink-0" />
                <div className="flex-1 grid grid-cols-8 text-[9px] tracking-widest text-slate-500"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
                    <div key={h}>{String(h).padStart(2, '0')}</div>
                  ))}
                </div>
              </div>

              {/* Day rows */}
              {days.map((day, di) => (
                <DayRow
                  key={di}
                  day={day}
                  periods={visible}
                  overlappingIds={overlappingIds}
                  onEditPeriod={setEditing}
                />
              ))}

              {visible.length === 0 && (
                <div className="text-sm text-slate-500 italic py-8 text-center">
                  No duty periods in this window for {pilot.name}. Use ADD PERIOD
                  to back-fill records.
                </div>
              )}

              {/* Legend */}
              <div className="mt-6 pt-4 border-t border-slate-800 flex flex-wrap items-center gap-4 text-[10px] tracking-widest text-slate-500"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <LegendDot color="bg-cyan-500/40 border-cyan-400" label="ON DUTY" />
                <LegendDot color="bg-amber-500/40 border-amber-400" label="PENDING" />
                <LegendDot color="bg-slate-700 border-slate-600" label="DECLINED" />
                <LegendDot color="bg-purple-500/40 border-purple-400" label="ADMIN-ATTESTED" />
                <LegendDot color="bg-red-500/40 border-red-400" label="OVERLAP" />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modals */}
      {editing && (
        <EditPeriodModal
          period={editing}
          currentUser={currentUser}
          onClose={() => setEditing(null)}
        />
      )}
      {adding && pilot && (
        <AddPeriodModal
          pilotUid={pilot.uid}
          pilotName={pilot.name}
          currentUser={currentUser}
          defaultStart={startMs}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-3 h-3 border ${color}`} />
      <span>{label}</span>
    </div>
  );
}

// =====================================================================
// DayRow — one row of the timeline (one local day)
// =====================================================================

function DayRow({ day, periods, overlappingIds, onEditPeriod }) {
  const dayStartMs = day.getTime();
  const dayEndMs = dayStartMs + MS_DAY;

  // Intersect each period with this day's window. A period that crosses
  // midnight will appear on both days' rows, each clipped to its
  // respective day. We carry the original period through so tap-to-edit
  // still hits the same Firestore doc.
  const segments = useMemo(() => {
    const out = [];
    for (const p of periods) {
      const s = p.dutyOnAt || 0;
      const e = p.dutyOffAt || Date.now();
      if (s >= dayEndMs || e <= dayStartMs) continue;
      const segStart = Math.max(s, dayStartMs);
      const segEnd = Math.min(e, dayEndMs);
      const leftPct = ((segStart - dayStartMs) / MS_DAY) * 100;
      const widthPct = ((segEnd - segStart) / MS_DAY) * 100;
      out.push({ period: p, leftPct, widthPct, segStart, segEnd });
    }
    return out;
  }, [periods, dayStartMs, dayEndMs]);

  const dayLabel = day.toLocaleDateString([], {
    weekday: 'short', month: 'numeric', day: 'numeric',
  });

  return (
    <div className="flex items-center gap-2 my-1">
      <div className="w-24 flex-shrink-0 text-[10px] text-slate-400"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {dayLabel}
      </div>
      <div className="flex-1 relative h-9 bg-slate-900/60 border border-slate-800">
        {/* Hour grid */}
        {Array.from({ length: 25 }, (_, i) => (
          <div key={i}
            className={`absolute top-0 bottom-0 border-l ${
              i === 0 || i === 24 ? 'border-slate-700' : 'border-slate-800/60'
            }`}
            style={{ left: `${(i / 24) * 100}%` }}
          />
        ))}
        {/* Duty bubbles */}
        {segments.map(({ period, leftPct, widthPct, segStart, segEnd }) => {
          const isOverlap = overlappingIds.has(period.id);
          const conf = period.confirmStatus || 'self-attested';
          const colors = bubbleColors(conf, isOverlap);
          const labelText = bubbleLabel(period, segStart, segEnd);
          return (
            <button
              key={period.id + '_' + segStart}
              onClick={() => onEditPeriod(period)}
              title={[
                `${period.role || ''} ${period.pilotName || ''}`.trim(),
                `${fmtTs(period.dutyOnAt)} → ${fmtTs(period.dutyOffAt)}`,
                period.tail ? `tail ${period.tail}` : null,
                `flight time ${fmtElapsed(period.flightTimeMs || 0)}`,
                isOverlap ? '⚠ OVERLAPS another period' : null,
              ].filter(Boolean).join('\n')}
              className={`absolute top-0.5 bottom-0.5 ${colors.bg} ${colors.border} border-2 hover:brightness-125 transition flex items-center px-1 overflow-hidden`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '6px' }}
            >
              <span className={`text-[9px] tracking-widest ${colors.text} truncate font-bold`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {labelText}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function bubbleColors(confirmStatus, isOverlap) {
  if (isOverlap) {
    return {
      bg: 'bg-red-500/30',
      border: 'border-red-400',
      text: 'text-red-100',
    };
  }
  if (confirmStatus === 'pending') {
    return {
      bg: 'bg-amber-500/30',
      border: 'border-amber-400/60',
      text: 'text-amber-100',
    };
  }
  if (confirmStatus === 'declined') {
    return {
      bg: 'bg-slate-700',
      border: 'border-slate-600',
      text: 'text-slate-400',
    };
  }
  if (confirmStatus === 'admin-attested') {
    return {
      bg: 'bg-purple-500/30',
      border: 'border-purple-400/60',
      text: 'text-purple-100',
    };
  }
  // 'self-attested' or legacy null
  return {
    bg: 'bg-cyan-500/30',
    border: 'border-cyan-400/60',
    text: 'text-cyan-100',
  };
}

function bubbleLabel(period, segStart, segEnd) {
  // For very narrow bubbles, show nothing; the title attribute carries
  // the full detail. For wider bubbles, show hours.
  const widthMs = segEnd - segStart;
  if (widthMs < 60 * 60 * 1000) return ''; // < 1h
  const startH = new Date(segStart).getHours();
  const endH = new Date(segEnd).getHours();
  const endM = new Date(segEnd).getMinutes();
  const startLabel = String(startH).padStart(2, '0');
  const endLabel = endM > 0
    ? `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`
    : String(endH).padStart(2, '0');
  const role = period.role ? ` ${period.role}` : '';
  return `${startLabel}-${endLabel}${role}`;
}

// =====================================================================
// EditPeriodModal — tap any bubble to open this
// =====================================================================

function EditPeriodModal({ period, currentUser, onClose }) {
  const [dutyOnStr, setDutyOnStr] = useState(msToLocalInputValue(period.dutyOnAt));
  const [dutyOffStr, setDutyOffStr] = useState(msToLocalInputValue(period.dutyOffAt));
  const [flightHours, setFlightHours] = useState(
    period.flightTimeMs ? (period.flightTimeMs / MS_HR).toFixed(1) : ''
  );
  const [tail, setTail] = useState(period.tail || '');
  const [location, setLocation] = useState(period.location || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const editedBy = currentUser?.displayName || currentUser?.name || currentUser?.uid || 'admin';

  const save = async () => {
    setErr('');
    setSaving(true);
    try {
      // Build a list of changes — only fields that actually changed
      const onMs = localInputToMs(dutyOnStr);
      const offMs = localInputToMs(dutyOffStr);
      if (!Number.isFinite(onMs)) throw new Error('duty on time is required');
      if (!Number.isFinite(offMs)) throw new Error('duty off time is required');
      if (offMs <= onMs) throw new Error('duty off must be after duty on');

      const flightMs = flightHours === ''
        ? 0
        : Math.round(parseFloat(flightHours) * MS_HR);
      if (!Number.isFinite(flightMs) || flightMs < 0) {
        throw new Error('flight time must be a non-negative number of hours');
      }

      // Apply changes one field at a time so each gets its own
      // adminEdits[] audit entry. editPeriod handles the over14
      // recompute when time fields change.
      if (onMs !== period.dutyOnAt) {
        await editPeriod(period.id, 'dutyOnAt', onMs, {
          editedBy, note: 'Admin timeline edit',
        });
      }
      if (offMs !== period.dutyOffAt) {
        await editPeriod(period.id, 'dutyOffAt', offMs, {
          editedBy, note: 'Admin timeline edit',
        });
      }
      if (flightMs !== (period.flightTimeMs || 0)) {
        await editPeriod(period.id, 'flightTimeMs', flightMs, {
          editedBy, note: 'Admin timeline edit',
        });
      }
      const newTail = tail.trim() || null;
      if (newTail !== (period.tail || null)) {
        await editPeriod(period.id, 'tail', newTail, {
          editedBy, note: 'Admin timeline edit',
        });
      }
      const newLoc = location.trim();
      if (newLoc !== (period.location || '')) {
        await editPeriod(period.id, 'location', newLoc, {
          editedBy, note: 'Admin timeline edit',
        });
      }
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
              EDIT DUTY PERIOD
            </div>
            <div className="text-xs text-slate-300 mt-0.5"
              style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {period.pilotName} · {period.role || 'no role'}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <Field label="DUTY ON">
            <input
              type="datetime-local"
              value={dutyOnStr}
              onChange={(e) => setDutyOnStr(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </Field>
          <Field label="DUTY OFF">
            <input
              type="datetime-local"
              value={dutyOffStr}
              onChange={(e) => setDutyOffStr(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </Field>
          <Field label="FLIGHT TIME (HOURS)">
            <input
              type="number"
              step="0.1"
              min="0"
              value={flightHours}
              onChange={(e) => setFlightHours(e.target.value)}
              placeholder="0.0"
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="TAIL">
              <input
                type="text"
                value={tail}
                onChange={(e) => setTail(e.target.value.toUpperCase())}
                placeholder="N444AM"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100 uppercase"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
            </Field>
            <Field label="LOCATION">
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="KAPF"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
            </Field>
          </div>

          {/* Live elapsed display */}
          <div className="text-[10px] text-slate-500 tracking-widest pt-1"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            ELAPSED · {(() => {
              const a = localInputToMs(dutyOnStr);
              const b = localInputToMs(dutyOffStr);
              if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return '—';
              return fmtElapsed(b - a);
            })()}
          </div>

          {err && (
            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 px-2 py-1">
              {err}
            </div>
          )}

          {/* Audit hint */}
          {(period.adminEdits || []).length > 0 && (
            <div className="text-[10px] text-slate-500 tracking-widest pt-2 border-t border-slate-800"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {(period.adminEdits || []).length} PRIOR EDIT{(period.adminEdits || []).length === 1 ? '' : 'S'} ON RECORD
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
            {saving ? 'SAVING…' : 'SAVE CHANGES'}
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// AddPeriodModal — admin backfill missing historical periods
// =====================================================================

function AddPeriodModal({ pilotUid, pilotName, currentUser, defaultStart, onClose }) {
  // Default the new period to "today, 6am to 6pm" so admin only has to
  // tweak rather than build from scratch. Use defaultStart (the window
  // start) if "today" falls outside the visible window.
  const initialDate = useMemo(() => {
    const d = new Date(defaultStart || Date.now());
    d.setHours(6, 0, 0, 0);
    return d;
  }, [defaultStart]);
  const initialEnd = useMemo(() => {
    const d = new Date(initialDate);
    d.setHours(18, 0, 0, 0);
    return d;
  }, [initialDate]);

  const [dutyOnStr, setDutyOnStr] = useState(msToLocalInputValue(initialDate.getTime()));
  const [dutyOffStr, setDutyOffStr] = useState(msToLocalInputValue(initialEnd.getTime()));
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
      const onMs = localInputToMs(dutyOnStr);
      const offMs = localInputToMs(dutyOffStr);
      if (!Number.isFinite(onMs)) throw new Error('duty on time is required');
      if (!Number.isFinite(offMs)) throw new Error('duty off time is required');
      if (offMs <= onMs) throw new Error('duty off must be after duty on');

      const flightMs = flightHours === ''
        ? 0
        : Math.round(parseFloat(flightHours) * MS_HR);
      if (!Number.isFinite(flightMs) || flightMs < 0) {
        throw new Error('flight time must be a non-negative number of hours');
      }

      await adminAddBackfillPeriod({
        pilotUid,
        pilotName,
        dutyOnAt: onMs,
        dutyOffAt: offMs,
        flightTimeMs: flightMs,
        tail: tail.trim() || null,
        location: location.trim() || '',
        role: role || null,
        editedBy,
        note: note.trim() || 'Admin backfilled via timeline editor',
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
            <div className="text-xs text-slate-300 mt-0.5"
              style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {pilotName} · creates a closed historical record
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <Field label="DUTY ON">
            <input
              type="datetime-local"
              value={dutyOnStr}
              onChange={(e) => setDutyOnStr(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </Field>
          <Field label="DUTY OFF">
            <input
              type="datetime-local"
              value={dutyOffStr}
              onChange={(e) => setDutyOffStr(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </Field>
          <Field label="FLIGHT TIME (HOURS)">
            <input
              type="number"
              step="0.1"
              min="0"
              value={flightHours}
              onChange={(e) => setFlightHours(e.target.value)}
              placeholder="0.0"
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="TAIL">
              <input
                type="text"
                value={tail}
                onChange={(e) => setTail(e.target.value.toUpperCase())}
                placeholder="N444AM"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100 uppercase"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
            </Field>
            <Field label="LOC">
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="KAPF"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
            </Field>
            <Field label="ROLE">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                style={{ fontFamily: 'DM Sans, sans-serif' }}
              >
                <option value="">—</option>
                <option value="PIC">PIC</option>
                <option value="SIC">SIC</option>
              </select>
            </Field>
          </div>
          <Field label="ADMIN NOTE (REQUIRED FOR AUDIT)">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Pilot flew N444AM but app crashed at duty-on; reconstructed from manifest."
              rows={2}
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
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
