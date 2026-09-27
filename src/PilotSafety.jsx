// Hours, certificate grade, and the flight log for the safety rating.
// Opened from Compliance / Currency. Medical, checks, and training are
// edited in that same section. Certificate scans in Pilot Docs fill a
// blank certificate summary and never contribute a certificate number.

import { useEffect, useMemo, useState } from 'react';
import {
  Download, Eye, Mail, Plus, Save, ShieldCheck, Trash2, Upload, X,
} from 'lucide-react';
import BrokerPilotReport, { PilotRatingBadge } from './BrokerPilotReport.jsx';
import { savePilotFlightEntry, savePilotLogbook } from './firebase-pilot-safety.js';
import {
  applyManualFlightEdit,
  newManualFlightEntry,
  rollUpPilotHours,
  voidEntry,
} from './flight-log.js';
import { generatePilotReportPdf } from './pilot-report-pdf.js';
import { computeStatus } from './currency-status.js';
import {
  CERTIFICATE_LEVELS,
  HOUR_FIELDS,
  brokerWithholdReasons,
  releaseBrokerReport,
  emptyLogbook,
  evaluatePilot,
  itemStatusLabel,
  normalizeCertificateLevel,
  normalizeLogbook,
  summarizeDutyFlightHours,
} from './pilot-safety.js';
import { usePilotSafetyData } from './use-pilot-safety-data.js';
import WyvernImporter from './WyvernImporter.jsx';

const TIER_ORDER = { doesNotMeet: 0, caution: 1, meets: 2 };

function PilotSafetyView({
  currentUser,
  users = [],
  data,
  embedded = false,
  initialUid = null,
  onEditChecks = null,
}) {
  const [query, setQuery] = useState('');
  const [selectedUid, setSelectedUid] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [recordTab, setRecordTab] = useState('pilot');

  const pilots = useMemo(() => {
    const list = data.viewAll
      ? users.filter((user) => user.uid && user.approved !== false && (user.role === 'crew' || data.logbooks[user.uid]))
      : users.filter((user) => user.uid === currentUser?.uid);
    return list
      .map((pilot) => ({ pilot, rating: data.rate(pilot) }))
      .sort((a, b) => (TIER_ORDER[a.rating.tier] - TIER_ORDER[b.rating.tier])
        || (a.pilot.name || '').localeCompare(b.pilot.name || ''));
  }, [users, data, currentUser?.uid]);

  const visible = pilots.filter(({ pilot }) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (pilot.name || '').toLowerCase().includes(q) || (pilot.email || '').toLowerCase().includes(q);
  });

  const selected = visible.find((row) => row.pilot.uid === selectedUid) || visible[0] || null;

  useEffect(() => {
    if (!initialUid) return;
    setSelectedUid(initialUid);
    setDirty(false);
    setShowReport(false);
  }, [initialUid]);

  const selectedStamp = `${selected?.pilot.uid || ''}:${data.logbooks[selected?.pilot.uid]?.updatedAt || 'none'}`;
  useEffect(() => {
    if (!selected?.pilot.uid || dirty) return;
    const stored = data.logbooks[selected.pilot.uid];
    setDraft(normalizeLogbook(
      stored || emptyLogbook(selected.pilot.uid, selected.pilot.name),
      selected.pilot.uid,
    ));
  }, [selectedStamp, dirty, selected?.pilot.uid, selected?.pilot.name, data.logbooks]);

  if (!currentUser) return <div className="p-6 text-sm text-slate-500">Sign in required.</div>;

  const pilotEntries = (data.flightEntries || []).filter((entry) => entry.uid === selected?.pilot.uid);
  const rolled = draft
    ? rollUpPilotHours({
      baseline: draft.baseline,
      storedHours: draft.hours,
      entries: pilotEntries,
      now: data.todayMs,
    })
    : null;
  const displayBook = draft ? {
    ...draft,
    hours: draft.baseline?.asOf ? rolled.hours : (draft.baseline?.hours || draft.hours),
    hoursMeta: draft.baseline?.asOf ? rolled.meta : draft.hoursMeta,
  } : null;
  const liveRating = selected && displayBook
    ? evaluatePilot({
        pilot: selected.pilot,
        logbook: displayBook,
        currencyDoc: data.currencies[selected.pilot.uid],
        pilotDocs: data.docsByUid[selected.pilot.uid] || [],
        standards: data.standards,
        dutyHours: summarizeDutyFlightHours(data.periods, selected.pilot.uid, data.todayMs),
        todayMs: data.todayMs,
      })
    : selected?.rating;
  const release = liveRating ? toBrokerRelease(liveRating) : null;
  const withhold = liveRating ? brokerWithholdReasons(liveRating) : [];
  const report = release?.report || null;
  const counts = {
    meets: pilots.filter((row) => row.rating.tier === 'meets').length,
    caution: pilots.filter((row) => row.rating.tier === 'caution').length,
    doesNotMeet: pilots.filter((row) => row.rating.tier === 'doesNotMeet').length,
  };

  const editBaseline = (mutate) => {
    setDraft((current) => {
      const hours = {
        ...(current.baseline?.hours || current.hours),
        timeInType: [...(current.baseline?.hours?.timeInType || current.hours.timeInType || [])],
      };
      mutate(hours);
      return {
        ...current,
        baseline: {
          asOf: current.baseline?.asOf || '',
          source: current.baseline?.source || 'manual',
          hours,
        },
      };
    });
    setDirty(true);
  };

  const updateHours = (key, value) => {
    editBaseline((hours) => {
      hours[key] = value === '' ? null : Number(value);
    });
  };

  const save = async () => {
    if (!selected || !draft) return;
    setSaving(true);
    setBanner(null);
    try {
      const baseline = draft.baseline || {
        asOf: '',
        source: 'manual',
        hours: draft.hours,
      };
      const nextRoll = rollUpPilotHours({
        baseline,
        entries: (data.flightEntries || []).filter((entry) => entry.uid === selected.pilot.uid),
        now: Date.now(),
      });
      await savePilotLogbook(selected.pilot.uid, {
        ...draft,
        pilotName: selected.pilot.name || draft.pilotName,
        baseline,
        hours: baseline.asOf ? nextRoll.hours : baseline.hours,
        hoursMeta: baseline.asOf ? nextRoll.meta : draft.hoursMeta,
      }, currentUser);
      setDirty(false);
      setBanner({ ok: true, text: 'Logbook saved. Totals include the baseline plus flights after the as-of date.' });
    } catch (err) {
      setBanner({ ok: false, text: err?.message || 'Could not save the logbook.' });
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    if (!report) {
      setShowReport(true);
      return;
    }
    const file = await generatePilotReportPdf(report);
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`flex min-h-0 flex-1 flex-col bg-slate-950 ${embedded ? 'h-full' : ''}`}>
      <header className="shrink-0 border-b border-slate-800 bg-slate-900/40 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-cyan-400" />
            <h1 className="text-sm tracking-widest text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {embedded ? 'HOURS AND RATING' : 'PILOT SAFETY RATING'}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.canEdit && !embedded && (
              <button
                type="button"
                onClick={() => setShowImport(true)}
                className="inline-flex items-center gap-1 border border-cyan-500/50 px-2 py-1.5 text-[10px] tracking-widest text-cyan-200"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                <Upload className="h-3.5 w-3.5" /> IMPORT FROM WYVERN
              </button>
            )}
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pilot…"
              className="w-full max-w-xs border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 sm:w-56"
            />
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-amber-100/80">
          {data.standards?.customized
            ? 'Ratings use the Registered Standard minimums saved in this section.'
            : 'Ratings use the Wyvern Registered Standard defaults, split by PIC and SIC. Change them with Rating minimums in this section.'}
          {' '}Checks and training dates are maintained on Currency.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Count label="MEETS" value={counts.meets} tone="text-emerald-300" />
          <Count label="EXPIRES SOON" value={counts.caution} tone="text-amber-200" />
          <Count label="DOES NOT MEET" value={counts.doesNotMeet} tone="text-red-200" />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="max-h-64 overflow-auto border-b border-slate-800 lg:max-h-none lg:border-b-0 lg:border-r">
          {visible.length === 0 && (
            <p className="p-4 text-sm italic text-slate-500">No pilots match.</p>
          )}
          {visible.map(({ pilot, rating }) => (
            <button
              key={pilot.uid}
              type="button"
              onClick={() => {
                setSelectedUid(pilot.uid);
                setDirty(false);
                setShowReport(false);
              }}
              className={`flex w-full items-center justify-between gap-2 border-b border-slate-800/80 px-3 py-2 text-left hover:bg-slate-900 ${selected?.pilot.uid === pilot.uid ? 'bg-slate-900' : ''}`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-slate-100">{pilot.name || pilot.email}</span>
                <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {(pilot.role || 'crew').toUpperCase()}
                </span>
              </span>
              <PilotRatingBadge rating={rating} />
            </button>
          ))}
        </aside>

        <main className="min-h-0 overflow-auto p-4">
          {!selected && <p className="text-sm text-slate-500">Select a pilot.</p>}
          {selected && draft && (
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 border border-slate-800 bg-slate-900/50 p-4">
                <div>
                  <h2 className="text-lg text-slate-100">{selected.pilot.name}</h2>
                  <p className="mt-1 text-xs text-slate-400">
                    Qualifies for {(liveRating?.qualifiesFor || []).join(' and ') || 'neither PIC nor SIC'}
                    {liveRating?.hoursUpdatedAt ? ` · hours last updated ${liveRating.hoursUpdatedAt}` : ''}
                  </p>
                  {(liveRating?.flags || []).length > 0 && (
                    <p className="mt-1 text-[11px] text-amber-200">{liveRating.flags.join(' · ')}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <SeatChip seat="PIC" tier={liveRating?.positions?.PIC?.tier} />
                  <SeatChip seat="SIC" tier={liveRating?.positions?.SIC?.tier} />
                </div>
              </div>

              <section className="border border-slate-800 p-4" data-testid="broker-withhold">
                <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>BROKER REPORT</h3>
                {withhold.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-300">
                    Shown to brokers only when every pilot assigned to the trip meets the standard. The share page and the emailed PDF are the green crew summary.
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-sm text-amber-100">
                      {report
                        ? 'Hidden from brokers on any trip that assigns this pilot to a seat they do not meet. That share page leaves the crew report off.'
                        : 'Hidden from brokers. The share page leaves the crew report off, and email is blocked, until this pilot meets the standard.'}
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-slate-300">
                      {withhold.map((line) => <li key={line}>{line}</li>)}
                    </ul>
                  </>
                )}
              </section>

              <section className="border border-slate-800 p-4" data-testid="gap-analysis">
                <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>GAP ANALYSIS</h3>
                {(liveRating?.unmet || []).length === 0 ? (
                  <p className="mt-2 text-sm text-slate-300">No unmet items.</p>
                ) : (
                  <table className="mt-2 w-full text-left text-xs text-slate-200">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                        <th className="py-1 font-medium">Item</th>
                        <th className="py-1 font-medium">Pilot</th>
                        <th className="py-1 font-medium">PIC</th>
                        <th className="py-1 font-medium">SIC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveRating.unmet.map((row) => (
                        <tr key={row.label} className="border-t border-slate-800">
                          <td className="py-1 pr-2">{row.label}</td>
                          <td className="py-1 pr-2">{row.pilotValue}</td>
                          <td className={`py-1 pr-2 ${row.picMet ? 'text-emerald-300' : 'text-red-300'}`}>{row.picCriteria}</td>
                          <td className={`py-1 ${row.sicMet ? 'text-emerald-300' : 'text-red-300'}`}>{row.sicCriteria}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <div className="flex gap-2">
                {[['pilot', 'PILOT'], ['experience', 'EXPERIENCE'], ['types', 'TYPE RATINGS']].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRecordTab(id)}
                    className={`border px-2 py-1 text-[10px] tracking-widest ${recordTab === id ? 'border-cyan-400 text-cyan-200' : 'border-slate-700 text-slate-400'}`}
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {recordTab === 'experience' && <section className="border border-slate-800 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>EXPERIENCE</h3>
                  {data.canEdit && (
                    <button type="button" onClick={save} disabled={saving || !dirty} className="inline-flex items-center gap-1 border border-cyan-500/40 px-2 py-1 text-[10px] tracking-widest text-cyan-200 disabled:opacity-40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      <Save className="h-3 w-3" /> {saving ? 'SAVING' : 'SAVE LOGBOOK'}
                    </button>
                  )}
                </div>
                <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
                  {draft.baseline?.asOf
                    ? `Baseline snapshot ${draft.baseline.asOf}${draft.baseline.source ? ` (${draft.baseline.source})` : ''} plus flights that blocked in after that date. Current totals are what the rating and the broker report use.`
                    : 'These figures are the snapshot. Set an as-of date before completed flights are added on top.'}
                  {rolled?.meta?.nightUncomputed
                    ? ` ${rolled.meta.nightUncomputed} leg${rolled.meta.nightUncomputed === 1 ? '' : 's'} still need night time.`
                    : ''}
                </p>
                <label className="mb-3 block max-w-xs text-[11px] text-slate-400">
                  Baseline as of
                  <input
                    type="date"
                    aria-label="Baseline as of"
                    disabled={!data.canEdit}
                    value={draft.baseline?.asOf || ''}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        baseline: {
                          asOf: event.target.value,
                          source: draft.baseline?.source || 'manual',
                          hours: draft.baseline?.hours || draft.hours,
                        },
                      });
                      setDirty(true);
                    }}
                    className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                  />
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {HOUR_FIELDS.filter((field) => !field.perType).map((field) => {
                    const line = liveRating?.experience.find((entry) => entry.key === field.key);
                    const baselineValue = (draft.baseline?.hours || draft.hours)[field.key];
                    return (
                      <label key={field.key} className="text-[11px] text-slate-400">
                        <span className="mb-1 flex items-center justify-between">
                          {field.label}
                          <span>{line?.state === 'meets' ? 'Meets' : line?.state === 'short' ? 'Short' : line?.state === 'optional' ? 'Optional' : 'Not on file'}</span>
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          disabled={!data.canEdit}
                          aria-label={field.label}
                          value={baselineValue ?? ''}
                          onChange={(event) => updateHours(field.key, event.target.value)}
                          className="w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-70"
                        />
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          {hourCaption(field.key, draft, rolled, displayBook)}
                          {` · minimum ${line?.required ? line.minimum : 'not required'}`}
                          {line?.source === 'duty' ? ' · showing duty flight time until a logbook value is saved' : ''}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {draft.baseline?.asOf && (
                  <p className="mt-3 text-[11px] text-slate-400" data-testid="flown-since">
                    Flown since {draft.baseline.asOf}: {fmtHours(rolled?.flownSince?.totalTime)} block
                    {' · '}PIC {fmtHours(rolled?.flownSince?.pic)}
                    {' · '}SIC {fmtHours(rolled?.flownSince?.sic)}
                    {' · '}landings {fmtHours(rolled?.flownSince?.landings)}
                    {' · '}last 6 months {fmtHours(displayBook?.hours?.last6Months)}
                    {' · '}current total {fmtHours(displayBook?.hours?.totalTime)}
                  </p>
                )}
                <div className="mt-3">
                  <div className="mb-1 text-[11px] text-slate-400">Time in type (baseline)</div>
                  {((draft.baseline?.hours || draft.hours).timeInType || []).map((row, index) => (
                    <div key={`${row.type}-${index}`} className="mb-1 flex gap-2">
                      <input
                        aria-label={`Aircraft type ${index + 1}`}
                        disabled={!data.canEdit}
                        value={row.type}
                        onChange={(event) => {
                          editBaseline((hours) => {
                            const timeInType = hours.timeInType.slice();
                            timeInType[index] = { ...row, type: event.target.value };
                            hours.timeInType = timeInType;
                          });
                        }}
                        className="flex-1 border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                      />
                      <input
                        type="number"
                        min="0"
                        aria-label={`PIC hours in type ${index + 1}`}
                        disabled={!data.canEdit}
                        value={row.picHours ?? ''}
                        onChange={(event) => {
                          editBaseline((hours) => {
                            const timeInType = hours.timeInType.slice();
                            timeInType[index] = { ...row, picHours: event.target.value === '' ? null : Number(event.target.value) };
                            hours.timeInType = timeInType;
                          });
                        }}
                        className="w-24 border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                      />
                      <input
                        type="number"
                        min="0"
                        aria-label={`Hours in type ${index + 1}`}
                        disabled={!data.canEdit}
                        value={row.hours ?? ''}
                        onChange={(event) => {
                          editBaseline((hours) => {
                            const timeInType = hours.timeInType.slice();
                            timeInType[index] = { ...row, hours: event.target.value === '' ? null : Number(event.target.value) };
                            hours.timeInType = timeInType;
                          });
                        }}
                        className="w-24 border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                      />
                      {data.canEdit && (
                        <button type="button" aria-label={`Remove type ${index + 1}`} onClick={() => {
                          editBaseline((hours) => {
                            hours.timeInType = hours.timeInType.filter((_, i) => i !== index);
                          });
                        }} className="px-2 text-slate-500 hover:text-red-300">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  {draft.baseline?.asOf && (displayBook?.hours?.timeInType || []).length > 0 && (
                    <p className="mt-1 text-[10px] text-slate-500">
                      Current time in type: {displayBook.hours.timeInType.map((entry) => `${entry.type} ${fmtHours(entry.hours)}`).join(' · ')}
                    </p>
                  )}
                  {data.canEdit && (
                    <button type="button"                 onClick={() => {
                      editBaseline((hours) => {
                        hours.timeInType = [...hours.timeInType, { type: '', hours: null, picHours: null }];
                      });
                    }} className="mt-1 inline-flex items-center gap-1 text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      <Plus className="h-3 w-3" /> ADD TYPE
                    </button>
                  )}
                </div>
              </section>}

              {recordTab === 'experience' && (
                <FlightLogPanel
                  pilot={selected.pilot}
                  entries={pilotEntries}
                  canEdit={data.canEdit}
                  currentUser={currentUser}
                  baseline={draft.baseline}
                  onSaved={(text) => setBanner({ ok: true, text })}
                  onError={(text) => setBanner({ ok: false, text })}
                />
              )}

              {recordTab === 'pilot' && (
              <CertificateBlock
                draft={draft}
                canEdit={data.canEdit}
                docs={data.docsByUid[selected.pilot.uid] || []}
                rating={liveRating}
                onChange={(certificate) => {
                  setDraft({ ...draft, certificate });
                  setDirty(true);
                }}
                onDrugChange={(drugAlcohol) => {
                  setDraft({ ...draft, drugAlcohol });
                  setDirty(true);
                }}
                onBackground={(background) => {
                  setDraft({ ...draft, background });
                  setDirty(true);
                }}
              />
              )}

              {recordTab === 'types' && (
                <TypeRatingsPanel
                  draft={draft}
                  currencyDoc={data.currencies[selected.pilot.uid]}
                  rating={liveRating}
                  todayMs={data.todayMs}
                  onEditChecks={onEditChecks && data.canEdit ? () => onEditChecks(selected.pilot.uid) : null}
                />
              )}

              {recordTab === 'pilot' && <section className="border border-slate-800 p-4">
                <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>REQUIREMENTS</h3>
                <p className="mt-1 text-[11px] text-slate-500">Medical class, check dates, and training dates are edited in this Compliance section. This list is the rating’s reading of that record.</p>
                {onEditChecks && data.canEdit && (
                  <button type="button" onClick={() => onEditChecks(selected.pilot.uid)} className="mt-2 text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    EDIT CHECKS AND MEDICAL
                  </button>
                )}
                <div className="mt-2 divide-y divide-slate-800">
                  {(liveRating?.requirements || []).filter((item) => item.included).map((item) => (
                    <div key={item.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                      <div>
                        <div className="text-slate-100">{item.label}</div>
                        <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                          {item.detail}
                          {item.completedOn ? ` · completed ${item.completedOn}` : ''}
                          {item.id !== 'medical' && item.dueOn ? ` · due ${item.dueOn}` : ''}
                        </div>
                      </div>
                      <span className="shrink-0 text-[10px] tracking-widest text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{item.statusLabel}</span>
                    </div>
                  ))}
                </div>
              </section>}

              {banner && (
                <p className={`text-xs ${banner.ok ? 'text-emerald-300' : 'text-red-300'}`}>{banner.text}</p>
              )}

              <div className="flex flex-wrap gap-2">
                {data.canEdit && (
                  <button type="button" onClick={save} disabled={saving || !dirty} className="inline-flex items-center gap-1 border border-cyan-500/40 px-3 py-2 text-[10px] tracking-widest text-cyan-200 disabled:opacity-40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    <Save className="h-3.5 w-3.5" /> {saving ? 'SAVING' : 'SAVE LOGBOOK'}
                  </button>
                )}
                <button type="button" onClick={() => setShowReport(true)} className="inline-flex items-center gap-1 border border-slate-600 px-3 py-2 text-[10px] tracking-widest text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <Eye className="h-3.5 w-3.5" /> {report ? 'PREVIEW REPORT' : 'WHY IT IS HIDDEN'}
                </button>
                <button type="button" onClick={download} disabled={!report} className="inline-flex items-center gap-1 border border-slate-600 px-3 py-2 text-[10px] tracking-widest text-slate-100 disabled:opacity-40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <Download className="h-3.5 w-3.5" /> DOWNLOAD PDF
                </button>
                {data.canSend && (
                  <button type="button" onClick={() => setShowEmail(true)} disabled={!report} className="inline-flex items-center gap-1 border border-cyan-500/50 px-3 py-2 text-[10px] tracking-widest text-cyan-200 disabled:opacity-40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    <Mail className="h-3.5 w-3.5" /> EMAIL BROKER
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {showReport && (
        <Modal title={report ? 'Crew report' : 'Not sent to brokers'} onClose={() => setShowReport(false)}>
          {report ? <BrokerPilotReport report={report} /> : (
            <div className="border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
              <p>This crew report is hidden from brokers. The share page omits it, and email is blocked, until the assigned pilot meets the standard.</p>
              <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-slate-300">
                {withhold.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}
        </Modal>
      )}
      {showEmail && report && selected && (
        <EmailPilotReport
          pilot={selected.pilot}
          onClose={() => setShowEmail(false)}
        />
      )}
      {showImport && data.canEdit && (
        <WyvernImporter
          users={users}
          currentUser={currentUser}
          logbooks={data.logbooks}
          currencies={data.currencies}
          flightEntries={data.flightEntries}
          standards={data.standards}
          onClose={() => setShowImport(false)}
          onImported={({ written, errors }) => {
            setBanner({
              ok: errors === 0,
              text: errors
                ? `Imported ${written} pilot${written === 1 ? '' : 's'} from Wyvern. ${errors} failed.`
                : `Imported ${written} pilot${written === 1 ? '' : 's'} from Wyvern. Ratings use the updated records.`,
            });
          }}
        />
      )}
    </div>
  );
}

function toBrokerRelease(rating) {
  return releaseBrokerReport(rating, { generatedAt: new Date().toISOString() });
}

function Count({ label, value, tone }) {
  return (
    <div className="border border-slate-800 bg-slate-950 px-3 py-2">
      <div className={`text-lg ${tone}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{value}</div>
      <div className="text-[9px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
    </div>
  );
}

const TYPE_FAMILIES = [
  { id: 'CE525', label: 'CE-525 / CE-525S', oral: 'groundOral293a_CE525', sim: 'sim293b_CE525' },
  { id: 'LR60', label: 'LR-60', oral: 'groundOral293a_LR60', sim: 'sim293b_LR60' },
  { id: 'SF50', label: 'SF-50', oral: 'groundOral293a_SF50', sim: 'sim293b_SF50' },
];

function SeatChip({ seat, tier }) {
  const fail = tier === 'doesNotMeet' || !tier;
  const caution = tier === 'caution';
  const tone = fail ? 'border-red-500/40 text-red-200' : caution ? 'border-amber-500/40 text-amber-200' : 'border-emerald-500/40 text-emerald-300';
  return (
    <span className={`border px-2 py-1 text-[10px] tracking-widest ${tone}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {seat} {fail ? 'DOES NOT MEET' : caution ? 'EXPIRES SOON' : 'MEETS'}
    </span>
  );
}

function checkLabel(item, months, todayMs) {
  if (!item || item.notApplicable) return 'Not Required';
  const result = computeStatus(item, null, todayMs, months > 0 ? { intervalMonths: months, graceMonths: 0 } : {});
  return itemStatusLabel(result.status, result.daysUntil);
}

function TypeRatingsPanel({ draft, currencyDoc, rating, todayMs, onEditChecks }) {
  const ratings = draft?.certificate?.typeRatings || [];
  const verified = draft?.certificate?.typeVerified === true;
  return (
    <section className="border border-slate-800 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>TYPE RATINGS</h3>
        {onEditChecks && (
          <button type="button" onClick={onEditChecks} className="text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            EDIT CHECKS AND MEDICAL
          </button>
        )}
      </div>
      <p className="mb-3 text-[11px] text-slate-400">
        Verified: {verified ? 'Yes' : 'Type Not Verified'}. Recurrent training {checkLabel(currencyDoc?.recurrentTraining351, 12, todayMs)}.
        {' '}{(rating?.flags || []).join(' · ')}
      </p>
      <div className="space-y-3">
        {TYPE_FAMILIES.map((family) => {
          const assigned = ratings.some((type) => type.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(family.id));
          const oral = currencyDoc?.[family.oral];
          const sim = currencyDoc?.[family.sim];
          return (
            <div key={family.id} className="border border-slate-800 p-3 text-sm text-slate-200">
              <div className="flex items-center justify-between gap-2">
                <span>{family.label}</span>
                <span className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {assigned ? 'ASSIGNED' : 'NOT ASSIGNED'}
                </span>
              </div>
              <dl className="mt-2 grid gap-1 text-[11px] text-slate-400 sm:grid-cols-2">
                <div>Aircraft-specific check: {checkLabel(oral, 12, todayMs)}{oral?.lastDate ? ` · ${oral.lastDate}` : ''}</div>
                <div>Simulator: {checkLabel(sim, 12, todayMs)}{sim?.notes ? ` · ${sim.notes}` : ''}</div>
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CertificateBlock({ draft, canEdit, docs, rating, onChange, onDrugChange, onBackground }) {
  const certificate = docs.find((entry) => entry.docType === 'certificate');
  const hint = certificate && !draft.certificate.level
    ? `Airman certificate on file lists ${certificate.certType || 'a grade'}${certificate.ratings ? ` (${certificate.ratings})` : ''}. The certificate number stays on Pilot Docs.`
    : '';
  const applyHint = () => {
    onChange({
      ...draft.certificate,
      level: normalizeCertificateLevel(certificate?.certType) || draft.certificate.level,
      typeRatings: draft.certificate.typeRatings.length
        ? draft.certificate.typeRatings
        : String(certificate?.ratings || '').split(/[,;\n]/).map((part) => part.trim()).filter(Boolean),
    });
  };
  return (
    <section className="border border-slate-800 p-4">
      <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PILOT</h3>
      {rating?.medical && (
        <p className="mt-2 text-[11px] text-slate-400">
          Medical {rating.medical.class || 'not on file'} · {rating.medical.statusLabel || 'Not Validated'}
          {rating.medical.lastDate ? ` · last medical ${rating.medical.lastDate}` : ''}
        </p>
      )}
      {hint && (
        <p className="mt-2 text-[11px] text-slate-400">
          {hint}
          {canEdit && (
            <button type="button" onClick={applyHint} className="ml-2 text-cyan-300">Use grade and ratings</button>
          )}
        </p>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <label className="text-[11px] text-slate-400">
          Certificate
          <select
            disabled={!canEdit}
            aria-label="Certificate level"
            value={draft.certificate.level}
            onChange={(event) => onChange({ ...draft.certificate, level: event.target.value })}
            className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          >
            <option value="">Not recorded</option>
            {CERTIFICATE_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
          </select>
        </label>
        <TriState
          label="Instrument rating"
          value={draft.certificate.instrument}
          disabled={!canEdit}
          onChange={(instrument) => onChange({ ...draft.certificate, instrument })}
        />
        <TriState
          label="Multi-engine rating"
          value={draft.certificate.multiEngine}
          disabled={!canEdit}
          onChange={(multiEngine) => onChange({ ...draft.certificate, multiEngine })}
        />
      </div>
      <label className="mt-2 block text-[11px] text-slate-400">
        Type ratings
        <input
          disabled={!canEdit}
          aria-label="Type ratings"
          value={(draft.certificate.typeRatings || []).join(', ')}
          onChange={(event) => onChange({
            ...draft.certificate,
            typeRatings: event.target.value.split(',').map((part) => part.trim()),
          })}
          placeholder="CE-525, LR-60, SF-50"
          className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
        />
      </label>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label className="text-[11px] text-slate-400">
          Issuing country
          <input
            disabled={!canEdit}
            aria-label="Issuing country"
            value={draft.certificate.country || ''}
            onChange={(event) => onChange({ ...draft.certificate, country: event.target.value })}
            className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <TriState
          label="Type rating verified"
          value={draft.certificate.typeVerified}
          disabled={!canEdit}
          onChange={(typeVerified) => onChange({ ...draft.certificate, typeVerified })}
        />
        <label className="text-[11px] text-slate-400">
          Employment
          <input
            disabled={!canEdit}
            aria-label="Employment status"
            value={draft.background?.employment || ''}
            onChange={(event) => onBackground?.({ ...draft.background, employment: event.target.value })}
            placeholder="Full Time"
            className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <RecordSelect
          label="Accident / incident"
          value={draft.background?.accident}
          disabled={!canEdit}
          onChange={(accident) => onBackground?.({ ...draft.background, accident })}
        />
        <RecordSelect
          label="Enforcement"
          value={draft.background?.enforcement}
          disabled={!canEdit}
          onChange={(enforcement) => onBackground?.({ ...draft.background, enforcement })}
        />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <label className="text-[11px] text-slate-400">
          Drug and alcohol program
          <select
            disabled={!canEdit}
            aria-label="Drug and alcohol enrollment"
            value={draft.drugAlcohol.enrolled == null ? '' : draft.drugAlcohol.enrolled ? 'yes' : 'no'}
            onChange={(event) => onDrugChange({
              ...draft.drugAlcohol,
              enrolled: event.target.value === '' ? null : event.target.value === 'yes',
            })}
            className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          >
            <option value="">Not recorded</option>
            <option value="yes">Enrolled</option>
            <option value="no">Not enrolled</option>
          </select>
        </label>
        <label className="text-[11px] text-slate-400">
          Enrolled on
          <input
            type="date"
            disabled={!canEdit}
            aria-label="Drug and alcohol enrollment date"
            value={draft.drugAlcohol.enrolledDate || ''}
            onChange={(event) => onDrugChange({ ...draft.drugAlcohol, enrolledDate: event.target.value })}
            className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-[11px] text-slate-400">
          Program
          <input
            disabled={!canEdit}
            aria-label="Drug and alcohol program name"
            value={draft.drugAlcohol.programName || ''}
            onChange={(event) => onDrugChange({ ...draft.drugAlcohol, programName: event.target.value })}
            className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>
    </section>
  );
}

function RecordSelect({ label, value, onChange, disabled }) {
  const current = value === true ? 'yes' : value === false ? 'none' : '';
  return (
    <label className="text-[11px] text-slate-400">
      {label}
      <select
        disabled={disabled}
        aria-label={label}
        value={current}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'yes')}
        className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
      >
        <option value="">Not recorded</option>
        <option value="none">None</option>
        <option value="yes">Yes</option>
      </select>
    </label>
  );
}

function TriState({ label, value, onChange, disabled }) {
  const current = value === true ? 'yes' : value === false ? 'no' : '';
  return (
    <label className="text-[11px] text-slate-400">
      {label}
      <select
        disabled={disabled}
        aria-label={label}
        value={current}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'yes')}
        className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
      >
        <option value="">Not recorded</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4">
      <div className="w-full max-w-3xl">
        <div className="mb-2 flex items-center justify-between text-slate-200">
          <span className="text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{title.toUpperCase()}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EmailPilotReport({ pilot, onClose }) {
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch('/api/pilot-report-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          to: to.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean),
          pilotUid: pilot.uid,
          note,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (body.blocked) {
        const why = Array.isArray(body.reasons) && body.reasons.length ? ` ${body.reasons.join(' ')}` : '';
        throw new Error(`${body.error || 'This report was not sent.'}${why}`);
      }
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || body.emailError || 'Email was not sent');
      }
      setResult({ ok: true, text: `Report sent to ${body.recipients?.join(', ') || to}. The PDF is attached.` });
    } catch (err) {
      setResult({ ok: false, text: err?.message || 'Email was not sent' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Email pilot report" onClose={onClose}>
      <div className="space-y-3 border border-slate-700 bg-slate-950 p-4 text-slate-100">
        <p className="text-sm text-slate-300">
          Sends {pilot.name}’s crew summary as a PDF. It goes out only when this pilot meets the standard. Certificate numbers, date of birth, and addresses are not included.
        </p>
        <label className="block text-[11px] text-slate-400">
          Broker email
          <input
            type="email"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="broker@example.com"
            className="mt-1 w-full border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-[11px] text-slate-400">
          Note
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            className="mt-1 w-full border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
          />
        </label>
        {result && <p className={`text-xs ${result.ok ? 'text-emerald-300' : 'text-red-300'}`}>{result.text}</p>}
        <button type="button" onClick={send} disabled={busy || !to.trim()} className="border border-cyan-500/50 px-3 py-2 text-[10px] tracking-widest text-cyan-200 disabled:opacity-40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {busy ? 'SENDING' : 'SEND PDF'}
        </button>
      </div>
    </Modal>
  );
}

export default function PilotSafetyScreen(props) {
  if (props.data) return <PilotSafetyView {...props} />;
  return <PilotSafetyConnected {...props} />;
}

function PilotSafetyConnected(props) {
  const data = usePilotSafetyData(props.currentUser, {
    trips: props.trips ?? null,
    aircraftByTail: props.aircraftByTail ?? null,
    users: props.users || [],
  });
  return <PilotSafetyView {...props} data={data} />;
}

function fmtHours(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);
}

function hourCaption(key, draft, rolled, displayBook) {
  if (!draft?.baseline?.asOf) return 'Baseline snapshot';
  if (key === 'instrument') return 'Baseline only — instrument time is not taken from the schedule';
  if (key === 'last90Days' || key === 'last12Months' || key === 'multiEngine90' || key === 'multiEngine12') {
    return `Current ${fmtHours(displayBook?.hours?.[key])} (baseline still in the window is estimated)`;
  }
  if (key === 'fixedWing' || key === 'rotorWing' || key === 'singleEngine') {
    return `Baseline ${fmtHours(displayBook?.hours?.[key])}`;
  }
  const added = rolled?.flownSince?.[key];
  return `Baseline + ${fmtHours(added)} flown since = ${fmtHours(displayBook?.hours?.[key])} current`;
}

function sourceLabel(source) {
  if (source === 'flightaware') return 'FlightAware';
  if (source === 'schedule') return 'Schedule';
  if (source === 'manual') return 'Manual';
  return source || '—';
}

function whenLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function FlightLogPanel({ pilot, entries, canEdit, currentUser, baseline, onSaved, onError }) {
  const [openId, setOpenId] = useState('');
  const [note, setNote] = useState('');
  const [blockHours, setBlockHours] = useState('');
  const [nightHours, setNightHours] = useState('');
  const [adding, setAdding] = useState(false);
  const [manual, setManual] = useState({
    origin: '', destination: '', role: 'PIC', aircraftType: '', blockHours: '', blockIn: '', nightHours: '', landings: '1', note: '',
    multiEngine: '', turbine: '',
  });
  const rows = [...(entries || [])].sort((a, b) => String(b.blockIn || '').localeCompare(String(a.blockIn || '')));

  const correct = async (entry) => {
    try {
      const next = applyManualFlightEdit(entry, {
        note,
        blockHours: blockHours === '' ? null : Number(blockHours),
        nightHours: nightHours === '' ? null : Number(nightHours),
      }, currentUser);
      await savePilotFlightEntry(next, currentUser);
      setOpenId('');
      setNote('');
      onSaved('Correction saved. The total recounts this leg once.');
    } catch (err) {
      onError(err?.message || 'Could not save the correction.');
    }
  };

  const voidLeg = async (entry) => {
    const reason = note.trim();
    if (!reason) {
      onError('A note is required to void a leg.');
      return;
    }
    try {
      await savePilotFlightEntry(voidEntry(entry, reason, currentUser), currentUser);
      setOpenId('');
      setNote('');
      onSaved('Leg voided. It no longer counts toward the total.');
    } catch (err) {
      onError(err?.message || 'Could not void the leg.');
    }
  };

  const addManual = async () => {
    try {
      const blockIn = manual.blockIn ? new Date(manual.blockIn).toISOString() : new Date().toISOString();
      const entry = newManualFlightEntry({
        uid: pilot.uid,
        pilotName: pilot.name,
        editor: currentUser,
        patch: {
          ...manual,
          blockIn,
          blockHours: manual.blockHours,
          nightHours: manual.nightHours === '' ? null : Number(manual.nightHours),
          landings: manual.landings === '' ? 1 : Number(manual.landings),
          multiEngine: manual.multiEngine === '' ? null : manual.multiEngine === 'yes',
          turbine: manual.turbine === '' ? null : manual.turbine === 'yes',
        },
      });
      await savePilotFlightEntry(entry, currentUser);
      setAdding(false);
      setManual({
        origin: '', destination: '', role: 'PIC', aircraftType: '', blockHours: '', blockIn: '', nightHours: '', landings: '1', note: '',
        multiEngine: '', turbine: '',
      });
      onSaved(baseline?.asOf
        ? 'Manual entry added. It counts when the block-in date is after the baseline.'
        : 'Manual entry added. Set a baseline as-of date before it changes the total.');
    } catch (err) {
      onError(err?.message || 'Could not add the entry.');
    }
  };

  return (
    <section className="border border-slate-800 p-4" data-testid="flight-log">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>FLIGHT LOG</h3>
        {canEdit && (
          <button type="button" onClick={() => setAdding((open) => !open)} className="inline-flex items-center gap-1 text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <Plus className="h-3 w-3" /> ADD ENTRY
          </button>
        )}
      </div>
      <p className="mb-3 text-[11px] text-slate-500">
        Each completed leg is credited once to the assigned PIC and SIC. FlightAware out–in is preferred; the schedule is used after the leg ends when actual times are missing. A correction keeps an audit note and is not overwritten by the next sync.
      </p>
      {adding && canEdit && (
        <div className="mb-3 grid gap-2 border border-slate-800 p-3 sm:grid-cols-2">
          <input aria-label="Manual origin" placeholder="From" value={manual.origin} onChange={(event) => setManual({ ...manual, origin: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
          <input aria-label="Manual destination" placeholder="To" value={manual.destination} onChange={(event) => setManual({ ...manual, destination: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
          <input aria-label="Manual aircraft" placeholder="Aircraft type" value={manual.aircraftType} onChange={(event) => setManual({ ...manual, aircraftType: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
          <select aria-label="Manual role" value={manual.role} onChange={(event) => setManual({ ...manual, role: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm">
            <option value="PIC">PIC</option>
            <option value="SIC">SIC</option>
          </select>
          <input aria-label="Manual block hours" type="number" min="0" step="0.1" placeholder="Block hours" value={manual.blockHours} onChange={(event) => setManual({ ...manual, blockHours: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
          <input aria-label="Manual block in" type="datetime-local" value={manual.blockIn} onChange={(event) => setManual({ ...manual, blockIn: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
          <select aria-label="Manual multi-engine" value={manual.multiEngine} onChange={(event) => setManual({ ...manual, multiEngine: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm">
            <option value="">Multi-engine unknown</option>
            <option value="yes">Multi-engine</option>
            <option value="no">Single-engine</option>
          </select>
          <select aria-label="Manual turbine" value={manual.turbine} onChange={(event) => setManual({ ...manual, turbine: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm">
            <option value="">Turbine unknown</option>
            <option value="yes">Turbine</option>
            <option value="no">Not turbine</option>
          </select>
          <input aria-label="Manual night hours" type="number" min="0" step="0.1" placeholder="Night hours, if known" value={manual.nightHours} onChange={(event) => setManual({ ...manual, nightHours: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
          <input aria-label="Manual note" placeholder="Why this entry is being added" value={manual.note} onChange={(event) => setManual({ ...manual, note: event.target.value })} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
          <button type="button" onClick={addManual} className="border border-cyan-500/40 px-2 py-1.5 text-[10px] tracking-widest text-cyan-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>SAVE ENTRY</button>
        </div>
      )}
      {rows.length === 0 && <p className="text-sm italic text-slate-500">No credited legs yet.</p>}
      <div className="divide-y divide-slate-800">
        {rows.map((entry) => (
          <div key={entry.id} className={`py-2 text-sm ${entry.status === 'void' ? 'opacity-50' : ''}`} data-testid={`leg-${entry.tripUid || entry.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-slate-100">
                {entry.role} {entry.origin || '—'}–{entry.destination || '—'}
                <span className="ml-2 text-[11px] text-slate-500">{entry.aircraftType || entry.tail}</span>
              </div>
              <div className="text-[11px] text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {fmtHours(entry.blockHours)} block
                {entry.flightHours != null ? ` · ${fmtHours(entry.flightHours)} flight` : ''}
                {' · '}{entry.landings ?? 0} landing{entry.landings === 1 ? '' : 's'}
              </div>
            </div>
            <div className="mt-1 text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {whenLabel(entry.blockIn)} · {sourceLabel(entry.timeSource)}
              {entry.nightStatus === 'unknown' ? ' · night needs manual entry' : ` · night ${fmtHours(entry.nightHours)}`}
              {entry.status === 'void' ? ` · void${entry.voidReason ? `: ${entry.voidReason}` : ''}` : ''}
              {entry.manualOverride ? ' · corrected' : ''}
            </div>
            {canEdit && entry.status !== 'void' && (
              <button type="button" onClick={() => {
                setOpenId(openId === entry.id ? '' : entry.id);
                setNote('');
                setBlockHours(entry.blockHours ?? '');
                setNightHours(entry.nightHours ?? '');
              }} className="mt-1 text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {openId === entry.id ? 'CLOSE' : 'CORRECT'}
              </button>
            )}
            {openId === entry.id && (
              <div className="mt-2 grid gap-2 border border-slate-800 p-2">
                <input aria-label="Corrected block hours" type="number" min="0" step="0.1" value={blockHours} onChange={(event) => setBlockHours(event.target.value)} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
                <input aria-label="Corrected night hours" type="number" min="0" step="0.1" placeholder="Night hours" value={nightHours} onChange={(event) => setNightHours(event.target.value)} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
                <input aria-label="Correction note" placeholder="Why this leg is being changed" value={note} onChange={(event) => setNote(event.target.value)} className="border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm" />
                <div className="flex gap-2">
                  <button type="button" onClick={() => correct(entry)} className="border border-cyan-500/40 px-2 py-1 text-[10px] tracking-widest text-cyan-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>SAVE CORRECTION</button>
                  <button type="button" onClick={() => voidLeg(entry)} className="border border-red-500/40 px-2 py-1 text-[10px] tracking-widest text-red-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>VOID LEG</button>
                </div>
                {(entry.audit || []).length > 0 && (
                  <ul className="space-y-1 text-[10px] text-slate-500">
                    {entry.audit.map((line, index) => (
                      <li key={`${line.at}-${index}`}>{line.action} · {line.byName || 'Flight log'} · {line.note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
