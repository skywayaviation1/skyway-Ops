// src/CrewBoardV2.jsx
//
// =====================================================================
// OPS CREW BOARD — Live duty status across all pilots
// =====================================================================
//
// Single section for the ops/admin dashboard. Shows every pilot grouped by
// their current state:
//   - ON DUTY (with elapsed time, color-coded for limit)
//   - RESTING (within 10h of last duty-off)
//   - AVAILABLE (clean rest window completed)
//   - ILLEGAL (legality engine returns 'illegal')
//   - APPROACHING LIMIT (legality engine returns 'warning')
//
// Pulls recent periods (30 days) for ALL pilots. Group by pilot, evaluate
// legality, render. Re-evaluates every 60s.

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock, CheckCircle2, Shield, Users, Download } from 'lucide-react';
import { subscribeRecentForAllPilots, subscribePeriodsForPilot, fetchOutsideFlyingForPilot } from './firebase-duty-v2.js';
import { evaluateCurrent, evaluateProposed } from './duty-legality.js';
import { DutyExportModal } from './DutyExport.jsx';

const MS_HR = 3600 * 1000;

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function CrewBoardV2() {
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  // Export modal state — opens via the EXPORT button in the header.
  // The modal owns its own pilot-picker / date-range / format state;
  // we just toggle visibility here.
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    const unsub = subscribeRecentForAllPilots(30, (list) => {
      setPeriods(list);
      setLoading(false);
    });
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => { unsub(); clearInterval(t); };
  }, []);

  // Group periods by pilot
  const byPilot = useMemo(() => {
    const m = new Map();
    for (const p of periods) {
      if (!p.pilotUid) continue;
      if (!m.has(p.pilotUid)) {
        m.set(p.pilotUid, { uid: p.pilotUid, name: p.pilotName || '(unknown)', periods: [] });
      }
      m.get(p.pilotUid).periods.push(p);
    }
    return Array.from(m.values());
  }, [periods]);

  // For each pilot, derive current state + legality
  const rows = useMemo(() => {
    return byPilot.map(pilot => {
      const sorted = [...pilot.periods].sort((a, b) => (b.dutyOnAt || 0) - (a.dutyOnAt || 0));
      const active = sorted.find(p => p.status === 'on') || null;
      // Note: outside flying not available here — would require a separate
      // subscription per pilot. For now, legality computed without outside.
      const legality = evaluateCurrent(pilot.periods, [], now,
        active?.crewType || 'two');
      // Derive simple state label
      let state = 'AVAILABLE';
      if (active) {
        state = 'ON DUTY';
      } else {
        const lastClosed = sorted.find(p => p.status === 'off');
        if (lastClosed?.dutyOffAt) {
          const sinceOff = now - lastClosed.dutyOffAt;
          if (sinceOff < 10 * MS_HR) state = 'RESTING';
        }
      }
      return { ...pilot, sorted, active, legality, state };
    });
  }, [byPilot, now]);

  // Sort: illegal first, then warning, then on-duty, then resting, then available
  const sortedRows = useMemo(() => {
    const order = (r) => {
      if (r.legality.status === 'illegal') return 0;
      if (r.legality.status === 'warning') return 1;
      if (r.state === 'ON DUTY') return 2;
      if (r.state === 'RESTING') return 3;
      return 4;
    };
    return [...rows].sort((a, b) => {
      const oa = order(a), ob = order(b);
      if (oa !== ob) return oa - ob;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [rows]);

  if (loading) {
    return (
      <div className="border border-slate-800 bg-slate-900/30 p-3">
        <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          CREW · LOADING…
        </div>
      </div>
    );
  }

  const stats = {
    onDuty: rows.filter(r => r.state === 'ON DUTY').length,
    resting: rows.filter(r => r.state === 'RESTING').length,
    available: rows.filter(r => r.state === 'AVAILABLE').length,
    illegal: rows.filter(r => r.legality.status === 'illegal').length,
    warning: rows.filter(r => r.legality.status === 'warning').length,
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs tracking-[0.2em] text-slate-300"
          style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
          CREW · DUTY STATUS
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {stats.onDuty} on duty · {stats.resting} resting · {stats.available} available
            {stats.illegal > 0 && <span className="text-red-400"> · {stats.illegal} illegal</span>}
            {stats.warning > 0 && <span className="text-amber-400"> · {stats.warning} warning</span>}
          </span>
          {/* Export button — opens a modal where ops/admin picks a pilot
              and date range, then downloads CSV or opens print preview
              for PDF. The crew board already has the pilot list in
              `rows` so we pass it through. */}
          <button
            onClick={() => setExportOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] tracking-widest text-slate-400 hover:text-cyan-300 border border-slate-700 hover:border-cyan-400"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title="Export pilot duty records (CSV or PDF)"
          >
            <Download className="w-3 h-3" />
            EXPORT
          </button>
        </div>
      </div>

      <div className="border border-slate-800 bg-slate-900/30 divide-y divide-slate-800">
        <div className="grid items-center gap-3 px-3 py-2 text-[10px] tracking-widest text-slate-500"
          style={{ fontFamily: 'JetBrains Mono, monospace', gridTemplateColumns: '1fr 100px 100px 1fr 120px' }}>
          <div>PILOT</div>
          <div>STATE</div>
          <div>ELAPSED</div>
          <div>CONTEXT</div>
          <div className="text-right">LEGALITY</div>
        </div>
        {sortedRows.map(row => (
          <CrewRow key={row.uid} row={row} now={now} />
        ))}
        {sortedRows.length === 0 && (
          <div className="px-3 py-4 text-[10px] text-slate-600 text-center">No crew data in past 30 days.</div>
        )}
      </div>

      {/* Export modal — renders nothing when closed, full-screen overlay when open */}
      <DutyExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        pilots={rows.map(r => ({ uid: r.uid, name: r.name }))}
      />
    </div>
  );
}

function CrewRow({ row, now }) {
  const { name, active, sorted, state, legality } = row;
  const elapsed = active?.dutyOnAt ? now - active.dutyOnAt : 0;
  const elapsedHrs = elapsed / MS_HR;
  let elapsedTone = 'text-slate-300';
  let pulse = false;
  if (active) {
    if (elapsedHrs >= 14) { elapsedTone = 'text-red-500'; pulse = true; }
    else if (elapsedHrs >= 12) { elapsedTone = 'text-red-400'; pulse = true; }
    else if (elapsedHrs >= 10) { elapsedTone = 'text-amber-400'; }
    else { elapsedTone = 'text-emerald-400'; }
  }
  const stateTone = {
    'ON DUTY':  'text-emerald-400',
    'RESTING':  'text-violet-300',
    'AVAILABLE':'text-slate-400',
  }[state] || 'text-slate-300';
  const legalityTone = legality.status === 'illegal'
    ? 'text-red-400'
    : legality.status === 'warning'
      ? 'text-amber-400'
      : 'text-emerald-400';

  const lastClosed = sorted.find(p => p.status === 'off');
  const restRemainingMs = (state === 'RESTING' && lastClosed?.dutyOffAt)
    ? (lastClosed.dutyOffAt + 10 * MS_HR) - now
    : null;

  return (
    <div className="grid items-center gap-3 px-3 py-2"
      style={{ gridTemplateColumns: '1fr 100px 100px 1fr 120px' }}>
      <div className="text-sm text-slate-200 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        {name}
      </div>
      <div className={`text-[11px] tracking-widest ${stateTone}`}
        style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
        {pulse && <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-pulse mr-1"></span>}
        {state}
      </div>
      <div className={`text-sm tabular-nums ${elapsedTone}`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {active ? fmtElapsed(elapsed) : (restRemainingMs > 0 ? `${fmtElapsed(restRemainingMs)} rest` : '—')}
      </div>
      <div className="text-[11px] text-slate-500 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {active
          ? [
              active.tail && `Tail ${active.tail}`,
              active.tripId && `Trip ${active.tripId}`,
              active.location && `@ ${active.location}`,
              active.role,
            ].filter(Boolean).join(' · ')
          : lastClosed
            ? `Last off ${fmtTime(lastClosed.dutyOffAt)}`
            : '—'}
      </div>
      <div className={`text-right text-[10px] tracking-widest ${legalityTone}`}
        style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
        {legality.status === 'illegal'
          ? 'ILLEGAL'
          : legality.status === 'warning'
            ? `WARN (${legality.warnings.length})`
            : 'LEGAL'}
      </div>
    </div>
  );
}

// =====================================================================
// DISPATCH PRE-RELEASE LEGALITY CHECK
// =====================================================================
// Mountable component for the trip-release flow. Takes a candidate
// assignment + pilot UID, fetches periods, evaluates, renders go/no-go.
// Used at the moment dispatch is about to release a trip.

export function DispatchLegalityCheck({ pilotUid, pilotName, proposed, onResult }) {
  const [periods, setPeriods] = useState([]);
  const [outside, setOutside] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!pilotUid) { setLoading(false); return; }
    const unsub = subscribePeriodsForPilot(pilotUid, (list) => {
      setPeriods(list);
      setLoading(false);
    });
    fetchOutsideFlyingForPilot(pilotUid).then(setOutside);
    return () => unsub();
  }, [pilotUid]);

  const result = useMemo(() => {
    if (!proposed) return null;
    return evaluateProposed(periods, outside, proposed, Date.now());
  }, [periods, outside, proposed]);

  useEffect(() => {
    if (result && onResult) onResult(result);
  }, [result, onResult]);

  if (loading) {
    return (
      <div className="border border-slate-800 bg-slate-900/30 p-3">
        <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          LEGALITY · LOADING…
        </div>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="text-[10px] text-slate-500 p-3">No assignment proposed.</div>
    );
  }

  const tone = result.status === 'illegal'
    ? { border: 'border-red-500/60', bg: 'bg-red-500/10', text: 'text-red-300', tag: 'text-red-500' }
    : result.status === 'warning'
      ? { border: 'border-amber-500/50', bg: 'bg-amber-500/10', text: 'text-amber-300', tag: 'text-amber-400' }
      : { border: 'border-emerald-500/30', bg: 'bg-emerald-500/5', text: 'text-emerald-200', tag: 'text-emerald-400' };

  return (
    <div className={`border ${tone.border} ${tone.bg} p-3`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Shield className={`w-4 h-4 ${tone.tag}`} />
          <span className="text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            DISPATCH LEGALITY · {pilotName || pilotUid}
          </span>
        </div>
        <span className={`text-xs tracking-widest ${tone.tag}`}
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
          {result.summary}
        </span>
      </div>
      <div className="space-y-1">
        {result.checks.filter(c => c.severity !== 'info').map((c, i) => (
          <div key={i} className={`text-[11px] flex items-start gap-1.5 ${tone.text}`}>
            <AlertTriangle className={`w-3 h-3 mt-0.5 shrink-0 ${c.severity === 'block' ? 'text-red-500' : 'text-amber-400'}`} />
            <span>{c.message}</span>
          </div>
        ))}
        {result.checks.filter(c => c.severity === 'info').map((c, i) => (
          <div key={`i${i}`} className="text-[10px] text-slate-500">{c.message}</div>
        ))}
      </div>
      {result.status === 'illegal' && (
        <div className="mt-3 pt-2 border-t border-red-500/30 text-[10px] text-red-300">
          BLOCKING — dispatch only with CP/DO override. Request override on the pilot's duty record after starting duty.
        </div>
      )}
    </div>
  );
}

// =====================================================================
// CrewPairLegalityCheck — pre-dispatch gate for a TWO-PILOT assignment.
// =====================================================================
//
// Wraps two DispatchLegalityCheck calls (PIC + SIC) and computes the
// aggregate go/no-go. The pair is:
//   LEGAL    only when BOTH pilots are legal
//   WARNING  when neither is illegal but at least one is warning
//   ILLEGAL  when EITHER pilot is illegal
//
// Designed to be mounted inline at the moment a dispatcher releases a
// trip with a paired crew. Calls `onResult` whenever the combined
// status changes — caller uses this to enable/disable the RELEASE
// button and to capture an override reason if blocking.
//
// Single-pilot trips should use DispatchLegalityCheck directly; this
// component is specifically for crew-paired (two-pilot) releases.

export function CrewPairLegalityCheck({ pic, sic, proposed, onResult }) {
  const [picResult, setPicResult] = useState(null);
  const [sicResult, setSicResult] = useState(null);

  // Aggregate the two results. Worst status wins. If a pilot's check
  // hasn't returned yet (null), we treat the overall as "pending" so
  // the caller can disable the dispatch button without false GO.
  const aggregate = useMemo(() => {
    if (!picResult || !sicResult) return null;
    const statuses = [picResult.status, sicResult.status];
    let status = 'legal';
    if (statuses.includes('illegal')) status = 'illegal';
    else if (statuses.includes('warning')) status = 'warning';
    const blockers = [
      ...(picResult.blockers || []).map(b => ({ ...b, who: 'PIC', pilot: pic?.pilotName })),
      ...(sicResult.blockers || []).map(b => ({ ...b, who: 'SIC', pilot: sic?.pilotName })),
    ];
    const warnings = [
      ...(picResult.warnings || []).map(w => ({ ...w, who: 'PIC', pilot: pic?.pilotName })),
      ...(sicResult.warnings || []).map(w => ({ ...w, who: 'SIC', pilot: sic?.pilotName })),
    ];
    return { status, blockers, warnings, picResult, sicResult };
  }, [picResult, sicResult, pic, sic]);

  // Propagate to caller.
  useEffect(() => {
    if (aggregate && onResult) onResult(aggregate);
  }, [aggregate, onResult]);

  // We always evaluate as crewType='two' for paired dispatches — even
  // if the per-pilot record was historically single-pilot.
  const proposedTwoPilot = useMemo(() => proposed
    ? { ...proposed, crewType: 'two' }
    : null, [proposed]);

  const tone = !aggregate
    ? { border: 'border-slate-700', bg: 'bg-slate-900/40', text: 'text-slate-400', tag: 'text-slate-500' }
    : aggregate.status === 'illegal'
      ? { border: 'border-red-500/60', bg: 'bg-red-500/10', text: 'text-red-300', tag: 'text-red-500' }
      : aggregate.status === 'warning'
        ? { border: 'border-amber-500/50', bg: 'bg-amber-500/10', text: 'text-amber-300', tag: 'text-amber-400' }
        : { border: 'border-emerald-500/30', bg: 'bg-emerald-500/5', text: 'text-emerald-200', tag: 'text-emerald-400' };

  return (
    <div className={`border ${tone.border} ${tone.bg} p-3 space-y-3`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className={`w-4 h-4 ${tone.tag}`} />
          <span className="text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            CREW PAIR LEGALITY
          </span>
        </div>
        {aggregate && (
          <span className={`text-xs tracking-widest ${tone.tag}`}
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            {aggregate.status.toUpperCase()}
          </span>
        )}
      </div>

      {/* Per-pilot results stacked. Each is its own DispatchLegalityCheck
          so the pair component composes the existing single-pilot check
          rather than reimplementing it. */}
      <DispatchLegalityCheck
        pilotUid={pic?.pilotUid}
        pilotName={pic?.pilotName || 'PIC'}
        proposed={proposedTwoPilot}
        onResult={setPicResult}
      />
      <DispatchLegalityCheck
        pilotUid={sic?.pilotUid}
        pilotName={sic?.pilotName || 'SIC'}
        proposed={proposedTwoPilot}
        onResult={setSicResult}
      />

      {aggregate?.status === 'illegal' && (
        <div className="pt-2 border-t border-red-500/30 text-[10px] text-red-300">
          BLOCKING — at least one crewmember is illegal for this assignment.
          Dispatch only with CP/DO override on the affected pilot's duty record.
        </div>
      )}
    </div>
  );
}

