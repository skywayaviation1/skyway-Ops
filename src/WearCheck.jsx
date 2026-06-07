// src/WearCheck.jsx
//
// Wear Watch UI — three exports:
//
//   <WearCheckBadge />          — small pill for the trip card showing
//                                 whether the first-flight or end-of-day
//                                 wear check is required, complete, or
//                                 deferred. Tap to open the modal.
//
//   <WearCheckModal />          — the full pilot inspection flow.
//                                 Photo + 4-button status pick per item.
//
//   <WearTab />                 — admin/ops/MX dashboard. Fleet grid
//                                 with rollup status per tail. Tap a
//                                 tail for the detail page (history,
//                                 per-item status, mark-replaced, etc.)
//
//   <WearTrainingLibrary />     — admin-only training library for AI
//                                 reference photos (Phase 2).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera, CheckCircle2, AlertTriangle, XCircle, Loader2, ChevronRight,
  ChevronLeft, X, Plane, Wrench, Activity, ShieldAlert, ShieldCheck,
  Clock, Image as ImageIcon, Trash2, Upload, Plus,
} from 'lucide-react';

import {
  TAIL_AIRCRAFT_TYPES, AIRCRAFT_WEAR_CONFIGS, WEAR_STATUS, STATUS_ORDER,
  INSPECTION_TYPES, ITEM_LABELS,
  configForTail, wearItemId, rollupStatus,
  uploadInspectionPhoto, uploadReplacementPhoto, uploadTrainingPhoto,
  saveWearInspection, markItemReplaced,
  saveTrainingPhoto, deleteTrainingPhoto,
  subscribeAllWearItems, subscribeWearItemsForTail,
  subscribeWearInspections, subscribeInspectionsForItem, subscribeTodayInspections,
  subscribeTrainingLibrary,
  checkComplete, requestAiAssessment,
} from './firebase-wear.js';

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STYLE TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_TAILWIND = {
  good:         { bg: 'bg-emerald-500/15', border: 'border-emerald-500/50', text: 'text-emerald-300', solid: 'bg-emerald-500', solidText: 'text-emerald-950' },
  monitor:      { bg: 'bg-amber-500/15',   border: 'border-amber-500/50',   text: 'text-amber-300',   solid: 'bg-amber-500',   solidText: 'text-amber-950' },
  replace_soon: { bg: 'bg-orange-500/15',  border: 'border-orange-500/50',  text: 'text-orange-300',  solid: 'bg-orange-500',  solidText: 'text-orange-950' },
  grounded:     { bg: 'bg-red-500/15',     border: 'border-red-500/50',     text: 'text-red-300',     solid: 'bg-red-500',     solidText: 'text-red-50' },
};

function StatusPill({ status, size = 'sm' }) {
  const s = WEAR_STATUS[status] || WEAR_STATUS.good;
  const t = STATUS_TAILWIND[status] || STATUS_TAILWIND.good;
  const cls = size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-[10px]';
  return (
    <span className={`${t.bg} ${t.border} ${t.text} border ${cls} tracking-widest font-bold`}
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {s.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// <WearCheckBadge /> — Tail-level wear-check status pill
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders one of:
//   - RED   "WEAR CHECK REQUIRED" — first-flight check not done for the tail today
//   - RED   "EOD CHECK REQUIRED"  — first-flight done, EOD not done yet
//   - AMBER "WEAR DEFERRED"       — a defer record exists for today
//   - GREEN "WEAR CHECK · OK"     — both checks complete for today
// Tapping opens <WearCheckModal /> with the appropriate inspection type.
//
// The caller is responsible for deciding WHERE the badge renders — e.g.
// TripDetail only renders it on the LAST scheduled leg of the day for the
// tail, so the badge naturally "moves" if a new leg is added later. The
// `isFirstFlightOfDay` / `isLastFlightOfDay` props are accepted for
// back-compat but no longer used to gate display inside this component.

export function WearCheckBadge({
  tail,
  isFirstFlightOfDay,    // accepted for back-compat; not used here
  isLastFlightOfDay,     // accepted for back-compat; not used here
  currentUser,
  tripId,
  legId,
  onOpenModal,
}) {
  const [todayInspections, setTodayInspections] = useState([]);
  useEffect(() => {
    if (!tail) return;
    const u = subscribeTodayInspections(tail, setTodayInspections);
    return () => u && u();
  }, [tail]);

  const firstFlightStatus = useMemo(
    () => checkComplete(tail, todayInspections, 'first_flight'),
    [tail, todayInspections],
  );
  const eodStatus = useMemo(
    () => checkComplete(tail, todayInspections, 'end_of_day'),
    [tail, todayInspections],
  );

  // What's needed for THIS tail TODAY, regardless of which leg this is.
  // The badge surfaces whichever check is most pressing first.
  const needFirstFlight = !firstFlightStatus.complete;
  const needEod = firstFlightStatus.complete && !eodStatus.complete;
  const wasDeferred = firstFlightStatus.deferred || eodStatus.deferred;
  const allDone = firstFlightStatus.complete && eodStatus.complete && !wasDeferred;

  let label, kind, openType;
  if (needFirstFlight) {
    label = 'WEAR CHECK REQUIRED';
    kind = 'red';
    openType = 'first_flight';
  } else if (needEod) {
    label = 'EOD CHECK REQUIRED';
    kind = 'red';
    openType = 'end_of_day';
  } else if (wasDeferred) {
    label = 'WEAR DEFERRED';
    kind = 'amber';
    openType = 'ad_hoc';
  } else {
    // allDone — green confirmation pill, still tappable for ad-hoc re-check
    label = 'WEAR CHECK · OK';
    kind = 'green';
    openType = 'ad_hoc';
  }

  const cls = {
    red:   'bg-red-500/20 border-red-500/60 text-red-200 animate-pulse',
    amber: 'bg-amber-500/15 border-amber-500/50 text-amber-200',
    green: 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/20',
    gray:  'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700',
  }[kind];

  return (
    <button
      onClick={() => onOpenModal({ tail, currentUser, tripId, legId, inspectionType: openType })}
      className={`inline-flex items-center gap-1.5 border ${cls} px-2 py-1 text-[10px] tracking-widest font-bold transition`}
      style={{ fontFamily: 'JetBrains Mono, monospace' }}
    >
      <Activity className="w-3 h-3" />
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// <WearCheckModal /> — Pilot inspection flow
// ─────────────────────────────────────────────────────────────────────────────

function PhotoCapture({ onCaptured, label = 'TAKE PHOTO' }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="w-full flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-cyan-500/40 bg-cyan-500/5 hover:bg-cyan-500/10 disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-8 h-8 text-cyan-300 animate-spin" /> : <Camera className="w-8 h-8 text-cyan-300" />}
        <span className="text-[11px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {busy ? 'UPLOADING…' : label}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true);
          try { await onCaptured(f); }
          finally { setBusy(false); e.target.value = ''; }
        }}
      />
    </div>
  );
}

function StatusPicker({ value, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {STATUS_ORDER.map((s) => {
        const t = STATUS_TAILWIND[s];
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={`px-3 py-3 border-2 tracking-widest text-sm font-bold transition ${
              active ? `${t.solid} ${t.solidText} border-transparent` : `${t.bg} ${t.border} ${t.text} hover:brightness-125`
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {WEAR_STATUS[s].label}
          </button>
        );
      })}
    </div>
  );
}

export function WearCheckModal({ tail, currentUser, tripId, legId, inspectionType = 'ad_hoc', onClose }) {
  const { type: aircraftType, config } = configForTail(tail);

  // Build the flat list of items to inspect, in order.
  const items = useMemo(() => {
    const list = [];
    for (const p of config.positions) {
      for (const it of p.items) {
        list.push({ position: p.id, positionLabel: p.label, itemType: it });
      }
    }
    return list;
  }, [config]);

  // Per-item draft state during the modal session.
  const [drafts, setDrafts] = useState({}); // key: `${position}:${itemType}` => { photoUrl, photoPath, status, notes }
  const [activeIdx, setActiveIdx] = useState(0);
  const [savingAll, setSavingAll] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [deferReason, setDeferReason] = useState('');
  const [err, setErr] = useState('');

  const active = items[activeIdx];
  const activeKey = active ? `${active.position}:${active.itemType}` : '';
  const activeDraft = drafts[activeKey] || {};

  const setDraft = (patch) => setDrafts((p) => ({ ...p, [activeKey]: { ...activeDraft, ...patch } }));

  const allDone = items.every((i) => {
    const k = `${i.position}:${i.itemType}`;
    const d = drafts[k];
    return d?.photoUrl && d?.status;
  });

  const onPhoto = async (file) => {
    try {
      const { url, path } = await uploadInspectionPhoto({
        tail, position: active.position, itemType: active.itemType, file,
      });
      setDraft({ photoUrl: url, photoPath: path });
    } catch (e) {
      setErr(e?.message || 'Upload failed');
    }
  };

  const onSubmit = async () => {
    if (!allDone) return;
    setSavingAll(true);
    setErr('');
    try {
      // Grab the ID token once for both notify + AI assessment
      let idToken = null;
      try { idToken = await currentUser?.getIdToken?.(); } catch (_) {}

      // Persist each item's inspection sequentially so AI assessment can
      // chain off it later. Updates the wear-items current state too.
      for (const it of items) {
        const k = `${it.position}:${it.itemType}`;
        const d = drafts[k];
        const inspectionId = await saveWearInspection({
          tail,
          position: it.position,
          itemType: it.itemType,
          pilotStatus: d.status,
          photoUrl: d.photoUrl,
          photoPath: d.photoPath,
          inspectedBy: currentUser?.uid,
          inspectedByName: currentUser?.name || currentUser?.displayName,
          inspectionType,
          legId,
          tripId,
          notes: d.notes || null,
          idToken, // triggers /api/wear-notify on status drop
        });
        // Phase 2 — fire-and-forget AI assessment
        if (idToken) requestAiAssessment({ idToken, inspectionId });
      }
      onClose();
    } catch (e) {
      setErr(e?.message || 'Save failed');
      setSavingAll(false);
    }
  };

  const onSubmitDefer = async () => {
    if (!deferReason.trim()) {
      setErr('Defer reason is required.');
      return;
    }
    setSavingAll(true);
    setErr('');
    try {
      let idToken = null;
      try { idToken = await currentUser?.getIdToken?.(); } catch (_) {}
      // Single defer record at the tail level — represents "skipping the
      // whole check on purpose for this inspectionType today." MX gets
      // notified via the email side-channel on save.
      await saveWearInspection({
        tail,
        position: 'all',
        itemType: 'all',
        pilotStatus: null,
        photoUrl: null,
        photoPath: null,
        inspectedBy: currentUser?.uid,
        inspectedByName: currentUser?.name || currentUser?.displayName,
        inspectionType,
        legId,
        tripId,
        notes: deferReason,
        isDeferred: true,
        deferReason,
        idToken,
      });
      onClose();
    } catch (e) {
      setErr(e?.message || 'Defer save failed');
      setSavingAll(false);
    }
  };

  // Render
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-4 overflow-y-auto"
      onClick={onClose}>
      <div className="bg-slate-950 border border-slate-700 w-full max-w-2xl my-4"
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Plane className="w-4 h-4 text-cyan-300" />
            <h3 className="text-sm tracking-widest text-slate-100"
              style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
              WEAR CHECK · {tail}
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-slate-800 bg-slate-900/50">
          <div className="text-[11px] tracking-widest text-slate-400"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {INSPECTION_TYPES[inspectionType] || 'Inspection'} · {config.label}
          </div>
        </div>

        {/* Item nav */}
        <div className="px-4 py-2 border-b border-slate-800 flex flex-wrap gap-1">
          {items.map((it, idx) => {
            const k = `${it.position}:${it.itemType}`;
            const d = drafts[k];
            const done = d?.photoUrl && d?.status;
            const isActive = idx === activeIdx;
            return (
              <button key={k} onClick={() => setActiveIdx(idx)}
                className={`px-2 py-1 text-[10px] tracking-widest border ${
                  isActive ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10' :
                  done ? 'border-emerald-500/50 text-emerald-300 bg-emerald-500/5' :
                  'border-slate-700 text-slate-500'
                }`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {done && <CheckCircle2 className="w-3 h-3 inline mr-1 -mt-0.5" />}
                {it.positionLabel.toUpperCase()} · {ITEM_LABELS[it.itemType].toUpperCase()}
              </button>
            );
          })}
        </div>

        {/* Active item body */}
        {!deferring && active && (
          <div className="p-4 space-y-3">
            <div className="text-xs text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              ITEM {activeIdx + 1} OF {items.length}
            </div>

            {/* Photo */}
            {activeDraft.photoUrl ? (
              <div className="relative">
                <img src={activeDraft.photoUrl} alt="" className="w-full max-h-72 object-contain bg-slate-900 border border-slate-700" />
                <button onClick={() => setDraft({ photoUrl: null, photoPath: null })}
                  className="absolute top-2 right-2 bg-slate-950/80 text-slate-100 px-2 py-1 text-[10px] tracking-widest border border-slate-700"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  RETAKE
                </button>
              </div>
            ) : (
              <PhotoCapture onCaptured={onPhoto} />
            )}

            {/* Status picker */}
            {activeDraft.photoUrl && (
              <div>
                <div className="text-[10px] tracking-widest text-slate-500 mb-1"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  CONDITION
                </div>
                <StatusPicker value={activeDraft.status} onChange={(s) => setDraft({ status: s })} />
              </div>
            )}

            {/* Optional note */}
            {activeDraft.photoUrl && activeDraft.status && (
              <div>
                <div className="text-[10px] tracking-widest text-slate-500 mb-1"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  NOTES (OPTIONAL)
                </div>
                <textarea
                  rows={2}
                  value={activeDraft.notes || ''}
                  onChange={(e) => setDraft({ notes: e.target.value })}
                  placeholder="e.g. uneven wear on outboard edge"
                  className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                  style={{ fontFamily: 'DM Sans, sans-serif' }}
                />
              </div>
            )}

            {/* Navigation */}
            <div className="flex items-center justify-between pt-2">
              <button onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
                disabled={activeIdx === 0}
                className="flex items-center gap-1 text-[10px] tracking-widest text-slate-300 disabled:opacity-30"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <ChevronLeft className="w-3 h-3" /> PREV
              </button>
              <button onClick={() => setActiveIdx((i) => Math.min(items.length - 1, i + 1))}
                disabled={activeIdx === items.length - 1}
                className="flex items-center gap-1 text-[10px] tracking-widest text-slate-300 disabled:opacity-30"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                NEXT <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* Defer flow */}
        {deferring && (
          <div className="p-4 space-y-3 bg-amber-500/5">
            <div className="flex items-center gap-2 text-amber-300">
              <AlertTriangle className="w-4 h-4" />
              <div className="text-[11px] tracking-widest font-bold"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                DEFER WITH REASON
              </div>
            </div>
            <div className="text-xs text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              Maintenance will be notified immediately. Use this only when conditions
              prevent a proper check (weather, ramp pressure, etc.).
            </div>
            <textarea
              rows={3}
              value={deferReason}
              onChange={(e) => setDeferReason(e.target.value)}
              placeholder="Why are you deferring the wear check?"
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </div>
        )}

        {err && (
          <div className="mx-4 mb-3 p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">
            {err}
          </div>
        )}

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-800 bg-slate-900/40">
          {!deferring ? (
            <>
              <button onClick={() => setDeferring(true)} disabled={savingAll}
                className="px-3 py-1.5 border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-[11px] tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                DEFER WITH REASON
              </button>
              <div className="flex items-center gap-2">
                <button onClick={onClose} disabled={savingAll}
                  className="px-3 py-1.5 border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] tracking-widest"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  CANCEL
                </button>
                <button onClick={onSubmit} disabled={!allDone || savingAll}
                  className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[11px] tracking-widest font-bold disabled:opacity-40"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {savingAll ? 'SAVING…' : `COMPLETE CHECK (${Object.keys(drafts).filter((k)=>drafts[k]?.status).length}/${items.length})`}
                </button>
              </div>
            </>
          ) : (
            <>
              <button onClick={() => { setDeferring(false); setDeferReason(''); }} disabled={savingAll}
                className="px-3 py-1.5 border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                BACK
              </button>
              <button onClick={onSubmitDefer} disabled={savingAll || !deferReason.trim()}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-amber-950 text-[11px] tracking-widest font-bold disabled:opacity-40"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {savingAll ? 'SAVING…' : 'SUBMIT DEFER'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// <WearTab /> — Admin/ops/MX dashboard
// ─────────────────────────────────────────────────────────────────────────────

function FleetTile({ tail, items, onSelect }) {
  const { config } = configForTail(tail);
  const tailItems = items.filter((i) => i.tail === tail);
  const rollup = rollupStatus(tailItems);
  const t = STATUS_TAILWIND[rollup];
  return (
    <button onClick={() => onSelect(tail)}
      className={`text-left p-3 border ${t.border} ${t.bg} hover:brightness-125 transition`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-lg font-bold text-slate-100" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            {tail}
          </div>
          <div className="text-[9px] tracking-widest text-slate-500"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {config.label.toUpperCase()}
          </div>
        </div>
        <StatusPill status={rollup} />
      </div>
      {/* Mini per-item color strip */}
      <div className="grid grid-cols-3 gap-1 mt-2">
        {config.positions.map((p) => {
          const posItems = tailItems.filter((i) => i.position === p.id);
          const posRollup = rollupStatus(posItems);
          const pt = STATUS_TAILWIND[posRollup];
          return (
            <div key={p.id} className="text-center">
              <div className={`h-1.5 ${pt.solid} mb-1`} />
              <div className="text-[8px] tracking-widest text-slate-500"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {p.label.replace('Gear ', '').toUpperCase()}
              </div>
            </div>
          );
        })}
      </div>
    </button>
  );
}

// Recent inspection log — horizontal strip of the last 6 photo inspections
// for ONE wear item. Tap a thumb to enlarge with full metadata. Skips
// deferred-with-reason entries since they have no photo.
function WearItemLog({ tail, position, itemType }) {
  const [inspections, setInspections] = useState([]);
  const [enlarged, setEnlarged] = useState(null);

  useEffect(() => {
    if (!tail || !position || !itemType) return;
    const u = subscribeInspectionsForItem(tail, position, itemType, setInspections, 12);
    return () => u && u();
  }, [tail, position, itemType]);

  const withPhotos = inspections.filter((i) => i.photoUrl && !i.isDeferred);
  if (withPhotos.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-slate-800">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9px] tracking-widest text-slate-500"
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
          WEAR LOG · LAST {Math.min(withPhotos.length, 6)} INSPECTIONS
        </div>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1 scroll-area">
        {withPhotos.slice(0, 6).map((i) => {
          const stat = i.pilotStatus || 'good';
          const tc = STATUS_TAILWIND[stat] || STATUS_TAILWIND.good;
          const dateLabel = i.inspectedAtMs
            ? new Date(i.inspectedAtMs).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
            : '';
          return (
            <button
              key={i.id}
              onClick={() => setEnlarged(i)}
              className={`flex-shrink-0 border-2 ${tc.border} bg-slate-900 w-[68px] hover:brightness-125 transition`}
              title={`${WEAR_STATUS[stat]?.label} · ${i.inspectedAtMs ? new Date(i.inspectedAtMs).toLocaleString() : ''}${i.inspectedByName ? ' · ' + i.inspectedByName : ''}`}
            >
              <img src={i.photoUrl} alt="" className="w-full h-14 object-cover" loading="lazy" />
              <div className={`text-[8px] tracking-widest px-1 py-0.5 ${tc.bg} ${tc.text} text-center font-bold`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {WEAR_STATUS[stat]?.label?.replace('REPLACE SOON', 'REPL') || '—'}
              </div>
              <div className="text-[8px] text-slate-500 text-center py-0.5"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {dateLabel}
              </div>
            </button>
          );
        })}
      </div>

      {/* Enlarged photo viewer */}
      {enlarged && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setEnlarged(null)}>
          <div className="max-w-3xl w-full bg-slate-950 border border-slate-700"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <div>
                <div className="text-[10px] tracking-widest text-slate-400"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {enlarged.tail} · {(enlarged.position || '').toUpperCase()} · {(enlarged.itemType || '').toUpperCase()}
                </div>
                <div className="text-xs text-slate-300 mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  {enlarged.inspectedAtMs ? new Date(enlarged.inspectedAtMs).toLocaleString() : '—'}
                  {enlarged.inspectedByName && <span className="text-slate-500"> · {enlarged.inspectedByName}</span>}
                </div>
              </div>
              <button onClick={() => setEnlarged(null)} className="text-slate-400 hover:text-slate-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <img src={enlarged.photoUrl} alt="" className="w-full max-h-[70vh] object-contain bg-slate-900" />
            <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between gap-3">
              <StatusPill status={enlarged.pilotStatus || 'good'} size="lg" />
              <div className="text-[10px] tracking-widest text-slate-500"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {INSPECTION_TYPES[enlarged.inspectionType] || enlarged.inspectionType || ''}
              </div>
            </div>
            {enlarged.notes && (
              <div className="px-4 pb-3 text-[12px] text-slate-300 italic"
                style={{ fontFamily: 'DM Sans, sans-serif' }}>
                "{enlarged.notes}"
              </div>
            )}
            {enlarged.aiAssessment && (
              <div className={`mx-4 mb-3 border ${enlarged.aiAssessment.discrepancy ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-700 bg-slate-900/40'} px-3 py-2`}>
                <div className="text-[9px] tracking-widest text-amber-300 mb-1"
                  style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
                  AI ASSESSMENT {enlarged.aiAssessment.discrepancy ? '· DISCREPANCY' : ''}
                </div>
                <div className="text-[11px] text-slate-200 flex items-center gap-2 flex-wrap">
                  <StatusPill status={enlarged.aiAssessment.status} />
                  <span className="text-slate-400 italic">{enlarged.aiAssessment.reasoning}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function WearItemCard({ item, onMarkReplaced, onOpenHistory }) {
  const t = STATUS_TAILWIND[item.status || 'good'];
  const cfg = AIRCRAFT_WEAR_CONFIGS[item.aircraftType];
  const posLabel = cfg?.positions.find((p) => p.id === item.position)?.label || item.position;
  return (
    <div className={`border ${t.border} ${t.bg} p-3`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <div className="text-[10px] tracking-widest text-slate-400"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {posLabel.toUpperCase()} · {ITEM_LABELS[item.itemType]?.toUpperCase()}
          </div>
          <div className="text-xs text-slate-500 mt-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {item.lastInspectedAtMs ? new Date(item.lastInspectedAtMs).toLocaleString() : 'Never inspected'}
            {item.lastInspectedByName && <span> · {item.lastInspectedByName}</span>}
          </div>
        </div>
        <StatusPill status={item.status || 'good'} />
      </div>
      {item.lastPhotoUrl && (
        <img src={item.lastPhotoUrl} alt=""
          className="w-full h-32 object-cover bg-slate-900 border border-slate-700 mb-2" />
      )}
      {item.lastNotes && (
        <div className="text-[11px] text-slate-300 italic mb-2"
          style={{ fontFamily: 'DM Sans, sans-serif' }}>
          “{item.lastNotes}”
        </div>
      )}
      {item.aiAssessment && (
        <div className={`border ${item.aiAssessment.discrepancy ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-700 bg-slate-900/40'} px-2 py-1.5 mb-2`}>
          <div className="text-[9px] tracking-widest text-amber-300 mb-0.5"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            AI ASSESSMENT {item.aiAssessment.discrepancy ? '· DISCREPANCY' : ''}
          </div>
          <div className="text-[11px] text-slate-200 flex items-center gap-2">
            <StatusPill status={item.aiAssessment.status} />
            <span className="text-slate-400 italic">{item.aiAssessment.reasoning}</span>
          </div>
        </div>
      )}
      {/* Recent inspection thumbnails — tap any to enlarge */}
      <WearItemLog tail={item.tail} position={item.position} itemType={item.itemType} />
      <div className="flex items-center justify-between gap-2 mt-3">
        <button onClick={() => onOpenHistory(item)}
          className="text-[10px] tracking-widest text-slate-400 hover:text-slate-200"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          HISTORY →
        </button>
        <button onClick={() => onMarkReplaced(item)}
          className="px-2 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-[10px] tracking-widest"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          MARK REPLACED
        </button>
      </div>
    </div>
  );
}

function MarkReplacedModal({ item, currentUser, onClose }) {
  const [file, setFile] = useState(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoPath, setPhotoPath] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onPhoto = async (f) => {
    try {
      const { url, path } = await uploadReplacementPhoto({
        tail: item.tail, position: item.position, itemType: item.itemType, file: f,
      });
      setPhotoUrl(url); setPhotoPath(path);
    } catch (e) { setErr(e?.message || 'Upload failed'); }
  };

  const onSubmit = async () => {
    if (!photoUrl) { setErr('Photo of new part is required.'); return; }
    setBusy(true);
    try {
      await markItemReplaced({
        tail: item.tail, position: item.position, itemType: item.itemType,
        photoUrl, photoPath,
        replacedBy: currentUser?.uid,
        replacedByName: currentUser?.name || currentUser?.displayName,
        notes,
      });
      onClose();
    } catch (e) {
      setErr(e?.message || 'Save failed');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="bg-slate-950 border border-slate-700 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-cyan-300" />
            <h3 className="text-sm tracking-widest text-slate-100"
              style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
              MARK REPLACED
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {item.tail} · {item.position.toUpperCase()} · {item.itemType.toUpperCase()}
          </div>
          {photoUrl ? (
            <div className="relative">
              <img src={photoUrl} alt="" className="w-full max-h-64 object-contain bg-slate-900 border border-slate-700" />
              <button onClick={() => { setPhotoUrl(''); setPhotoPath(''); }}
                className="absolute top-2 right-2 bg-slate-950/80 text-slate-100 px-2 py-1 text-[10px] tracking-widest border border-slate-700"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                RETAKE
              </button>
            </div>
          ) : (
            <PhotoCapture onCaptured={onPhoto} label="PHOTO OF NEW PART" />
          )}
          <div>
            <div className="text-[10px] tracking-widest text-slate-500 mb-1"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              NOTES (PART NO, VENDOR, ETC.)
            </div>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Goodyear F-Spec p/n 184F09-2, installed by Skyway MX"
              className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }} />
          </div>
          {err && <div className="p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-slate-900/40">
          <button onClick={onClose} disabled={busy}
            className="px-3 py-1.5 border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>CANCEL</button>
          <button onClick={onSubmit} disabled={busy || !photoUrl}
            className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[11px] tracking-widest font-bold disabled:opacity-40"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {busy ? 'SAVING…' : 'RECORD REPLACEMENT'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryDrawer({ item, onClose }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!item) return;
    const u = subscribeWearInspections(item.tail, (all) => {
      const filtered = all.filter((r) => r.position === item.position && r.itemType === item.itemType);
      setRows(filtered);
    });
    return () => u && u();
  }, [item]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="bg-slate-950 border border-slate-700 w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-950 z-10">
          <h3 className="text-sm tracking-widest text-slate-100"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            HISTORY · {item.tail} {item.position.toUpperCase()} {item.itemType.toUpperCase()}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {rows.length === 0 ? (
            <div className="text-sm text-slate-500 italic">No inspections logged yet.</div>
          ) : rows.map((r) => (
            <div key={r.id} className="border border-slate-800 p-3 bg-slate-900/40">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div>
                  <div className="text-[10px] tracking-widest text-slate-400"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {INSPECTION_TYPES[r.inspectionType] || r.inspectionType}
                  </div>
                  <div className="text-xs text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                    {r.inspectedAtMs ? new Date(r.inspectedAtMs).toLocaleString() : '—'} · {r.inspectedByName || '—'}
                  </div>
                </div>
                {r.isDeferred ? (
                  <span className="px-2 py-0.5 text-[10px] tracking-widest border border-amber-500/50 text-amber-300 bg-amber-500/10"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}>DEFERRED</span>
                ) : (
                  <StatusPill status={r.pilotStatus} />
                )}
              </div>
              {r.photoUrl && <img src={r.photoUrl} alt="" className="w-full max-h-48 object-cover bg-slate-900 border border-slate-700 mb-2" />}
              {r.notes && (
                <div className="text-[11px] text-slate-300 italic"
                  style={{ fontFamily: 'DM Sans, sans-serif' }}>“{r.notes}”</div>
              )}
              {r.aiAssessment && (
                <div className="mt-2 border border-slate-700 px-2 py-1.5">
                  <div className="text-[9px] tracking-widest text-amber-300"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}>AI</div>
                  <div className="text-[11px] text-slate-300 flex items-center gap-2">
                    <StatusPill status={r.aiAssessment.status} />
                    <span className="italic text-slate-400">{r.aiAssessment.reasoning}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TailDetail({ tail, currentUser, onBack }) {
  const [items, setItems] = useState([]);
  const [replacing, setReplacing] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  useEffect(() => {
    const u = subscribeWearItemsForTail(tail, setItems);
    return () => u && u();
  }, [tail]);

  const { config } = configForTail(tail);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-100">
          <ChevronLeft className="w-4 h-4 inline" /> BACK
        </button>
        <h2 className="text-2xl tracking-wider text-slate-100"
          style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
          {tail} · WEAR
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {config.positions.flatMap((p) =>
          p.items.map((it) => {
            const itemId = wearItemId(tail, p.id, it);
            const item = items.find((i) => i.id === itemId) || {
              id: itemId, tail, aircraftType: configForTail(tail).type,
              position: p.id, itemType: it, status: 'good',
            };
            return (
              <WearItemCard
                key={itemId} item={item}
                onMarkReplaced={(i) => setReplacing(i)}
                onOpenHistory={(i) => setHistoryFor(i)}
              />
            );
          }),
        )}
      </div>

      {replacing && <MarkReplacedModal item={replacing} currentUser={currentUser} onClose={() => setReplacing(null)} />}
      {historyFor && <HistoryDrawer item={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

export function WearTab({ currentUser }) {
  const [items, setItems] = useState([]);
  const [selectedTail, setSelectedTail] = useState(null);

  useEffect(() => {
    const u = subscribeAllWearItems(setItems);
    return () => u && u();
  }, []);

  if (selectedTail) {
    return <TailDetail tail={selectedTail} currentUser={currentUser} onBack={() => setSelectedTail(null)} />;
  }

  const tails = Object.keys(TAIL_AIRCRAFT_TYPES);
  // Sort tails by worst rollup first
  const sorted = [...tails].sort((a, b) => {
    const aR = rollupStatus(items.filter((i) => i.tail === a));
    const bR = rollupStatus(items.filter((i) => i.tail === b));
    return (WEAR_STATUS[bR]?.priority || 0) - (WEAR_STATUS[aR]?.priority || 0);
  });

  const buckets = {
    grounded: items.filter((i) => i.status === 'grounded').length,
    replace_soon: items.filter((i) => i.status === 'replace_soon').length,
    monitor: items.filter((i) => i.status === 'monitor').length,
    good: items.filter((i) => i.status === 'good').length,
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl tracking-wider text-slate-100"
          style={{ fontFamily: 'Bebas Neue, sans-serif' }}>WEAR WATCH</h2>
        <p className="text-xs text-slate-500 mt-1">
          Fleet tires + brakes. Statuses are logged by pilots on first flight + end of day. Tap a tail to drill in.
        </p>
      </div>

      {/* Bucket summary */}
      <div className="grid grid-cols-4 gap-2">
        {STATUS_ORDER.map((s) => {
          const t = STATUS_TAILWIND[s];
          return (
            <div key={s} className={`border ${t.border} ${t.bg} p-2`}>
              <div className={`text-[8px] tracking-widest ${t.text} font-bold`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {WEAR_STATUS[s].label}
              </div>
              <div className="text-xl" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                {buckets[s] || 0}
              </div>
            </div>
          );
        })}
      </div>

      {/* Fleet grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {sorted.map((tail) => (
          <FleetTile key={tail} tail={tail} items={items} onSelect={setSelectedTail} />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// <WearTrainingLibrary /> — Admin-only (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

export function WearTrainingLibrary({ currentUser }) {
  const [aircraftType, setAircraftType] = useState('cj3');
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const u = subscribeTrainingLibrary(aircraftType, setRows);
    return () => u && u();
  }, [aircraftType]);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ itemType: 'tire', status: 'good', notes: '' });
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoPath, setPhotoPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onPhoto = async (f) => {
    try {
      const { url, path } = await uploadTrainingPhoto({
        aircraftType, itemType: draft.itemType, status: draft.status, file: f,
      });
      setPhotoUrl(url); setPhotoPath(path);
    } catch (e) { setErr(e?.message || 'Upload failed'); }
  };

  const onSave = async () => {
    if (!photoUrl) { setErr('Photo required'); return; }
    setBusy(true);
    try {
      await saveTrainingPhoto({
        aircraftType, itemType: draft.itemType, status: draft.status,
        photoUrl, photoPath,
        addedBy: currentUser?.uid,
        addedByName: currentUser?.name || currentUser?.displayName,
        notes: draft.notes,
      });
      setAdding(false); setPhotoUrl(''); setPhotoPath(''); setDraft({ itemType: 'tire', status: 'good', notes: '' });
    } catch (e) { setErr(e?.message || 'Save failed'); }
    setBusy(false);
  };

  // Group by itemType -> status
  const grouped = useMemo(() => {
    const g = { tire: { good: [], monitor: [], replace_soon: [], grounded: [] },
                brake:{ good: [], monitor: [], replace_soon: [], grounded: [] } };
    for (const r of rows) {
      if (g[r.itemType] && g[r.itemType][r.status]) g[r.itemType][r.status].push(r);
    }
    return g;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl tracking-wider text-slate-100"
            style={{ fontFamily: 'Bebas Neue, sans-serif' }}>TRAINING LIBRARY</h2>
          <p className="text-xs text-slate-500 mt-1">
            Labeled reference photos. AI compares pilot inspections against this set when grading.
          </p>
        </div>
        <button onClick={() => setAdding(true)}
          className="flex items-center gap-1 px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[11px] tracking-widest font-bold"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <Plus className="w-3 h-3" /> ADD REFERENCE
        </button>
      </div>

      <div className="flex items-center gap-2">
        {Object.entries(AIRCRAFT_WEAR_CONFIGS).map(([id, cfg]) => (
          <button key={id} onClick={() => setAircraftType(id)}
            className={`px-3 py-1 text-[11px] tracking-widest border ${
              aircraftType === id ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10' : 'border-slate-700 text-slate-400'
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {cfg.label.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Buckets */}
      {['tire', 'brake'].map((it) => (
        <div key={it} className="border border-slate-800 p-3 bg-slate-950/40">
          <div className="text-sm tracking-widest text-slate-100 mb-2"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            {ITEM_LABELS[it].toUpperCase()}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {STATUS_ORDER.map((s) => {
              const t = STATUS_TAILWIND[s];
              const photos = grouped[it][s] || [];
              return (
                <div key={s} className={`border ${t.border} ${t.bg} p-2`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-[9px] tracking-widest ${t.text} font-bold`}
                      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {WEAR_STATUS[s].label}
                    </span>
                    <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{photos.length}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {photos.slice(0, 6).map((p) => (
                      <div key={p.id} className="relative group">
                        <img src={p.photoUrl} alt="" className="w-full h-12 object-cover bg-slate-900 border border-slate-700" />
                        <button onClick={() => deleteTrainingPhoto(p.id)}
                          className="absolute top-0.5 right-0.5 bg-red-500/80 text-white p-0.5 opacity-0 group-hover:opacity-100">
                          <Trash2 className="w-2 h-2" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Add modal */}
      {adding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setAdding(false)}>
          <div className="bg-slate-950 border border-slate-700 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm tracking-widest text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
                ADD REFERENCE PHOTO
              </h3>
              <button onClick={() => setAdding(false)}><X className="w-4 h-4 text-slate-400 hover:text-slate-100" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] tracking-widest text-slate-500 mb-1"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}>ITEM</div>
                  <select value={draft.itemType} onChange={(e) => setDraft((p) => ({ ...p, itemType: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100">
                    <option value="tire">Tire</option>
                    <option value="brake">Brake</option>
                  </select>
                </div>
                <div>
                  <div className="text-[10px] tracking-widest text-slate-500 mb-1"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}>LABEL</div>
                  <select value={draft.status} onChange={(e) => setDraft((p) => ({ ...p, status: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100">
                    {STATUS_ORDER.map((s) => <option key={s} value={s}>{WEAR_STATUS[s].label}</option>)}
                  </select>
                </div>
              </div>
              {photoUrl ? (
                <img src={photoUrl} alt="" className="w-full max-h-64 object-contain bg-slate-900 border border-slate-700" />
              ) : (
                <PhotoCapture onCaptured={onPhoto} label="UPLOAD REFERENCE PHOTO" />
              )}
              <textarea rows={2} value={draft.notes} onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
                placeholder="Optional notes (e.g. tread depth, what makes this category)"
                className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
                style={{ fontFamily: 'DM Sans, sans-serif' }} />
              {err && <div className="p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">{err}</div>}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-slate-900/40">
              <button onClick={() => setAdding(false)} disabled={busy}
                className="px-3 py-1.5 border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>CANCEL</button>
              <button onClick={onSave} disabled={busy || !photoUrl}
                className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[11px] tracking-widest font-bold disabled:opacity-40"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {busy ? 'SAVING…' : 'SAVE REFERENCE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
