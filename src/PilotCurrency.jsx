// src/PilotCurrency.jsx
//
// Pilot Currency & Training Dashboard — v3
//
// Tracks FAA baseline recency plus Part 135 qualifications, testing, training,
// special-role checks, and operator-specific items. Applicability is shown on
// every item because PIC-only, SIC-only, IFR-only, aircraft-specific, and
// check-pilot/instructor requirements must not be presented as universal.
//
// The JetInsight import columns remain supported:
//   - FAA recency (61.57 a/b/c)
//   - Part 135 general (basic indoc, 293(a) general ground/oral)
//   - Part 135 aircraft-specific (293(a)(2-3) and 293(b) × 4 type variants)
//   - Part 135 checks (297, 299)
//   - Training (CRM, emergency, hazmat, recurrent 343/351)
//   - Special ops (RVSM, TFSSP, DASSP)
//   - Badges (KCM — no expiration)
//   - Medical (separate, uses class + explicit expirationDate)
//
// Three view modes (admin toggles):
//
//   MATRIX  — JetInsight-style grid. Rows = pilots, columns = items.
//             Color-coded cells (green/yellow/orange/red/gray). Tap any
//             cell to drill into that pilot's item editor. Best for
//             "fleet at a glance."
//
//   CARDS   — Pilot-first. Each pilot is a card; expand to see all
//             their items grouped by category. Best for per-pilot
//             review and editing.
//
//   AGENDA  — Item-first. Each currency type listed with pilots due
//             soonest at top. Best for "schedule the sims this month."
//
// Editing happens through one modal regardless of view mode. Modal
// understands both direct due-date entry (matches JetInsight) and
// last-completed entry (system computes due).

import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import {
  ShieldCheck, ChevronDown, ChevronUp, X, Save, Edit3, Grid3x3,
  LayoutList, ListTree, AlertTriangle, CheckCircle2, Minus,
  Search, Upload, Loader2,
} from 'lucide-react';
import {
  CURRENCY_TYPES,
  STATUS_COLORS,
  computeStatus,
  computeMedicalStatus,
  rollupPilotStatus,
  subscribePilotCurrencies,
  subscribeMyPilotCurrency,
  savePilotCurrency,
} from './firebase-currency.js';

// Lazy-loaded bulk importer modal. Only pulled in when admin clicks
// IMPORT — keeps the dashboard load light for everyone else.
const CurrencyImporterLazy = lazy(() => import('./CurrencyImporter.jsx'));

const ACTIVE_TYPES = CURRENCY_TYPES.filter(t => !t.hidden && t.category !== 'LEGACY');

const CATEGORY_ORDER = [
  'FAA RECENCY',
  'PART 135 GENERAL',
  'AIRCRAFT-SPECIFIC',
  'PART 135 CHECKS',
  'TRAINING',
  'SPECIAL OPS',
  'BADGES',
];

const CATEGORY_COLORS = {
  'FAA RECENCY':       'text-cyan-400 border-cyan-500/40',
  'PART 135 GENERAL':  'text-violet-400 border-violet-500/40',
  'AIRCRAFT-SPECIFIC': 'text-orange-400 border-orange-500/40',
  'PART 135 CHECKS':   'text-blue-400 border-blue-500/40',
  'TRAINING':          'text-emerald-400 border-emerald-500/40',
  'SPECIAL OPS':       'text-pink-400 border-pink-500/40',
  'BADGES':            'text-yellow-400 border-yellow-500/40',
  'MEDICAL':           'text-red-400 border-red-500/40',
};

const TYPES_BY_CATEGORY = (() => {
  const map = {};
  for (const cat of CATEGORY_ORDER) map[cat] = [];
  for (const t of ACTIVE_TYPES) {
    if (!map[t.category]) map[t.category] = [];
    map[t.category].push(t);
  }
  return map;
})();

/* ═══════════════════════════════════════════════════════════════════
   ROOT
   ═══════════════════════════════════════════════════════════════════ */

export default function PilotCurrencyScreen({ currentUser, users, allTrips }) {
  const isAdminOrOps = currentUser?.role === 'admin' || currentUser?.role === 'ops';
  const isCrew = currentUser?.role === 'crew';

  const [currenciesByUid, setCurrenciesByUid] = useState({});
  useEffect(() => {
    if (!currentUser) return;
    let unsub = null;
    if (isAdminOrOps) {
      unsub = subscribePilotCurrencies(setCurrenciesByUid);
    } else if (isCrew) {
      unsub = subscribeMyPilotCurrency(currentUser.uid, setCurrenciesByUid);
    }
    return () => { if (unsub) unsub(); };
  }, [currentUser, isAdminOrOps, isCrew]);

  const todayMs = Date.now();
  // Do not infer §135.247/§61.57 landing currency from schedule assignment:
  // being listed as PIC/SIC does not prove sole manipulation or that the
  // takeoff/landing occurred. Currency must come from an actual pilot/training
  // record or an approved source.
  const currenciesEnriched = currenciesByUid;

  const pilots = useMemo(() => {
    if (isCrew) return users.filter(u => u.uid === currentUser.uid);
    return users
      .filter(u => u.uid && u.approved !== false)
      .filter(u => ['crew', 'admin', 'ops'].includes(u.role) || currenciesEnriched[u.uid])
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [users, currenciesEnriched, isCrew, currentUser?.uid]);

  const [view, setView] = useState('matrix');
  useEffect(() => { if (isCrew) setView('cards'); }, [isCrew]);

  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [editTarget, setEditTarget] = useState(null);
  const [showImporter, setShowImporter] = useState(false);

  const summary = useMemo(() => {
    let expired = 0, warning = 0, current = 0, unknown = 0;
    for (const p of pilots) {
      const r = rollupPilotStatus(currenciesEnriched[p.uid], todayMs);
      if (r.status === 'expired') expired++;
      else if (['critical', 'warning'].includes(r.status)) warning++;
      else if (r.status === 'current') current++;
      else unknown++;
    }
    return { expired, warning, current, unknown, total: pilots.length };
  }, [pilots, currenciesEnriched, todayMs]);

  const filteredPilots = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pilots.filter(p => {
      if (q && !(p.name || '').toLowerCase().includes(q) && !(p.email || '').toLowerCase().includes(q)) return false;
      if (statusFilter === 'all') return true;
      const r = rollupPilotStatus(currenciesEnriched[p.uid], todayMs);
      if (statusFilter === 'expired') return r.status === 'expired';
      if (statusFilter === 'expiring') return ['critical', 'warning'].includes(r.status);
      if (statusFilter === 'current') return r.status === 'current';
      if (statusFilter === 'unknown') return r.status === 'unknown';
      return true;
    });
  }, [pilots, search, statusFilter, currenciesEnriched, todayMs]);

  if (!currentUser) return <div className="p-6 text-slate-500 text-sm">Sign in required.</div>;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-950">
      <header className="px-4 py-3 border-b border-slate-800 bg-slate-900/40 shrink-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-cyan-400" />
            <h1 className="text-sm tracking-widest text-slate-200"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              PILOT CURRENCY &amp; TRAINING
            </h1>
          </div>
          {isAdminOrOps && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowImporter(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] tracking-widest border border-cyan-500/40 hover:border-cyan-400 text-cyan-300 hover:text-cyan-200"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                title="Bulk-import currency data from JetInsight"
              >
                <Upload className="w-3 h-3" /> IMPORT
              </button>
              <ViewToggle current={view} onChange={setView} />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
          <SummaryStat label="TOTAL" value={summary.total} tone="cyan" />
          <SummaryStat label="EXPIRED" value={summary.expired} tone="red" onClick={() => setStatusFilter('expired')} active={statusFilter === 'expired'} />
          <SummaryStat label="EXPIRING" value={summary.warning} tone="orange" onClick={() => setStatusFilter('expiring')} active={statusFilter === 'expiring'} />
          <SummaryStat label="CURRENT" value={summary.current} tone="emerald" onClick={() => setStatusFilter('current')} active={statusFilter === 'current'} />
          <SummaryStat label="NOT SET" value={summary.unknown} tone="slate" onClick={() => setStatusFilter('unknown')} active={statusFilter === 'unknown'} />
        </div>

        <div className="mt-3 border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-100/70" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          Requirements are applicability-aware. Mark PIC-only, SIC-only, IFR,
          aircraft-specific, special-authorization, or operator-program items N/A
          when they do not apply. The approved training program and OpSpecs remain controlling.
        </div>

        <div className="flex items-center gap-2 mt-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search pilot…"
              className="w-full bg-slate-950 border border-slate-800 pl-7 pr-2 py-1.5 text-xs text-slate-100"
            />
          </div>
          {statusFilter !== 'all' && (
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className="px-2 py-1.5 text-[10px] tracking-widest text-slate-400 hover:text-slate-200 border border-slate-800"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >CLEAR FILTER</button>
          )}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-auto">
        {view === 'matrix' && (
          <MatrixView pilots={filteredPilots} currencies={currenciesEnriched} todayMs={todayMs} canEdit={isAdminOrOps} onEdit={(uid, focusKey) => setEditTarget({ pilotUid: uid, focusKey })} />
        )}
        {view === 'cards' && (
          <CardsView pilots={filteredPilots} currencies={currenciesEnriched} todayMs={todayMs} canEdit={isAdminOrOps} onEdit={(uid, focusKey) => setEditTarget({ pilotUid: uid, focusKey })} />
        )}
        {view === 'agenda' && (
          <AgendaView pilots={filteredPilots} currencies={currenciesEnriched} todayMs={todayMs} canEdit={isAdminOrOps} onEdit={(uid, focusKey) => setEditTarget({ pilotUid: uid, focusKey })} />
        )}
      </main>

      {editTarget && (
        <EditCurrencyModal
          pilot={pilots.find(p => p.uid === editTarget.pilotUid)}
          existing={currenciesEnriched[editTarget.pilotUid]}
          focusKey={editTarget.focusKey}
          onClose={() => setEditTarget(null)}
          onSave={async (patch) => {
            await savePilotCurrency(editTarget.pilotUid, patch, currentUser.uid);
            setEditTarget(null);
          }}
        />
      )}

      {showImporter && isAdminOrOps && (
        <Suspense fallback={
          <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        }>
          <CurrencyImporterLazy
            users={users}
            currentUserUid={currentUser.uid}
            onClose={() => setShowImporter(false)}
            onImported={() => {
              // Subscription auto-refreshes; just close.
              setShowImporter(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   VIEW TOGGLE + SUMMARY STAT + STATUS PILL
   ═══════════════════════════════════════════════════════════════════ */

function ViewToggle({ current, onChange }) {
  const opts = [
    { id: 'matrix', icon: Grid3x3,    label: 'MATRIX' },
    { id: 'cards',  icon: LayoutList, label: 'CARDS' },
    { id: 'agenda', icon: ListTree,   label: 'AGENDA' },
  ];
  return (
    <div className="flex items-center bg-slate-950 border border-slate-800 p-0.5">
      {opts.map(o => {
        const active = o.id === current;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] tracking-widest ${active ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <o.icon className="w-3 h-3" /> {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SummaryStat({ label, value, tone, onClick, active }) {
  const tones = {
    cyan:    'text-cyan-400 border-cyan-500/30',
    red:     'text-red-300 border-red-500/40',
    orange:  'text-orange-300 border-orange-500/40',
    emerald: 'text-emerald-300 border-emerald-500/40',
    slate:   'text-slate-400 border-slate-700',
  };
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`text-left p-2 border ${tones[tone]} ${active ? 'bg-cyan-500/10 ring-1 ring-cyan-500/40' : 'bg-slate-950/40'} ${onClick ? 'hover:bg-slate-900 cursor-pointer' : ''}`}
    >
      <div className="text-[9px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      <div className={`text-2xl ${tones[tone].split(' ')[0]}`} style={{ fontFamily: 'Bebas Neue, sans-serif' }}>{value}</div>
    </Comp>
  );
}

function StatusPill({ status, daysUntil, compact = false }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  let txt = c.label;
  if (status === 'expired' && daysUntil != null) txt = `EXP ${Math.abs(daysUntil)}d`;
  else if (status === 'current' && daysUntil != null) txt = `${daysUntil}d`;
  else if (['caution', 'warning', 'critical'].includes(status) && daysUntil != null) txt = `${daysUntil}d`;
  return (
    <span className={`inline-block px-1.5 ${compact ? 'py-0' : 'py-0.5'} text-[9px] ${c.bg} ${c.border} ${c.text} border`}
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>{txt}</span>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MATRIX
   ═══════════════════════════════════════════════════════════════════ */

function MatrixView({ pilots, currencies, todayMs, canEdit, onEdit }) {
  const cellClick = (uid, key) => { if (canEdit) onEdit(uid, key); };
  return (
    <div className="overflow-auto">
      <table className="border-separate" style={{ borderSpacing: 0 }}>
        <thead className="sticky top-0 z-20">
          <tr>
            <th className="bg-slate-900/95 border-b border-slate-800 px-3 py-2 text-left sticky left-0 z-30 min-w-[180px]">
              <span className="text-[9px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PILOT</span>
            </th>
            <th className="bg-slate-900/95 border-b border-slate-800 px-3 py-2 text-left sticky left-[180px] z-30 min-w-[60px]">
              <span className="text-[9px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>MED</span>
            </th>
            {CATEGORY_ORDER.map(cat => {
              const list = TYPES_BY_CATEGORY[cat] || [];
              if (list.length === 0) return null;
              const color = CATEGORY_COLORS[cat] || 'text-slate-400 border-slate-700';
              return (
                <th key={cat} colSpan={list.length} className={`bg-slate-900/95 border-b border-l ${color} px-2 py-1.5 text-left whitespace-nowrap`}>
                  <span className="text-[9px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{cat}</span>
                </th>
              );
            })}
          </tr>
          <tr>
            <th className="bg-slate-900/95 border-b border-slate-800 sticky left-0 z-30"></th>
            <th className="bg-slate-900/95 border-b border-slate-800 sticky left-[180px] z-30"></th>
            {CATEGORY_ORDER.flatMap(cat => (TYPES_BY_CATEGORY[cat] || []).map((t, i) => (
              <th key={t.key} className={`bg-slate-900/95 border-b border-slate-800 ${i === 0 ? 'border-l border-slate-700' : ''} px-2 py-2 text-left whitespace-nowrap min-w-[100px]`} title={t.label}>
                <span className="text-[10px] text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{t.abbrev}</span>
              </th>
            )))}
          </tr>
        </thead>
        <tbody>
          {pilots.length === 0 && (
            <tr>
              <td colSpan={ACTIVE_TYPES.length + 2} className="px-3 py-10 text-center text-slate-500 text-sm italic">
                No pilots match the current filter.
              </td>
            </tr>
          )}
          {pilots.map(pilot => {
            const doc = currencies[pilot.uid] || {};
            const rollup = rollupPilotStatus(doc, todayMs);
            const rowColor = rollup.status === 'expired' ? 'bg-red-950/20' : ['critical', 'warning'].includes(rollup.status) ? 'bg-orange-950/15' : '';
            return (
              <tr key={pilot.uid} className={`${rowColor} hover:bg-slate-800/30 transition-colors`}>
                <td
                  className={`sticky left-0 z-10 bg-slate-950 border-r border-slate-800 px-3 py-1.5 text-sm text-slate-100 cursor-pointer ${rowColor}`}
                  onClick={() => canEdit && onEdit(pilot.uid)}
                >
                  <div className="text-slate-100 leading-tight">{pilot.name || pilot.email}</div>
                  <div className="text-[9px] text-slate-500 leading-tight" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {(pilot.role || 'crew').toUpperCase()}
                  </div>
                </td>
                <td
                  className={`sticky left-[180px] z-10 bg-slate-950 border-r border-slate-800 px-2 py-1.5 cursor-pointer ${rowColor}`}
                  onClick={() => cellClick(pilot.uid, '__medical__')}
                >
                  <MatrixCell result={computeMedicalStatus(doc.medical, todayMs)} />
                </td>
                {CATEGORY_ORDER.flatMap(cat => (TYPES_BY_CATEGORY[cat] || []).map((t, i) => {
                  const r = computeStatus(doc[t.key], t.interval, todayMs, t);
                  return (
                    <td key={t.key} className={`px-2 py-1.5 ${i === 0 ? 'border-l border-slate-800' : ''} cursor-pointer`} onClick={() => cellClick(pilot.uid, t.key)}>
                      <MatrixCell result={r} />
                    </td>
                  );
                }))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MatrixCell({ result }) {
  const c = STATUS_COLORS[result.status] || STATUS_COLORS.unknown;
  if (result.status === 'na') {
    return <div className="flex items-center justify-center h-7"><Minus className="w-3 h-3 text-slate-700" /></div>;
  }
  if (result.status === 'noExpiration') {
    return <div className={`flex items-center justify-center h-7 ${c.bg} border ${c.border}`}><CheckCircle2 className="w-3 h-3 text-cyan-300" /></div>;
  }
  if (result.status === 'unknown') {
    return (
      <div className="flex items-center justify-center h-7 border border-slate-800 bg-slate-900/30">
        <span className="text-[9px] text-slate-600" style={{ fontFamily: 'JetBrains Mono, monospace' }}>—</span>
      </div>
    );
  }
  return (
    <div
      className={`flex flex-col items-center justify-center h-7 ${c.bg} border ${c.border}`}
      title={`${result.status.toUpperCase()} · due ${result.dueDate || '—'}${result.graceDate ? ` · grace through ${result.graceDate}` : ''}`}
    >
      <span className={`text-[9px] ${c.text} leading-none`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {result.dueDate ? result.dueDate.slice(5).replace('-', '/') : ''}
      </span>
      <span className={`text-[8px] ${c.text} leading-none opacity-70`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {result.daysUntil < 0 ? `${Math.abs(result.daysUntil)}d AGO` : `${result.daysUntil}d`}
      </span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CARDS
   ═══════════════════════════════════════════════════════════════════ */

function CardsView({ pilots, currencies, todayMs, canEdit, onEdit }) {
  const [expandedUid, setExpandedUid] = useState(null);
  return (
    <div className="p-4 space-y-3">
      {pilots.length === 0 && (
        <div className="text-center text-slate-500 text-sm italic py-10">No pilots match the current filter.</div>
      )}
      {pilots.map(p => {
        const doc = currencies[p.uid] || {};
        const rollup = rollupPilotStatus(doc, todayMs);
        const isExpanded = expandedUid === p.uid;
        const c = STATUS_COLORS[rollup.status] || STATUS_COLORS.unknown;
        return (
          <div key={p.uid} className={`border ${c.border} bg-slate-900/40`}>
            <button type="button" onClick={() => setExpandedUid(isExpanded ? null : p.uid)} className="w-full flex items-center justify-between gap-3 p-3 hover:bg-slate-800/40">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-1 h-10 ${c.bg.replace('/15', '/40').replace('/30', '/40')}`}></div>
                <div className="min-w-0 text-left">
                  <div className="text-sm text-slate-100 truncate">{p.name || p.email}</div>
                  <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {(p.role || 'crew').toUpperCase()}
                    {rollup.expiredCount > 0 && <span className="text-red-300 ml-2">· {rollup.expiredCount} EXPIRED</span>}
                    {rollup.warningCount > 0 && <span className="text-orange-300 ml-2">· {rollup.warningCount} EXPIRING</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <StatusPill status={rollup.status} daysUntil={rollup.worstDays} />
                {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
              </div>
            </button>
            {isExpanded && (
              <div className="border-t border-slate-800 p-3 space-y-3">
                <CategoryBlock cat="MEDICAL" rows={[{ type: { key: '__medical__', label: 'FAA Medical Certificate' }, result: computeMedicalStatus(doc.medical, todayMs), extra: doc.medical?.class || '' }]} pilotUid={p.uid} canEdit={canEdit} onEdit={onEdit} />
                {CATEGORY_ORDER.map(cat => {
                  const types = TYPES_BY_CATEGORY[cat] || [];
                  if (types.length === 0) return null;
                  const rows = types.map(t => ({ type: t, result: computeStatus(doc[t.key], t.interval, todayMs, t) }));
                  const visible = rows.filter(r => r.result.status !== 'na');
                  if (visible.length === 0) return null;
                  return <CategoryBlock key={cat} cat={cat} rows={visible} pilotUid={p.uid} canEdit={canEdit} onEdit={onEdit} />;
                })}
                {canEdit && (
                  <div className="pt-2">
                    <button type="button" onClick={() => onEdit(p.uid)} className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] tracking-widest text-cyan-300 hover:text-cyan-200 border border-cyan-500/30 hover:border-cyan-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      <Edit3 className="w-3 h-3" /> EDIT ALL ITEMS
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CategoryBlock({ cat, rows, pilotUid, canEdit, onEdit }) {
  const color = CATEGORY_COLORS[cat] || 'text-slate-400 border-slate-700';
  return (
    <div className={`border-l-2 ${color.split(' ')[1]} pl-3`}>
      <div className={`text-[10px] tracking-widest ${color.split(' ')[0]} mb-1.5`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{cat}</div>
      <div className="space-y-1">
        {rows.map(({ type, result, extra }) => (
          <button key={type.key} type="button" onClick={() => canEdit && onEdit(pilotUid, type.key)} className="w-full flex items-center justify-between gap-3 p-1.5 hover:bg-slate-800/40 text-left">
            <div className="min-w-0">
              <div className="text-xs text-slate-200 truncate">{type.label}</div>
              {extra && <div className="text-[9px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{extra}</div>}
              {result.dueDate && (
                <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>Due {result.dueDate}</div>
              )}
              {result.graceDate && (
                <div className="text-[9px] text-amber-400/70" style={{ fontFamily: 'JetBrains Mono, monospace' }}>Grace through {result.graceDate}</div>
              )}
            </div>
            <StatusPill status={result.status} daysUntil={result.daysUntil} />
          </button>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENDA
   ═══════════════════════════════════════════════════════════════════ */

function AgendaView({ pilots, currencies, todayMs, canEdit, onEdit }) {
  const groups = useMemo(() => {
    const out = [];
    for (const cat of CATEGORY_ORDER) {
      const types = TYPES_BY_CATEGORY[cat] || [];
      for (const t of types) {
        const items = [];
        for (const p of pilots) {
          const doc = currencies[p.uid] || {};
          const r = computeStatus(doc[t.key], t.interval, todayMs, t);
          if (r.status === 'na') continue;
          items.push({ pilot: p, result: r });
        }
        const ord = (status) => ({ expired: 0, critical: 1, warning: 2, caution: 3, unknown: 4, current: 5, noExpiration: 6 }[status] ?? 9);
        items.sort((a, b) => {
          const d = ord(a.result.status) - ord(b.result.status);
          if (d !== 0) return d;
          return (a.result.daysUntil ?? 99999) - (b.result.daysUntil ?? 99999);
        });
        out.push({ type: t, category: cat, items });
      }
    }
    return out;
  }, [pilots, currencies, todayMs]);

  return (
    <div className="p-4 space-y-4">
      {CATEGORY_ORDER.map(cat => {
        const inCat = groups.filter(g => g.category === cat);
        if (inCat.length === 0) return null;
        const color = CATEGORY_COLORS[cat] || 'text-slate-400 border-slate-700';
        return (
          <div key={cat}>
            <div className={`text-xs tracking-widest mb-2 ${color.split(' ')[0]}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{cat}</div>
            <div className="space-y-2">
              {inCat.map(g => (
                <details key={g.type.key} className="border border-slate-800 bg-slate-900/40">
                  <summary className="flex items-center justify-between gap-3 p-3 cursor-pointer hover:bg-slate-800/40 select-none">
                    <div className="min-w-0">
                      <div className="text-sm text-slate-200">{g.type.label}</div>
                      <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        {g.items.length} pilot{g.items.length === 1 ? '' : 's'} tracked
                        {g.type.interval
                          ? ` · ${g.type.interval}-day cadence`
                          : g.type.intervalMonths
                            ? ` · ${g.type.intervalMonths}-calendar-month cadence`
                            : g.type.noExpiration
                              ? ' · no expiration'
                              : ' · operator-defined due date'}
                      </div>
                    </div>
                    <div className="shrink-0"><ChevronDown className="w-4 h-4 text-slate-500" /></div>
                  </summary>
                  <div className="border-t border-slate-800 divide-y divide-slate-800/50">
                    {g.items.length === 0 && (
                      <div className="p-3 text-xs text-slate-500 italic text-center">No applicable pilots</div>
                    )}
                    {g.items.map(({ pilot, result }) => (
                      <button key={pilot.uid} type="button" onClick={() => canEdit && onEdit(pilot.uid, g.type.key)} className="w-full flex items-center justify-between gap-3 p-3 hover:bg-slate-800/40 text-left">
                        <div className="min-w-0">
                          <div className="text-sm text-slate-100 truncate">{pilot.name || pilot.email}</div>
                          {result.dueDate && (
                            <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>Due {result.dueDate}</div>
                          )}
                          {result.graceDate && (
                            <div className="text-[9px] text-amber-400/70" style={{ fontFamily: 'JetBrains Mono, monospace' }}>Grace through {result.graceDate}</div>
                          )}
                        </div>
                        <StatusPill status={result.status} daysUntil={result.daysUntil} />
                      </button>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   EDIT MODAL
   ═══════════════════════════════════════════════════════════════════ */

function EditCurrencyModal({ pilot, existing, focusKey, onClose, onSave }) {
  if (!pilot) return null;

  const buildInitial = () => {
    const d = {};
    for (const t of CURRENCY_TYPES) {
      const ex = existing?.[t.key] || {};
      d[t.key] = {
        dueDate: ex.dueDate || '',
        lastDate: ex.lastDate || '',
        graceDate: ex.graceDate || '',
        notes: ex.notes || '',
        notApplicable: ex.notApplicable === true,
        present: ex.present === true,
      };
    }
    d.medical = {
      class: existing?.medical?.class || '',
      expirationDate: existing?.medical?.expirationDate || '',
      notes: existing?.medical?.notes || '',
    };
    return d;
  };
  const [draft, setDraft] = useState(buildInitial());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const setItem = (key, patch) => setDraft(d => ({ ...d, [key]: { ...d[key], ...patch } }));

  const handleSave = async () => {
    setErr(null); setSaving(true);
    try {
      const patch = {};
      for (const t of CURRENCY_TYPES) {
        const cur = draft[t.key] || {};
        const existingItem = existing?.[t.key];
        const hasData = existingItem
          || cur.dueDate
          || cur.lastDate
          || cur.graceDate
          || cur.notes
          || cur.notApplicable
          || cur.present;
        if (hasData) {
          patch[t.key] = {
            dueDate: cur.dueDate || '',
            lastDate: cur.lastDate || '',
            graceDate: cur.graceDate || '',
            notes: cur.notes || '',
            notApplicable: cur.notApplicable === true,
            ...(t.noExpiration ? { present: cur.present === true } : {}),
          };
        }
      }
      if (draft.medical?.class || draft.medical?.expirationDate || draft.medical?.notes) {
        patch.medical = {
          class: draft.medical.class || '',
          expirationDate: draft.medical.expirationDate || '',
          notes: draft.medical.notes || '',
        };
      }
      patch.pilotName = pilot.name || '';
      await onSave(patch);
    } catch (e) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-2">
      <div className="w-full max-w-4xl bg-slate-900 border border-slate-700 flex flex-col max-h-[95vh]">
        <div className="flex items-center justify-between p-3 border-b border-slate-800 shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm tracking-widest text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              EDIT CURRENCY · {pilot.name || pilot.email}
            </h3>
            <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              Enter DUE DATE (printed on certificate) — or LAST date and let the system compute due.
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          <CategoryEditBlock label="MEDICAL" color={CATEGORY_COLORS.MEDICAL} defaultOpen={focusKey === '__medical__'}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <FieldLabel label="CLASS">
                <select value={draft.medical.class} onChange={e => setDraft(d => ({ ...d, medical: { ...d.medical, class: e.target.value } }))} className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100">
                  <option value="">—</option>
                  <option value="First">First</option>
                  <option value="Second">Second</option>
                  <option value="Third">Third</option>
                  <option value="BasicMed">BasicMed (not valid for Part 135 duty)</option>
                </select>
              </FieldLabel>
              <FieldLabel label="EXPIRATION (YYYY-MM-DD)">
                <input type="date" value={draft.medical.expirationDate} onChange={e => setDraft(d => ({ ...d, medical: { ...d.medical, expirationDate: e.target.value } }))} className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100" />
              </FieldLabel>
              <FieldLabel label="NOTES">
                <input type="text" value={draft.medical.notes} onChange={e => setDraft(d => ({ ...d, medical: { ...d.medical, notes: e.target.value } }))} className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100" />
              </FieldLabel>
            </div>
            <div className="mt-2 text-[10px] text-amber-300/70">
              BasicMed does not authorize Part 135 pilot service. Record the FAA medical class and actual expiration used for the assignment.
            </div>
          </CategoryEditBlock>

          {CATEGORY_ORDER.map(cat => {
            const types = TYPES_BY_CATEGORY[cat] || [];
            if (types.length === 0) return null;
            const hasFocus = focusKey && types.some(t => t.key === focusKey);
            return (
              <CategoryEditBlock key={cat} label={cat} color={CATEGORY_COLORS[cat]} defaultOpen={hasFocus}>
                <div className="space-y-3">
                  {types.map(t => (
                    <ItemEditRow key={t.key} type={t} value={draft[t.key]} onChange={(patch) => setItem(t.key, patch)} focused={focusKey === t.key} />
                  ))}
                </div>
              </CategoryEditBlock>
            );
          })}

          {err && (
            <div className="border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {err}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-slate-800 flex items-center justify-end gap-2 shrink-0">
          <button type="button" onClick={onClose} className="px-3 py-2 text-[11px] tracking-widest text-slate-400 hover:text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CANCEL</button>
          <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-2 text-[11px] tracking-widest bg-cyan-500 hover:bg-cyan-400 text-slate-950 disabled:opacity-50 inline-flex items-center gap-2" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            <Save className="w-3 h-3" /> SAVE
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function CategoryEditBlock({ label, color, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const c = color || 'text-slate-400 border-slate-700';
  return (
    <div className={`border ${c.split(' ')[1]}`}>
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 p-2.5 bg-slate-950/40 hover:bg-slate-900">
        <span className={`text-[10px] tracking-widest ${c.split(' ')[0]}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
      </button>
      {open && <div className="p-3 border-t border-slate-800">{children}</div>}
    </div>
  );
}

function ItemEditRow({ type, value, onChange, focused }) {
  return (
    <div className={`border border-slate-800 ${focused ? 'ring-1 ring-cyan-500/40' : ''} p-2.5 bg-slate-950/30`}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-xs text-slate-200">{type.label}</div>
          {type.notes && <div className="text-[10px] text-slate-500 italic">{type.notes}</div>}
            {type.applicability && (
              <div className="mt-0.5 text-[10px] text-cyan-400/70">
                Applies: {type.applicability}
              </div>
            )}
            {type.citation && (
              <div className="text-[9px] text-slate-600" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {type.citation}
              </div>
            )}
        </div>
        <label className="flex items-center gap-1.5 text-[10px] text-slate-500 shrink-0 cursor-pointer">
          <input type="checkbox" checked={value.notApplicable} onChange={e => onChange({ notApplicable: e.target.checked })} className="accent-slate-500" />
          <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>N/A</span>
        </label>
      </div>
      {!value.notApplicable && (
        type.noExpiration ? (
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input type="checkbox" checked={value.present} onChange={e => onChange({ present: e.target.checked })} className="accent-cyan-500" />
            <span>Active / on file</span>
          </label>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <FieldLabel label="DUE DATE (from cert)">
              <input type="date" value={value.dueDate} onChange={e => onChange({ dueDate: e.target.value })} className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-slate-100" />
            </FieldLabel>
            <FieldLabel label="GRACE (optional)">
              <input type="date" value={value.graceDate} onChange={e => onChange({ graceDate: e.target.value })} className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-slate-100" />
            </FieldLabel>
            <FieldLabel label="OR LAST COMPLETED">
              <input type="date" value={value.lastDate} onChange={e => onChange({ lastDate: e.target.value })} className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-slate-100" />
            </FieldLabel>
          </div>
        )
      )}
    </div>
  );
}

function FieldLabel({ label, children }) {
  return (
    <label className="block">
      <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      {children}
    </label>
  );
}
