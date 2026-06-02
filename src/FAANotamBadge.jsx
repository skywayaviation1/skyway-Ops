// src/FAANotamBadge.jsx
//
// Compact inline badge that displays operationally-significant NOTAMs
// for an airport. Renders NOTHING when there are no significant NOTAMs
// — silent by default so it doesn't add noise to the UI for airports
// without issues.
//
// Used in two places:
//   1. Trip detail hero card in App.jsx (ops view)
//   2. Broker tracking page TripTrack.jsx
//
// Behavior:
//   - Fetches /api/faa-notams?icao={code} on mount
//   - 10-min client cache (server has its own Firestore cache too)
//   - Shows a colored badge if significantOnly.length > 0
//   - Click → expand panel with the NOTAM list
//   - Silent (returns null) when no significant NOTAMs
//   - Silent on errors too — never shows a "couldn't load NOTAMs" message
//     to the user. We don't want to alarm brokers because our endpoint
//     failed.
//
// Auth: for AUTHENTICATED callers (ops app), pass `getIdToken` prop —
// component will Bearer-auth the API call. For UNAUTHENTICATED callers
// (broker page), omit `getIdToken`; the endpoint allows anonymous reads
// since NOTAM data is public FAA info.

import React, { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, X } from 'lucide-react';

// In-memory cache shared across all instances of the badge in this page.
// Keyed by ICAO. 10-min TTL matches the server cache.
const _notamCache = new Map();
const CLIENT_TTL_MS = 10 * 60 * 1000;

async function fetchNotamsFor(icao, getIdToken) {
  if (!icao) return null;
  const key = String(icao).toUpperCase();
  const now = Date.now();
  const cached = _notamCache.get(key);
  if (cached && (now - cached.fetchedAt) < CLIENT_TTL_MS) return cached.data;
  const headers = { 'Accept': 'application/json' };
  if (getIdToken) {
    try {
      const t = await getIdToken();
      if (t) headers['Authorization'] = `Bearer ${t}`;
    } catch (_) { /* anonymous fallback */ }
  }
  try {
    const r = await fetch(`/api/faa-notams?icao=${encodeURIComponent(key)}`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    _notamCache.set(key, { data, fetchedAt: now });
    return data;
  } catch (_) {
    return null;
  }
}

// Severity → visual tone. We use the SAME palette as the existing
// weather badge so the two indicators read consistently when shown
// next to each other.
const TONE = {
  high:   { border: 'border-red-500/60',     bg: 'bg-red-500/10',     text: 'text-red-300',     dot: 'bg-red-400' },
  medium: { border: 'border-amber-500/50',   bg: 'bg-amber-500/10',   text: 'text-amber-300',   dot: 'bg-amber-400' },
  low:    { border: 'border-slate-500/40',   bg: 'bg-slate-500/10',   text: 'text-slate-300',   dot: 'bg-slate-400' },
};

// Compute the highest severity among a list of NOTAMs. high > medium > low.
function maxSeverity(notams) {
  if (!notams || notams.length === 0) return null;
  if (notams.some((n) => n.severity === 'high')) return 'high';
  if (notams.some((n) => n.severity === 'medium')) return 'medium';
  return 'low';
}

// Format a NOTAM effective window for display. "ACTIVE UNTIL 14 JUN 18:00Z"
// or "EFFECTIVE NOW" if no end date. Compact.
function formatWindow(notam) {
  const now = Date.now();
  if (notam.effectiveEnd) {
    const d = new Date(notam.effectiveEnd);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `UNTIL ${day} ${mon} ${hh}${mm}Z`;
  }
  if (notam.effectiveStart && notam.effectiveStart > now) {
    const d = new Date(notam.effectiveStart);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
    return `FROM ${day} ${mon}`;
  }
  return 'ACTIVE';
}

export default function FAANotamBadge({ icao, getIdToken, compact = true }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchNotamsFor(icao, getIdToken).then((d) => {
      if (cancelled) return;
      setData(d);
    });
    return () => { cancelled = true; };
  }, [icao]); // eslint-disable-line react-hooks/exhaustive-deps

  // The badge is the centerpiece of this component's contract: silent
  // when nothing significant is reported. This is intentional — every
  // major US airport has dozens of routine NOTAMs at any moment and
  // surfacing them all is noise.
  const significant = data?.significantOnly || [];
  if (significant.length === 0) return null;

  const severity = maxSeverity(significant) || 'medium';
  const tone = TONE[severity];
  const count = significant.length;
  // Pick the highest-severity NOTAM for the badge label
  const primary = [...significant].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
  })[0];

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] tracking-wider border ${tone.border} ${tone.bg} ${tone.text} rounded-sm cursor-pointer`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
        title={`${count} active NOTAM${count === 1 ? '' : 's'} — click for details`}
      >
        <AlertTriangle className="w-2.5 h-2.5" />
        NOTAM{count > 1 ? ` ×${count}` : ''}
        {!compact && primary && (
          <span className="ml-1 text-slate-400 normal-case">· {primary.summary}</span>
        )}
      </button>

      {open && (
        <NotamPanel
          icao={icao}
          notams={significant}
          allNotams={data?.notams || []}
          fetchedAt={data?.fetchedAt}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

// Expanded panel — shows the significant NOTAMs in detail. Click-outside
// to close. Positioned absolutely below the badge.
function NotamPanel({ icao, notams, allNotams, fetchedAt, onClose }) {
  // Track an "expanded" mode that shows ALL NOTAMs (including routine
  // ones we filtered out by default). Useful for crew that wants the
  // full picture before a leg.
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? allNotams : notams;
  const ageStr = fetchedAt
    ? `Updated ${Math.max(1, Math.floor((Date.now() - fetchedAt) / 60000))}m ago`
    : '';

  return (
    <>
      {/* Click-outside backdrop. Transparent — just intercepts clicks. */}
      <div
        className="fixed inset-0 z-40"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      />
      <div
        className="absolute z-50 mt-1 right-0 w-[340px] max-h-[420px] overflow-y-auto border border-slate-700 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 sticky top-0 bg-slate-950">
          <div>
            <div className="text-xs tracking-widest text-slate-300">
              {icao} · NOTAMs
            </div>
            <div className="text-[9px] text-slate-600">{ageStr}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* List */}
        <div className="divide-y divide-slate-800">
          {list.length === 0 ? (
            <div className="px-3 py-4 text-[10px] text-slate-500">No NOTAMs to display.</div>
          ) : (
            list.map((n) => (
              <NotamRow key={n.id || Math.random()} notam={n} />
            ))
          )}
        </div>

        {/* Toggle full / significant only */}
        {allNotams.length > notams.length && (
          <div className="px-3 py-2 border-t border-slate-800 sticky bottom-0 bg-slate-950">
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="text-[9px] tracking-widest text-cyan-400/70 hover:text-cyan-400"
            >
              {showAll
                ? `▾ HIDE ROUTINE · SHOW ${notams.length} SIGNIFICANT`
                : `▸ SHOW ALL ${allNotams.length} NOTAMs (incl. routine)`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function NotamRow({ notam }) {
  const tone = TONE[notam.severity] || TONE.low;
  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline gap-2 mb-1">
        <span className={`inline-flex items-center gap-1 px-1 text-[9px] ${tone.text}`}>
          <span className={`w-1 h-1 rounded-full ${tone.dot}`} />
          {notam.type}
        </span>
        {notam.id && (
          <span className="text-[9px] text-slate-600">{notam.id}</span>
        )}
        <span className="text-[9px] text-slate-500 ml-auto">
          {formatWindow(notam)}
        </span>
      </div>
      <div className="text-[10px] font-medium text-slate-200 mb-0.5">
        {notam.summary}
      </div>
      <div className="text-[10px] text-slate-400 whitespace-pre-wrap leading-snug">
        {notam.text}
      </div>
    </div>
  );
}
