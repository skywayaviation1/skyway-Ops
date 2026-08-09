// OpsConsole.jsx — at-a-glance view of every active trip with the data
// dispatchers need to do their job at the start of a shift:
//   - Which trips are coming up in the next 48h
//   - What's missing (trip sheet, broker email, parsed pax, dispatchers)
//   - Where each trip is on its status checklist
//   - One-click "send update to crew" push when ops makes a change
//
// Render rules:
//   - Trip is "active" if start within 48h, not completed, not archived
//   - Repo legs hide PAX-related outstanding items (they don't apply)
//   - Outstanding items only show as warnings, not blockers — the trip
//     can still run, ops just sees the gap and fills it

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock, Search, ShieldAlert,
  Users, UserCheck, Send, Loader2, X, ExternalLink,
} from 'lucide-react';
import { statusEventAt } from './trip-status.js';
import {
  OPS_STATUS_STEPS,
  buildActiveOpsTrips,
  computeOutstanding,
  readinessLevel,
} from './ops-readiness.js';

export { computeOutstanding } from './ops-readiness.js';

// Inject the pulse keyframes once. Inline <style> rather than a CSS
// import so this code-split chunk is self-contained — no separate CSS
// file to worry about loading order on first ops-console open.
const OPS_PULSE_STYLE = `
@keyframes opsPulse {
  0%, 100% { transform: scale(1);   opacity: 1; }
  50%      { transform: scale(1.25); opacity: 0.7; }
}
`;
function StyleInjector() {
  useEffect(() => {
    const id = 'ops-console-pulse-style';
    if (document.getElementById(id)) return; // already injected
    const el = document.createElement('style');
    el.id = id;
    el.textContent = OPS_PULSE_STYLE;
    document.head.appendChild(el);
  }, []);
  return null;
}

// ------------- helpers ----------------------------------------------------

function fmtTime(d) {
  if (!d) return '--';
  try {
    return new Date(d).toLocaleString('en-US', {
      weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    });
  } catch { return '--'; }
}

function hoursUntil(d) {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / (3600 * 1000);
}

// Status steps — kept in sync with the STATUS tab list in App.jsx (the
// `STATUS_STEPS` array there). Step IDs MUST match exactly; the truthy
// check is on `statuses[id]` as a whole, not `.completedAt`, because the
// stored shape is { at, by, gps } and the presence of the entry IS the
// completion signal.
// ------------- status strip -----------------------------------------------

function StatusStrip({ trip, statuses, hasCatering = true }) {
  const isRevenue = trip?.info?.legType === 'REVENUE';
  const visible = OPS_STATUS_STEPS.filter((s) => (
    (!s.revenueOnly || isRevenue) && (!s.cateringOnly || hasCatering)
  ));
  const total = visible.length;

  // For each step, capture { id, label, done, at }. Tooltip text built up
  // here once so the render below stays tidy.
  const enriched = visible.map((step) => {
    const entry = statuses && statuses[step.id];
    const done = !!entry;
    let tip = step.label;
    if (done) {
      const at = statusEventAt(entry);
      if (at) {
        try {
          tip += ' · ' + new Date(at).toLocaleString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
          });
        } catch (_) { tip += ' · logged'; }
      } else { tip += ' · logged'; }
    } else { tip += ' · not yet'; }
    return { ...step, done, tip };
  });

  // ------------- POSITIONING MATH (read carefully — it has to be coherent)
  //
  // The bar is divided into `total` equal segments, each segment width
  // is (100/total)%. A "done" segment is one where step.done is true.
  //
  // The progress FILL extends from 0% to the right edge of the rightmost
  // done segment. Importantly: this rewards completed work even if a
  // crew marks a later step before an earlier one (e.g. PAX BOARDED
  // before PAX ARRIVED) — the fill goes to the end of PAX BOARDED's
  // segment, not the end of PAX ARRIVED's.
  //
  // The DOT sits ON the right edge of the rightmost done segment, which
  // is the same point where the fill ends. When nothing's done, dot is
  // at 0%. When everything's done, dot is hidden and we just show the
  // solid emerald bar (no dot needed).
  //
  // Both fill width and dot position derive from the SAME computation
  // (lastDoneIdx) so they can never disagree.

  // Find the index of the rightmost done step. -1 = nothing done.
  let lastDoneIdx = -1;
  for (let i = 0; i < enriched.length; i++) {
    if (enriched[i].done) lastDoneIdx = i;
  }
  // Right edge of segment N (0-indexed) is at ((N + 1) / total) * 100 %
  const fillPct = lastDoneIdx === -1 ? 0 : ((lastDoneIdx + 1) / total) * 100;
  const doneCount = enriched.filter((s) => s.done).length;
  const allDone = doneCount === total && total > 0;

  // "Current" step for label coloring = first non-done step (the one
  // that should be done next). This is independent from the dot/fill
  // position — it just colors the appropriate label cyan.
  const currentIdx = enriched.findIndex((s) => !s.done);

  return (
    <div className="mt-3">
      {/* Progress bar with tick marks and a pulsing current-step dot. */}
      <div className="relative">
        <div className="h-2 bg-slate-800/80 rounded-sm overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              allDone
                ? 'bg-gradient-to-r from-emerald-400 to-emerald-300'
                : 'bg-gradient-to-r from-cyan-500 to-emerald-400'
            }`}
            style={{ width: `${fillPct}%` }}
          />
        </div>
        {/* Tick marks between segments. n-1 ticks for n segments. */}
        {enriched.map((_, i) => (
          i === 0 ? null : (
            <div
              key={i}
              className="absolute top-0 w-px bg-slate-950/70 pointer-events-none"
              style={{ left: `${(i / total) * 100}%`, height: '8px' }}
            />
          )
        ))}
        {/* Pulsing current-step dot — sits AT the edge where the fill
            ends. Same position as fillPct so they always agree. Only
            rendered when not all done (no need for the dot if complete). */}
        {!allDone && (
          <div
            className="absolute -top-1 w-3 h-3 rounded-full bg-cyan-400"
            style={{
              left: `calc(${fillPct}% - 6px)`,
              boxShadow: '0 0 8px rgba(34,211,238,0.85), 0 0 14px rgba(34,211,238,0.4)',
              animation: 'opsPulse 2s ease-in-out infinite',
            }}
            title={currentIdx >= 0 ? enriched[currentIdx].tip : 'In progress'}
          />
        )}
      </div>

      {/* Step labels under the bar. Done = bright emerald, current = cyan,
          future = dim. Labels are tiny mono so they don't overwhelm. */}
      <div className="flex mt-1.5">
        {enriched.map((step, i) => (
          <div
            key={step.id}
            className={`flex-1 text-[8px] tracking-widest text-center cursor-help ${
              step.done
                ? 'text-emerald-400'
                : i === currentIdx
                  ? 'text-cyan-300'
                  : 'text-slate-600'
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title={step.tip}
          >
            {step.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------- send-update modal -----------------------------------------

function SendUpdateModal({ trip, currentUser, onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(null); // null | summary object

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true); setErr('');
    try {
      const { auth } = await import('./firebase.js');
      const currentAuthUser = auth.currentUser;
      if (!currentAuthUser) throw new Error('Not signed in');
      const idToken = await currentAuthUser.getIdToken();
      const senderUid = currentUser.uid || currentUser.id;
      const senderName = currentUser.name || currentUser.displayName || 'Ops';
      // Reuse the trip-status push pipeline — same recipient resolution
      // (PIC + SIC + dispatchers/all-ops), same title format, just with
      // a custom message body. The server treats kind: 'trip-status'
      // and statusLabel as the body line; senderName goes alongside.
      const resp = await fetch('/api/send-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          tripId: trip.uid,
          kind: 'trip-status',
          statusLabel: t,
          tripPicName: trip.info?.pic || '',
          tripSicName: trip.info?.sic || '',
          tripTail: trip.info?.tail || '',
          tripFrom: trip.info?.from || '',
          tripTo: trip.info?.to || '',
          message: { text: '', senderUid, senderName },
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
      setSent(body);
    } catch (e) {
      setErr(e.message || 'Send failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(2,6,23,0.7)' }}>
      <div className="w-full max-w-md bg-slate-950 border border-slate-800 rounded-lg">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-sm tracking-widest text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              SEND UPDATE TO CREW
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {trip.info?.tail} · {trip.info?.from} → {trip.info?.to}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {sent ? (
            <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 p-3 leading-relaxed">
              Push sent. Dispatched to {sent.dispatched} device{sent.dispatched === 1 ? '' : 's'}
              {sent.suppressed > 0 && `, ${sent.suppressed} suppressed (no tokens / quiet hours / muted)`}.
            </div>
          ) : (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder="What changed? e.g. Pickup time moved to 09:30, broker email updated, etc."
                maxLength={200}
                disabled={busy}
                className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400 resize-none"
                style={{ fontFamily: 'DM Sans, sans-serif' }}
              />
              <p className="text-[10px] text-slate-500">
                Goes to PIC, SIC, and assigned dispatchers (or all ops if none assigned). Title shows the trip; this text appears as the body.
              </p>
            </>
          )}
          {err && <div className="text-xs text-red-400">{err}</div>}
        </div>
        <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-end gap-2">
          {sent ? (
            <button onClick={onClose} className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs tracking-widest font-medium" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DONE
            </button>
          ) : (
            <>
              <button onClick={onClose} disabled={busy} className="px-3 py-2 border border-slate-700 text-slate-300 text-xs tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                CANCEL
              </button>
              <button
                onClick={send}
                disabled={busy || !text.trim()}
                className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs tracking-widest font-medium flex items-center gap-1.5"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                SEND PUSH
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------- trip card --------------------------------------------------

function TripCard({
  trip,
  state,
  currentUser,
  users,
  onOpenTrip,
  onSendUpdate,
  onControl,
  controlBusy,
}) {
  const outstanding = computeOutstanding(trip, state);
  const critical = outstanding.filter((o) => o.severity === 'critical');
  const warns = outstanding.filter((o) => o.severity === 'warn');
  const infos = outstanding.filter((o) => o.severity === 'info');
  const hrs = hoursUntil(trip.start);
  const hrsLabel = hrs == null ? '' : hrs < 0 ? 'IN PROGRESS' : hrs < 1 ? '< 1h' : `${Math.floor(hrs)}h`;
  const isInProgress = hrs != null && hrs < 0;
  const completed = state?.completed;
  const disposition = state?.opsDisposition || 'monitoring';
  const assigned = Array.isArray(state?.dispatcherUids) ? state.dispatcherUids : [];
  const myUid = currentUser?.uid || currentUser?.id;
  const claimedByMe = assigned.includes(myUid);
  const assignedNames = assigned
    .map((uid) => users?.find((user) => (user.uid || user.id) === uid)?.name)
    .filter(Boolean);
  const readiness = readinessLevel(outstanding);

  return (
    <div
      className={`bg-slate-900 border ${
        disposition === 'hold' || critical.length > 0
          ? 'border-red-500/50'
          : warns.length > 0 ? 'border-amber-500/30' : 'border-slate-800'
      } p-3 hover:border-cyan-500/40 transition-colors`}
    >
      {/* Header row */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <button
            onClick={() => onOpenTrip(trip.uid)}
            className="text-base tracking-wide text-slate-100 hover:text-cyan-300 truncate"
            style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
          >
            {trip.info?.tail || '?'}
          </button>
          <span className="text-xs text-slate-400 tabular-nums" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {trip.info?.from || '?'} → {trip.info?.to || '?'}
          </span>
        </div>
        <span className={`text-[10px] tracking-widest tabular-nums px-1.5 py-0.5 ${
          isInProgress ? 'bg-cyan-500/20 text-cyan-300' :
          hrs != null && hrs < 6 ? 'bg-amber-500/20 text-amber-300' :
          'text-slate-500'
        }`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {hrsLabel}
        </span>
      </div>

      {/* Time + leg type */}
      <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-500">
        <Clock className="w-3 h-3" />
        <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{fmtTime(trip.start)} ET</span>
        <span className="text-slate-600">·</span>
        <span className="tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {trip.info?.legType || '?'}
        </span>
        {trip.info?.pax > 0 && (
          <>
            <span className="text-slate-600">·</span>
            <Users className="w-3 h-3" />
            <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{trip.info.pax}</span>
          </>
        )}
      </div>

      {/* OCC coordination state — explicitly separate from regulatory release. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
          disposition === 'hold'
            ? 'border-red-500/40 bg-red-500/15 text-red-300'
            : disposition === 'ready'
              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
              : 'border-slate-700 bg-slate-800 text-slate-400'
        }`}>
          {disposition === 'hold' && <ShieldAlert className="h-2.5 w-2.5" />}
          {disposition === 'ready' ? 'Ops ready' : disposition}
        </span>
        <span className={`text-[9px] uppercase tracking-wider ${
          readiness === 'critical' ? 'text-red-300'
            : readiness === 'warning' ? 'text-amber-300'
              : readiness === 'ready' ? 'text-emerald-300' : 'text-slate-400'
        }`}>
          {readiness === 'ready' ? 'Checklist clean' : `${critical.length + warns.length} action item${critical.length + warns.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* Crew */}
      {(trip.info?.pic || trip.info?.sic) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px]">
          {trip.info?.pic && (
            <span className="flex items-center gap-1">
              <span className="text-slate-500 tracking-widest text-[9px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PIC</span>
              <span className="text-slate-300">{trip.info.pic}</span>
            </span>
          )}
          {trip.info?.sic && (
            <span className="flex items-center gap-1">
              <span className="text-slate-500 tracking-widest text-[9px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>SIC</span>
              <span className="text-slate-300">{trip.info.sic}</span>
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-500">
        <UserCheck className="h-3 w-3" />
        {assigned.length === 0
          ? 'Unassigned controller'
          : assignedNames.length ? assignedNames.join(', ') : `${assigned.length} controller${assigned.length === 1 ? '' : 's'} assigned`}
      </div>

      {/* Status strip */}
      <StatusStrip trip={trip} statuses={state?.statuses} hasCatering={state?.hasCatering !== false} />

      {/* Outstanding items */}
      {(critical.length > 0 || warns.length > 0 || infos.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {critical.map((item) => (
            <span key={item.code} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-red-500/15 border border-red-500/30 text-red-300 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <AlertTriangle className="w-2.5 h-2.5" />
              {item.label}
            </span>
          ))}
          {warns.map((w) => (
            <span key={w.code} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <AlertTriangle className="w-2.5 h-2.5" />
              {w.label}
            </span>
          ))}
          {infos.map((i) => (
            <span key={i.code} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-800 border border-slate-700 text-slate-400 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {i.label}
            </span>
          ))}
        </div>
      )}

      {state?.opsLatestNote && (
        <div className="mt-2 rounded border border-slate-700 bg-slate-950/60 px-2 py-1.5">
          <p className="line-clamp-2 text-[10px] leading-relaxed text-slate-400">{state.opsLatestNote}</p>
          <p className="mt-1 text-[9px] text-slate-600">{state.opsLatestNoteByName || 'Operations'}</p>
        </div>
      )}

      {/* Completed badge */}
      {completed && (
        <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <CheckCircle2 className="w-2.5 h-2.5" /> COMPLETE
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 border-t border-slate-800 pt-2">
        <div className="mb-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={controlBusy}
            onClick={() => onControl(trip, claimedByMe ? 'unclaim' : 'claim')}
            className="rounded border border-slate-700 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-slate-300 hover:border-cyan-500/40 hover:text-cyan-300 disabled:opacity-50"
          >
            {claimedByMe ? 'Unclaim' : 'Claim'}
          </button>
          <button
            type="button"
            disabled={controlBusy}
            onClick={() => onControl(trip, 'set-disposition', { disposition: 'ready' })}
            className="rounded border border-emerald-500/30 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
          >
            Ops ready
          </button>
          <button
            type="button"
            disabled={controlBusy}
            onClick={() => onControl(trip, 'set-disposition', { disposition: 'hold' })}
            className="rounded border border-red-500/30 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-red-300 hover:bg-red-500/10 disabled:opacity-50"
          >
            Hold
          </button>
          <button
            type="button"
            disabled={controlBusy}
            onClick={() => onControl(trip, 'add-trip-note')}
            className="rounded border border-slate-700 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-slate-300 hover:border-slate-500 disabled:opacity-50"
          >
            Note
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => onOpenTrip(trip.uid)}
          className="text-[10px] tracking-widest text-slate-400 hover:text-cyan-300 flex items-center gap-1"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          OPEN TRIP <ExternalLink className="w-2.5 h-2.5" />
        </button>
        <button
          onClick={() => onSendUpdate(trip)}
          className="text-[10px] tracking-widest bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 px-2 py-1 flex items-center gap-1"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          <Send className="w-2.5 h-2.5" /> SEND UPDATE
        </button>
        </div>
      </div>
    </div>
  );
}

// ------------- main console -----------------------------------------------

/**
 * OpsConsole — props:
 *   currentUser   ({uid, role, name})
 *   allTrips      Array of trip objects from the schedule (iCal + manual)
 *   onOpenTrip    (tripUid) -> void — caller-supplied navigation
 */
function OpsConsole({ currentUser, allTrips, users = [], onOpenTrip }) {
  const [stateMap, setStateMap] = useState(new Map());
  const [loaded, setLoaded] = useState(false);
  const [sendingTo, setSendingTo] = useState(null); // trip object or null
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [controlBusy, setControlBusy] = useState(null);
  const [controlMessage, setControlMessage] = useState(null);

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      const m = await import('./firebase-data.js');
      unsub = m.subscribeAllTripStates((map) => {
        setStateMap(map);
        setLoaded(true);
      });
    })();
    return () => { try { unsub(); } catch (_) {} };
  }, []);

  const active = useMemo(
    () => buildActiveOpsTrips(allTrips, stateMap),
    [allTrips, stateMap],
  );

  // Apply current filter.
  const visible = useMemo(() => {
    let filtered = active;
    if (filter === 'flags') {
      filtered = active.filter((t) => {
        const out = computeOutstanding(t, stateMap.get(t.uid));
        return out.some((o) => o.severity === 'critical' || o.severity === 'warn');
      });
    } else if (filter === 'inprogress') {
      filtered = active.filter((t) => {
        const ts = t.start instanceof Date ? t.start.getTime() : new Date(t.start).getTime();
        return ts < Date.now();
      });
    } else if (filter === 'hold') {
      filtered = active.filter((t) => stateMap.get(t.uid)?.opsDisposition === 'hold');
    } else if (filter === 'unassigned') {
      filtered = active.filter((t) => !(stateMap.get(t.uid)?.dispatcherUids?.length));
    }
    const needle = query.trim().toLowerCase();
    if (!needle) return filtered;
    return filtered.filter((trip) => [
      trip.info?.tail,
      trip.info?.from,
      trip.info?.to,
      trip.info?.pic,
      trip.info?.sic,
      trip.info?.customer,
      trip.info?.broker,
    ].some((value) => String(value || '').toLowerCase().includes(needle)));
  }, [active, filter, query, stateMap]);

  // Summary counts for the header.
  const counts = useMemo(() => {
    let withFlags = 0, inProgress = 0, holds = 0, ready = 0, unassigned = 0;
    const now = Date.now();
    active.forEach((t) => {
      const out = computeOutstanding(t, stateMap.get(t.uid));
      if (out.some((o) => o.severity === 'critical' || o.severity === 'warn')) withFlags++;
      const ts = t.start instanceof Date ? t.start.getTime() : new Date(t.start).getTime();
      if (ts < now) inProgress++;
      const state = stateMap.get(t.uid);
      if (state?.opsDisposition === 'hold') holds++;
      if (state?.opsDisposition === 'ready') ready++;
      if (!state?.dispatcherUids?.length) unassigned++;
    });
    return { total: active.length, withFlags, inProgress, holds, ready, unassigned };
  }, [active, stateMap]);

  const runControl = async (trip, action, extra = {}) => {
    const key = `${trip.uid}-${action}`;
    setControlBusy(key);
    setControlMessage(null);
    try {
      const payload = { ...extra };
      if (action === 'set-disposition' && extra.disposition === 'hold') {
        const reason = window.prompt('Reason for operational hold (required):', stateMap.get(trip.uid)?.opsDispositionReason || '');
        if (reason == null) return;
        if (!reason.trim()) throw new Error('A hold reason is required');
        payload.reason = reason.trim();
      }
      if (action === 'add-trip-note') {
        const note = window.prompt('Add an OCC note for this trip:', '');
        if (note == null) return;
        if (!note.trim()) throw new Error('A note is required');
        payload.note = note.trim();
      }
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error('Your operations session expired');
      const response = await fetch('/api/ops-control-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ idToken, action, tripId: trip.uid, ...payload }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Control action failed');
      setControlMessage({ tone: 'success', text: `${trip.info?.tail || 'Trip'} updated.` });
    } catch (error) {
      setControlMessage({ tone: 'danger', text: error.message || 'Control action failed' });
    } finally {
      setControlBusy(null);
    }
  };

  if (!['ops', 'admin'].includes(currentUser?.role)) {
    return (
      <div className="p-6 max-w-md mx-auto">
        <div className="bg-slate-900 border border-slate-800 p-4 text-center">
          <p className="text-sm text-slate-400">Ops Console is restricted to ops and admin users.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-screen-2xl mx-auto">
      <StyleInjector />
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-lg tracking-widest text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            OPS CONSOLE
          </h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Rolling 48-hour flight-control board · coordination status is not a regulatory release
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <span className="text-slate-400">
            <span className="text-cyan-300 text-base tabular-nums">{counts.total}</span> TOTAL
          </span>
          <span className="text-slate-400">
            <span className="text-cyan-300 text-base tabular-nums">{counts.inProgress}</span> ACTIVE
          </span>
          <span className="text-slate-400">
            <span className="text-amber-300 text-base tabular-nums">{counts.withFlags}</span> FLAGS
          </span>
          <span className="text-slate-400">
            <span className="text-red-300 text-base tabular-nums">{counts.holds}</span> HOLD
          </span>
          <span className="text-slate-400">
            <span className="text-emerald-300 text-base tabular-nums">{counts.ready}</span> READY
          </span>
        </div>
      </div>

      {controlMessage && (
        <div className={`mb-3 rounded border px-3 py-2 text-xs ${
          controlMessage.tone === 'success'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : 'border-red-500/30 bg-red-500/10 text-red-300'
        }`}>
          {controlMessage.text}
        </div>
      )}

      {/* Controller filters and fast search */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2">
          {[
            { id: 'all', label: 'ALL', count: counts.total },
            { id: 'flags', label: 'WITH FLAGS', count: counts.withFlags },
            { id: 'inprogress', label: 'IN PROGRESS', count: counts.inProgress },
            { id: 'hold', label: 'ON HOLD', count: counts.holds },
            { id: 'unassigned', label: 'UNASSIGNED', count: counts.unassigned },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 text-[11px] tracking-widest border ${
                filter === f.id
                  ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
              }`}
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {f.label} <span className="ml-1 opacity-70">{f.count}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto min-w-[14rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Tail, route, crew, customer…"
            className="w-full border border-slate-800 bg-slate-900 py-1.5 pl-8 pr-3 text-xs text-slate-200 outline-none focus:border-cyan-500/50"
          />
        </label>
      </div>

      {!loaded ? (
        <div className="flex items-center justify-center py-16 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading trip states...
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 p-8 text-center">
          <p className="text-sm text-slate-500">
            {filter === 'all'
              ? 'No active trips in the rolling 48-hour window.'
              : filter === 'flags'
                ? 'No trips with outstanding items. Nice.'
                : 'No trips currently in progress.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {visible.map((trip) => (
            <TripCard
              key={trip.uid}
              trip={trip}
              state={stateMap.get(trip.uid)}
              currentUser={currentUser}
              users={users}
              onOpenTrip={onOpenTrip}
              onSendUpdate={(t) => setSendingTo(t)}
              onControl={runControl}
              controlBusy={Boolean(controlBusy?.startsWith(`${trip.uid}-`))}
            />
          ))}
        </div>
      )}

      {sendingTo && (
        <SendUpdateModal
          trip={sendingTo}
          currentUser={currentUser}
          onClose={() => setSendingTo(null)}
        />
      )}
    </div>
  );
}

export default OpsConsole;
