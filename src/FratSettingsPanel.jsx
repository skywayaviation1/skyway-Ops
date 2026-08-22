/**
 * Settings → FRAT scoring.
 *
 * Admin-editable weights, thresholds, and blocker flags for the per-trip
 * Flight Risk Assessment Tool. Changes are org-wide (app-config/frat) and take
 * effect the next time any FRAT is opened.
 *
 * A live preview re-scores three canned legs as the values change, so the
 * effect of a weight change is visible before saving.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ChevronDown, Loader2, RotateCcw, Save, Shield, X,
} from 'lucide-react';
import {
  DEFAULT_FRAT_CONFIG,
  FRAT_CHECKLIST,
  FRAT_CONFIG_SCHEMA,
  FRAT_FACTOR_OPTIONS,
  computeFrat,
  fratLevels,
  normalizeFratConfig,
} from './frat.js';
import { saveFratConfig, subscribeFratConfig } from './firebase-data.js';

function getPath(object, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object);
}

function setPath(object, path, value) {
  const keys = path.split('.');
  const next = { ...object };
  let cursor = next;
  for (let i = 0; i < keys.length - 1; i += 1) {
    cursor[keys[i]] = { ...(cursor[keys[i]] || {}) };
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
  return next;
}

/** Three representative legs so a weight change shows a concrete delta. */
const PREVIEW_CASES = [
  {
    id: 'clear',
    label: 'Clear day, full crew',
    build: () => ({
      trip: {
        start: '2030-06-15T15:00:00Z',
        end: '2030-06-15T16:30:00Z',
        info: { from: 'KAPF', to: 'KBCT', tail: 'N1', pic: 'A Pilot', sic: 'B Pilot', pax: 2, legType: 'REVENUE', category: 'REVENUE' },
      },
      originWx: { ok: true, metar: { flightCategory: 'VFR', ceilingFt: 6000, visibilitySm: 10, windKt: 6 } },
      destWx: { ok: true, metar: { flightCategory: 'VFR', ceilingFt: 5000, visibilitySm: 10, windKt: 8 } },
      aircraftStatus: { status: 'AIRWORTHY', reasons: [], melOpen: 0 },
      squawkSummary: { grounding: 0, openSquawks: 0, melCount: 0 },
      pic: { name: 'A Pilot', resolved: true, legality: { status: 'legal' }, currency: { status: 'current' } },
      sic: { name: 'B Pilot', resolved: true, legality: { status: 'legal' }, currency: { status: 'current' } },
      outstanding: [],
    }),
  },
  {
    id: 'marginal',
    label: 'IFR night, 1 MEL',
    build: () => ({
      trip: {
        start: '2030-11-15T23:30:00Z',
        end: '2030-11-16T02:45:00Z',
        info: { from: 'KAPF', to: 'KTEB', tail: 'N1', pic: 'A Pilot', sic: 'B Pilot', pax: 7, legType: 'REVENUE', category: 'REVENUE' },
        sameDayLegCount: 3,
      },
      originWx: { ok: true, metar: { flightCategory: 'IFR', ceilingFt: 700, visibilitySm: 2, windGustKt: 28 } },
      destWx: { ok: true, metar: { flightCategory: 'MVFR', ceilingFt: 2500, visibilitySm: 5 } },
      originNotams: { significantOnly: [{ severity: 'medium' }, { severity: 'medium' }] },
      aircraftStatus: { status: 'RESTRICTED', reasons: ['MEL 34-1'], melOpen: 1 },
      squawkSummary: { grounding: 0, openSquawks: 1, melCount: 1 },
      pic: { name: 'A Pilot', resolved: true, legality: { status: 'warning', warnings: [{ message: 'Approaching 14h' }] }, currency: { status: 'current' } },
      sic: { name: 'B Pilot', resolved: true, legality: { status: 'legal' }, currency: { warningCount: 1, status: 'warning' } },
      outstanding: [{ code: 'no-sheet', label: 'No trip sheet', severity: 'warn' }],
    }),
  },
  {
    id: 'severe',
    label: 'LIFR, AOG, no PIC',
    build: () => ({
      trip: {
        start: '2030-01-15T01:00:00Z',
        end: '2030-01-15T07:30:00Z',
        info: { from: 'APF', to: 'MYNN', tail: 'N1', pic: '', sic: '', pax: 8, legType: 'REVENUE', category: 'REVENUE' },
        sameDayLegCount: 4,
      },
      originWx: { ok: true, metar: { flightCategory: 'LIFR', ceilingFt: 200, visibilitySm: 0.5, windGustKt: 40 } },
      destWx: { ok: true, metar: { flightCategory: 'IFR', ceilingFt: 600, visibilitySm: 2 } },
      originNotams: { significantOnly: [{ severity: 'high' }, { severity: 'medium' }] },
      aircraftStatus: { status: 'AOG', reasons: ['Hydraulic leak'], melOpen: 0 },
      squawkSummary: { grounding: 1, openSquawks: 2, melCount: 0 },
      outstanding: [{ code: 'ops-hold', label: 'Ops hold', severity: 'critical' }],
      tripState: { opsDisposition: 'hold', opsDispositionReason: 'Weather' },
    }),
  },
];

function toneText(tone) {
  switch (tone) {
    case 'green': return 'text-emerald-300';
    case 'amber': return 'text-amber-300';
    case 'orange': return 'text-orange-300';
    case 'red': return 'text-red-300';
    default: return 'text-slate-300';
  }
}

function NumberField({ label, value, unit, max = 100, step = 1, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[11px] text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        {label}
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <input
          type="range"
          min={0}
          max={max}
          step={step}
          value={Number(value) || 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-28 accent-cyan-400"
        />
        <input
          type="number"
          min={0}
          max={max}
          step={step}
          value={Number(value) || 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-16 px-1.5 py-1 bg-slate-950 border border-slate-800 text-slate-200 text-xs text-right"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        />
        <span className="w-6 text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {unit || 'pts'}
        </span>
      </span>
    </label>
  );
}

function BooleanField({ label, value, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[11px] text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`px-2.5 py-1 text-[10px] tracking-widest border shrink-0 ${
          value
            ? 'border-red-400 text-red-300 bg-red-500/10'
            : 'border-slate-700 text-slate-500'
        }`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        {value ? 'BLOCKS' : 'SCORES ONLY'}
      </button>
    </label>
  );
}

function InclusionField({
  label,
  value,
  onChange,
  onLabel = 'INCLUDED',
  offLabel = 'IGNORED',
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[11px] text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`px-2.5 py-1 text-[10px] tracking-widest border shrink-0 ${
          value
            ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
            : 'border-slate-700 text-slate-600'
        }`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        {value ? onLabel : offLabel}
      </button>
    </label>
  );
}

function Section({ title, description, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span>
          <span className="text-[10px] tracking-widest text-cyan-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {title.toUpperCase()}
          </span>
          {description && (
            <span className="block text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {description}
            </span>
          )}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-3 pb-3 divide-y divide-slate-800/60">{children}</div>}
    </div>
  );
}

export default function FratSettingsPanel({ currentUser, asModal = false, onClose }) {
  const isAdmin = currentUser?.role === 'admin';
  const [stored, setStored] = useState(null);
  const [draft, setDraft] = useState(() => normalizeFratConfig(null));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const unsub = subscribeFratConfig((data) => {
      if (cancelled) return;
      setStored(data);
      setDraft(normalizeFratConfig(data));
      setLoading(false);
    });
    return () => { cancelled = true; unsub?.(); };
  }, []);

  const previews = useMemo(() => PREVIEW_CASES.map((testCase) => {
    const built = testCase.build();
    const checklist = {};
    for (const item of FRAT_CHECKLIST) checklist[item.id] = item.invert ? true : false;
    const result = computeFrat({ ...built, checklist, config: draft });
    return { id: testCase.id, label: testCase.label, result };
  }), [draft]);

  const dirty = useMemo(
    () => JSON.stringify(normalizeFratConfig(stored)) !== JSON.stringify(draft),
    [stored, draft],
  );

  const update = useCallback((path, value) => {
    setDraft((prev) => normalizeFratConfig(setPath(prev, path, value)));
    setInfo(null);
  }, []);

  async function save() {
    if (!isAdmin || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await saveFratConfig(draft, currentUser);
      setInfo('FRAT scoring saved. New scores use these weights immediately.');
    } catch (err) {
      setError(err.message || 'Could not save FRAT scoring');
    } finally {
      setBusy(false);
    }
  }

  function resetToDefaults() {
    setDraft(normalizeFratConfig(DEFAULT_FRAT_CONFIG));
    setInfo('Reverted to built-in defaults — not saved yet.');
  }

  const levels = fratLevels(draft);

  const body = (
    <div className="space-y-3">
      <p className="text-xs text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        Adjust how every trip&apos;s FRAT score is calculated. Weights are risk points; thresholds decide when a factor applies. These settings apply to the whole operation.
      </p>

      {info && (
        <div className="p-2 border border-emerald-500/40 bg-emerald-500/5 text-xs text-emerald-300">{info}</div>
      )}
      {error && (
        <div className="p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">{error}</div>
      )}
      {!isAdmin && (
        <div className="p-2 border border-slate-700 bg-slate-900/40 text-[11px] text-slate-500">
          Only an administrator can change FRAT scoring. Values below are read-only.
        </div>
      )}

      {loading ? (
        <div className="text-xs text-slate-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading scoring model…
        </div>
      ) : (
        <>
          {/* Live preview */}
          <div className="border border-slate-800 bg-slate-950/60 p-3 space-y-2">
            <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              LIVE PREVIEW
            </div>
            {previews.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  {p.label}
                </span>
                <span className="flex items-center gap-2 shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <span className={`text-sm ${toneText(p.result.tone)}`}>{p.result.score}</span>
                  <span className={`text-[10px] ${toneText(p.result.tone)}`}>{p.result.levelLabel}</span>
                  <span className={`text-[10px] ${p.result.go ? 'text-emerald-300' : 'text-red-300'}`}>
                    {p.result.go ? 'GO' : 'NO-GO'}
                  </span>
                </span>
              </div>
            ))}
          </div>

          {/* Level bands */}
          <Section title="Risk bands" description="Score at or below each value earns that level." defaultOpen>
            <NumberField
              label="LOW up to"
              value={draft.levels.low}
              max={200}
              onChange={(v) => update('levels.low', v)}
            />
            <NumberField
              label="MODERATE up to"
              value={draft.levels.moderate}
              max={300}
              onChange={(v) => update('levels.moderate', v)}
            />
            <NumberField
              label="HIGH up to"
              value={draft.levels.high}
              max={400}
              onChange={(v) => update('levels.high', v)}
            />
            <BooleanField
              label="SEVERE band forces NO-GO"
              value={draft.severeIsNoGo}
              onChange={(v) => update('severeIsNoGo', v)}
            />
            <div className="pt-2 flex flex-wrap gap-2">
              {levels.map((l) => (
                <span key={l.id} className={`text-[10px] tracking-widest ${toneText(l.tone)}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {l.label} ≤ {Number.isFinite(l.max) ? l.max : '∞'}
                </span>
              ))}
            </div>
          </Section>

          {/* Auto-scored groups */}
          {FRAT_CONFIG_SCHEMA.map((group) => (
            <Section key={group.group} title={group.label} description={group.description}>
              <InclusionField
                label={`Include all ${group.label.toLowerCase()} scoring`}
                value={draft[group.group].enabled}
                onChange={(v) => update(`${group.group}.enabled`, v)}
                onLabel="CATEGORY ON"
                offLabel="CATEGORY OFF"
              />
              <div className="py-2">
                <div className="mb-1 text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  CHOOSE WHAT COUNTS
                </div>
                {FRAT_FACTOR_OPTIONS
                  .filter((factor) => factor.group === group.group)
                  .map((factor) => (
                    <InclusionField
                      key={factor.id}
                      label={factor.label}
                      value={draft.factors[factor.id]}
                      onChange={(value) => update(`factors.${factor.id}`, value)}
                    />
                  ))}
              </div>
              {group.fields.map((field) => {
                const path = `${group.group}.${field.key}`;
                const value = getPath(draft, path);
                if (field.type === 'boolean') {
                  return (
                    <BooleanField
                      key={path}
                      label={field.label}
                      value={value}
                      onChange={(v) => update(path, v)}
                    />
                  );
                }
                return (
                  <NumberField
                    key={path}
                    label={field.label}
                    value={value}
                    unit={field.unit}
                    max={field.max}
                    step={field.step}
                    onChange={(v) => update(path, v)}
                  />
                );
              })}
            </Section>
          ))}

          {/* Checklist */}
          <Section title="Human factors checklist" description="Points added when an item is answered adversely.">
            {FRAT_CHECKLIST.map((item) => {
              const cfg = draft.checklist[item.id];
              return (
                <div key={item.id} className="py-2 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                      {item.label}
                      <span className="text-slate-600 ml-1.5 text-[10px]">{item.group}</span>
                    </span>
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => update(`checklist.${item.id}.enabled`, !cfg.enabled)}
                        className={`px-2 py-0.5 text-[10px] tracking-widest border ${
                          cfg.enabled ? 'border-cyan-500/40 text-cyan-300' : 'border-slate-700 text-slate-600'
                        }`}
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        {cfg.enabled ? 'ON' : 'OFF'}
                      </button>
                      <button
                        type="button"
                        onClick={() => update(`checklist.${item.id}.required`, !cfg.required)}
                        className={`px-2 py-0.5 text-[10px] tracking-widest border ${
                          cfg.required ? 'border-amber-500/40 text-amber-300' : 'border-slate-700 text-slate-600'
                        }`}
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        {cfg.required ? 'REQUIRED' : 'OPTIONAL'}
                      </button>
                      <button
                        type="button"
                        onClick={() => update(`checklist.${item.id}.blocks`, !cfg.blocks)}
                        className={`px-2 py-0.5 text-[10px] tracking-widest border ${
                          cfg.blocks ? 'border-red-400 text-red-300' : 'border-slate-700 text-slate-600'
                        }`}
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        {cfg.blocks ? 'BLOCKS' : 'SCORES'}
                      </button>
                    </div>
                  </div>
                  <NumberField
                    label="Adverse points"
                    value={cfg.points}
                    max={200}
                    onChange={(v) => update(`checklist.${item.id}.points`, v)}
                  />
                </div>
              );
            })}
          </Section>

          {stored?.updatedAt && (
            <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              Last saved {new Date(stored.updatedAt).toLocaleString()}
              {stored.updatedByName ? ` by ${stored.updatedByName}` : ''}
            </div>
          )}

          {isAdmin && (
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={resetToDefaults}
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 border border-slate-700 text-slate-300 hover:border-cyan-500/40 text-xs tracking-widest disabled:opacity-50"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                <RotateCcw className="w-3.5 h-3.5" /> RESET DEFAULTS
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !dirty}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 text-xs tracking-widest"
                style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {busy ? 'SAVING…' : dirty ? 'SAVE SCORING' : 'SAVED'}
              </button>
            </div>
          )}

          <div className="flex items-start gap-2 text-[10px] text-slate-500" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-400/70" />
            Changing weights does not re-sign FRATs already signed on a trip; those keep the score recorded at signature time.
          </div>
        </>
      )}
    </div>
  );

  if (!asModal) {
    return (
      <section>
        <h3 className="text-xs tracking-widest text-cyan-400 mb-3 flex items-center gap-2" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
          <Shield className="w-3.5 h-3.5" /> FRAT SCORING
        </h3>
        {body}
      </section>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] bg-slate-950/80 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4">
      <div className="w-full max-w-2xl bg-slate-950 border border-slate-800 my-6">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-950 z-10">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-cyan-400" />
            <span className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              FRAT scoring
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
