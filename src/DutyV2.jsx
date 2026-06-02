// src/DutyV2.jsx
//
// =====================================================================
// PILOT DUTY CONSOLE (V2)
// =====================================================================
//
// What this is:
//   - Big green DUTY ON button — opens a confirmation form
//   - Big red DUTY OFF button — opens an end-of-duty form
//   - Live duty timer with color-coded warning bar
//   - Legality status panel (LEGAL / WARNING / ILLEGAL) computed from
//     all the pilot's recent periods + outside flying
//   - History strip with editable past periods
//   - Outside commercial flying logger (separate compact section)
//
// What this is NOT:
//   - It does not enforce blocking on the pilot side. If the engine
//     says illegal, the pilot can still record duty (we want the data
//     captured) but the UI shows a giant red banner and requires
//     acknowledgment + override request before submission.
//
// Data sources:
//   - firebase-duty-v2.js for all reads/writes
//   - duty-legality.js for the legality computation
//
// Audit:
//   - Every action goes through firebase-duty-v2 which appends to
//     adminEdits[]. This UI never writes directly to Firestore.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Square, AlertTriangle, CheckCircle2, Edit3, Plus, X,
  ChevronDown, ChevronUp, Clock, Plane, MapPin, Shield,
} from 'lucide-react';
import {
  subscribePeriodsForPilot,
  subscribeOutsideFlyingForPilot,
  startDuty as fbStartDuty,
  endDuty as fbEndDuty,
  editPeriod as fbEditPeriod,
  requestOverride as fbRequestOverride,
  addOutsideFlying as fbAddOutsideFlying,
} from './firebase-duty-v2.js';
import { evaluateCurrent, LIMITS } from './duty-legality.js';

const MS_HR = 3600 * 1000;
const MS_DAY = 24 * MS_HR;

// ---- Time formatting helpers ----

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtTime(t) {
  if (!t) return '—';
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function roundToFive(d = new Date()) {
  return new Date(Math.round(d.getTime() / 300000) * 300000);
}

function toLocalInputValue(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(s) {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

// ---- Top-level component ----

export default function DutyV2({ currentUser }) {
  const uid = currentUser?.uid || currentUser?.id;
  const name = currentUser?.name || currentUser?.displayName || 'Unknown';

  const [periods, setPeriods] = useState([]);
  const [outside, setOutside] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Live timer — tick every 30s so elapsed counters stay current.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Subscribe to this pilot's periods + outside flying.
  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    const unsubA = subscribePeriodsForPilot(uid, (list) => {
      setPeriods(list);
      setLoading(false);
    });
    const unsubB = subscribeOutsideFlyingForPilot(uid, setOutside);
    return () => { unsubA(); unsubB(); };
  }, [uid]);

  // The current period is the one with status='on'. There should be
  // at most one at any time (startDuty enforces this).
  const current = useMemo(
    () => periods.find(p => p.status === 'on') || null,
    [periods]
  );

  // Compute legality for the pilot's current state. This drives the
  // top-of-card status pill and the warnings panel.
  const legality = useMemo(
    () => evaluateCurrent(periods, outside, now,
      // crewType defaults to 'two' here; will be re-evaluated per period
      // for legality of the active period itself
      current?.crewType || 'two'),
    [periods, outside, now, current?.crewType]
  );

  // UI form state. Single source of truth — only one form is open at a time.
  // 'start' | 'end' | `edit:${periodId}:${field}` | 'override' | 'outside' | null
  const [openForm, setOpenForm] = useState(null);

  // ---- Handlers (wrap firebase functions, surface errors) ----

  const doStart = async (opts) => {
    setBusy(true); setError(null);
    try {
      await fbStartDuty({ pilotUid: uid, pilotName: name, ...opts });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to start duty');
    } finally { setBusy(false); }
  };

  const doEnd = async (opts) => {
    if (!current?.id) return;
    setBusy(true); setError(null);
    try {
      await fbEndDuty(current.id, { ...opts, endedBy: name });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to end duty');
    } finally { setBusy(false); }
  };

  const doEdit = async (periodId, field, value, note) => {
    setBusy(true); setError(null);
    try {
      await fbEditPeriod(periodId, field, value, { editedBy: name, note });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to update');
    } finally { setBusy(false); }
  };

  const doRequestOverride = async (reason) => {
    if (!current?.id) return;
    setBusy(true); setError(null);
    try {
      await fbRequestOverride(current.id, { requestedBy: name, reason });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to request override');
    } finally { setBusy(false); }
  };

  const doAddOutside = async (opts) => {
    setBusy(true); setError(null);
    try {
      await fbAddOutsideFlying({ pilotUid: uid, pilotName: name, ...opts });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to log outside flying');
    } finally { setBusy(false); }
  };

  if (loading) {
    return (
      <div className="border border-slate-800 bg-slate-900/30 p-4">
        <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          DUTY · LOADING…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Error banner */}
      {error && (
        <div className="border border-red-500/40 bg-red-500/5 px-3 py-2 flex items-center justify-between">
          <span className="text-xs text-red-300">{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Legality status panel — always visible */}
      <LegalityPanel legality={legality} />

      {/* Active state card */}
      {current ? (
        <OnDutyCard
          period={current}
          now={now}
          busy={busy}
          openForm={openForm}
          setOpenForm={setOpenForm}
          legality={legality}
          onEnd={doEnd}
          onEdit={doEdit}
          onRequestOverride={doRequestOverride}
        />
      ) : (
        <OffDutyCard
          busy={busy}
          openForm={openForm}
          setOpenForm={setOpenForm}
          periods={periods}
          now={now}
          onStart={doStart}
        />
      )}

      {/* Outside flying section */}
      <OutsideFlyingSection
        outside={outside}
        busy={busy}
        openForm={openForm}
        setOpenForm={setOpenForm}
        onAdd={doAddOutside}
      />

      {/* History strip */}
      <DutyHistoryStrip
        periods={periods.filter(p => p.id !== current?.id)}
        busy={busy}
        openForm={openForm}
        setOpenForm={setOpenForm}
        onEdit={doEdit}
      />
    </div>
  );
}

// =====================================================================
// Sub-components
// =====================================================================

function LegalityPanel({ legality }) {
  const toneFor = (status) => {
    switch (status) {
      case 'illegal': return { border: 'border-red-500/60', bg: 'bg-red-500/10', text: 'text-red-300', tag: 'text-red-500' };
      case 'warning': return { border: 'border-amber-500/50', bg: 'bg-amber-500/10', text: 'text-amber-300', tag: 'text-amber-400' };
      default:        return { border: 'border-emerald-500/30', bg: 'bg-emerald-500/5', text: 'text-emerald-200', tag: 'text-emerald-400' };
    }
  };
  const tone = toneFor(legality.status);
  const visibleChecks = legality.checks.filter(c => c.severity !== 'info');

  return (
    <div className={`border ${tone.border} ${tone.bg} p-3`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Shield className={`w-4 h-4 ${tone.tag}`} />
          <span className="text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            FAR 135 STATUS
          </span>
        </div>
        <span className={`text-xs tracking-widest ${tone.tag}`}
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
          {legality.summary}
        </span>
      </div>
      {visibleChecks.length > 0 && (
        <div className="space-y-1 mt-2">
          {visibleChecks.map((c, i) => (
            <div key={i} className={`text-[11px] flex items-start gap-1.5 ${tone.text}`}>
              {c.severity === 'block'
                ? <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-red-500" />
                : <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-400" />}
              <span>{c.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OffDutyCard({ busy, openForm, setOpenForm, periods, now, onStart }) {
  const starting = openForm === 'start';
  // Show rest-status info: if most-recent closed period ended within
  // 10 hours, the pilot is technically still resting.
  const lastClosed = periods.find(p => p.status === 'off');
  const restAvailableMs = lastClosed?.dutyOffAt
    ? (now - lastClosed.dutyOffAt)
    : null;

  return (
    <div className="border border-slate-700 bg-slate-900/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-slate-500" />
        <span className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          OFF DUTY
        </span>
        {restAvailableMs != null && (
          <span className="text-[10px] text-slate-500 ml-auto" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            Rest since {fmtTime(lastClosed.dutyOffAt)} · {fmtElapsed(restAvailableMs)}
          </span>
        )}
      </div>
      {!starting && (
        <button
          onClick={() => setOpenForm('start')}
          disabled={busy}
          className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 text-white text-base tracking-widest font-bold disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          <Play className="w-5 h-5" />
          DUTY ON
        </button>
      )}
      {starting && (
        <StartDutyForm
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onConfirm={onStart}
        />
      )}
    </div>
  );
}

function OnDutyCard({ period, now, busy, openForm, setOpenForm, legality, onEnd, onEdit, onRequestOverride }) {
  const elapsed = now - (period.dutyOnAt || now);
  const elapsedHrs = elapsed / MS_HR;
  // Color tone based on hours
  const tone = (() => {
    if (elapsedHrs >= 14) return { text: 'text-red-500', border: 'border-red-500/60', bg: 'bg-red-500/10', pulse: true, label: 'OVER 14' };
    if (elapsedHrs >= 12) return { text: 'text-red-400', border: 'border-red-500/50', bg: 'bg-red-500/10', pulse: true };
    if (elapsedHrs >= 10) return { text: 'text-amber-400', border: 'border-amber-500/40', bg: 'bg-amber-500/5' };
    return { text: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/5' };
  })();
  const progress = Math.max(0, Math.min(1, elapsed / (14 * MS_HR)));
  const ending = openForm === 'end';
  const editingOn = openForm === `edit:${period.id}:dutyOnAt`;
  const requestingOverride = openForm === 'override';

  return (
    <div className={`border ${tone.border} ${tone.bg} p-4`}>
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${tone.pulse ? 'animate-pulse' : ''} bg-current`} />
          <span className="text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            ON DUTY
          </span>
          {tone.label && (
            <span className="text-[9px] tracking-widest text-red-500 px-1.5 py-0.5 border border-red-500/60"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {tone.label}
            </span>
          )}
          <span className="text-[10px] text-slate-500 ml-2">
            {period.assignmentType === 'regular' ? '14h regular' : 'unscheduled'} · {period.crewType === 'two' ? '2 pilot' : 'single'}
          </span>
        </div>
        <span className={`text-2xl tabular-nums ${tone.text}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtElapsed(elapsed)}
        </span>
      </div>

      {/* Progress bar — fills toward 14h */}
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mb-3">
        <div className={`h-full ${tone.pulse ? 'animate-pulse' : ''} ${
          elapsedHrs >= 12 ? 'bg-red-500' : elapsedHrs >= 10 ? 'bg-amber-500' : 'bg-emerald-500'
        }`} style={{ width: `${progress * 100}%` }} />
      </div>

      {/* Context info */}
      <div className="text-[11px] text-slate-400 space-y-0.5 mb-3" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <div><span className="text-slate-600">Started:</span> <span className="text-slate-200">{fmtTime(period.dutyOnAt)}</span></div>
        {period.location && <div><span className="text-slate-600">Loc:</span> <span className="text-slate-300">{period.location}</span></div>}
        {period.tail && <div><span className="text-slate-600">Tail:</span> <span className="text-slate-300">{period.tail}</span></div>}
        {period.tripId && <div><span className="text-slate-600">Trip:</span> <span className="text-slate-300">{period.tripId}</span></div>}
        {period.role && <div><span className="text-slate-600">Role:</span> <span className="text-slate-300">{period.role}</span></div>}
      </div>

      {/* Edit duty-on time inline */}
      {!editingOn && !ending && !requestingOverride && (
        <button
          onClick={() => setOpenForm(`edit:${period.id}:dutyOnAt`)}
          className="text-[10px] text-slate-500 hover:text-cyan-400 flex items-center gap-1 mb-2"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          <Edit3 className="w-3 h-3" /> ADJUST DUTY-ON TIME
        </button>
      )}
      {editingOn && (
        <InlineTimeEditor
          label="ADJUST DUTY-ON TIME"
          initialMs={period.dutyOnAt}
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onSave={(ms, note) => onEdit(period.id, 'dutyOnAt', ms, note)}
        />
      )}

      {/* Override request when illegal */}
      {legality.status === 'illegal' && period.overrideStatus !== 'approved' && !requestingOverride && !ending && !editingOn && (
        <div className="border border-red-500/40 bg-red-500/10 p-2 mb-2">
          <div className="text-[10px] tracking-widest text-red-300 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            ILLEGAL — DO/CP OVERRIDE REQUIRED
          </div>
          <div className="text-[11px] text-red-200 mb-2">
            Continuing duty in this state requires written approval from your Chief Pilot or Director of Operations.
          </div>
          {period.overrideStatus === 'requested' ? (
            <div className="text-[10px] text-amber-300">
              Override requested by {period.overrideRequestedBy} at {fmtTime(period.overrideRequestedAt)} —
              awaiting CP/DO approval.
            </div>
          ) : (
            <button
              onClick={() => setOpenForm('override')}
              className="text-[10px] tracking-widest text-cyan-300 hover:text-cyan-100"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              REQUEST OVERRIDE →
            </button>
          )}
        </div>
      )}
      {requestingOverride && (
        <OverrideRequestForm
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onConfirm={onRequestOverride}
        />
      )}

      {/* End duty */}
      {!ending && !editingOn && !requestingOverride && (
        <button
          onClick={() => setOpenForm('end')}
          disabled={busy}
          className="w-full mt-2 py-4 bg-red-600 hover:bg-red-500 text-white text-base tracking-widest font-bold disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          <Square className="w-5 h-5" />
          DUTY OFF
        </button>
      )}
      {ending && (
        <EndDutyForm
          period={period}
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onConfirm={onEnd}
        />
      )}
    </div>
  );
}

// =====================================================================
// Forms
// =====================================================================

function StartDutyForm({ busy, onCancel, onConfirm }) {
  const [dutyOnAt, setDutyOnAt] = useState(() => toLocalInputValue(roundToFive()));
  const [location, setLocation] = useState('');
  const [tail, setTail] = useState('');
  const [tripId, setTripId] = useState('');
  const [role, setRole] = useState('PIC');
  const [crewType, setCrewType] = useState('two');
  const [assignmentType, setAssignmentType] = useState('unscheduled');
  const [fitForDuty, setFitForDuty] = useState(false);
  const [priorRestHours, setPriorRestHours] = useState('10');

  const onAtMs = fromLocalInputValue(dutyOnAt);
  const priorRestMs = (() => {
    const n = parseFloat(priorRestHours);
    return Number.isFinite(n) && n >= 0 ? n * MS_HR : null;
  })();

  const canSubmit = Boolean(
    location.trim() &&
    crewType &&
    assignmentType &&
    fitForDuty &&
    onAtMs != null &&
    onAtMs <= Date.now() + 60000   // not in the far future
  );

  const submit = () => {
    if (!canSubmit) return;
    onConfirm({
      location: location.trim(),
      tail: tail.trim() || null,
      tripId: tripId.trim() || null,
      role,
      crewType,
      assignmentType,
      fitForDuty: true,
      priorRestMs,
      dutyOnAt: onAtMs,
    });
  };

  return (
    <div className="space-y-3" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <Label>DUTY-ON TIME</Label>
      <input
        type="datetime-local"
        value={dutyOnAt}
        onChange={(e) => setDutyOnAt(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
      />

      <Label>LOCATION (airport code or freeform)</Label>
      <input
        type="text"
        value={location}
        onChange={(e) => setLocation(e.target.value.toUpperCase().slice(0, 30))}
        placeholder="e.g. KAPF, hotel, home base"
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>TAIL (optional)</Label>
          <input
            type="text"
            value={tail}
            onChange={(e) => setTail(e.target.value.toUpperCase().slice(0, 10))}
            placeholder="N444AM"
            className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          />
        </div>
        <div>
          <Label>TRIP ID (optional)</Label>
          <input
            type="text"
            value={tripId}
            onChange={(e) => setTripId(e.target.value)}
            placeholder="L32LW0"
            className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>ROLE</Label>
          <Toggle options={['PIC', 'SIC']} value={role} onChange={setRole} />
        </div>
        <div>
          <Label>CREW</Label>
          <Toggle
            options={[{ value: 'single', label: '1 PILOT' }, { value: 'two', label: '2 PILOTS' }]}
            value={crewType}
            onChange={setCrewType}
          />
        </div>
      </div>

      <div>
        <Label>ASSIGNMENT TYPE</Label>
        <Toggle
          options={[
            { value: 'unscheduled', label: 'UNSCHEDULED' },
            { value: 'regular', label: 'REGULAR (14h)' },
          ]}
          value={assignmentType}
          onChange={setAssignmentType}
        />
        <div className="text-[10px] text-slate-500 mt-1">
          {assignmentType === 'unscheduled'
            ? '135.267(b) — no 14h duty cap; limited by flight time + rest.'
            : '135.267(c) — up to 14h duty, must have rest before & after totaling 24h.'}
        </div>
      </div>

      <div>
        <Label>PRIOR REST (hours)</Label>
        <input
          type="number"
          step="0.5"
          min="0"
          max="48"
          value={priorRestHours}
          onChange={(e) => setPriorRestHours(e.target.value)}
          className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
        />
        <div className="text-[10px] text-slate-500 mt-1">
          Your continuous rest immediately before this duty. Need ≥10h normally.
        </div>
      </div>

      <label className="flex items-center gap-2 p-3 border border-amber-500/30 bg-amber-500/5 cursor-pointer">
        <input
          type="checkbox"
          checked={fitForDuty}
          onChange={(e) => setFitForDuty(e.target.checked)}
          className="w-4 h-4 accent-amber-500"
        />
        <span className="text-[11px] text-amber-200">
          <strong>FIT FOR DUTY.</strong> I am not fatigued, ill, medicated, or otherwise impaired,
          and I have had the rest period indicated above.
        </span>
      </label>

      <div className="flex gap-2 pt-1">
        <button
          onClick={submit}
          disabled={busy || !canSubmit}
          className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold tracking-widest disabled:opacity-40"
        >
          {busy ? 'STARTING…' : 'CONFIRM DUTY ON'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-3 border border-slate-700 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

function EndDutyForm({ period, busy, onCancel, onConfirm }) {
  const [dutyOffAt, setDutyOffAt] = useState(() => toLocalInputValue(roundToFive()));
  const [flightTimeHours, setFlightTimeHours] = useState(
    period.flightTimeMs ? (period.flightTimeMs / MS_HR).toFixed(1) : '0'
  );
  const [excursionReason, setExcursionReason] = useState('');

  const offAtMs = fromLocalInputValue(dutyOffAt);
  const ftMs = (() => {
    const n = parseFloat(flightTimeHours);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * MS_HR) : 0;
  })();

  const elapsed = offAtMs != null ? offAtMs - period.dutyOnAt : 0;
  const over14 = elapsed > 14 * MS_HR;
  const limit = period.crewType === 'two' ? LIMITS.TWO_PILOT_FLIGHT_MAX_MS : LIMITS.SINGLE_PILOT_FLIGHT_MAX_MS;
  const overFlight = ftMs > limit;

  const canSubmit = offAtMs != null && offAtMs > period.dutyOnAt && offAtMs <= Date.now() + 60000;

  return (
    <div className="space-y-3 mt-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <Label>DUTY-OFF TIME</Label>
      <input
        type="datetime-local"
        value={dutyOffAt}
        onChange={(e) => setDutyOffAt(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
      />
      {canSubmit && (
        <div className="text-[11px] text-slate-400">
          Total duty: <span className={over14 ? 'text-red-400 font-semibold' : 'text-slate-200'}>{fmtElapsed(elapsed)}</span>
          {over14 && <span className="text-red-400"> · OVER 14h</span>}
        </div>
      )}

      <Label>FLIGHT TIME (hours, block)</Label>
      <input
        type="number"
        step="0.1"
        min="0"
        max="24"
        value={flightTimeHours}
        onChange={(e) => setFlightTimeHours(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
      />
      <div className="text-[10px] text-slate-500">
        Sum of block time across legs in this duty period. Limit for{' '}
        {period.crewType === 'two' ? 'two-pilot' : 'single-pilot'}: {limit / MS_HR}h.
      </div>

      {overFlight && (
        <>
          <div className="border border-red-500/40 bg-red-500/10 p-2">
            <div className="text-[10px] tracking-widest text-red-300 mb-1" style={{ fontWeight: 700 }}>
              FLIGHT TIME EXCEEDED LIMIT
            </div>
            <div className="text-[11px] text-red-200">
              An excursion is only permitted if outside pilot/operator control (weather, ATC, mechanical, passenger delay).
              Pilot-caused excursions are violations.
            </div>
          </div>
          <Label>EXCURSION REASON</Label>
          <textarea
            value={excursionReason}
            onChange={(e) => setExcursionReason(e.target.value)}
            placeholder="Required — describe the outside-control circumstance"
            rows={2}
            className="w-full bg-slate-950/80 border border-red-500/40 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          />
        </>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onConfirm({
            dutyOffAt: offAtMs,
            flightTimeMs: ftMs,
            excursionReason: overFlight ? (excursionReason.trim() || null) : null,
          })}
          disabled={busy || !canSubmit || (overFlight && !excursionReason.trim())}
          className="flex-1 py-3 bg-red-600 hover:bg-red-500 text-white text-sm font-bold tracking-widest disabled:opacity-40"
        >
          {busy ? 'ENDING…' : 'CONFIRM DUTY OFF'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-3 border border-slate-700 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

function OverrideRequestForm({ busy, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <div className="space-y-2 mt-2 p-3 border border-red-500/40 bg-red-500/5"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <Label>OVERRIDE REQUEST REASON</Label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Explain why this assignment must proceed despite the legality finding"
        rows={3}
        className="w-full bg-slate-950/80 border border-red-500/40 px-3 py-2 text-sm text-slate-100"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      />
      <div className="text-[10px] text-amber-300">
        This sends a request to Chief Pilot / Director of Operations. You must NOT
        continue duty until approval is granted.
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onConfirm(reason.trim())}
          disabled={busy || !reason.trim()}
          className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-40"
        >
          {busy ? 'SENDING…' : 'SEND OVERRIDE REQUEST'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300 hover:border-slate-500"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

function InlineTimeEditor({ label, initialMs, busy, onCancel, onSave }) {
  const [value, setValue] = useState(() => toLocalInputValue(new Date(initialMs)));
  const [note, setNote] = useState('');
  const ms = fromLocalInputValue(value);
  const inFuture = ms != null && ms > Date.now() + 60000;
  return (
    <div className="space-y-2 mt-2 p-3 border border-cyan-500/30 bg-cyan-500/5"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {label && <Label>{label}</Label>}
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
      />
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional reason for edit (logged)"
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-[11px] text-slate-100"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      />
      {inFuture && <div className="text-[10px] text-red-400">Time is in the future.</div>}
      <div className="flex gap-2">
        <button
          onClick={() => onSave(ms, note.trim() || null)}
          disabled={busy || ms == null || inFuture}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'SAVING…' : 'SAVE'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300 hover:border-slate-500"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// Outside flying
// =====================================================================

function OutsideFlyingSection({ outside, busy, openForm, setOpenForm, onAdd }) {
  const [expanded, setExpanded] = useState(false);
  const adding = openForm === 'outside';
  // Only count outside flying in the last 30 days for the summary
  const recent = outside.filter(o => o.startAt > Date.now() - 30 * MS_DAY);

  return (
    <div className="border border-slate-800 bg-slate-900/20">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/30"
      >
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          OUTSIDE COMMERCIAL FLYING (last 30d) · {recent.length}
        </span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
      </button>
      {expanded && (
        <div className="border-t border-slate-800 p-2">
          {recent.length > 0 && (
            <div className="space-y-1 mb-2">
              {recent.slice(0, 10).map(o => (
                <div key={o.id} className="text-[11px] text-slate-400 flex justify-between"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <span>{fmtTime(o.startAt)} → {fmtTime(o.endAt)}</span>
                  <span>{(o.flightTimeMs / MS_HR).toFixed(1)}h · {o.source}</span>
                </div>
              ))}
            </div>
          )}
          {!adding && (
            <button
              onClick={() => setOpenForm('outside')}
              className="text-[10px] tracking-widest text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              <Plus className="w-3 h-3" /> LOG OUTSIDE FLIGHT
            </button>
          )}
          {adding && (
            <OutsideFlyingForm
              busy={busy}
              onCancel={() => setOpenForm(null)}
              onConfirm={onAdd}
            />
          )}
        </div>
      )}
    </div>
  );
}

function OutsideFlyingForm({ busy, onCancel, onConfirm }) {
  const [startAt, setStartAt] = useState(() => toLocalInputValue(roundToFive()));
  const [endAt, setEndAt] = useState(() => toLocalInputValue(roundToFive()));
  const [flightTimeHours, setFlightTimeHours] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const startMs = fromLocalInputValue(startAt);
  const endMs = fromLocalInputValue(endAt);
  const ftMs = parseFloat(flightTimeHours) * MS_HR;
  const valid = startMs && endMs && endMs > startMs && Number.isFinite(ftMs) && ftMs > 0 && source.trim();

  return (
    <div className="space-y-2 mt-2 p-3 border border-slate-700"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>START</Label>
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)}
            className="w-full bg-slate-950/80 border border-slate-700 px-2 py-2 text-sm text-slate-100" />
        </div>
        <div>
          <Label>END</Label>
          <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)}
            className="w-full bg-slate-950/80 border border-slate-700 px-2 py-2 text-sm text-slate-100" />
        </div>
      </div>
      <Label>FLIGHT TIME (hours)</Label>
      <input type="number" step="0.1" min="0" value={flightTimeHours} onChange={(e) => setFlightTimeHours(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100" />
      <Label>OPERATOR / SOURCE</Label>
      <input type="text" value={source} onChange={(e) => setSource(e.target.value)}
        placeholder="e.g. Other Air Inc, personal flight"
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100" />
      <Label>NOTES (optional)</Label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100"
        style={{ fontFamily: 'DM Sans, sans-serif' }} />
      <div className="flex gap-2">
        <button
          onClick={() => onConfirm({ startAt: startMs, endAt: endMs, flightTimeMs: Math.round(ftMs), source: source.trim(), notes: notes.trim() })}
          disabled={busy || !valid}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'SAVING…' : 'LOG FLIGHT'}
        </button>
        <button onClick={onCancel} disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300">
          CANCEL
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// History
// =====================================================================

function DutyHistoryStrip({ periods, busy, openForm, setOpenForm, onEdit }) {
  const closed = periods.filter(p => p.status === 'off' && p.dutyOffAt).slice(0, 10);
  const [expanded, setExpanded] = useState(false);
  if (closed.length === 0) return null;
  return (
    <div className="border border-slate-800 bg-slate-900/20">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/30"
      >
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          RECENT DUTY · {closed.length}
        </span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
      </button>
      {expanded && (
        <div className="divide-y divide-slate-800">
          {closed.map(p => (
            <HistoryRow key={p.id} period={p} busy={busy} openForm={openForm} setOpenForm={setOpenForm} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ period, busy, openForm, setOpenForm, onEdit }) {
  const elapsed = (period.dutyOffAt || 0) - (period.dutyOnAt || 0);
  const ftH = (period.flightTimeMs || 0) / MS_HR;
  const editing = openForm?.startsWith(`edit:${period.id}:`);
  return (
    <div className="px-3 py-2">
      <div className="grid items-baseline gap-2 text-[11px]"
        style={{ gridTemplateColumns: '1fr 1fr 70px 70px 60px', fontFamily: 'JetBrains Mono, monospace' }}>
        <div className="text-slate-300 tabular-nums">{fmtTime(period.dutyOnAt)}</div>
        <div className="text-slate-400 tabular-nums">{fmtTime(period.dutyOffAt)}</div>
        <div className={`text-right tabular-nums ${period.over14 ? 'text-red-400' : 'text-slate-300'}`}>
          {fmtElapsed(elapsed)}
        </div>
        <div className="text-right tabular-nums text-slate-400">{ftH.toFixed(1)}hFT</div>
        <div className="text-right">
          {!editing && (
            <button onClick={() => setOpenForm(`edit:${period.id}:dutyOnAt`)}
              className="text-[10px] text-slate-500 hover:text-cyan-400">EDIT</button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 space-y-2">
          <InlineTimeEditor label="DUTY-ON" initialMs={period.dutyOnAt} busy={busy}
            onCancel={() => setOpenForm(null)}
            onSave={(ms, note) => onEdit(period.id, 'dutyOnAt', ms, note)} />
          <InlineTimeEditor label="DUTY-OFF" initialMs={period.dutyOffAt} busy={busy}
            onCancel={() => setOpenForm(null)}
            onSave={(ms, note) => onEdit(period.id, 'dutyOffAt', ms, note)} />
        </div>
      )}
      {period.excursionReason && (
        <div className="text-[10px] text-amber-300/80 italic mt-1">
          Excursion: {period.excursionReason}
        </div>
      )}
      {period.overrideStatus === 'approved' && (
        <div className="text-[10px] text-emerald-300 mt-1">
          ✓ Override approved by {period.overrideApprovedBy}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Tiny shared UI atoms
// =====================================================================

function Label({ children }) {
  return (
    <div className="text-[10px] tracking-widest text-slate-500"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {children}
    </div>
  );
}

function Toggle({ options, value, onChange }) {
  const normalized = options.map(o => typeof o === 'string' ? { value: o, label: o } : o);
  return (
    <div className="flex gap-1 p-0.5 bg-slate-950/80 border border-slate-700">
      {normalized.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 py-1.5 text-[10px] tracking-widest ${
            value === o.value ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
          }`}
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
