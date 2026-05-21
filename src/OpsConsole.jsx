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
  AlertTriangle, CheckCircle2, Clock, FileText, Mail,
  Users, MessageSquare, Send, Loader2, X, ExternalLink,
} from 'lucide-react';

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

// Status steps — kept in sync with the STATUS tab list. If you add/rename
// a step in App.jsx, mirror it here so the strip stays accurate.
const STATUS_STEPS = [
  { id: 'crew_onsite',   label: 'CREW' },
  { id: 'aircraft_ready', label: 'A/C' },
  { id: 'pax_arrived',   label: 'PAX IN', revenueOnly: true },
  { id: 'pax_boarded',   label: 'PAX BRD', revenueOnly: true },
  { id: 'block_out',     label: 'BLOCK OUT' },
  { id: 'block_in',      label: 'BLOCK IN' },
  { id: 'trip_complete', label: 'DONE' },
];

// ------------- outstanding-items detector ---------------------------------

/**
 * Compute the list of missing/outstanding items for a trip. Returns an
 * array of { code, label, severity } where severity is 'warn' (something
 * to flag) or 'info' (worth noting but not urgent). Pure function — easy
 * to test, no React/Firestore dependencies.
 */
export function computeOutstanding(trip, state) {
  const out = [];
  if (!trip || !trip.info) return out;
  const info = trip.info;
  const isRevenue = info.legType === 'REVENUE';
  const s = state || {};

  // Trip sheet: applies to ALL trips
  if (!s.tripSheetUrl) {
    out.push({ code: 'no-sheet', label: 'No trip sheet', severity: 'warn' });
  }

  // Broker email: revenue only
  if (isRevenue) {
    const email = (s.brokerEmail || info.broker || '').trim();
    if (!email) {
      out.push({ code: 'no-broker', label: 'No broker email', severity: 'warn' });
    }
  }

  // Pax parsed: revenue only. Pax considered "parsed" if either
  // state.passengers has entries, OR there's a paxOverride number > 0
  // (manual entry), OR info.pax = 0 (no pax expected on this leg).
  if (isRevenue) {
    const paxCount = (info.pax != null ? info.pax : 0);
    const parsedCount = Array.isArray(s.passengers) ? s.passengers.length : 0;
    const overrideCount = typeof s.paxOverride === 'number' ? s.paxOverride : null;
    if (paxCount > 0 && parsedCount === 0 && overrideCount == null) {
      out.push({ code: 'no-pax', label: `${paxCount} pax not parsed`, severity: 'warn' });
    }
  }

  // Dispatchers: any trip without dispatcherUids falls back to all-ops.
  // Flag as info (not warn) since the fallback still works — it's just
  // the operational hygiene we want to encourage.
  if (!Array.isArray(s.dispatcherUids) || s.dispatcherUids.length === 0) {
    out.push({ code: 'no-dispatch', label: 'No dispatcher set', severity: 'info' });
  }

  // PIC/SIC missing — only matters for revenue trips that actually need crew
  if (isRevenue && !info.pic) {
    out.push({ code: 'no-pic', label: 'No PIC', severity: 'warn' });
  }
  if (isRevenue && !info.sic) {
    out.push({ code: 'no-sic', label: 'No SIC', severity: 'info' });
  }

  return out;
}

// ------------- status strip -----------------------------------------------

function StatusStrip({ trip, statuses }) {
  const isRevenue = trip?.info?.legType === 'REVENUE';
  const visible = STATUS_STEPS.filter((s) => !s.revenueOnly || isRevenue);
  return (
    <div className="flex gap-1 mt-2">
      {visible.map((step) => {
        const done = !!(statuses && statuses[step.id]?.completedAt);
        return (
          <div
            key={step.id}
            className={`flex-1 px-1 py-1 text-[9px] tracking-widest text-center border ${
              done
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-900/40 border-slate-800 text-slate-600'
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title={step.label}
          >
            {done ? '✓' : '·'}
          </div>
        );
      })}
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

function TripCard({ trip, state, currentUser, onOpenTrip, onSendUpdate }) {
  const outstanding = computeOutstanding(trip, state);
  const warns = outstanding.filter((o) => o.severity === 'warn');
  const infos = outstanding.filter((o) => o.severity === 'info');
  const hrs = hoursUntil(trip.start);
  const hrsLabel = hrs == null ? '' : hrs < 0 ? 'IN PROGRESS' : hrs < 1 ? '< 1h' : `${Math.floor(hrs)}h`;
  const isInProgress = hrs != null && hrs < 0;
  const completed = state?.completed;

  return (
    <div
      className={`bg-slate-900 border ${
        warns.length > 0 ? 'border-amber-500/30' : 'border-slate-800'
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

      {/* Status strip */}
      <StatusStrip trip={trip} statuses={state?.statuses} />

      {/* Outstanding items */}
      {(warns.length > 0 || infos.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
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

      {/* Completed badge */}
      {completed && (
        <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <CheckCircle2 className="w-2.5 h-2.5" /> COMPLETE
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 pt-2 border-t border-slate-800 flex items-center justify-between gap-2">
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
  );
}

// ------------- main console -----------------------------------------------

/**
 * OpsConsole — props:
 *   currentUser   ({uid, role, name})
 *   allTrips      Array of trip objects from the schedule (iCal + manual)
 *   onOpenTrip    (tripUid) -> void — caller-supplied navigation
 */
function OpsConsole({ currentUser, allTrips, onOpenTrip }) {
  const [stateMap, setStateMap] = useState(new Map());
  const [loaded, setLoaded] = useState(false);
  const [sendingTo, setSendingTo] = useState(null); // trip object or null
  const [filter, setFilter] = useState('all'); // 'all' | 'flags' | 'inprogress'

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

  // Active trips: starts during TODAY (Eastern), OR started earlier and is
  // still in progress (started in the past, not yet completed). This is
  // the "what's flying today, what's about to fly today, plus what's
  // still up from last night" view. Filter out completed/archived.
  const active = useMemo(() => {
    const now = Date.now();
    // Compute the start and end of TODAY in Eastern time, expressed as
    // UTC ms. Use Intl to get today's Y-M-D in ET, then anchor 00:00 ET
    // and 24:00 ET as UTC instants.
    let todayStart = 0, todayEnd = now + 24 * 3600 * 1000;
    try {
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(now));
      const y = Number(etParts.find(p => p.type === 'year').value);
      const mo = Number(etParts.find(p => p.type === 'month').value);
      const d = Number(etParts.find(p => p.type === 'day').value);
      const naive = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
      const etStr = naive.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const utcStr = naive.toLocaleString('en-US', { timeZone: 'UTC' });
      const offset = new Date(etStr).getTime() - new Date(utcStr).getTime();
      todayStart = naive.getTime() - offset;
      todayEnd = todayStart + 24 * 3600 * 1000;
    } catch (_) { /* fall back to wide window */ }

    const candidate = (allTrips || []).filter((t) => {
      const ts = t.start instanceof Date ? t.start.getTime() : new Date(t.start).getTime();
      if (!Number.isFinite(ts)) return false;
      const s = stateMap.get(t.uid);
      if (s?.completed || s?.archived) return false;
      // In-window if:
      //   (a) starts today (Eastern), OR
      //   (b) started in the last 24h and isn't marked complete (the trip
      //       might still be in the air — flights are at most ~10-15h, so
      //       24h covers any plausibly-still-flying case; anything older
      //       is definitely landed even if nobody tapped MARK COMPLETE).
      //
      // Without the 24h cap, every past trip ever flown shows here because
      // most legacy trips were never explicitly marked complete.
      const startsToday = ts >= todayStart && ts < todayEnd;
      const inProgress = ts < now && ts > now - (24 * 60 * 60 * 1000);
      return startsToday || inProgress;
    });
    candidate.sort((a, b) => {
      const ta = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
      const tb = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
      return ta - tb;
    });
    return candidate;
  }, [allTrips, stateMap]);

  // Apply current filter.
  const visible = useMemo(() => {
    if (filter === 'all') return active;
    if (filter === 'flags') {
      return active.filter((t) => {
        const out = computeOutstanding(t, stateMap.get(t.uid));
        return out.some((o) => o.severity === 'warn');
      });
    }
    if (filter === 'inprogress') {
      return active.filter((t) => {
        const ts = t.start instanceof Date ? t.start.getTime() : new Date(t.start).getTime();
        return ts < Date.now();
      });
    }
    return active;
  }, [active, filter, stateMap]);

  // Summary counts for the header.
  const counts = useMemo(() => {
    let withFlags = 0, inProgress = 0;
    const now = Date.now();
    active.forEach((t) => {
      const out = computeOutstanding(t, stateMap.get(t.uid));
      if (out.some((o) => o.severity === 'warn')) withFlags++;
      const ts = t.start instanceof Date ? t.start.getTime() : new Date(t.start).getTime();
      if (ts < now) inProgress++;
    });
    return { total: active.length, withFlags, inProgress };
  }, [active, stateMap]);

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
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-lg tracking-widest text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            OPS CONSOLE
          </h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Today's trips · plus anything still in progress
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
        </div>
      </div>

      {/* Filter buttons */}
      <div className="flex gap-2 mb-4">
        {[
          { id: 'all', label: 'ALL' },
          { id: 'flags', label: 'WITH FLAGS' },
          { id: 'inprogress', label: 'IN PROGRESS' },
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
            {f.label}
          </button>
        ))}
      </div>

      {!loaded ? (
        <div className="flex items-center justify-center py-16 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading trip states...
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 p-8 text-center">
          <p className="text-sm text-slate-500">
            {filter === 'all'
              ? 'No active trips in the next 48 hours.'
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
              onOpenTrip={onOpenTrip}
              onSendUpdate={(t) => setSendingTo(t)}
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
