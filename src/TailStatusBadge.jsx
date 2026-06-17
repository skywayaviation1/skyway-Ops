// src/TailStatusBadge.jsx
//
// Surfaces open squawks and active MEL deferrals for a tail on the
// trip detail hero card. PICs see at trip-acceptance time exactly
// what's open against the aircraft they're about to fly.
//
// Composition:
//   <TailStatusBadge tail="N20UF" />
//
// Subscribes to maint-squawks and maint-mel filtered by tail.
// Renders nothing if no open items. When items exist, shows a colored
// pill button with severity + count. Tap → modal listing every item
// with description, category, days remaining, and reporter.
//
// Severity precedence:
//   GROUNDING  any grounding squawk         red
//   SQUAWK     any open squawk              orange
//   MEL        only MEL deferrals open      yellow
//
// Backed entirely by the existing firebase-maint.js module. No new
// Firestore collections, no new helpers. Pure UI surface that joins
// data the maint dashboard already manages.

import { useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import {
  subscribeSquawks,
  subscribeMel,
  melDaysRemaining,
} from './firebase-maint.js';

export default function TailStatusBadge({ tail }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [squawks, setSquawks] = useState([]);
  const [melItems, setMelItems] = useState([]);

  useEffect(() => {
    if (!tail) return undefined;
    const unsubs = [];
    // Filter at the query layer (where('tail','==',...)) — keeps the
    // client lean on big fleets and avoids re-rendering when other
    // tails' squawks change.
    unsubs.push(subscribeSquawks(
      (list) => setSquawks(list.filter((s) => s.status !== 'closed')),
      { tail }
    ));
    unsubs.push(subscribeMel(
      (list) => setMelItems(list.filter((m) => m.status === 'open')),
      { tail }
    ));
    return () => { for (const fn of unsubs) fn(); };
  }, [tail]);

  // Compute counts + severity
  const counts = useMemo(() => {
    const grounding = squawks.filter((s) => s.grounding === true);
    const openNonGrounding = squawks.filter((s) => s.grounding !== true);
    return {
      grounding: grounding.length,
      openSquawks: openNonGrounding.length,
      melCount: melItems.length,
      total: squawks.length + melItems.length,
    };
  }, [squawks, melItems]);

  // No badge if there's nothing to show
  if (counts.total === 0) return null;

  // Severity → color + label
  let palette;
  let label;
  if (counts.grounding > 0) {
    palette = { bg: 'bg-red-500/30', border: 'border-red-500/60', text: 'text-red-200' };
    label = 'GROUNDED';
  } else if (counts.openSquawks > 0) {
    palette = { bg: 'bg-orange-500/20', border: 'border-orange-500/40', text: 'text-orange-300' };
    label = `${counts.openSquawks} SQUAWK${counts.openSquawks > 1 ? 'S' : ''}`;
  } else {
    palette = { bg: 'bg-yellow-500/15', border: 'border-yellow-500/30', text: 'text-yellow-300' };
    label = `${counts.melCount} MEL${counts.melCount > 1 ? '' : ''}`;
  }

  // Show extra count for the OTHER category in compact form
  let extraSuffix = '';
  if (counts.grounding > 0 && (counts.openSquawks > 0 || counts.melCount > 0)) {
    extraSuffix = ` +${counts.openSquawks + counts.melCount}`;
  } else if (counts.openSquawks > 0 && counts.melCount > 0) {
    extraSuffix = ` +${counts.melCount}M`;
  }

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        className={`px-2 py-1 ${palette.bg} ${palette.border} border ${palette.text} text-xs tracking-wider flex items-center gap-1.5 hover:brightness-110 transition-all`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
        title={`${tail} — ${counts.total} open item${counts.total !== 1 ? 's' : ''}`}
      >
        <AlertTriangle className="w-3 h-3" />
        <span>{label}{extraSuffix}</span>
      </button>

      {modalOpen && (
        <TailStatusModal
          tail={tail}
          squawks={squawks}
          melItems={melItems}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

// Modal listing every open item for the tail. Grounding squawks float
// to the top; everything else sorts by recency.
function TailStatusModal({ tail, squawks, melItems, onClose }) {
  const sortedSquawks = useMemo(() => {
    return [...squawks].sort((a, b) => {
      if (a.grounding !== b.grounding) return a.grounding ? -1 : 1;
      return (b.reportedAt || 0) - (a.reportedAt || 0);
    });
  }, [squawks]);

  const sortedMel = useMemo(() => {
    // Most-urgent MEL first (least days remaining, then by deferredAt)
    return [...melItems].sort((a, b) => {
      const aDays = melDaysRemaining(a);
      const bDays = melDaysRemaining(b);
      const aFinite = Number.isFinite(aDays);
      const bFinite = Number.isFinite(bDays);
      if (aFinite && bFinite) return aDays - bDays;
      if (aFinite) return -1;
      if (bFinite) return 1;
      return (b.deferredAt || 0) - (a.deferredAt || 0);
    });
  }, [melItems]);

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-slate-950/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-lg sm:my-8 flex flex-col min-h-screen sm:min-h-0 sm:max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-lg tracking-wider text-slate-100 truncate" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              {tail} STATUS
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {squawks.length} open squawk{squawks.length !== 1 ? 's' : ''}
              {' · '}
              {melItems.length} active MEL{melItems.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-200 shrink-0"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {sortedSquawks.length > 0 && (
            <div>
              <div className="text-[10px] tracking-widest text-slate-500 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                OPEN SQUAWKS
              </div>
              <div className="space-y-2">
                {sortedSquawks.map((s) => <SquawkRow key={s.id} squawk={s} />)}
              </div>
            </div>
          )}

          {sortedMel.length > 0 && (
            <div>
              <div className="text-[10px] tracking-widest text-slate-500 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                ACTIVE MEL DEFERRALS
              </div>
              <div className="space-y-2">
                {sortedMel.map((m) => <MelRow key={m.id} item={m} />)}
              </div>
            </div>
          )}

          {sortedSquawks.length === 0 && sortedMel.length === 0 && (
            <div className="text-center py-8 text-slate-500 text-sm">
              No open squawks or MEL deferrals.
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-between shrink-0">
          <div className="text-xs text-slate-500">
            Full triage in MAINT → SQUAWKS or MEL.
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-slate-700 text-slate-200 hover:bg-slate-600 tracking-wider"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function SquawkRow({ squawk }) {
  const palette = squawk.grounding === true
    ? { bg: 'bg-red-500/15', border: 'border-red-500/40', text: 'text-red-300', label: 'GROUNDING' }
    : { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-300', label: 'OPEN' };
  return (
    <div className={`p-3 ${palette.bg} border ${palette.border}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className={`text-[10px] tracking-widest ${palette.text}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {palette.label}
        </div>
        <div className="text-xs text-slate-500 shrink-0">
          {squawk.reportedAt ? new Date(squawk.reportedAt).toLocaleDateString() : ''}
        </div>
      </div>
      <div className="text-sm text-slate-200 break-words">{squawk.description}</div>
      <div className="text-xs text-slate-500 mt-1">
        Reported by {squawk.reportedByName || 'Unknown'}
        {squawk.tripLabel && <span className="text-slate-600"> · {squawk.tripLabel}</span>}
      </div>
    </div>
  );
}

function MelRow({ item }) {
  const daysRemaining = melDaysRemaining(item);
  const isOverdue = Number.isFinite(daysRemaining) && daysRemaining < 0;
  const palette = isOverdue
    ? { bg: 'bg-red-500/15', border: 'border-red-500/40', text: 'text-red-300' }
    : { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-300' };
  return (
    <div className={`p-3 ${palette.bg} border ${palette.border}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className={`text-[10px] tracking-widest ${palette.text}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          CAT {item.category}
          {item.melItemRef && <span className="ml-2 text-slate-400">· {item.melItemRef}</span>}
        </div>
        <div className="text-xs text-slate-500 shrink-0">
          {Number.isFinite(daysRemaining) ? (
            isOverdue
              ? <span className="text-red-400">{-daysRemaining}d OVERDUE</span>
              : <span>{daysRemaining}d remaining</span>
          ) : (
            'no fixed limit'
          )}
        </div>
      </div>
      <div className="text-sm text-slate-200 break-words">{item.description}</div>
      {item.partDeferred && (
        <div className="text-xs text-slate-400 mt-1">{item.partDeferred}</div>
      )}
      {item.remarks && (
        <div className="text-xs text-slate-500 mt-1 italic break-words">"{item.remarks}"</div>
      )}
      <div className="text-xs text-slate-500 mt-1">
        Deferred {item.deferredAt ? new Date(item.deferredAt).toLocaleDateString() : ''}
      </div>
    </div>
  );
}
