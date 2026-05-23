// MELLookup.jsx — pilot/crew MEL lookup.
//
// Different from the MelLibraryTab in MaintScreen, which is the
// admin/maint surface for managing MEL revisions (upload, activate,
// supersede). This is a read-only lookup intended for crew:
//
//   - Pick any tail in the fleet (or browse them all)
//   - Search the active MEL by keyword (locally via searchMelItems)
//     or use AI assist (server-side via /api/mel-search) for natural
//     language ("left wing landing light inop")
//   - See FULL item details: ref, system, category, provisos,
//     M / O procedure requirements
//   - Mobile-first layout — most pilots will use this on a tablet
//     or phone in the cockpit/preflight
//
// What this does NOT do:
//   - No deferral. That happens through AML on the MAINT LOG screen.
//   - No editing or revision management. That's in the MAINT screen.
//   - No tail-cross-search ("does any aircraft have this MEL item")
//     because each tail has its own MEL revision; a comparison view
//     would be a different feature.

import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen, Search, Loader2, ChevronLeft, AlertTriangle, Plane,
} from 'lucide-react';

const DEFAULT_FLEET = ['N20UF', 'N168ZZ', 'N286N', 'N444AM', 'N651TW', 'N551FP', 'N85AH', 'N525CR'];

export default function MELLookup({ currentUser, fleetTails }) {
  // Show fleet picker on mobile when no tail picked, or always-visible
  // sidebar on desktop. Empty tail = "pick a tail" screen on mobile.
  const tails = (fleetTails && fleetTails.length) ? fleetTails : DEFAULT_FLEET;
  const [tail, setTail] = useState(null);  // null until picked

  return (
    <div className="max-w-5xl mx-auto p-3 sm:p-4 space-y-3 sm:space-y-4">
      <div>
        <h1 className="text-2xl sm:text-3xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
          MEL LOOKUP
        </h1>
        <p className="text-xs sm:text-sm text-slate-500 mt-1">
          Read-only search of each aircraft's currently-active Minimum Equipment List.
          Search results show the verbatim MEL text — read every proviso before relying on it.
        </p>
      </div>

      {/* Fleet picker — chips. Selected = expanded content area appears below. */}
      <div>
        <div className="text-[10px] tracking-widest text-slate-500 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          PICK A TAIL
        </div>
        <div className="overflow-x-auto -mx-3 sm:mx-0 px-3 sm:px-0">
          <div className="flex items-center gap-2 min-w-max">
            {tails.map((t) => (
              <button
                key={t}
                onClick={() => setTail(t)}
                className={`px-3 py-2 text-sm tracking-widest border whitespace-nowrap ${
                  tail === t
                    ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                    : 'border-slate-700 text-slate-300 hover:text-slate-100 hover:border-slate-500'
                }`}
                style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Empty state */}
      {!tail && (
        <div className="border border-dashed border-slate-700 p-8 sm:p-12 text-center">
          <BookOpen className="w-8 h-8 text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-500">Select a tail above to load its MEL.</p>
        </div>
      )}

      {tail && <TailMelView tail={tail} />}
    </div>
  );
}

// ====================================================================
// TAIL MEL VIEW — loads + searches one tail's MEL
// ====================================================================

function TailMelView({ tail }) {
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);

  // Search state
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);          // null = browse mode
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');

  // Reload when tail changes
  useEffect(() => {
    let unsub = null, cancelled = false;
    setLoading(true);
    setActive(null);
    setResults(null);
    setQ('');
    (async () => {
      const m = await import('./firebase-mel.js');
      if (cancelled) return;
      unsub = m.subscribeActiveRevision(tail, (rev) => {
        setActive(rev);
        setLoading(false);
      });
    })();
    return () => { cancelled = true; if (unsub) try { unsub(); } catch (_) {} };
  }, [tail]);

  const items = active?.items || [];

  // Local keyword search — fast, runs on every keystroke when q is set
  async function runLocalSearch() {
    if (!q.trim()) { setResults(null); setAiNote(''); return; }
    const m = await import('./firebase-mel.js');
    setResults(m.searchMelItems(items, q));
    setAiNote('');
  }

  // AI-assisted natural-language search
  async function runAi() {
    if (!q.trim() || !active) return;
    setAiBusy(true);
    setAiNote('');
    try {
      const { auth } = await import('./firebase.js');
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
      const r = await fetch('/api/mel-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, tail, query: q }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setAiNote(`AI search: ${data.error || r.status}`);
        return;
      }
      const m = await import('./firebase-mel.js');
      const resolved = m.resolveRefs(items, data.candidates || []);
      setResults(resolved);
      setAiNote(data.note || 'AI suggestions — read provisos before relying on them.');
    } catch (e) {
      setAiNote(`AI search failed: ${e.message}`);
    } finally {
      setAiBusy(false);
    }
  }

  // What to show — search results when q is set, full item list otherwise
  const displayItems = useMemo(() => {
    if (Array.isArray(results)) return results;
    return items;
  }, [results, items]);

  if (loading) {
    return (
      <div className="p-8 sm:p-12 text-center text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
        Loading {tail} MEL...
      </div>
    );
  }

  if (!active) {
    return (
      <div className="border border-amber-500/40 bg-amber-500/10 p-4 sm:p-6 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
        <div>
          <div className="text-amber-100 font-semibold" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            NO ACTIVE MEL FOR {tail}
          </div>
          <div className="text-xs text-amber-200/90 mt-1">
            This aircraft doesn't have an active MEL revision uploaded.
            Maintenance can upload one from the MAINT screen.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Active revision info */}
      <div className="bg-slate-900/40 border border-slate-800 p-3 text-xs" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <Plane className="w-4 h-4 text-cyan-300" />
          <span className="text-slate-100 font-semibold">{tail}</span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-300">{active.label || 'Active revision'}</span>
          {active.effectiveDate && (
            <>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">EFFECTIVE</span>
              <span className="text-slate-300">{active.effectiveDate}</span>
            </>
          )}
          <span className="ml-auto text-slate-500">{items.length} items</span>
        </div>
      </div>

      {/* Search input */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-3 text-slate-500 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              // Auto-run local search as you type
              if (!e.target.value.trim()) setResults(null);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') runLocalSearch(); }}
            placeholder="Search MEL — keyword, ATA ref, system name..."
            className="w-full bg-slate-900 border border-slate-700 pl-10 pr-3 py-2.5 text-slate-100 placeholder:text-slate-600"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={runLocalSearch}
            disabled={!q.trim()}
            className="px-3 py-2 border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 text-xs tracking-widest disabled:opacity-50"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Search className="w-3 h-3 inline-block mr-1 -mt-0.5" /> SEARCH
          </button>
          <button
            onClick={runAi}
            disabled={!q.trim() || aiBusy}
            className="px-3 py-2 border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 text-xs tracking-widest disabled:opacity-50"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title="Use AI to interpret natural language and match against MEL items"
          >
            {aiBusy
              ? <Loader2 className="w-3 h-3 inline-block mr-1 -mt-0.5 animate-spin" />
              : <Search className="w-3 h-3 inline-block mr-1 -mt-0.5" />}
            AI ASSIST
          </button>
          {results !== null && (
            <button
              onClick={() => { setResults(null); setQ(''); setAiNote(''); }}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              CLEAR
            </button>
          )}
        </div>
        {aiNote && (
          <p className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {aiNote}
          </p>
        )}
      </div>

      {/* Result count strip */}
      {results !== null && (
        <div className="text-xs text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {results.length === 0
            ? 'No matches'
            : `${results.length} match${results.length === 1 ? '' : 'es'}`}
        </div>
      )}

      {/* Results / items list */}
      {displayItems.length === 0 ? (
        <div className="border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500">
          {results !== null
            ? 'No MEL items match this search. Try a different keyword or use AI ASSIST.'
            : `This MEL has no items.`}
        </div>
      ) : (
        <div className="space-y-2">
          {displayItems.map((item, i) => (
            <MELItemCard key={item.ref || i} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ====================================================================
// SINGLE MEL ITEM CARD — full details
// ====================================================================

function MELItemCard({ item }) {
  const [expanded, setExpanded] = useState(false);

  // Header — always visible
  const ref = item.ref || '';
  const itemName = item.subitem
    ? `${item.item || ''} — ${item.subitem}. ${item.subitem_name || ''}`.trim()
    : (item.item || '');
  const systemName = [item.system, item.system_name].filter(Boolean).join(' ');

  return (
    <div className="bg-slate-900/40 border border-slate-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-3 hover:bg-slate-900/70"
      >
        {/* Top row: ref, category, flags */}
        <div className="flex items-center gap-2 flex-wrap text-xs" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <span className="font-semibold text-slate-100">{ref}</span>
          {item.category && (
            <span className="text-amber-300 font-semibold">CAT {item.category}</span>
          )}
          {item.non_relief === true && (
            <span className="px-1.5 py-0.5 bg-red-500/20 border border-red-500/40 text-red-200 text-[9px] tracking-widest">
              NON-RELIEF
            </span>
          )}
          {item.maint_required === true && (
            <span className="px-1.5 py-0.5 bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[9px] tracking-widest">
              (M)
            </span>
          )}
          {item.ops_required === true && (
            <span className="px-1.5 py-0.5 bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-[9px] tracking-widest">
              (O)
            </span>
          )}
          <span className="ml-auto text-[10px] text-slate-500">
            {expanded ? 'TAP TO HIDE' : 'TAP FOR DETAILS'}
          </span>
        </div>
        {systemName && (
          <div className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {systemName}
          </div>
        )}
        <div className="text-sm text-slate-200 mt-1" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
          {itemName || '(no name)'}
        </div>

        {/* Number installed / required for dispatch — always visible if present */}
        {(item.number_installed != null || item.number_required != null) && (
          <div className="text-[11px] text-slate-400 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {item.number_installed != null && (
              <span><span className="text-slate-500">INSTALLED</span> {item.number_installed}</span>
            )}
            {item.number_required != null && (
              <span className="ml-3"><span className="text-slate-500">REQ DISPATCH</span> {item.number_required}</span>
            )}
          </div>
        )}
      </button>

      {/* Expanded body — provisos and any extra detail */}
      {expanded && (
        <div className="border-t border-slate-800 px-3 py-3 space-y-3">
          {item.remarks ? (
            <div>
              <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                PROVISOS / REMARKS
              </div>
              <div className="text-sm text-slate-200 whitespace-pre-wrap" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                {item.remarks}
              </div>
            </div>
          ) : (
            <div className="text-[10px] text-slate-600 italic" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              (no provisos extracted from this MEL — verify against source document)
            </div>
          )}

          {(item.maint_required || item.ops_required) && (
            <div className="flex items-center gap-2 flex-wrap" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <span className="text-[10px] tracking-widest text-slate-500">REQUIRES:</span>
              {item.maint_required && (
                <span className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[10px] tracking-widest">
                  (M) MAINT PROCEDURE
                </span>
              )}
              {item.ops_required && (
                <span className="px-2 py-0.5 bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-[10px] tracking-widest">
                  (O) OPS PROCEDURE
                </span>
              )}
            </div>
          )}

          {/* Anything else the ingest captured that we want to surface */}
          {item.ata && (
            <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              ATA {item.ata}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
