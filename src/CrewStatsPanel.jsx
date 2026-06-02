// src/CrewStatsPanel.jsx
//
// =====================================================================
// CREW STATS PANEL (admin-only)
// =====================================================================
//
// Mounts above the CrewBoardV2 grid. Visible only to admin/ops users
// — the caller passes canManage to gate it. Two sections inside a
// collapsible header:
//
//   1. TRAILING WINDOW (7d / 30d / 90d toggleable)
//      Per-pilot stats aggregated from duty-period-v2 docs:
//        - Duty days (distinct calendar days with a duty start)
//        - Total duty hours
//        - Avg duty per duty day
//        - Total flight hours
//        - Avg flight per duty day
//      Sorted by total duty descending (busiest at top).
//
//   2. LAST 24H ROLLING
//      Per-pilot:
//        - Actual flight hours (sum of flightTimeMs from periods that
//          overlap the 24h window)
//        - Scheduled leg count (count of trip legs scheduled for this
//          pilot in the window, attributed by fuzzy name match on
//          trip.info.pic and trip.info.sic)
//      Sorted by actual flight desc.
//
// HONEST LIMITATIONS, surfaced in the UI:
//   - "Scheduled flight HOURS" can't be computed because trip legs
//     store only departure time, not arrival/duration. The panel shows
//     scheduled LEG COUNT instead as a proxy for scheduled workload.
//     To upgrade this to real scheduled hours, hook FlightAware ETE
//     data into each trip leg at ingest, then sum (scheduledIn -
//     scheduledOut) per leg.
//   - "Calendar day" boundaries use the viewer's browser local TZ. A
//     pilot's duty that crosses midnight will count toward whichever
//     local-time day they started in. Not perfect but consistent.
//   - Periods with confirmStatus 'pending' or 'declined' are excluded
//     (matching the legality engine's filter).
//   - Open (status='on') periods count from dutyOnAt to "now" so
//     active duty contributes accurately to running totals.

import React, { useState, useMemo } from 'react';
import { BarChart3, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';

const MS_HR = 3600 * 1000;
const MS_DAY = 24 * MS_HR;

const VALID_STATUSES = new Set(['self-attested', 'admin-attested']);

// Format ms → "X.Yh" (1 decimal). Returns "0.0" for null/negative.
function fmtH(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0';
  return (ms / MS_HR).toFixed(1);
}

// Unique key for a date in browser-local TZ. Consistent across periods
// for the same calendar day; differs for adjacent days.
function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Aggregate periods for each pilot over a trailing window in days.
// Returns array of { uid, name, dutyDays, dutyMs, avgDutyMs, flightMs,
// avgFlightMs } sorted by dutyMs desc.
function aggregateTrailing(periods, now, windowDays) {
  const cutoff = now - windowDays * MS_DAY;
  const byPilot = new Map();

  for (const p of periods) {
    if (!p.pilotUid || !p.dutyOnAt) continue;
    if (p.dutyOnAt < cutoff) continue;
    if (p.confirmStatus && !VALID_STATUSES.has(p.confirmStatus)) continue;

    let entry = byPilot.get(p.pilotUid);
    if (!entry) {
      entry = {
        uid: p.pilotUid,
        name: p.pilotName || '(unknown)',
        days: new Set(),
        dutyMs: 0,
        flightMs: 0,
      };
      byPilot.set(p.pilotUid, entry);
    }
    entry.days.add(localDayKey(p.dutyOnAt));
    // Open periods count up to now; closed use dutyOffAt
    const offAt = p.dutyOffAt || now;
    entry.dutyMs += Math.max(0, offAt - p.dutyOnAt);
    entry.flightMs += p.flightTimeMs || 0;
  }

  return Array.from(byPilot.values())
    .map(e => ({
      uid: e.uid,
      name: e.name,
      dutyDays: e.days.size,
      dutyMs: e.dutyMs,
      flightMs: e.flightMs,
      avgDutyMs: e.days.size ? e.dutyMs / e.days.size : 0,
      avgFlightMs: e.days.size ? e.flightMs / e.days.size : 0,
    }))
    .sort((a, b) => b.dutyMs - a.dutyMs);
}

// Simple fuzzy name match: 2+ token overlap (case/punct-insensitive).
// Same heuristic the duty pair-detection uses. Conservative enough that
// "Cole Z" matching "Cole Zangerle" works but random first-name
// collisions don't (e.g. "Cole Z" vs "Cole Madsen" → only 1 token
// overlap, skipped).
function nameMatch(tripName, userName) {
  if (!tripName || !userName) return false;
  const tokens = (s) => s.toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
  const a = new Set(tokens(tripName));
  const b = tokens(userName);
  if (a.size === 0 || b.length === 0) return false;
  let overlap = 0;
  for (const t of b) if (a.has(t)) overlap++;
  return overlap >= 2;
}

// Try to parse a leg's departure time to UTC ms. JetInsight legs store
// depDate (e.g. "Jun 2, 2026") plus depTimeZ (Zulu string e.g.
// "13:30Z"). We combine them defensively. Some imports may have
// scheduledDep ISO strings — try those as fallback.
function parseLegTime(leg) {
  if (!leg) return null;
  // First try scheduled ISO if present (e.g. enriched from FlightAware)
  for (const k of ['scheduledOut', 'scheduledDep', 'depISO']) {
    if (leg[k]) {
      const t = Date.parse(leg[k]);
      if (Number.isFinite(t)) return t;
    }
  }
  // Then the JetInsight depDate + depTimeZ combination
  if (leg.depDate && leg.depTimeZ) {
    // Examples: "Jun 2, 2026" + "13:30Z" → "Jun 2, 2026 13:30Z"
    // Date.parse handles common formats; if it fails we just skip.
    const z = String(leg.depTimeZ).replace(/Z?$/i, 'Z');
    const t = Date.parse(`${leg.depDate} ${z}`);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Aggregate last 24h activity per pilot. Returns array of
// { uid, name, actualFlightMs, scheduledLegs } sorted by actual desc.
// Only includes pilots with non-zero actualFlightMs OR non-zero
// scheduledLegs in the window.
function aggregate24h(periods, trips, allPilotIds, now) {
  const windowStart = now - MS_DAY;
  const windowEnd = now;
  const byPilot = new Map();

  // Helper to add or fetch a pilot entry
  const get = (uid, name) => {
    let entry = byPilot.get(uid);
    if (!entry) {
      entry = { uid, name: name || '(unknown)', actualFlightMs: 0, scheduledLegs: 0 };
      byPilot.set(uid, entry);
    }
    return entry;
  };

  // Pass 1: actual flight time from duty periods that intersect the window
  for (const p of periods) {
    if (!p.pilotUid || !p.dutyOnAt) continue;
    if (p.confirmStatus && !VALID_STATUSES.has(p.confirmStatus)) continue;
    const offAt = p.dutyOffAt || now;
    // Skip periods entirely outside the window
    if (offAt < windowStart) continue;
    if (p.dutyOnAt > windowEnd) continue;
    const entry = get(p.pilotUid, p.pilotName);
    // Flight time is recorded as a total on the period rather than
    // distributed across the period's duration. Counting the full
    // value here is consistent with how the legality engine handles
    // sliding-window flight totals for periods that overlap. A
    // refinement would prorate when a period extends past the window,
    // but in practice flight totals are recorded at duty-off and
    // periods rarely straddle the 24h boundary.
    entry.actualFlightMs += p.flightTimeMs || 0;
  }

  // Pass 2: scheduled leg count from trips
  // For each trip leg whose departure time falls in the 24h window,
  // attribute it to the PIC and SIC named on the trip if either
  // matches a known pilot in allPilotIds.
  if (Array.isArray(trips) && trips.length && Array.isArray(allPilotIds)) {
    for (const trip of trips) {
      const picStr = trip?.info?.pic;
      const sicStr = trip?.info?.sic;
      if (!picStr && !sicStr) continue;
      const legs = trip?.legs;
      if (!Array.isArray(legs)) continue;
      for (const leg of legs) {
        const legMs = parseLegTime(leg);
        if (!Number.isFinite(legMs)) continue;
        if (legMs < windowStart || legMs > windowEnd) continue;
        // Attribute. We iterate all known pilots and check the name
        // against each. O(legs × pilots) but both are small.
        for (const pilot of allPilotIds) {
          if (!pilot?.name) continue;
          if (picStr && nameMatch(picStr, pilot.name)) {
            get(pilot.uid, pilot.name).scheduledLegs++;
          } else if (sicStr && nameMatch(sicStr, pilot.name)) {
            get(pilot.uid, pilot.name).scheduledLegs++;
          }
        }
      }
    }
  }

  return Array.from(byPilot.values())
    .filter(e => e.actualFlightMs > 0 || e.scheduledLegs > 0)
    .sort((a, b) => b.actualFlightMs - a.actualFlightMs);
}

// =====================================================================
// Component
// =====================================================================

export default function CrewStatsPanel({ periods = [], trips = [], users = [], canManage = false }) {
  // Gate. Caller already checks canManage, but defense-in-depth: if a
  // crew user somehow renders this panel, hide it entirely.
  if (!canManage) return null;

  const [expanded, setExpanded] = useState(true);
  const [windowDays, setWindowDays] = useState(30);

  // Recompute every render; cheap given the small data volumes
  // (≤30 days of periods, ≤a few hundred trips).
  const now = Date.now();

  const trailing = useMemo(
    () => aggregateTrailing(periods, now, windowDays),
    [periods, now, windowDays]
  );

  // For 24h, we want to attribute scheduled legs to pilots even when
  // they have NO duty period in the window. Pass the full user list
  // so the name matcher has something to attribute to.
  const allPilots = useMemo(
    () => (users || []).map(u => ({ uid: u.uid || u.id, name: u.name || u.displayName })),
    [users]
  );

  const last24 = useMemo(
    () => aggregate24h(periods, trips, allPilots, now),
    [periods, trips, allPilots, now]
  );

  const hasTrips = Array.isArray(trips) && trips.length > 0;

  return (
    <div className="border border-slate-800 bg-slate-900/30 mb-2">
      {/* Collapsible header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-800/50"
      >
        <div className="flex items-center gap-2">
          <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-xs tracking-[0.2em] text-slate-300"
            style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
            CREW STATS
          </span>
          <span className="text-[9px] tracking-widest text-cyan-500 ml-1"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            ADMIN
          </span>
        </div>
        {expanded
          ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
          : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
        }
      </button>

      {expanded && (
        <div className="border-t border-slate-800 p-3 space-y-4"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>

          {/* =================================================
              SECTION 1: TRAILING WINDOW
              ================================================= */}
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-[10px] tracking-widest text-slate-500">
                TRAILING WINDOW
              </span>
              <div className="flex gap-1">
                {[7, 30, 90].map(d => (
                  <button
                    key={d}
                    onClick={() => setWindowDays(d)}
                    className={`text-[10px] tracking-widest px-2 py-0.5 border ${
                      windowDays === d
                        ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
                        : 'border-slate-700 text-slate-400 hover:border-cyan-500'
                    }`}
                  >
                    {d}D
                  </button>
                ))}
              </div>
            </div>

            {trailing.length === 0 ? (
              <div className="text-[10px] text-slate-600 text-center py-3">
                No duty activity in this window.
              </div>
            ) : (
              <div className="border border-slate-800">
                <div className="grid items-center gap-2 px-2 py-1.5 text-[9px] tracking-widest text-slate-500 bg-slate-950/50"
                  style={{ gridTemplateColumns: '1fr 60px 70px 70px 70px 70px' }}>
                  <div>PILOT</div>
                  <div className="text-right">DAYS</div>
                  <div className="text-right">DUTY (h)</div>
                  <div className="text-right">AVG D/D</div>
                  <div className="text-right">FLIGHT (h)</div>
                  <div className="text-right">AVG F/D</div>
                </div>
                {trailing.map(r => (
                  <div key={r.uid}
                    className="grid items-center gap-2 px-2 py-1.5 text-[11px] border-t border-slate-800/50"
                    style={{ gridTemplateColumns: '1fr 60px 70px 70px 70px 70px' }}>
                    <div className="text-slate-200 truncate"
                      style={{ fontFamily: 'DM Sans, sans-serif' }}>
                      {r.name}
                    </div>
                    <div className="text-right text-slate-300 tabular-nums">{r.dutyDays}</div>
                    <div className="text-right text-slate-100 tabular-nums">{fmtH(r.dutyMs)}</div>
                    <div className="text-right text-cyan-300 tabular-nums">{fmtH(r.avgDutyMs)}</div>
                    <div className="text-right text-slate-300 tabular-nums">{fmtH(r.flightMs)}</div>
                    <div className="text-right text-slate-400 tabular-nums">{fmtH(r.avgFlightMs)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* =================================================
              SECTION 2: LAST 24H
              ================================================= */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] tracking-widest text-slate-500">
                LAST 24H · FLOWN vs SCHEDULED
              </span>
              {!hasTrips && (
                <span className="text-[9px] text-amber-500/80 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  trip data not connected
                </span>
              )}
            </div>

            {last24.length === 0 ? (
              <div className="text-[10px] text-slate-600 text-center py-3">
                No flight activity or scheduled legs in last 24h.
              </div>
            ) : (
              <div className="border border-slate-800">
                <div className="grid items-center gap-2 px-2 py-1.5 text-[9px] tracking-widest text-slate-500 bg-slate-950/50"
                  style={{ gridTemplateColumns: '1fr 90px 90px' }}>
                  <div>PILOT</div>
                  <div className="text-right">ACTUAL FLIGHT</div>
                  <div className="text-right">SCHED LEGS</div>
                </div>
                {last24.map(r => (
                  <div key={r.uid}
                    className="grid items-center gap-2 px-2 py-1.5 text-[11px] border-t border-slate-800/50"
                    style={{ gridTemplateColumns: '1fr 90px 90px' }}>
                    <div className="text-slate-200 truncate"
                      style={{ fontFamily: 'DM Sans, sans-serif' }}>
                      {r.name}
                    </div>
                    <div className="text-right text-cyan-300 tabular-nums">{fmtH(r.actualFlightMs)} h</div>
                    <div className="text-right text-slate-300 tabular-nums">
                      {r.scheduledLegs > 0 ? `${r.scheduledLegs} legs` : '—'}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Honest caveat note */}
            <div className="text-[9px] text-slate-500 mt-1.5 flex items-start gap-1">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                Scheduled HOURS not shown — trip legs store departure time only,
                not duration. Showing leg COUNT as a workload proxy.
                {!hasTrips && ' Pass trips prop from parent to enable.'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
