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
import { AlertTriangle, Clock, CheckCircle2, Shield, Users, Download, Settings } from 'lucide-react';
import { subscribeRecentForAllPilots, subscribePeriodsForPilot, fetchOutsideFlyingForPilot } from './firebase-duty-v2.js';
import { evaluateCurrent, evaluateProposed } from './duty-legality.js';
import { DutyExportModal } from './DutyExport.jsx';
import CrewManagePanel from './CrewManagePanel.jsx';

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

export default function CrewBoardV2({ currentUser, users = [] } = {}) {
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  // Export modal state — opens via the EXPORT button in the header.
  // The modal owns its own pilot-picker / date-range / format state;
  // we just toggle visibility here.
  const [exportOpen, setExportOpen] = useState(false);
  // Which pilot row has the management panel expanded. Single-expand:
  // opening another row collapses the previous. Null = all collapsed.
  const [managePilotUid, setManagePilotUid] = useState(null);

  // Admin and ops users get management controls. During admin
  // impersonation (currentUser._impersonating === true) the original
  // admin retains management ability. Crew users see only the
  // read-only board.
  const role = (currentUser?.role || '').toLowerCase();
  const canManage = role === 'admin' || role === 'ops' || currentUser?._impersonating === true;

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
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            gridTemplateColumns: canManage
              ? '1fr 100px 110px 1fr 120px 60px'
              : '1fr 100px 110px 1fr 120px',
          }}>
          <div>PILOT</div>
          <div>STATE</div>
          <div>ELAPSED</div>
          <div>CONTEXT</div>
          <div className="text-right">LEGALITY</div>
          {canManage && <div className="text-right">ADMIN</div>}
        </div>
        {/* PAIR-AWARE RENDER LOOP
            ------------------------
            For each pilot row (sorted by urgency), check if their active
            duty period has a confirmed partner whose period is ALSO in
            the visible row list. If both periods cross-link via
            partnerPeriodId AND both are status='on' AND at least one is
            confirmed (self- or admin-attested), render them as a single
            CrewPairRow. The `seen` set tracks already-emitted pilots so
            each pair appears only once.

            Resting and Available pilots are NEVER grouped, even if their
            most recent duty was paired — they might pair with a
            different pilot for the next duty day, so showing them
            individually is the operationally correct default.

            Sort position: the pair surfaces at the position of whichever
            pilot sorted first (the more urgent of the two). That
            matches the existing sort intent. */}
        {(() => {
          const seen = new Set();
          const elements = [];
          for (const row of sortedRows) {
            if (seen.has(row.uid)) continue;

            // Pair detection — only fires for active confirmed periods
            // whose partner is also in the visible rows.
            if (row.active?.partnerPeriodId) {
              const partnerRow = sortedRows.find(
                r => r.active?.id === row.active.partnerPeriodId
              );
              if (
                partnerRow &&
                partnerRow.uid !== row.uid &&
                partnerRow.active?.partnerPeriodId === row.active.id
              ) {
                const validStatuses = new Set(['self-attested', 'admin-attested']);
                const meOk = !row.active.confirmStatus || validStatuses.has(row.active.confirmStatus);
                const partnerOk = !partnerRow.active.confirmStatus
                  || validStatuses.has(partnerRow.active.confirmStatus);
                const partnerPending = partnerRow.active.confirmStatus === 'pending';
                const mePending = row.active.confirmStatus === 'pending';

                if ((meOk && partnerOk) || (meOk && partnerPending) || (mePending && partnerOk)) {
                  // It's a pair. Figure out who's PIC and who's SIC.
                  const isPic = row.active.role === 'PIC';
                  const picRow = isPic ? row : partnerRow;
                  const sicRow = isPic ? partnerRow : row;
                  // Pending flag — true when the SIC hasn't confirmed yet
                  const sicPending = sicRow.active.confirmStatus === 'pending';

                  seen.add(row.uid);
                  seen.add(partnerRow.uid);
                  elements.push(
                    <CrewPairRow
                      key={`pair:${picRow.uid}:${sicRow.uid}`}
                      pic={picRow}
                      sic={sicRow}
                      sicPending={sicPending}
                      now={now}
                      canManage={canManage}
                      currentUser={currentUser}
                      crewUsers={users}
                      expandedUid={managePilotUid}
                      onToggle={(uid) => setManagePilotUid(managePilotUid === uid ? null : uid)}
                      allPeriods={periods}
                    />
                  );
                  continue;
                }
              }
            }

            // Solo row
            seen.add(row.uid);
            elements.push(
              <CrewRow
                key={row.uid}
                row={row}
                now={now}
                canManage={canManage}
                currentUser={currentUser}
                crewUsers={users}
                expanded={managePilotUid === row.uid}
                onToggle={() => setManagePilotUid(managePilotUid === row.uid ? null : row.uid)}
                allPeriods={periods}
              />
            );
          }
          return elements;
        })()}
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

function CrewRow({ row, now, canManage, currentUser, crewUsers, expanded, onToggle, allPeriods }) {
  const { name, active, sorted, state, legality, uid } = row;
  const elapsed = active?.dutyOnAt ? now - active.dutyOnAt : 0;
  const elapsedHrs = elapsed / MS_HR;
  // `pulse` triggers the small animated dot next to the STATE label
  // when a pilot is approaching/exceeding the 14h regular-duty cap.
  // (The stacked elapsed/LEFT display below has its own inline color
  // logic — it no longer relies on a precomputed tone class.)
  const pulse = active && elapsedHrs >= 12;
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
  // For resting pilots, show how long they've been resting + how much
  // legal rest is still required. Mirrors the duty-on bar's
  // elapsed/LEFT pattern.
  const restElapsedMs = (state === 'RESTING' && lastClosed?.dutyOffAt)
    ? now - lastClosed.dutyOffAt
    : null;
  // Solo on-duty: time remaining in the 14h regular-duty budget.
  // (For unscheduled assignments per 135.267(b), this is informational
  // — there's no hard 14h cap. We still show it so the pilot/ops can
  // see duration; the column header itself is just ELAPSED.)
  const dutyRemainingMs = active ? Math.max(0, 14 * MS_HR - elapsed) : null;

  // Find the partner period (if any) — needed by the manage panel.
  // Look up directly in allPeriods rather than per-pilot list because
  // the partner is, by definition, a DIFFERENT pilot's period.
  const partnerPeriod = active?.partnerPeriodId
    ? (allPeriods || []).find(p => p.id === active.partnerPeriodId)
    : null;

  // Grid template — adds a fixed-width MANAGE column on the right for
  // admin/ops viewers. Crew users get the original 5-column layout.
  const gridCols = canManage
    ? '1fr 100px 110px 1fr 120px 60px'
    : '1fr 100px 110px 1fr 120px';

  return (
    <div>
      <div className="grid items-center gap-3 px-3 py-2"
        style={{ gridTemplateColumns: gridCols }}>
        <div className="text-sm text-slate-200 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {name}
        </div>
        <div className={`text-[11px] tracking-widest ${stateTone}`}
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          {pulse && <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-pulse mr-1"></span>}
          {state}
        </div>
        {/* ELAPSED column — stacked display for both active duty and
            rest, so the pilot/ops can see both "where we are" and
            "how much further until the next state change." */}
        <div style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {active ? (
            <>
              <div className={`text-sm tabular-nums leading-tight ${
                elapsedHrs >= 14 ? 'text-red-500 animate-pulse' : 'text-amber-400'
              }`}>
                {fmtElapsed(elapsed)}
              </div>
              {elapsedHrs < 14 ? (
                <div className="text-[10px] tabular-nums text-emerald-400 leading-tight">
                  {fmtElapsed(dutyRemainingMs)} LEFT
                </div>
              ) : (
                <div className="text-[10px] tabular-nums text-red-500 leading-tight animate-pulse">
                  OVER
                </div>
              )}
            </>
          ) : restElapsedMs != null ? (
            <>
              <div className="text-sm tabular-nums text-violet-300 leading-tight">
                {fmtElapsed(restElapsedMs)}
              </div>
              {restRemainingMs > 0 ? (
                <div className="text-[10px] tabular-nums text-emerald-400 leading-tight">
                  {fmtElapsed(restRemainingMs)} LEFT
                </div>
              ) : (
                <div className="text-[10px] tabular-nums text-emerald-400 leading-tight">
                  ✓ REST MET
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-slate-600">—</div>
          )}
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
        {/* Admin manage toggle — only renders when canManage. The button
            is intentionally small/quiet so it doesn't compete with the
            status info; ops/admins expecting it know where to look. */}
        {canManage && (
          <div className="text-right">
            <button
              onClick={onToggle}
              disabled={!active}
              className={`text-[9px] tracking-widest px-1.5 py-1 border ${
                expanded
                  ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                  : 'border-slate-700 text-slate-500 hover:border-cyan-400 hover:text-cyan-300'
              } disabled:opacity-30 disabled:cursor-not-allowed`}
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              title={active ? 'Manage this duty period' : 'No active duty to manage'}
            >
              {expanded ? 'CLOSE' : 'MANAGE'}
            </button>
          </div>
        )}
      </div>

      {/* Expanded admin panel — rendered inline below the row when expanded.
          Crew users never see this (canManage gates the toggle button so
          this branch is unreachable for them). */}
      {canManage && expanded && active && (
        <CrewManagePanel
          period={active}
          partnerPeriod={partnerPeriod}
          currentUser={currentUser}
          crewUsers={crewUsers}
          onClose={onToggle}
        />
      )}
    </div>
  );
}

// =====================================================================
// CREW PAIR ROW — both pilots crewed together on the same duty period
// =====================================================================
//
// When pair-detection in the render loop finds two pilots' periods
// cross-linked via partnerPeriodId AND both active (or one pending),
// they collapse into this single row instead of two solo CrewRows.
//
// Layout matches the solo CrewRow grid exactly, so headers align:
//   PILOT  | STATE  | ELAPSED      | CONTEXT          | LEGALITY | ADMIN
//   PIC: X | ON DUTY| 10h 56m      | Tail N168ZZ      | LEGAL    | MGR PIC
//   SIC: Y |        | 3h 04m LEFT  | Trip GWXLM0 KBCT |          | MGR SIC
//
// Time accounting uses the EARLIER of the two pilots' dutyOnAt — that
// way if their start times differ (one had time edited), we display
// the more conservative (less remaining) value. In practice both
// times match because startDutyPair / addPartnerToActiveDuty inherit
// the timestamp from the PIC's duty.
//
// Legality is worst-of-both: illegal > warning > legal.
//
// Admin column renders TWO stacked MGR buttons (MGR PIC, MGR SIC) so
// ops can drill into either pilot's record. Clicking one expands the
// existing CrewManagePanel below the row.

function CrewPairRow({ pic, sic, sicPending, now, canManage, currentUser, crewUsers, expandedUid, onToggle, allPeriods }) {
  // Use the earlier dutyOnAt for shared elapsed (conservative)
  const dutyOnAt = Math.min(
    pic.active?.dutyOnAt || Number.POSITIVE_INFINITY,
    sic.active?.dutyOnAt || Number.POSITIVE_INFINITY,
  );
  const elapsed = Number.isFinite(dutyOnAt) ? now - dutyOnAt : 0;
  const elapsedHrs = elapsed / MS_HR;
  const dutyRemainingMs = Math.max(0, 14 * MS_HR - elapsed);

  // Shared context — pull from PIC's active period (which is the
  // authoritative copy; SIC inherited these fields at pair creation).
  const tail = pic.active?.tail || sic.active?.tail;
  const tripId = pic.active?.tripId || sic.active?.tripId;
  const location = pic.active?.location || sic.active?.location;

  // Worst-of-both legality. evaluateCurrent returns
  // 'legal' | 'warning' | 'illegal' per-pilot.
  const order = { legal: 0, warning: 1, illegal: 2 };
  const worstLegality = (order[pic.legality.status] || 0) >= (order[sic.legality.status] || 0)
    ? pic.legality
    : sic.legality;
  const legalityTone = worstLegality.status === 'illegal'
    ? 'text-red-400'
    : worstLegality.status === 'warning'
      ? 'text-amber-400'
      : 'text-emerald-400';
  const legalityLabel = worstLegality.status === 'illegal'
    ? 'ILLEGAL'
    : worstLegality.status === 'warning'
      ? `WARN (${worstLegality.warnings?.length || 0})`
      : 'LEGAL';

  // Pulse if either pilot is over the urgency threshold
  const pulse = elapsedHrs >= 12;

  const gridCols = canManage
    ? '1fr 100px 110px 1fr 120px 60px'
    : '1fr 100px 110px 1fr 120px';

  // The expanded panel can be either pilot — track which one is
  // currently open via the shared expandedUid prop from the parent.
  const expandedPilot = expandedUid === pic.uid
    ? { row: pic, period: pic.active, partner: sic.active }
    : expandedUid === sic.uid
      ? { row: sic, period: sic.active, partner: pic.active }
      : null;

  return (
    <div>
      <div className="grid items-center gap-3 px-3 py-2"
        style={{ gridTemplateColumns: gridCols }}>
        {/* PILOTS — PIC on top, SIC below, with a small chevron marker
            so it's obvious this is one crew, not two random pilots. */}
        <div className="space-y-0.5 min-w-0">
          <div className="text-sm text-slate-200 truncate flex items-center gap-1.5"
            style={{ fontFamily: 'DM Sans, sans-serif' }}>
            <span className="text-[9px] tracking-widest text-cyan-500 shrink-0">PIC</span>
            <span className="truncate">{pic.name}</span>
          </div>
          <div className="text-sm text-slate-300 truncate flex items-center gap-1.5"
            style={{ fontFamily: 'DM Sans, sans-serif' }}>
            <span className="text-[9px] tracking-widest text-cyan-500 shrink-0">SIC</span>
            <span className="truncate">{sic.name}</span>
            {sicPending && (
              <span className="text-[9px] tracking-widest text-amber-400 shrink-0"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                · PENDING
              </span>
            )}
          </div>
        </div>

        {/* STATE — single label, vertically centered. The cyan
            "CREWED" suffix distinguishes paired duty at a glance. */}
        <div className="text-[11px] tracking-widest text-emerald-400"
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          {pulse && <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-pulse mr-1"></span>}
          ON DUTY
          <div className="text-[9px] tracking-widest text-cyan-400 mt-0.5">CREWED</div>
        </div>

        {/* ELAPSED — yellow elapsed on top, green LEFT below. Same
            pattern the on-duty card uses internally. Pulses red if
            over 14h. */}
        <div style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <div className={`text-sm tabular-nums leading-tight ${
            elapsedHrs >= 14 ? 'text-red-500 animate-pulse' : 'text-amber-400'
          }`}>
            {fmtElapsed(elapsed)}
          </div>
          {elapsedHrs < 14 ? (
            <div className="text-[10px] tabular-nums text-emerald-400 leading-tight">
              {fmtElapsed(dutyRemainingMs)} LEFT
            </div>
          ) : (
            <div className="text-[10px] tabular-nums text-red-500 leading-tight animate-pulse">
              OVER
            </div>
          )}
        </div>

        {/* CONTEXT — tail/trip on one line, location on another. */}
        <div className="text-[11px] text-slate-500 min-w-0"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <div className="truncate">
            {[tail && `Tail ${tail}`, tripId && `Trip ${tripId}`].filter(Boolean).join(' · ') || '—'}
          </div>
          <div className="truncate text-slate-600">
            {location ? `@ ${location}` : ''}
          </div>
        </div>

        {/* LEGALITY — worst of both. */}
        <div className={`text-right text-[10px] tracking-widest ${legalityTone}`}
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
          {legalityLabel}
        </div>

        {/* ADMIN — two stacked tiny buttons, MGR PIC / MGR SIC. The
            current expanded uid (if any) is highlighted. */}
        {canManage && (
          <div className="flex flex-col gap-1 items-end">
            <button
              onClick={() => onToggle(pic.uid)}
              className={`text-[9px] tracking-widest px-1.5 py-0.5 border ${
                expandedUid === pic.uid
                  ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                  : 'border-slate-700 text-slate-500 hover:border-cyan-400 hover:text-cyan-300'
              }`}
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              title={`Manage ${pic.name}'s duty period`}
            >
              {expandedUid === pic.uid ? 'CLOSE' : 'MGR PIC'}
            </button>
            <button
              onClick={() => onToggle(sic.uid)}
              className={`text-[9px] tracking-widest px-1.5 py-0.5 border ${
                expandedUid === sic.uid
                  ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                  : 'border-slate-700 text-slate-500 hover:border-cyan-400 hover:text-cyan-300'
              }`}
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              title={`Manage ${sic.name}'s duty period`}
            >
              {expandedUid === sic.uid ? 'CLOSE' : 'MGR SIC'}
            </button>
          </div>
        )}
      </div>

      {/* Expanded admin panel — for whichever pilot the admin chose.
          Uses the same CrewManagePanel as solo rows for consistency. */}
      {canManage && expandedPilot && (
        <CrewManagePanel
          period={expandedPilot.period}
          partnerPeriod={expandedPilot.partner}
          currentUser={currentUser}
          crewUsers={crewUsers}
          onClose={() => onToggle(expandedPilot.row.uid)}
        />
      )}
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

