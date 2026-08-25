/**
 * Per-trip FRAT panel — auto-scores from weather, NOTAMs, MX, crew, ops
 * readiness, then collects IMSAFE / go-items before a PIC can sign.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Loader2, RefreshCw, Settings2, Shield,
} from 'lucide-react';
import {
  FRAT_CHECKLIST,
  computeFrat,
  fratSummary,
  normalizeFratConfig,
} from './frat.js';
import { computeOutstanding } from './ops-readiness.js';
import { resolvePilot } from './duty-pairing.js';
import { evaluateCurrent } from './duty-legality.js';
import { deriveAircraftStatus, subscribeMel, subscribeSquawks } from './firebase-maint.js';
import { rollupPilotStatus } from './firebase-currency.js';
import { subscribePeriodsForPilot } from './firebase-duty-v2.js';
import { saveTripState, subscribeFratConfig } from './firebase-data.js';
import FratSettingsPanel from './FratSettingsPanel.jsx';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase.js';

async function loadPilotCurrency(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, 'pilot-currencies', uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

const WX_TTL = 5 * 60 * 1000;
const _wxCache = new Map();
const _notamCache = new Map();

async function authHeaders() {
  const { auth } = await import('./firebase.js');
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchWx(icao) {
  if (!icao) return null;
  const key = String(icao).toUpperCase();
  const hit = _wxCache.get(key);
  if (hit && Date.now() - hit.at < WX_TTL) return hit.data;
  try {
    const headers = await authHeaders();
    const r = await fetch(`/api/airport-weather?icao=${encodeURIComponent(key)}`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    _wxCache.set(key, { data, at: Date.now() });
    return data;
  } catch {
    return null;
  }
}

async function fetchNotams(icao) {
  if (!icao) return null;
  const key = String(icao).toUpperCase();
  const hit = _notamCache.get(key);
  if (hit && Date.now() - hit.at < WX_TTL * 2) return hit.data;
  try {
    const headers = await authHeaders();
    const r = await fetch(`/api/faa-notams?icao=${encodeURIComponent(key)}`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    _notamCache.set(key, { data, at: Date.now() });
    return data;
  } catch {
    return null;
  }
}

function toneClasses(tone) {
  switch (tone) {
    case 'green':
      return { border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', text: 'text-emerald-300', bar: 'bg-emerald-400' };
    case 'amber':
      return { border: 'border-amber-500/40', bg: 'bg-amber-500/10', text: 'text-amber-300', bar: 'bg-amber-400' };
    case 'orange':
      return { border: 'border-orange-500/40', bg: 'bg-orange-500/10', text: 'text-orange-300', bar: 'bg-orange-400' };
    case 'red':
      return { border: 'border-red-500/40', bg: 'bg-red-500/10', text: 'text-red-300', bar: 'bg-red-400' };
    default:
      return { border: 'border-slate-700', bg: 'bg-slate-900/40', text: 'text-slate-300', bar: 'bg-slate-500' };
  }
}

function useCrewLegality(uid) {
  const [periods, setPeriods] = useState([]);
  useEffect(() => {
    if (!uid) {
      setPeriods([]);
      return undefined;
    }
    return subscribePeriodsForPilot(uid, (list) => setPeriods(Array.isArray(list) ? list : []));
  }, [uid]);
  return useMemo(() => {
    if (!uid) return null;
    try {
      return evaluateCurrent(periods, [], Date.now(), 'two');
    } catch {
      return null;
    }
  }, [uid, periods]);
}

function FratScoreHero({ result }) {
  if (!result) return null;
  const tone = toneClasses(result.tone);
  const maxBar = 60;
  const pct = Math.min(100, Math.round((result.score / maxBar) * 100));
  return (
    <div className={`border ${tone.border} ${tone.bg} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            FRAT SCORE
          </div>
          <div className={`text-3xl font-semibold ${tone.text}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {result.score}
            <span className="text-sm text-slate-500 ml-2">{result.levelLabel}</span>
          </div>
        </div>
        <div className={`flex items-center gap-1.5 px-2 py-1 border ${tone.border} ${tone.text} text-[10px] tracking-widest`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <Shield className="w-3.5 h-3.5" />
          {result.go ? 'GO' : 'NO-GO'}
        </div>
      </div>
      <div className="h-1.5 bg-slate-950/60 overflow-hidden">
        <div className={`h-full ${tone.bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[11px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        Auto-scored from weather, NOTAMs, aircraft status, crew currency/duty, and ops readiness.
        Sign after completing the human-factors checklist. Not a regulatory release.
      </div>
    </div>
  );
}

export default function TripFrat({
  trip,
  currentUser,
  users = [],
  allTrips = [],
  tripState = null,
}) {
  const canEdit = ['admin', 'ops', 'crew', 'pilot'].includes(currentUser?.role);
  const [originWx, setOriginWx] = useState(null);
  const [destWx, setDestWx] = useState(null);
  const [originNotams, setOriginNotams] = useState(null);
  const [destNotams, setDestNotams] = useState(null);
  const [squawks, setSquawks] = useState([]);
  const [melItems, setMelItems] = useState([]);
  const [picCurrency, setPicCurrency] = useState(null);
  const [sicCurrency, setSicCurrency] = useState(null);
  const [checklist, setChecklist] = useState(() => tripState?.frat?.checklist || {});
  const [saved, setSaved] = useState(tripState?.frat || null);
  const [fratConfig, setFratConfig] = useState(() => normalizeFratConfig(null));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    const unsub = subscribeFratConfig((data) => setFratConfig(normalizeFratConfig(data)));
    return () => unsub?.();
  }, []);

  const picResolved = useMemo(
    () => resolvePilot(trip?.info?.pic, users),
    [trip?.info?.pic, users],
  );
  const sicResolved = useMemo(
    () => resolvePilot(trip?.info?.sic, users),
    [trip?.info?.sic, users],
  );
  const picUid = picResolved.user?.uid || picResolved.user?.id || null;
  const sicUid = sicResolved.user?.uid || sicResolved.user?.id || null;
  const picLegality = useCrewLegality(picUid);
  const sicLegality = useCrewLegality(sicUid);

  const sameDayLegCount = useMemo(() => {
    const tail = String(trip?.info?.tail || '').toUpperCase();
    if (!tail || !trip?.start) return 1;
    const day = new Date(trip.start);
    if (Number.isNaN(day.getTime())) return 1;
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth();
    const d = day.getUTCDate();
    return (allTrips || []).filter((t) => {
      if (String(t?.info?.tail || '').toUpperCase() !== tail) return false;
      const s = new Date(t.start);
      return s.getUTCFullYear() === y && s.getUTCMonth() === m && s.getUTCDate() === d;
    }).length;
  }, [allTrips, trip?.info?.tail, trip?.start]);

  const refreshExternal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ox, dx, on, dn] = await Promise.all([
        fetchWx(trip?.info?.from),
        fetchWx(trip?.info?.to),
        fetchNotams(trip?.info?.from),
        fetchNotams(trip?.info?.to),
      ]);
      setOriginWx(ox);
      setDestWx(dx);
      setOriginNotams(on);
      setDestNotams(dn);
    } catch (err) {
      setError(err.message || 'Failed to load FRAT inputs');
    } finally {
      setLoading(false);
    }
  }, [trip?.info?.from, trip?.info?.to]);

  useEffect(() => { refreshExternal(); }, [refreshExternal]);

  useEffect(() => {
    const tail = trip?.info?.tail;
    if (!tail) return undefined;
    const unsubs = [];
    unsubs.push(subscribeSquawks(
      (list) => setSquawks(list.filter((s) => s.status !== 'closed')),
      { tail },
    ));
    unsubs.push(subscribeMel(
      (list) => setMelItems(list.filter((m) => m.status === 'open')),
      { tail },
    ));
    return () => { for (const fn of unsubs) fn(); };
  }, [trip?.info?.tail]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (picUid) {
        try {
          const docData = await loadPilotCurrency(picUid);
          if (!cancelled) setPicCurrency(docData);
        } catch { if (!cancelled) setPicCurrency(null); }
      } else setPicCurrency(null);
      if (sicUid) {
        try {
          const docData = await loadPilotCurrency(sicUid);
          if (!cancelled) setSicCurrency(docData);
        } catch { if (!cancelled) setSicCurrency(null); }
      } else setSicCurrency(null);
    })();
    return () => { cancelled = true; };
  }, [picUid, sicUid]);

  useEffect(() => {
    if (tripState?.frat?.checklist) setChecklist(tripState.frat.checklist);
    if (tripState?.frat) setSaved(tripState.frat);
  }, [tripState?.frat]);

  const aircraftStatus = useMemo(
    () => deriveAircraftStatus(trip?.info?.tail, squawks, melItems),
    [trip?.info?.tail, squawks, melItems],
  );

  const squawkSummary = useMemo(() => ({
    grounding: squawks.filter((s) => s.grounding === true && s.status !== 'deferred').length,
    openSquawks: squawks.filter((s) => s.grounding !== true).length,
    melCount: melItems.length,
  }), [squawks, melItems]);

  const outstanding = useMemo(
    () => computeOutstanding(trip, tripState || {}, Date.now()),
    [trip, tripState],
  );

  const result = useMemo(() => computeFrat({
    trip: { ...trip, sameDayLegCount },
    config: fratConfig,
    tripState,
    originWx,
    destWx,
    originNotams,
    destNotams,
    aircraftStatus,
    squawkSummary,
    outstanding,
    checklist,
    pic: {
      name: trip?.info?.pic,
      resolved: Boolean(picUid),
      legality: picLegality,
      currency: rollupPilotStatus(picCurrency),
    },
    sic: {
      name: trip?.info?.sic,
      resolved: Boolean(sicUid),
      legality: sicLegality,
      currency: rollupPilotStatus(sicCurrency),
    },
  }), [
    trip, sameDayLegCount, fratConfig, tripState, originWx, destWx, originNotams, destNotams,
    aircraftStatus, squawkSummary, outstanding, checklist,
    picUid, sicUid, picLegality, sicLegality, picCurrency, sicCurrency,
  ]);

  function setAnswer(id, value) {
    setChecklist((prev) => ({ ...prev, [id]: value }));
    setInfo(null);
  }

  async function signFrat() {
    if (!canEdit || busy || !trip?.uid) return;
    if (result.unanswered.length) {
      setError('Answer every required checklist item before signing.');
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const summary = {
        ...fratSummary(result),
        checklist: { ...checklist },
        configVersion: fratConfig.version || null,
        configUpdatedAt: fratConfig.updatedAt || null,
        signedAt: Date.now(),
        signedByUid: currentUser?.uid || null,
        signedByName: currentUser?.name || currentUser?.email || 'Crew',
        factors: result.factors,
        blockers: result.blockers,
      };
      await saveTripState(trip.uid, { frat: summary });
      setSaved(summary);
      setInfo(result.go
        ? `FRAT signed — ${result.levelLabel} (${result.score}).`
        : `FRAT signed with NO-GO — ${result.levelLabel} (${result.score}). Review blockers before release.`);
    } catch (err) {
      setError(err.message || 'Could not save FRAT');
    } finally {
      setBusy(false);
    }
  }

  const tone = toneClasses(result?.tone);
  const byCategory = useMemo(() => {
    const map = new Map();
    for (const f of result?.factors || []) {
      if (!map.has(f.category)) map.set(f.category, []);
      map.get(f.category).push(f);
    }
    return [...map.entries()];
  }, [result]);

  return (
    <div className="p-4 max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] tracking-widest text-cyan-400 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            FLIGHT RISK ASSESSMENT
          </div>
          <div className="text-[11px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            Scores this leg from live weather, NOTAMs, aircraft squawks/MEL, crew duty & currency, and ops readiness — then you complete IMSAFE.
          </div>
        </div>
        <button
          type="button"
          onClick={refreshExternal}
          className="p-1.5 text-slate-500 hover:text-cyan-300"
          title="Refresh weather / NOTAMs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <span className="text-slate-500">
          BANDS · LOW ≤{fratConfig.levels.low} · MOD ≤{fratConfig.levels.moderate} · HIGH ≤{fratConfig.levels.high}
        </span>
        {currentUser?.role === 'admin' && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300"
          >
            <Settings2 className="w-3 h-3" /> ADJUST SCORING
          </button>
        )}
      </div>

      {settingsOpen && (
        <FratSettingsPanel
          currentUser={currentUser}
          asModal
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {error && (
        <div className="p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">{error}</div>
      )}
      {info && (
        <div className="p-2 border border-emerald-500/40 bg-emerald-500/5 text-xs text-emerald-300">{info}</div>
      )}

      {loading && !result ? (
        <div className="text-xs text-slate-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Gathering FRAT inputs…
        </div>
      ) : (
        <FratScoreHero result={result} />
      )}

      {saved?.signedAt && (
        <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          Last signed {new Date(saved.signedAt).toLocaleString()}
          {saved.signedByName ? ` by ${saved.signedByName}` : ''}
          {saved.score != null ? ` — score ${saved.score} (${saved.levelLabel})` : ''}
        </div>
      )}

      {result?.blockers?.length > 0 && (
        <div className="border border-red-500/40 bg-red-500/5 p-3 space-y-2">
          <div className="flex items-center gap-2 text-red-300 text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <AlertTriangle className="w-3.5 h-3.5" /> BLOCKERS
          </div>
          {result.blockers.map((b) => (
            <div key={b.id} className="text-[11px] text-red-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {b.label}{b.detail ? ` — ${b.detail}` : ''}
            </div>
          ))}
        </div>
      )}

      <div className="border border-slate-800 bg-slate-900/40 p-4 space-y-4">
        <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          RISK FACTORS ({result?.factors?.length || 0})
        </div>
        {byCategory.length === 0 ? (
          <div className="text-[11px] text-slate-500">No elevated factors from available data.</div>
        ) : byCategory.map(([category, items]) => (
          <div key={category} className="space-y-1.5">
            <div className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {category.toUpperCase()}
            </div>
            {items.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-3 text-[11px]">
                <div className="text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  {f.label}
                  {f.detail && <div className="text-slate-500 text-[10px] mt-0.5">{f.detail}</div>}
                </div>
                <div className={`shrink-0 font-mono ${f.points >= 15 ? 'text-red-300' : f.points >= 8 ? 'text-amber-300' : 'text-slate-400'}`}>
                  +{f.points}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          HUMAN FACTORS / GO ITEMS
        </div>
        <div className="text-[11px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          Answer every item. IMSAFE “Yes” adds risk. Go-items must be “Done”.
        </div>
        {['IMSAFE', 'GO'].map((group) => (
          <div key={group} className="space-y-2">
            <div className="text-[10px] tracking-widest text-cyan-400/80" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {group}
            </div>
            {FRAT_CHECKLIST.filter((i) => i.group === group).filter((i) => fratConfig.checklist[i.id]?.enabled).map((item) => {
              const value = checklist[item.id];
              const itemCfg = fratConfig.checklist[item.id];
              const yesLabel = item.invert ? 'DONE' : 'YES';
              const noLabel = item.invert ? 'NOT YET' : 'NO';
              const yesIsAdverse = !item.invert;
              return (
                <div key={item.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border border-slate-800/80 px-3 py-2">
                  <div className="text-[11px] text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                    {item.label}
                    <span className="ml-1.5 text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      +{itemCfg.points}{itemCfg.blocks ? ' · BLOCKS' : ''}{itemCfg.required ? '' : ' · optional'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => setAnswer(item.id, true)}
                      className={`px-2.5 py-1 text-[10px] tracking-widest border disabled:opacity-50 ${
                        value === true
                          ? (yesIsAdverse ? 'border-red-400 text-red-300 bg-red-500/10' : 'border-emerald-400 text-emerald-300 bg-emerald-500/10')
                          : 'border-slate-700 text-slate-400'
                      }`}
                      style={{ fontFamily: 'JetBrains Mono, monospace' }}
                    >
                      {yesLabel}
                    </button>
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => setAnswer(item.id, false)}
                      className={`px-2.5 py-1 text-[10px] tracking-widest border disabled:opacity-50 ${
                        value === false
                          ? (yesIsAdverse ? 'border-emerald-400 text-emerald-300 bg-emerald-500/10' : 'border-amber-400 text-amber-300 bg-amber-500/10')
                          : 'border-slate-700 text-slate-400'
                      }`}
                      style={{ fontFamily: 'JetBrains Mono, monospace' }}
                    >
                      {noLabel}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {canEdit && (
        <button
          type="button"
          disabled={busy || result?.unanswered?.length > 0}
          onClick={signFrat}
          className={`w-full py-3 text-sm tracking-widest border disabled:opacity-50 ${tone.border} ${tone.text} hover:bg-white/5`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {busy ? (
            <span className="inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> SAVING…</span>
          ) : result?.unanswered?.length ? (
            `ANSWER ${result.unanswered.length} ITEM${result.unanswered.length === 1 ? '' : 'S'} TO SIGN`
          ) : (
            <span className="inline-flex items-center justify-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              SIGN FRAT — {result?.levelLabel} ({result?.score})
            </span>
          )}
        </button>
      )}
    </div>
  );
}

/** Compact score pill for Status aside / lists. */
export function FratBadge({ frat, onOpen }) {
  if (!frat || frat.score == null) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="text-[10px] tracking-widest text-slate-500 hover:text-cyan-300 border border-slate-800 px-2 py-1"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        FRAT — OPEN
      </button>
    );
  }
  const tone = toneClasses(frat.tone);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`inline-flex items-center gap-1.5 text-[10px] tracking-widest border px-2 py-1 ${tone.border} ${tone.text} ${tone.bg}`}
      style={{ fontFamily: 'JetBrains Mono, monospace' }}
      title="Open FRAT"
    >
      <Shield className="w-3 h-3" />
      FRAT {frat.score} · {frat.levelLabel}
      {frat.go === false && <span className="text-red-300">· NO-GO</span>}
    </button>
  );
}
