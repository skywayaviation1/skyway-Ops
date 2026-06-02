// src/DutySimple.jsx
//
// SIMPLIFIED DUTY CONSOLE — replaces the previous DutyCardInner.
//
// Single-pilot model. Each crew member tracks THEIR OWN duty period.
// No partner pairings, no FBO auto-triggers, no rest overrides at start,
// no linked-confirmation flows. Pilots can:
//   - Start a duty period (with editable start time, defaulting to now)
//   - End a duty period (with editable end time, defaulting to now)
//   - Edit the on/off time of their CURRENT period at any moment
//   - View their last 5 duty periods, expand any to edit times
//
// FAR 117 warning behavior:
//   - Color-coded elapsed time:
//       0–10h: green
//       10–12h: amber
//       12–14h: red (pulsing)
//       14h+:   "OVER 14" tag, optional reason prompt on end
//
// Data model — preserves the field names used by:
//   - firebase-duty.js helpers (subscribeToActiveDuty, etc.)
//   - OpsCommandCenter CrewDutyPanel (reads pilotName, dutyOnAt, over14, sicName)
//   - Maintenance dispatch (reads status)
// Fields kept: pilotUid, pilotName, role, sicUid (null), sicName (null),
//              dutyOnAt, dutyOffAt, restUntil, over14, status,
//              adminEdits[], createdAt, updatedAt.
// Fields no longer used by this UI but preserved as nulls/false:
//              fboArrivalAt (null), linkedPeriodId (null), linkPending (false),
//              linkedAuto (false), restOverride (null),
//              over14ReasonPic (string), over14ReasonSic (string)

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, AlertTriangle, Edit3, CheckCircle, X, ChevronDown, ChevronUp } from 'lucide-react';

// FAR 117 limits — mirrors the constants in firebase-duty.js so this UI
// stays consistent with whatever else reads/writes the duty-state collection.
const DUTY_MAX_MS = 14 * 60 * 60 * 1000;
const REST_MIN_MS = 10 * 60 * 60 * 1000;
const WARN_HRS = 10;
const URGENT_HRS = 12;

// Round a Date to the nearest 5 minutes — used to seed the time picker
// when the pilot opens the start/end form. "Now" rounded feels less
// fiddly than the literal millisecond they pressed the button.
function roundToFive(d = new Date()) {
  const ms = d.getTime();
  const fiveMin = 5 * 60 * 1000;
  return new Date(Math.round(ms / fiveMin) * fiveMin);
}

// HTML <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in LOCAL time.
// JS Date.toISOString gives UTC, which is wrong for this input. Build it manually.
function toLocalInputValue(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

// Inverse — parse a "YYYY-MM-DDTHH:mm" value back into ms since epoch in
// local time. The Date constructor handles this string format natively.
function fromLocalInputValue(s) {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

// Format an elapsed milliseconds as "Xh YYm" — compact, monospace-friendly.
function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return `${hrs}h ${String(mins).padStart(2, '0')}m`;
}

// Format a Date as "Tue 2:43 PM" — for showing dutyOn/Off times in the UI.
function fmtTime(t) {
  if (!t) return '—';
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Determine duty state from the latest period doc. Three states:
//   - 'available':  no current duty, no active rest window (rare; usually fresh user)
//   - 'in_rest':    last duty ended, restUntil is in the future
//   - 'on':         currently on duty
function deriveState(period, now = Date.now()) {
  if (!period) return 'available';
  if (period.status === 'on') return 'on';
  if (period.restUntil && period.restUntil > now) return 'in_rest';
  return 'available';
}

// Tone classes for the elapsed-time pill based on hours into duty.
function toneFor(hrs) {
  if (hrs >= 14) return { text: 'text-red-500', border: 'border-red-500/60', bg: 'bg-red-500/10', pulse: true, label: 'OVER 14' };
  if (hrs >= URGENT_HRS) return { text: 'text-red-400', border: 'border-red-500/50', bg: 'bg-red-500/10', pulse: true, label: null };
  if (hrs >= WARN_HRS) return { text: 'text-amber-400', border: 'border-amber-500/40', bg: 'bg-amber-500/5', pulse: false, label: null };
  return { text: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/5', pulse: false, label: null };
}

export default function DutySimple({ currentUser }) {
  const [current, setCurrent] = useState(null);    // latest duty period for this pilot
  const [history, setHistory] = useState([]);      // recent 5 periods (any status)
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // UI: which form is open. Null = no form, just shows current state card.
  // 'start' = pilot opening a new duty period
  // 'end' = pilot closing the current duty period
  // 'edit:<periodId>:<field>' = editing dutyOnAt or dutyOffAt on a specific period
  const [openForm, setOpenForm] = useState(null);

  // Now ticker — updates every 30s so the elapsed-time pill stays current.
  // We don't need second-level precision; minute precision is what shows.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Subscribe to this pilot's current/latest duty period.
  // Also load history (one-shot fetch each time current changes, since
  // the small number of recent periods doesn't need a live subscription).
  useEffect(() => {
    const uid = currentUser?.uid || currentUser?.id;
    if (!uid) { setLoading(false); return; }
    let cancelled = false;
    let unsub = null;
    (async () => {
      try {
        const m = await import('./firebase-duty.js');
        if (cancelled) return;
        unsub = m.subscribeToCurrentDuty(uid, (period) => {
          if (cancelled) return;
          setCurrent(period);
          setLoading(false);
        });
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Failed to load duty');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [currentUser?.uid, currentUser?.id]);

  // Load recent history (last 5 periods) when current period changes.
  // Re-runs naturally as soon as current is non-null or changes status.
  useEffect(() => {
    const uid = currentUser?.uid || currentUser?.id;
    if (!uid) return;
    let cancelled = false;
    (async () => {
      try {
        const { db } = await import('./firebase.js');
        const { collection, query, where, getDocs } = await import('firebase/firestore');
        const snap = await getDocs(query(
          collection(db, 'duty-state'),
          where('pilotUid', '==', uid),
        ));
        if (cancelled) return;
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.dutyOnAt || 0) - (a.dutyOnAt || 0));
        setHistory(list.slice(0, 6));    // 6 so we have one extra to compare current vs history
      } catch (e) {
        // History load failure is non-fatal — leave history empty.
        console.warn('[duty] history load failed:', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [currentUser?.uid, currentUser?.id, current?.id, current?.status, current?.dutyOffAt]);

  const state = deriveState(current, now);

  // -------- Actions: start, end, edit --------
  //
  // We write Firestore DIRECTLY rather than going through the existing
  // firebase-duty.js helpers because those helpers enforce linked-pair
  // logic, require reason notes, etc. — the friction we're rewriting
  // away. All writes preserve the field names other readers expect.

  const startDuty = async (atMs) => {
    const uid = currentUser?.uid || currentUser?.id;
    if (!uid) return;
    const pilotName = currentUser?.name || currentUser?.displayName || 'Unknown';
    setBusy(true); setError(null);
    try {
      const { db } = await import('./firebase.js');
      const { doc, setDoc } = await import('firebase/firestore');
      const onTime = Number.isFinite(atMs) ? atMs : Date.now();
      const id = `${uid}_${onTime}`;
      await setDoc(doc(db, 'duty-state', id), {
        id,
        pilotUid: uid,
        pilotName,
        role: 'PIC',
        sicUid: null,
        sicName: null,
        dutyOnAt: onTime,
        dutyOffAt: null,
        // fboArrivalAt kept null — the auto-FBO-trigger is gone, but the
        // field is preserved for any reader that still references it.
        fboArrivalAt: null,
        restUntil: null,
        over14: false,
        over14ReasonPic: '',
        over14ReasonSic: '',
        // Linkage fields preserved as null/false for any reader that
        // checks them. Single-pilot model has no partner.
        linkedPeriodId: null,
        linkPending: false,
        linkedAuto: false,
        restOverride: null,
        status: 'on',
        adminEdits: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to start duty');
    } finally {
      setBusy(false);
    }
  };

  const endDuty = async (atMs, reasonIfOver14) => {
    if (!current?.id) return;
    setBusy(true); setError(null);
    try {
      const { db } = await import('./firebase.js');
      const { doc, updateDoc } = await import('firebase/firestore');
      const offTime = Number.isFinite(atMs) ? atMs : Date.now();
      const elapsed = offTime - (current.dutyOnAt || offTime);
      const over14 = elapsed > DUTY_MAX_MS;
      const patch = {
        dutyOffAt: offTime,
        restUntil: offTime + REST_MIN_MS,
        over14,
        status: 'off',
        updatedAt: Date.now(),
      };
      // Capture reason for over-14 closes — kept on PIC field since this is
      // the single-pilot model. Not required (no hard block), just logged.
      if (over14 && reasonIfOver14) {
        patch.over14ReasonPic = String(reasonIfOver14).slice(0, 1000);
      }
      await updateDoc(doc(db, 'duty-state', current.id), patch);
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to end duty');
    } finally {
      setBusy(false);
    }
  };

  // Edit the dutyOnAt OR dutyOffAt of an arbitrary period (own past
  // periods OR the current active one). Records the edit in adminEdits[]
  // for audit. Reason note is optional in this simplified flow — the
  // audit shows WHO and WHEN; pilots can fix typos without explaining.
  const editPeriodTime = async (periodId, field, newMs, optionalReason) => {
    if (!periodId || !['dutyOnAt', 'dutyOffAt'].includes(field)) return;
    if (!Number.isFinite(newMs)) {
      setError('Invalid time');
      return;
    }
    setBusy(true); setError(null);
    try {
      const { db } = await import('./firebase.js');
      const { doc, getDoc, updateDoc } = await import('firebase/firestore');
      const ref = doc(db, 'duty-state', periodId);
      const snap = await getDoc(ref);
      if (!snap.exists()) throw new Error('duty period not found');
      const cur = snap.data();
      const from = cur[field] || null;
      const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];
      const patch = {
        [field]: newMs,
        adminEdits: [...edits, {
          by: currentUser?.name || currentUser?.displayName || 'pilot-self-edit',
          at: Date.now(),
          field,
          from,
          to: newMs,
          note: optionalReason ? String(optionalReason).slice(0, 500) : 'pilot self-edit',
        }],
        updatedAt: Date.now(),
      };
      // Recompute derived fields if the change affects them
      if (field === 'dutyOffAt' && newMs) {
        patch.restUntil = newMs + REST_MIN_MS;
        if (cur.dutyOnAt) patch.over14 = (newMs - cur.dutyOnAt) > DUTY_MAX_MS;
      }
      if (field === 'dutyOnAt' && newMs && cur.dutyOffAt) {
        patch.over14 = (cur.dutyOffAt - newMs) > DUTY_MAX_MS;
      }
      await updateDoc(ref, patch);
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to update');
    } finally {
      setBusy(false);
    }
  };

  // -------- Render --------

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
      {/* Error banner — surfaces any failed write */}
      {error && (
        <div className="border border-red-500/40 bg-red-500/5 px-3 py-2 flex items-center justify-between">
          <span className="text-xs text-red-300">{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main state card */}
      {state === 'on' && (
        <OnDutyCard
          period={current}
          now={now}
          busy={busy}
          openForm={openForm}
          setOpenForm={setOpenForm}
          onEditTime={editPeriodTime}
          onEnd={endDuty}
        />
      )}
      {state === 'in_rest' && (
        <InRestCard
          period={current}
          now={now}
          busy={busy}
          openForm={openForm}
          setOpenForm={setOpenForm}
          onStart={startDuty}
        />
      )}
      {state === 'available' && (
        <AvailableCard
          busy={busy}
          openForm={openForm}
          setOpenForm={setOpenForm}
          onStart={startDuty}
        />
      )}

      {/* History strip */}
      <DutyHistoryStrip
        history={history}
        currentId={current?.id}
        busy={busy}
        openForm={openForm}
        setOpenForm={setOpenForm}
        onEditTime={editPeriodTime}
      />
    </div>
  );
}

// =====================================================================
// State cards
// =====================================================================

function OnDutyCard({ period, now, busy, openForm, setOpenForm, onEditTime, onEnd }) {
  const elapsed = now - (period.dutyOnAt || now);
  const elapsedHrs = elapsed / 3600000;
  const tone = toneFor(elapsedHrs);
  const remaining = DUTY_MAX_MS - elapsed;
  // Progress bar — fraction of 14h consumed, capped 0-1.
  const progress = Math.max(0, Math.min(1, elapsed / DUTY_MAX_MS));

  const editingOn = openForm === `edit:${period.id}:dutyOnAt`;
  const ending = openForm === 'end';

  return (
    <div className={`border ${tone.border} ${tone.bg} p-4`}>
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${tone.pulse ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: 'currentColor' }} />
          <span className="text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            ON DUTY
          </span>
          {tone.label && (
            <span className="text-[9px] tracking-widest text-red-500 px-1.5 py-0.5 border border-red-500/60"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {tone.label}
            </span>
          )}
        </div>
        <span className={`text-2xl tabular-nums ${tone.text}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtElapsed(elapsed)}
        </span>
      </div>

      {/* Progress bar — fills as duty time accumulates */}
      <div className="h-1 bg-slate-800 rounded-full overflow-hidden mb-3">
        <div
          className={tone.pulse ? 'h-full bg-red-500 animate-pulse' : 'h-full bg-current'}
          style={{ width: `${progress * 100}%`, color: tone.text.replace('text-', '') }}
        />
      </div>

      {/* On-time row + edit */}
      <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
        <span>
          <span className="text-slate-600">Started:</span>{' '}
          <span className="text-slate-200 tabular-nums">{fmtTime(period.dutyOnAt)}</span>
        </span>
        {!editingOn && !ending && (
          <button
            onClick={() => setOpenForm(`edit:${period.id}:dutyOnAt`)}
            className="text-[10px] text-slate-500 hover:text-cyan-400 flex items-center gap-1"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Edit3 className="w-3 h-3" />
            EDIT TIME
          </button>
        )}
      </div>

      {/* Inline edit form for dutyOnAt */}
      {editingOn && (
        <InlineTimeEditor
          label="ADJUST DUTY-ON TIME"
          initialMs={period.dutyOnAt}
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onSave={(ms) => onEditTime(period.id, 'dutyOnAt', ms)}
        />
      )}

      {/* End duty action */}
      {!ending && !editingOn && (
        <button
          onClick={() => setOpenForm('end')}
          disabled={busy}
          className="w-full mt-2 py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm tracking-widest text-slate-200 disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
        >
          END DUTY
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

      {/* Remaining-time tooltip — pure informational, only when not over */}
      {remaining > 0 && !ending && !editingOn && (
        <div className="text-[10px] text-slate-600 mt-2 text-center" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtElapsed(remaining)} until FAR 117 14-hour limit
        </div>
      )}
    </div>
  );
}

function InRestCard({ period, now, busy, openForm, setOpenForm, onStart }) {
  const restRemainingMs = (period.restUntil || 0) - now;
  const restEnds = period.restUntil ? new Date(period.restUntil) : null;
  const starting = openForm === 'start';

  return (
    <div className="border border-violet-500/40 bg-violet-500/5 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-violet-400" />
          <span className="text-[10px] tracking-widest text-violet-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            IN REST
          </span>
        </div>
        <span className="text-xl tabular-nums text-violet-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtElapsed(restRemainingMs)}
        </span>
      </div>
      <div className="text-xs text-slate-400 mb-3">
        Last duty ended {fmtTime(period.dutyOffAt)}. Earliest legal next duty:
        <br />
        <span className="text-slate-200 tabular-nums">{fmtTime(restEnds)}</span>
      </div>
      {!starting && (
        <button
          onClick={() => setOpenForm('start')}
          disabled={busy}
          className="w-full py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm tracking-widest font-medium disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          START NEW DUTY
        </button>
      )}
      {starting && (
        <StartDutyForm
          busy={busy}
          warningMs={restRemainingMs > 0 ? restRemainingMs : 0}
          onCancel={() => setOpenForm(null)}
          onConfirm={onStart}
        />
      )}
    </div>
  );
}

function AvailableCard({ busy, openForm, setOpenForm, onStart }) {
  const starting = openForm === 'start';
  return (
    <div className="border border-slate-700 bg-slate-900/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-slate-500" />
        <span className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          AVAILABLE
        </span>
      </div>
      {!starting && (
        <button
          onClick={() => setOpenForm('start')}
          disabled={busy}
          className="w-full py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm tracking-widest font-medium disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          START DUTY
        </button>
      )}
      {starting && (
        <StartDutyForm
          busy={busy}
          warningMs={0}
          onCancel={() => setOpenForm(null)}
          onConfirm={onStart}
        />
      )}
    </div>
  );
}

// =====================================================================
// Forms
// =====================================================================

function StartDutyForm({ busy, warningMs, onCancel, onConfirm }) {
  // Seed with current time rounded to 5 min. Pilot can adjust if backdating.
  const [value, setValue] = useState(() => toLocalInputValue(roundToFive()));
  const ms = fromLocalInputValue(value);
  const now = Date.now();
  // Sanity: warn if pilot picks a time more than 12h in the past or any
  // time in the future. Doesn't block — just informs.
  const tooFarBack = ms != null && (now - ms) > 12 * 3600000;
  const inFuture = ms != null && ms > now + 60000;

  return (
    <div className="space-y-2">
      <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        DUTY ON TIME
      </div>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      />
      {warningMs > 0 && (
        <div className="text-[10px] text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>You're still in rest for {fmtElapsed(warningMs)}. Starting duty early is logged.</span>
        </div>
      )}
      {tooFarBack && (
        <div className="text-[10px] text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>That time is more than 12 hours ago. Double-check before confirming.</span>
        </div>
      )}
      {inFuture && (
        <div className="text-[10px] text-red-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>Time is in the future. Adjust before continuing.</span>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onConfirm(ms)}
          disabled={busy || ms == null || inFuture}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {busy ? 'STARTING…' : 'CONFIRM START'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

function EndDutyForm({ period, busy, onCancel, onConfirm }) {
  const [value, setValue] = useState(() => toLocalInputValue(roundToFive()));
  const [reason, setReason] = useState('');
  const ms = fromLocalInputValue(value);
  const now = Date.now();
  const dutyOnAt = period.dutyOnAt || now;
  const elapsed = ms != null ? ms - dutyOnAt : 0;
  const willBeOver14 = elapsed > DUTY_MAX_MS;
  const inFuture = ms != null && ms > now + 60000;
  const beforeStart = ms != null && ms <= dutyOnAt;

  return (
    <div className="space-y-2 mt-2">
      <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        DUTY OFF TIME
      </div>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      />
      {ms != null && !beforeStart && !inFuture && (
        <div className="text-[10px] text-slate-400">
          Total duty: <span className={willBeOver14 ? 'text-red-400' : 'text-slate-200'}>{fmtElapsed(elapsed)}</span>
          {willBeOver14 && <span className="text-red-400"> · OVER 14</span>}
        </div>
      )}
      {beforeStart && (
        <div className="text-[10px] text-red-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>End time must be after start time ({fmtTime(dutyOnAt)}).</span>
        </div>
      )}
      {inFuture && (
        <div className="text-[10px] text-red-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>Time is in the future. Adjust before continuing.</span>
        </div>
      )}
      {willBeOver14 && !beforeStart && (
        <div className="space-y-1">
          <div className="text-[10px] tracking-widest text-amber-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            OVER 14 — REASON (OPTIONAL, LOGGED)
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. weather hold at OPF, late pax, mx delay…"
            rows={2}
            className="w-full bg-slate-950/80 border border-amber-500/30 px-3 py-2 text-[11px] text-slate-100 focus:outline-none focus:border-amber-400"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          />
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onConfirm(ms, reason)}
          disabled={busy || ms == null || beforeStart || inFuture}
          className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-medium disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {busy ? 'ENDING…' : 'CONFIRM END'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

// Generic inline editor for either dutyOnAt or dutyOffAt. Used both on the
// active card (edit current duty start) and from the history strip (edit
// any past period).
function InlineTimeEditor({ label, initialMs, busy, onCancel, onSave }) {
  const [value, setValue] = useState(() => toLocalInputValue(initialMs ? new Date(initialMs) : roundToFive()));
  const ms = fromLocalInputValue(value);
  const now = Date.now();
  const inFuture = ms != null && ms > now + 60000;

  return (
    <div className="space-y-2 mt-2 p-3 border border-cyan-500/30 bg-cyan-500/5">
      <div className="text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </div>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      />
      {inFuture && (
        <div className="text-[10px] text-red-400">Time is in the future.</div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => onSave(ms)}
          disabled={busy || ms == null || inFuture}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {busy ? 'SAVING…' : 'SAVE'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// History strip
// =====================================================================

function DutyHistoryStrip({ history, currentId, busy, openForm, setOpenForm, onEditTime }) {
  // Filter out the current active period from history (it's already shown in
  // the main card). Show last 5 closed periods.
  const closed = history.filter(p => p.id !== currentId && p.dutyOffAt).slice(0, 5);
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
            <HistoryRow
              key={p.id}
              period={p}
              busy={busy}
              openForm={openForm}
              setOpenForm={setOpenForm}
              onEditTime={onEditTime}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ period, busy, openForm, setOpenForm, onEditTime }) {
  const elapsed = (period.dutyOffAt || 0) - (period.dutyOnAt || 0);
  const editOn = openForm === `edit:${period.id}:dutyOnAt`;
  const editOff = openForm === `edit:${period.id}:dutyOffAt`;
  const editing = editOn || editOff;
  return (
    <div className="px-3 py-2">
      <div className="grid items-baseline gap-2 text-xs"
        style={{ gridTemplateColumns: '1fr 1fr 90px 80px' }}>
        <div className="text-slate-300 tabular-nums" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtTime(period.dutyOnAt)}
        </div>
        <div className="text-slate-400 tabular-nums" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtTime(period.dutyOffAt)}
        </div>
        <div className={`text-right tabular-nums ${period.over14 ? 'text-red-400' : 'text-slate-300'}`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtElapsed(elapsed)}
        </div>
        <div className="text-right">
          {!editing && (
            <button
              onClick={() => setOpenForm(`edit:${period.id}:dutyOnAt`)}
              className="text-[10px] text-slate-500 hover:text-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              EDIT
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DUTY-ON</div>
            <InlineTimeEditor
              label=""
              initialMs={period.dutyOnAt}
              busy={busy}
              onCancel={() => setOpenForm(null)}
              onSave={(ms) => onEditTime(period.id, 'dutyOnAt', ms)}
            />
          </div>
          <div>
            <div className="text-[10px] text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DUTY-OFF</div>
            <InlineTimeEditor
              label=""
              initialMs={period.dutyOffAt}
              busy={busy}
              onCancel={() => setOpenForm(null)}
              onSave={(ms) => onEditTime(period.id, 'dutyOffAt', ms)}
            />
          </div>
        </div>
      )}
      {period.over14 && period.over14ReasonPic && (
        <div className="mt-1 text-[10px] text-amber-300/80 italic">
          {period.over14ReasonPic}
        </div>
      )}
    </div>
  );
}
