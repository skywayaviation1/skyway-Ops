// src/PilotCurrency.jsx
//
// Pilot Currency & Training Dashboard
//
// Single screen that surfaces every tracked pilot's compliance status
// for FAA currencies (61.57), Part 135 checkrides (293/297/299), and
// recurrent training (351), plus medical certificate expiration.
//
// Audience:
//   - Admin / ops: full view of all crew, can edit any pilot's dates
//   - Crew: read-only view of THEIR OWN record (auto-filtered)
//
// Surface design:
//   Sticky header with summary counts + filter chips
//   Vertical list of pilot cards (mobile-first, scales fine to desktop)
//   Each card collapsed shows worst-status badge + summary line
//   Expanded shows every currency type with its own status + due date
//   Admin sees Edit icon on each card → modal editor
//
// Data flow:
//   subscribePilotCurrencies → currenciesByUid (admin)
//   subscribeMyPilotCurrency → {[uid]: doc} (crew)
//   For each pilot in users[] (filtered to role='crew'), join the
//   currency doc, compute statuses, render.

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ShieldCheck, ChevronDown, ChevronUp, X, Save, Edit3,
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

export default function PilotCurrencyScreen({ currentUser, users }) {
  // Role gating: admin + ops can see everyone and edit; crew sees self
  // only, read-only. We treat 'admin' and 'ops' as the editable roles
  // here — chief pilot duties usually fall to ops, and admin has god
  // mode by convention elsewhere in the app.
  const isAdminOrOps = currentUser?.role === 'admin' || currentUser?.role === 'ops';
  const isCrew = currentUser?.role === 'crew';

  const [currenciesByUid, setCurrenciesByUid] = useState({});
  const [filterMode, setFilterMode] = useState('all');     // all | expired | expiring | current
  const [sortMode, setSortMode] = useState('soonest');     // soonest | name
  const [expandedUid, setExpandedUid] = useState(null);
  const [editingUid, setEditingUid] = useState(null);

  useEffect(() => {
    if (isAdminOrOps) {
      return subscribePilotCurrencies(setCurrenciesByUid);
    }
    if (isCrew && currentUser?.uid) {
      return subscribeMyPilotCurrency(currentUser.uid, (d) => {
        setCurrenciesByUid(d ? { [currentUser.uid]: d } : {});
      });
    }
    return undefined;
  }, [isAdminOrOps, isCrew, currentUser?.uid]);

  // Pilot universe. Admin/ops sees all approved crew. Crew sees just
  // themselves. We deliberately exclude unapproved users — they haven't
  // been activated and shouldn't appear on a compliance dashboard.
  const pilots = useMemo(() => {
    if (isCrew && currentUser) return [currentUser];
    return (users || []).filter((u) => u.role === 'crew' && u.approved !== false);
  }, [users, isCrew, currentUser]);

  // Today snapshot — computed once per render. For status calcs to
  // remain stable across renders during one user session this is fine;
  // a multi-day-open tab will see updates re-flow on the next re-render.
  const todayMs = Date.now();

  // Join + roll up per pilot.
  const pilotRows = useMemo(() => {
    return pilots.map((p) => {
      const docForPilot = currenciesByUid[p.uid] || null;
      const rollup = rollupPilotStatus(docForPilot, todayMs);
      return { pilot: p, doc: docForPilot, rollup };
    });
  }, [pilots, currenciesByUid, todayMs]);

  // Apply filter chips
  const filteredRows = useMemo(() => {
    if (filterMode === 'all') return pilotRows;
    if (filterMode === 'expired')  return pilotRows.filter((r) => r.rollup.expiredCount > 0);
    if (filterMode === 'expiring') return pilotRows.filter((r) => r.rollup.expiredCount > 0 || r.rollup.warningCount > 0);
    if (filterMode === 'current')  return pilotRows.filter((r) => r.rollup.expiredCount === 0 && r.rollup.warningCount === 0 && r.rollup.status !== 'unknown');
    return pilotRows;
  }, [pilotRows, filterMode]);

  // Sort. SOONEST puts the most urgent at the top — what an ops manager
  // wants to see first thing in the morning.
  const sortedRows = useMemo(() => {
    const rows = [...filteredRows];
    if (sortMode === 'name') {
      rows.sort((a, b) => (a.pilot.name || a.pilot.email || '').localeCompare(b.pilot.name || b.pilot.email || ''));
    } else {
      rows.sort((a, b) => {
        const aDays = a.rollup.worstDays;
        const bDays = b.rollup.worstDays;
        if (aDays == null && bDays == null) return 0;
        if (aDays == null) return 1;
        if (bDays == null) return -1;
        return aDays - bDays;
      });
    }
    return rows;
  }, [filteredRows, sortMode]);

  // Header summary counts. "unset" surfaces pilots that need their
  // currency data initialized — invisible work the dashboard makes
  // visible.
  const summary = useMemo(() => {
    let expired = 0, warning = 0, current = 0, unset = 0;
    for (const r of pilotRows) {
      if (r.rollup.status === 'unknown') unset++;
      else if (r.rollup.expiredCount > 0) expired++;
      else if (r.rollup.warningCount > 0) warning++;
      else current++;
    }
    return { expired, warning, current, unset, total: pilotRows.length };
  }, [pilotRows]);

  return (
    <div className="flex-1 overflow-y-auto scroll-area">
      {/* HEADER — sticky so the title + filters stay visible as ops scrolls. */}
      <div className="sticky top-0 z-10 bg-slate-950 border-b border-slate-800 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl tracking-wider text-slate-100 flex items-center gap-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              <ShieldCheck className="w-5 h-5 text-cyan-400" />
              PILOT CURRENCY & TRAINING
            </h1>
            <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-3">
              <span>{summary.total} pilot{summary.total !== 1 ? 's' : ''}</span>
              {summary.expired > 0 && <span className="text-red-400">{summary.expired} EXPIRED</span>}
              {summary.warning > 0 && <span className="text-orange-400">{summary.warning} EXPIRING</span>}
              {summary.unset > 0 && <span className="text-slate-500">{summary.unset} not set up</span>}
              {summary.current > 0 && <span className="text-emerald-400">{summary.current} CURRENT</span>}
            </div>
          </div>
        </div>

        {isAdminOrOps && (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <div className="flex gap-1 text-xs">
              {[
                { id: 'all',      label: 'ALL' },
                { id: 'expired',  label: 'EXPIRED' },
                { id: 'expiring', label: 'EXPIRING' },
                { id: 'current',  label: 'CURRENT' },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilterMode(f.id)}
                  className={`px-3 py-1.5 border tracking-wider transition-colors ${
                    filterMode === f.id
                      ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                      : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-1 text-xs">
              <span className="text-slate-600 self-center mr-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>SORT</span>
              {[
                { id: 'soonest', label: 'SOONEST' },
                { id: 'name',    label: 'NAME' },
              ].map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSortMode(s.id)}
                  className={`px-3 py-1.5 border tracking-wider transition-colors ${
                    sortMode === s.id
                      ? 'bg-slate-700/50 border-slate-600 text-slate-200'
                      : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* PILOT CARDS */}
      <div className="p-4 space-y-3 max-w-4xl mx-auto">
        {sortedRows.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">
            {filterMode === 'all'
              ? 'No pilots visible yet. Approved users with role=crew will show up here.'
              : 'No pilots match this filter.'}
          </div>
        ) : sortedRows.map(({ pilot, doc: pilotDoc, rollup }) => (
          <PilotCard
            key={pilot.uid}
            pilot={pilot}
            currencyDoc={pilotDoc}
            rollup={rollup}
            expanded={expandedUid === pilot.uid}
            onToggle={() => setExpandedUid(expandedUid === pilot.uid ? null : pilot.uid)}
            onEdit={isAdminOrOps ? () => setEditingUid(pilot.uid) : null}
            todayMs={todayMs}
          />
        ))}
      </div>

      {/* EDIT MODAL — admin/ops only */}
      {editingUid && isAdminOrOps && (
        <PilotCurrencyEditor
          pilot={pilots.find((p) => p.uid === editingUid)}
          existing={currenciesByUid[editingUid] || null}
          currentUser={currentUser}
          onClose={() => setEditingUid(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// PILOT CARD
// ============================================================
//
// Collapsed: status badge + name + summary line
// Expanded: every currency type as its own row with status + due date

function PilotCard({ pilot, currencyDoc, rollup, expanded, onToggle, onEdit, todayMs }) {
  const statusColor = STATUS_COLORS[rollup.status] || STATUS_COLORS.unknown;

  return (
    <div className={`bg-slate-900/60 border ${statusColor.border}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-slate-800/30 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div
            className={`px-2 py-1 ${statusColor.bg} ${statusColor.border} border text-xs tracking-wider ${statusColor.text} shrink-0`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {statusColor.label}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-slate-100 text-base font-medium truncate">
              {pilot.name || pilot.email || 'Unknown'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {rollup.status === 'unknown' && 'Currency data not yet entered'}
              {rollup.expiredCount > 0 && (
                <span className="text-red-400">
                  {rollup.expiredCount} expired item{rollup.expiredCount !== 1 ? 's' : ''}
                </span>
              )}
              {rollup.expiredCount === 0 && rollup.warningCount > 0 && (
                <span className="text-orange-400">
                  {rollup.warningCount} expiring soon
                  {rollup.worstDays != null && ` · ${rollup.worstDays}d`}
                </span>
              )}
              {rollup.expiredCount === 0 && rollup.warningCount === 0 && rollup.status !== 'unknown' && (
                <span className="text-emerald-400">
                  All current{rollup.worstDays != null && ` · next due in ${rollup.worstDays}d`}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="p-2 text-slate-400 hover:text-cyan-300 hover:bg-slate-800/50 transition-colors"
              title="Edit"
            >
              <Edit3 className="w-4 h-4" />
            </button>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-4 py-2 bg-slate-950/40">
          {CURRENCY_TYPES.map((type) => (
            <CurrencyRow
              key={type.key}
              type={type}
              item={currencyDoc?.[type.key]}
              todayMs={todayMs}
            />
          ))}
          <MedicalRow medical={currencyDoc?.medical} todayMs={todayMs} />
        </div>
      )}
    </div>
  );
}

// One row in the expanded card — either a CURRENCY_TYPE or medical.
function CurrencyRow({ type, item, todayMs }) {
  const r = computeStatus(item, type.interval, todayMs);
  const colors = STATUS_COLORS[r.status] || STATUS_COLORS.unknown;
  return (
    <div className="flex items-start justify-between py-3 border-b border-slate-800/50 last:border-b-0">
      <div className="flex-1 min-w-0 pr-3">
        <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {type.category}
        </div>
        <div className="text-sm text-slate-200 mt-0.5">{type.abbrev}</div>
        <div className="text-xs text-slate-500 mt-0.5">{type.notes}</div>
        {item?.notes && (
          <div className="text-xs text-slate-400 mt-1 italic">"{item.notes}"</div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div
          className={`text-[10px] tracking-widest ${colors.text}`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {colors.label}
        </div>
        {r.dueDate && (
          <div className="text-xs text-slate-400 mt-1">
            {r.daysUntil >= 0 ? `due ${r.dueDate}` : `was due ${r.dueDate}`}
          </div>
        )}
        {r.daysUntil != null && (
          <div className={`text-xs mt-0.5 ${r.status === 'expired' ? 'text-red-400' : 'text-slate-500'}`}>
            {r.daysUntil >= 0 ? `${r.daysUntil}d remaining` : `${-r.daysUntil}d overdue`}
          </div>
        )}
      </div>
    </div>
  );
}

function MedicalRow({ medical, todayMs }) {
  const r = computeMedicalStatus(medical, todayMs);
  const colors = STATUS_COLORS[r.status] || STATUS_COLORS.unknown;
  return (
    <div className="flex items-start justify-between py-3">
      <div className="flex-1 min-w-0 pr-3">
        <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          MEDICAL
        </div>
        <div className="text-sm text-slate-200 mt-0.5">
          {medical?.class ? `${medical.class} Class` : 'FAA / BasicMed'}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">Certificate expiration</div>
        {medical?.notes && (
          <div className="text-xs text-slate-400 mt-1 italic">"{medical.notes}"</div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className={`text-[10px] tracking-widest ${colors.text}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {colors.label}
        </div>
        {r.dueDate && (
          <div className="text-xs text-slate-400 mt-1">
            {r.daysUntil >= 0 ? `expires ${r.dueDate}` : `expired ${r.dueDate}`}
          </div>
        )}
        {r.daysUntil != null && (
          <div className={`text-xs mt-0.5 ${r.status === 'expired' ? 'text-red-400' : 'text-slate-500'}`}>
            {r.daysUntil >= 0 ? `${r.daysUntil}d remaining` : `${-r.daysUntil}d overdue`}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// EDIT MODAL
// ============================================================
//
// Admin / ops only. Renders every CURRENCY_TYPE as a date+notes pair
// plus the medical block (class dropdown + explicit expiration date).
//
// Note: dates use <input type="date"> so we get the native picker on
// every platform without a date-picker library.

function PilotCurrencyEditor({ pilot, existing, currentUser, onClose }) {
  const [draft, setDraft] = useState(() => {
    const d = {};
    for (const type of CURRENCY_TYPES) {
      d[type.key] = {
        lastDate: existing?.[type.key]?.lastDate || '',
        notes:    existing?.[type.key]?.notes || '',
      };
    }
    d.medical = {
      class:           existing?.medical?.class || '',
      expirationDate:  existing?.medical?.expirationDate || '',
      notes:           existing?.medical?.notes || '',
    };
    return d;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const onSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      await savePilotCurrency(pilot.uid, draft, currentUser?.uid, pilot.name);
      onClose();
    } catch (e) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-slate-950/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-lg sm:my-8 flex flex-col min-h-screen sm:min-h-0 sm:max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-lg tracking-wider text-slate-100 truncate" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              EDIT CURRENCY · {pilot?.name || pilot?.email || 'PILOT'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Enter the LAST completed date. System computes when each item next comes due.
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-200 shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {CURRENCY_TYPES.map((type) => (
            <div key={type.key} className="border border-slate-800 p-3">
              <div className="text-[10px] text-slate-500 tracking-widest mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {type.category} · {type.abbrev}
              </div>
              <div className="text-sm text-slate-200 mb-1">{type.label}</div>
              <div className="text-xs text-slate-500 mb-3">{type.notes} ({type.interval}d cycle)</div>
              <input
                type="date"
                value={draft[type.key].lastDate}
                onChange={(e) => setDraft((d) => ({
                  ...d,
                  [type.key]: { ...d[type.key], lastDate: e.target.value },
                }))}
                className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              />
              <input
                type="text"
                value={draft[type.key].notes}
                onChange={(e) => setDraft((d) => ({
                  ...d,
                  [type.key]: { ...d[type.key], notes: e.target.value },
                }))}
                placeholder="Notes (sim center, instructor, aircraft, etc.)"
                className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 mt-2"
              />
            </div>
          ))}

          {/* Medical block */}
          <div className="border border-slate-800 p-3">
            <div className="text-[10px] text-slate-500 tracking-widest mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              MEDICAL
            </div>
            <div className="text-sm text-slate-200 mb-1">FAA Medical / BasicMed</div>
            <div className="text-xs text-slate-500 mb-3">Use the expiration printed on the certificate.</div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={draft.medical.class}
                onChange={(e) => setDraft((d) => ({ ...d, medical: { ...d.medical, class: e.target.value } }))}
                className="bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              >
                <option value="">— Class —</option>
                <option value="First">First Class</option>
                <option value="Second">Second Class</option>
                <option value="Third">Third Class</option>
                <option value="BasicMed">BasicMed</option>
              </select>
              <input
                type="date"
                value={draft.medical.expirationDate}
                onChange={(e) => setDraft((d) => ({ ...d, medical: { ...d.medical, expirationDate: e.target.value } }))}
                className="bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <input
              type="text"
              value={draft.medical.notes}
              onChange={(e) => setDraft((d) => ({ ...d, medical: { ...d.medical, notes: e.target.value } }))}
              placeholder="Notes (AME, restrictions, etc.)"
              className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 mt-2"
            />
          </div>
        </div>

        {err && (
          <div className="px-4 py-2 text-xs text-red-400 border-t border-slate-800 shrink-0">{err}</div>
        )}

        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 disabled:opacity-50"
          >
            CANCEL
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="px-4 py-2 text-sm bg-cyan-500 text-slate-950 tracking-wider hover:bg-cyan-400 disabled:opacity-50 flex items-center gap-2"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Save className="w-4 h-4" />
            {saving ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
