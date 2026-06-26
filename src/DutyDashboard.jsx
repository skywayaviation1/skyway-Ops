// src/DutyDashboard.jsx
//
// =====================================================================
// ADMIN DUTY DASHBOARD — the primary duty management interface
// =====================================================================
//
// Built to the Part 135 Crew Duty & Rest spec. Three views behind one
// switcher:
//
//   CALENDAR — month grid, crew per day, color-coded, click a day for the
//              complete record detail. (Reuses the existing, working
//              DutyAdminCalendar, which opens DutyDayDetail on click.)
//   TIMELINE — horizontal per-pilot swimlanes with 24h / 3d / 7d / 30d zoom.
//              Duty blocks colored by status, rest shown as the gaps,
//              "now" marker. Click a block for the record.
//   GRID     — sortable, filterable data table (Pilot, Crew, Aircraft,
//              Duty Start/End, Duty Hours, Rest Hours, Status, Duty Limit,
//              Edited, Last Updated). Filters: Pilot, Aircraft, Date, Crew,
//              Status, Violation, plus free-text search.
//
// Reads duty-periods-v2 via subscribeRecentForAllPilots over a selectable
// window (30 / 90 / 180 / 365 days). All three views share that one live
// subscription (the Calendar pulls its own 365-day feed internally).
//
// Color scheme (spec): GREEN = legal (< 12h), YELLOW = near limit
// (12–14h), RED = duty limit exceeded (≥ 14h). Rest is shown in blue.
//
// Props: { currentUser, users }

import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays, Activity, Table2, ChevronLeft, ChevronRight, Search,
  X, Loader2, AlertTriangle, Clock, Plane, Users as UsersIcon, ArrowUpDown,
} from 'lucide-react';
import { subscribeRecentForAllPilots } from './firebase-duty-v2.js';
import DutyAdminCalendar from './DutyAdminCalendar.jsx';

const MS_HR = 3600 * 1000;
const MS_DAY = 24 * MS_HR;
const FONT_HEAD = 'Bebas Neue, sans-serif';
const FONT_MONO = 'JetBrains Mono, monospace';
const FONT_BODY = 'DM Sans, sans-serif';

// 14h duty limit, 10h legal rest — kept here as named constants so the
// thresholds the dashboard colors by are obvious and easy to change.
const DUTY_LIMIT_MS = 14 * MS_HR;
const DUTY_NEAR_MS = 12 * MS_HR;
const REST_REQUIRED_MS = 10 * MS_HR;

// ---------- formatting helpers ----------
function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
function fmtTimeOnly(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDateOnly(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtHrs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / MS_HR);
  const m = Math.round((ms % MS_HR) / 60000);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function initialsOf(name) {
  if (!name) return '?';
  const p = String(name).trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

// Elapsed duty time for a period (closed → fixed; open → live to `now`).
function dutyElapsed(p, now) {
  if (!p?.dutyOnAt) return 0;
  const end = p.dutyOffAt || now;
  return Math.max(0, end - p.dutyOnAt);
}
// Duty status band per spec.
function dutyBand(elapsedMs) {
  if (elapsedMs >= DUTY_LIMIT_MS) return 'exceeded';
  if (elapsedMs >= DUTY_NEAR_MS) return 'near';
  return 'legal';
}
const BAND_STYLE = {
  legal:    { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', dot: 'bg-emerald-400', label: 'LEGAL' },
  near:     { text: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   dot: 'bg-amber-400',   label: 'NEAR LIMIT' },
  exceeded: { text: 'text-red-500',     bg: 'bg-red-500/15',     border: 'border-red-500/50',     dot: 'bg-red-500',     label: 'EXCEEDED' },
};

// Was this record manually edited (vs only auto-created)?
function isEdited(p) {
  const edits = Array.isArray(p.adminEdits) ? p.adminEdits : [];
  return edits.some(e =>
    ['dutyOnAt', 'dutyOffAt', 'flightTimeMs', 'overwrite-import', 'role', 'tail', 'location', 'crewType'].includes(e.field)
  );
}

// Current display status of a period.
function statusOf(p, now) {
  if (p.confirmStatus === 'pending') return 'PENDING';
  if (p.confirmStatus === 'declined') return 'DECLINED';
  if (p.status === 'on') return 'ON DUTY';
  if (p.dutyOffAt && (now - p.dutyOffAt) < REST_REQUIRED_MS) return 'REST';
  return 'OFF';
}
const STATUS_STYLE = {
  'ON DUTY':  'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  'REST':     'text-sky-300 border-sky-500/40 bg-sky-500/10',
  'OFF':      'text-slate-400 border-slate-700 bg-slate-800/40',
  'PENDING':  'text-amber-300 border-amber-500/40 bg-amber-500/10',
  'DECLINED': 'text-slate-500 border-slate-700 bg-slate-800/40',
};

// Violation classification for filtering.
function violationOf(p, restBeforeMs) {
  const over = dutyElapsed(p, Date.now()) >= DUTY_LIMIT_MS || p.over14;
  const shortRest = Number.isFinite(restBeforeMs) && restBeforeMs < REST_REQUIRED_MS;
  if (over) return 'duty';
  if (shortRest) return 'rest';
  return 'none';
}

// =====================================================================
// MAIN
// =====================================================================
export default function DutyDashboard({ currentUser, users = [] }) {
  const [view, setView] = useState('calendar'); // 'calendar' | 'timeline' | 'grid'
  const [windowDays, setWindowDays] = useState(90);
  const [periods, setPeriods] = useState(null); // null = loading
  const [detail, setDetail] = useState(null);   // period for the record modal
  const [now, setNow] = useState(Date.now());

  // Live tick (1 min) so open-duty elapsed + "now" line stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // Subscribe for timeline + grid (calendar self-subscribes to 365d).
  useEffect(() => {
    if (view === 'calendar') return; // calendar handles its own data
    setPeriods(null);
    const unsub = subscribeRecentForAllPilots(windowDays, (list) => setPeriods(list));
    return () => unsub && unsub();
  }, [view, windowDays]);

  // id → period map for partner resolution.
  const byId = useMemo(() => {
    const m = new Map();
    (periods || []).forEach(p => m.set(p.id, p));
    return m;
  }, [periods]);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-slate-950">
      {/* Header + view switcher */}
      <div className="px-4 pt-4 pb-3 border-b border-slate-800">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="text-3xl leading-none text-cyan-400" style={{ fontFamily: FONT_HEAD, letterSpacing: '0.04em' }}>
              DUTY &amp; REST
            </span>
            <span className="text-[10px] tracking-widest text-slate-500 border border-slate-700 px-1.5 py-0.5"
              style={{ fontFamily: FONT_MONO }}>
              PART 135 · OFFICIAL RECORD
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <ViewTab icon={CalendarDays} label="CALENDAR" active={view === 'calendar'} onClick={() => setView('calendar')} />
            <ViewTab icon={Activity} label="TIMELINE" active={view === 'timeline'} onClick={() => setView('timeline')} />
            <ViewTab icon={Table2} label="GRID" active={view === 'grid'} onClick={() => setView('grid')} />
          </div>
        </div>
        {view !== 'calendar' && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: FONT_MONO }}>WINDOW</span>
            {[30, 90, 180, 365].map(d => (
              <button key={d} onClick={() => setWindowDays(d)}
                className={`text-[11px] px-2 py-1 border ${windowDays === d ? 'border-cyan-500/60 text-cyan-300 bg-cyan-500/10' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}
                style={{ fontFamily: FONT_MONO }}>
                {d}d
              </button>
            ))}
            {periods && (
              <span className="text-[10px] text-slate-600 ml-1" style={{ fontFamily: FONT_MONO }}>
                {periods.length} records{periods.length >= 500 ? ' (capped — narrow the window)' : ''}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === 'calendar' && (
          <div className="h-full overflow-y-auto">
            <DutyAdminCalendar currentUser={currentUser} users={users} />
          </div>
        )}
        {view === 'timeline' && (
          periods === null
            ? <Loading label="LOADING TIMELINE" />
            : <TimelineView periods={periods} now={now} byId={byId} onPick={setDetail} />
        )}
        {view === 'grid' && (
          periods === null
            ? <Loading label="LOADING GRID" />
            : <GridView periods={periods} now={now} byId={byId} onPick={setDetail} />
        )}
      </div>

      {detail && (
        <RecordDetailModal period={detail} byId={byId} now={now} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}

// ---------- small shared bits ----------
function ViewTab({ icon: Icon, label, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 border text-[11px] tracking-wider ${active ? 'border-cyan-500/60 text-cyan-300 bg-cyan-500/10' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}
      style={{ fontFamily: FONT_MONO }}>
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}
function Loading({ label }) {
  return (
    <div className="h-full flex items-center justify-center text-slate-500" style={{ fontFamily: FONT_MONO }}>
      <Loader2 className="w-4 h-4 animate-spin mr-2" /> {label}
    </div>
  );
}
function Empty({ label }) {
  return (
    <div className="h-full flex items-center justify-center text-slate-600 text-sm" style={{ fontFamily: FONT_MONO }}>
      {label}
    </div>
  );
}

// =====================================================================
// TIMELINE VIEW
// =====================================================================
function TimelineView({ periods, now, byId, onPick }) {
  const ZOOMS = [
    { label: '24H', ms: MS_DAY },
    { label: '3D', ms: 3 * MS_DAY },
    { label: '7D', ms: 7 * MS_DAY },
    { label: '30D', ms: 30 * MS_DAY },
  ];
  const [zoomMs, setZoomMs] = useState(7 * MS_DAY);
  const [endMs, setEndMs] = useState(now);

  // keep the right edge tracking "now" until the admin pans back
  const [pinnedNow, setPinnedNow] = useState(true);
  useEffect(() => { if (pinnedNow) setEndMs(now); }, [now, pinnedNow]);

  const startMs = endMs - zoomMs;

  // group periods by pilot
  const pilots = useMemo(() => {
    const m = new Map();
    for (const p of periods) {
      if (!p.pilotUid) continue;
      if (!m.has(p.pilotUid)) m.set(p.pilotUid, { uid: p.pilotUid, name: p.pilotName || p.pilotUid, periods: [] });
      m.get(p.pilotUid).periods.push(p);
    }
    const arr = [...m.values()];
    arr.forEach(pl => pl.periods.sort((a, b) => (a.dutyOnAt || 0) - (b.dutyOnAt || 0)));
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [periods]);

  // gridlines
  const ticks = useMemo(() => {
    const out = [];
    const step = zoomMs <= MS_DAY ? 3 * MS_HR : zoomMs <= 3 * MS_DAY ? 12 * MS_HR : MS_DAY;
    let t = Math.ceil(startMs / step) * step;
    while (t <= endMs) { out.push(t); t += step; }
    return out;
  }, [startMs, endMs, zoomMs]);

  const pct = (ms) => ((ms - startMs) / zoomMs) * 100;

  return (
    <div className="h-full flex flex-col">
      {/* controls */}
      <div className="px-4 py-2 flex items-center gap-2 border-b border-slate-800 flex-wrap">
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: FONT_MONO }}>ZOOM</span>
        {ZOOMS.map(z => (
          <button key={z.label} onClick={() => setZoomMs(z.ms)}
            className={`text-[11px] px-2 py-1 border ${zoomMs === z.ms ? 'border-cyan-500/60 text-cyan-300 bg-cyan-500/10' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}
            style={{ fontFamily: FONT_MONO }}>{z.label}</button>
        ))}
        <div className="flex items-center gap-1 ml-2">
          <button onClick={() => { setPinnedNow(false); setEndMs(e => e - zoomMs / 2); }}
            className="p-1 border border-slate-700 text-slate-400 hover:border-slate-600"><ChevronLeft className="w-3.5 h-3.5" /></button>
          <button onClick={() => { setPinnedNow(false); setEndMs(e => Math.min(now, e + zoomMs / 2)); }}
            className="p-1 border border-slate-700 text-slate-400 hover:border-slate-600"><ChevronRight className="w-3.5 h-3.5" /></button>
          <button onClick={() => { setPinnedNow(true); setEndMs(now); }}
            className={`text-[11px] px-2 py-1 border ${pinnedNow ? 'border-cyan-500/60 text-cyan-300 bg-cyan-500/10' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}
            style={{ fontFamily: FONT_MONO }}>NOW</button>
        </div>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-slate-500" style={{ fontFamily: FONT_MONO }}>
          <Legend dot="bg-emerald-400" label="LEGAL" />
          <Legend dot="bg-amber-400" label="NEAR" />
          <Legend dot="bg-red-500" label="OVER" />
          <Legend dot="bg-sky-500/60" label="REST" />
        </div>
      </div>

      {pilots.length === 0 ? <Empty label="NO DUTY RECORDS IN THIS WINDOW" /> : (
        <div className="flex-1 overflow-auto">
          {/* time axis */}
          <div className="sticky top-0 z-10 bg-slate-950 border-b border-slate-800 flex">
            <div className="w-32 shrink-0 border-r border-slate-800" />
            <div className="relative flex-1 h-7">
              {ticks.map((t, i) => (
                <div key={i} className="absolute top-0 h-7 border-l border-slate-800/70 pl-1 text-[9px] text-slate-500"
                  style={{ left: `${pct(t)}%`, fontFamily: FONT_MONO }}>
                  {zoomMs <= MS_DAY ? fmtTimeOnly(t) : fmtDateOnly(t).replace(/, \d{4}$/, '')}
                </div>
              ))}
              {pct(now) >= 0 && pct(now) <= 100 && (
                <div className="absolute top-0 bottom-0 w-px bg-cyan-400/70" style={{ left: `${pct(now)}%` }} />
              )}
            </div>
          </div>
          {/* rows */}
          {pilots.map(pl => (
            <div key={pl.uid} className="flex border-b border-slate-800/60 hover:bg-slate-900/30">
              <div className="w-32 shrink-0 border-r border-slate-800 px-2 py-2 flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-slate-800 text-[9px] text-cyan-300 flex items-center justify-center shrink-0"
                  style={{ fontFamily: FONT_MONO }}>{initialsOf(pl.name)}</span>
                <span className="text-[11px] text-slate-300 truncate" style={{ fontFamily: FONT_BODY }}>{pl.name}</span>
              </div>
              <div className="relative flex-1 h-10">
                {/* rest gaps (between consecutive duties) */}
                {pl.periods.map((p, i) => {
                  if (i === 0 || !p.dutyOnAt) return null;
                  const prev = pl.periods[i - 1];
                  const prevEnd = prev.dutyOffAt || now;
                  const gapStart = Math.max(prevEnd, startMs);
                  const gapEnd = Math.min(p.dutyOnAt, endMs);
                  if (gapEnd <= gapStart) return null;
                  return (
                    <div key={`rest-${p.id}`} title={`Rest ${fmtHrs(p.dutyOnAt - prevEnd)}`}
                      className="absolute top-3.5 h-3 bg-sky-500/15 border-y border-sky-500/30"
                      style={{ left: `${pct(gapStart)}%`, width: `${Math.max(0.3, pct(gapEnd) - pct(gapStart))}%` }} />
                  );
                })}
                {/* duty blocks */}
                {pl.periods.map(p => {
                  if (!p.dutyOnAt) return null;
                  const s = Math.max(p.dutyOnAt, startMs);
                  const e = Math.min(p.dutyOffAt || now, endMs);
                  if (e <= s) return null;
                  const band = BAND_STYLE[dutyBand(dutyElapsed(p, now))];
                  const pending = p.confirmStatus === 'pending';
                  return (
                    <button key={p.id} onClick={() => onPick(p)}
                      title={`${p.pilotName} · ${fmtTimeOnly(p.dutyOnAt)}→${p.dutyOffAt ? fmtTimeOnly(p.dutyOffAt) : 'open'} · ${fmtHrs(dutyElapsed(p, now))}`}
                      className={`absolute top-1.5 h-7 ${band.bg} border ${band.border} ${pending ? 'opacity-50 border-dashed' : ''} hover:brightness-125 flex items-center px-1 overflow-hidden`}
                      style={{ left: `${pct(s)}%`, width: `${Math.max(0.5, pct(e) - pct(s))}%` }}>
                      <span className={`text-[8px] ${band.text} truncate`} style={{ fontFamily: FONT_MONO }}>
                        {p.tail || ''}{p.role ? ` ${p.role}` : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function Legend({ dot, label }) {
  return <span className="flex items-center gap-1"><span className={`w-2 h-2 ${dot}`} />{label}</span>;
}

// =====================================================================
// GRID VIEW
// =====================================================================
function GridView({ periods, now, byId, onPick }) {
  const [fPilot, setFPilot] = useState('');
  const [fTail, setFTail] = useState('');
  const [fDate, setFDate] = useState('');
  const [fCrew, setFCrew] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fViolation, setFViolation] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('dutyOnAt');
  const [sortDir, setSortDir] = useState('desc');

  // rest-before (same pilot, prior period) for each period
  const restBefore = useMemo(() => {
    const byPilot = new Map();
    for (const p of periods) {
      if (!p.pilotUid) continue;
      if (!byPilot.has(p.pilotUid)) byPilot.set(p.pilotUid, []);
      byPilot.get(p.pilotUid).push(p);
    }
    const map = new Map();
    for (const list of byPilot.values()) {
      list.sort((a, b) => (a.dutyOnAt || 0) - (b.dutyOnAt || 0));
      for (let i = 0; i < list.length; i++) {
        if (i === 0) { map.set(list[i].id, null); continue; }
        const prevEnd = list[i - 1].dutyOffAt;
        map.set(list[i].id, prevEnd ? (list[i].dutyOnAt - prevEnd) : null);
      }
    }
    return map;
  }, [periods]);

  const pilotOpts = useMemo(() => [...new Set(periods.map(p => p.pilotName).filter(Boolean))].sort(), [periods]);
  const tailOpts = useMemo(() => [...new Set(periods.map(p => p.tail).filter(Boolean))].sort(), [periods]);

  const rows = useMemo(() => {
    let r = periods.filter(p => {
      if (fPilot && p.pilotName !== fPilot) return false;
      if (fTail && p.tail !== fTail) return false;
      if (fCrew && (p.crewType || 'single') !== fCrew) return false;
      if (fStatus && statusOf(p, now) !== fStatus) return false;
      if (fViolation && violationOf(p, restBefore.get(p.id)) !== fViolation) return false;
      if (fDate) {
        // any period touching the selected local day
        const onKey = p.dutyOnAt ? localDateKey(p.dutyOnAt) : null;
        const offKey = p.dutyOffAt ? localDateKey(p.dutyOffAt) : null;
        if (onKey !== fDate && offKey !== fDate) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        const hay = `${p.pilotName || ''} ${p.tail || ''} ${p.location || ''} ${p.tripId || ''} ${p.role || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    r = [...r].sort((a, b) => {
      let av, bv;
      switch (sortKey) {
        case 'pilotName': av = a.pilotName || ''; bv = b.pilotName || ''; return av.localeCompare(bv) * dir;
        case 'tail': av = a.tail || ''; bv = b.tail || ''; return av.localeCompare(bv) * dir;
        case 'dutyHrs': av = dutyElapsed(a, now); bv = dutyElapsed(b, now); break;
        case 'restHrs': av = restBefore.get(a.id) ?? -1; bv = restBefore.get(b.id) ?? -1; break;
        case 'dutyOffAt': av = a.dutyOffAt || 0; bv = b.dutyOffAt || 0; break;
        case 'updatedAt': av = a.updatedAt || 0; bv = b.updatedAt || 0; break;
        default: av = a.dutyOnAt || 0; bv = b.dutyOnAt || 0;
      }
      return (av - bv) * dir;
    });
    return r;
  }, [periods, fPilot, fTail, fDate, fCrew, fStatus, fViolation, search, sortKey, sortDir, now, restBefore]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };
  const clearFilters = () => {
    setFPilot(''); setFTail(''); setFDate(''); setFCrew(''); setFStatus(''); setFViolation(''); setSearch('');
  };
  const anyFilter = fPilot || fTail || fDate || fCrew || fStatus || fViolation || search;

  const Th = ({ k, children, className = '' }) => (
    <th className={`px-2 py-2 text-left border-b border-slate-800 select-none cursor-pointer hover:text-cyan-300 ${className}`}
      onClick={() => k && toggleSort(k)} style={{ fontFamily: FONT_MONO }}>
      <span className="inline-flex items-center gap-1 text-[10px] tracking-wider text-slate-400">
        {children}{k && <ArrowUpDown className={`w-3 h-3 ${sortKey === k ? 'text-cyan-400' : 'text-slate-600'}`} />}
      </span>
    </th>
  );

  return (
    <div className="h-full flex flex-col">
      {/* filters */}
      <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-2 flex-wrap">
        <Sel value={fPilot} onChange={setFPilot} placeholder="PILOT" opts={pilotOpts} />
        <Sel value={fTail} onChange={setFTail} placeholder="AIRCRAFT" opts={tailOpts} />
        <Sel value={fCrew} onChange={setFCrew} placeholder="CREW" opts={[['two', 'Two-pilot'], ['single', 'Single']]} />
        <Sel value={fStatus} onChange={setFStatus} placeholder="STATUS" opts={['ON DUTY', 'REST', 'OFF', 'PENDING', 'DECLINED']} />
        <Sel value={fViolation} onChange={setFViolation} placeholder="VIOLATION" opts={[['duty', 'Over 14h'], ['rest', 'Rest < 10h'], ['none', 'None']]} />
        <input type="date" value={fDate} onChange={e => setFDate(e.target.value)}
          className="bg-slate-900 border border-slate-700 text-[11px] text-slate-300 px-2 py-1" style={{ fontFamily: FONT_MONO }} />
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1.5 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search…"
            className="bg-slate-900 border border-slate-700 text-[11px] text-slate-200 pl-7 pr-2 py-1 w-36" style={{ fontFamily: FONT_MONO }} />
        </div>
        {anyFilter && (
          <button onClick={clearFilters} className="flex items-center gap-1 text-[10px] text-slate-400 border border-slate-700 px-2 py-1 hover:border-slate-600" style={{ fontFamily: FONT_MONO }}>
            <X className="w-3 h-3" /> CLEAR
          </button>
        )}
        <span className="ml-auto text-[10px] text-slate-600" style={{ fontFamily: FONT_MONO }}>{rows.length} rows</span>
      </div>

      {/* table */}
      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? <Empty label="NO RECORDS MATCH" /> : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-slate-950 z-10">
              <tr>
                <Th k="pilotName">PILOT</Th>
                <Th>CREW</Th>
                <Th k="tail">A/C</Th>
                <Th k="dutyOnAt">DUTY START</Th>
                <Th k="dutyOffAt">DUTY END</Th>
                <Th k="dutyHrs">DUTY HRS</Th>
                <Th k="restHrs">REST HRS</Th>
                <Th>STATUS</Th>
                <Th>DUTY LIMIT</Th>
                <Th>EDITED</Th>
                <Th k="updatedAt">LAST UPDATED</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const elapsed = dutyElapsed(p, now);
                const band = BAND_STYLE[dutyBand(elapsed)];
                const st = statusOf(p, now);
                const partner = p.partnerPeriodId ? byId.get(p.partnerPeriodId) : null;
                const rb = restBefore.get(p.id);
                const edited = isEdited(p);
                return (
                  <tr key={p.id} onClick={() => onPick(p)}
                    className="border-b border-slate-800/50 hover:bg-slate-900/40 cursor-pointer" style={{ fontFamily: FONT_MONO }}>
                    <td className="px-2 py-1.5 text-slate-200">{p.pilotName || '—'}{p.role ? <span className="text-slate-500"> · {p.role}</span> : null}</td>
                    <td className="px-2 py-1.5 text-slate-400">
                      {p.crewType === 'two'
                        ? (partner ? `${initialsOf(partner.pilotName)} ${partner.role || ''}`.trim() : 'TWO')
                        : 'SINGLE'}
                    </td>
                    <td className="px-2 py-1.5 text-cyan-300">{p.tail || '—'}</td>
                    <td className="px-2 py-1.5 text-slate-300">{fmtClock(p.dutyOnAt)}</td>
                    <td className="px-2 py-1.5 text-slate-300">{p.dutyOffAt ? fmtClock(p.dutyOffAt) : <span className="text-cyan-400">— open —</span>}</td>
                    <td className={`px-2 py-1.5 ${band.text}`}>{fmtHrs(elapsed)}</td>
                    <td className="px-2 py-1.5 text-sky-300">{Number.isFinite(rb) ? fmtHrs(rb) : '—'}</td>
                    <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 border text-[9px] ${STATUS_STYLE[st]}`}>{st}</span></td>
                    <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 border text-[9px] ${band.border} ${band.text}`}>{band.label}</span></td>
                    <td className="px-2 py-1.5 text-center">{edited ? <span className="text-amber-400">✎</span> : <span className="text-slate-700">—</span>}</td>
                    <td className="px-2 py-1.5 text-slate-500">{p.updatedAt ? fmtClock(p.updatedAt) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Sel({ value, onChange, placeholder, opts }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={`bg-slate-900 border text-[11px] px-2 py-1 ${value ? 'border-cyan-500/50 text-cyan-300' : 'border-slate-700 text-slate-400'}`}
      style={{ fontFamily: FONT_MONO }}>
      <option value="">{placeholder}</option>
      {opts.map(o => {
        const val = Array.isArray(o) ? o[0] : o;
        const lbl = Array.isArray(o) ? o[1] : o;
        return <option key={val} value={val}>{lbl}</option>;
      })}
    </select>
  );
}

// =====================================================================
// RECORD DETAIL MODAL (complete duty record + audit trail, read-only)
// =====================================================================
function RecordDetailModal({ period: p, byId, now, onClose }) {
  const elapsed = dutyElapsed(p, now);
  const band = BAND_STYLE[dutyBand(elapsed)];
  const st = statusOf(p, now);
  const partner = p.partnerPeriodId ? byId.get(p.partnerPeriodId) : null;
  const edits = Array.isArray(p.adminEdits) ? p.adminEdits : [];

  const Row = ({ label, value, mono = true }) => (
    <div className="flex justify-between gap-4 py-1 border-b border-slate-800/50">
      <span className="text-[10px] tracking-wider text-slate-500 shrink-0" style={{ fontFamily: FONT_MONO }}>{label}</span>
      <span className={`text-[11px] text-slate-200 text-right ${mono ? '' : ''}`} style={{ fontFamily: mono ? FONT_MONO : FONT_BODY }}>{value}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-xl text-cyan-400 leading-none" style={{ fontFamily: FONT_HEAD, letterSpacing: '0.03em' }}>DUTY RECORD</div>
            <div className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: FONT_MONO }}>{p.id}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 border text-[10px] ${STATUS_STYLE[st]}`} style={{ fontFamily: FONT_MONO }}>{st}</span>
            <span className={`px-2 py-0.5 border text-[10px] ${band.border} ${band.text}`} style={{ fontFamily: FONT_MONO }}>{band.label}</span>
            {p.over14 && <span className="px-2 py-0.5 border border-red-500/50 text-red-400 text-[10px]" style={{ fontFamily: FONT_MONO }}>OVER 14H FLAG</span>}
            {isEdited(p) && <span className="px-2 py-0.5 border border-amber-500/40 text-amber-400 text-[10px]" style={{ fontFamily: FONT_MONO }}>EDITED</span>}
          </div>

          <div>
            <Row label="PILOT" value={`${p.pilotName || '—'}${p.role ? ` (${p.role})` : ''}`} />
            <Row label="CREW TYPE" value={p.crewType === 'two' ? 'TWO-PILOT' : 'SINGLE-PILOT'} />
            <Row label="PARTNER" value={partner ? `${partner.pilotName} (${partner.role || 'crew'})` : (p.crewType === 'two' ? '— link broken —' : '—')} />
            <Row label="AIRCRAFT" value={p.tail || '—'} />
            <Row label="TRIP" value={p.tripId || '—'} />
            <Row label="LOCATION" value={p.location || '—'} />
            <Row label="ASSIGNMENT" value={(p.assignmentType || '—').toUpperCase()} />
            <Row label="CONFIRM" value={(p.confirmStatus || '—').toUpperCase()} />
          </div>
          <div>
            <Row label="DUTY ON" value={fmtClock(p.dutyOnAt)} />
            <Row label="DUTY OFF" value={p.dutyOffAt ? fmtClock(p.dutyOffAt) : '— open —'} />
            <Row label="DUTY TIME" value={fmtHrs(elapsed)} />
            <Row label="FLIGHT TIME" value={Number.isFinite(p.flightTimeMs) ? fmtHrs(p.flightTimeMs) : '—'} />
            <Row label="PRIOR REST (ATTESTED)" value={Number.isFinite(p.priorRestMs) ? fmtHrs(p.priorRestMs) : '—'} />
          </div>
          {(p.overrideStatus && p.overrideStatus !== 'none') && (
            <div className="border border-amber-500/30 bg-amber-500/5 p-2">
              <Row label="OVERRIDE" value={(p.overrideStatus || '').toUpperCase()} />
              {p.overrideRequestReason && <Row label="REASON" value={p.overrideRequestReason} mono={false} />}
              {p.overrideApprovedBy && <Row label="APPROVED BY" value={p.overrideApprovedBy} />}
            </div>
          )}

          {/* audit trail */}
          <div>
            <div className="text-[10px] tracking-widest text-slate-500 mb-1 mt-2" style={{ fontFamily: FONT_MONO }}>
              AUDIT TRAIL ({edits.length})
            </div>
            {edits.length === 0 ? (
              <div className="text-[11px] text-slate-600" style={{ fontFamily: FONT_MONO }}>No edits recorded.</div>
            ) : (
              <div className="space-y-1">
                {edits.slice().reverse().map((e, i) => (
                  <div key={i} className="border border-slate-800 bg-slate-950/50 px-2 py-1.5">
                    <div className="flex justify-between text-[10px]" style={{ fontFamily: FONT_MONO }}>
                      <span className="text-cyan-300">{e.field}</span>
                      <span className="text-slate-500">{e.at ? fmtClock(e.at) : ''}</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5" style={{ fontFamily: FONT_MONO }}>
                      by {e.by || '—'}
                    </div>
                    {e.note && <div className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: FONT_BODY }}>{e.note}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="text-[9px] text-slate-600 pt-1" style={{ fontFamily: FONT_MONO }}>
            Created {p.createdAt ? fmtClock(p.createdAt) : '—'} · Updated {p.updatedAt ? fmtClock(p.updatedAt) : '—'}
            <br />Edits are made in the day editor (click a day on the Calendar) or Admin Duty Tools — never destructively.
          </div>
        </div>
      </div>
    </div>
  );
}
