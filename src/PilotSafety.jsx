// Pilot safety rating. Hours and enrollment are edited here. Checks,
// training, and the medical are read from Currency. Certificate scans in
// Pilot Docs fill a blank certificate summary and never contribute a
// certificate number to the screen or the broker report.

import { useEffect, useMemo, useState } from 'react';
import {
  Download, Eye, Mail, Plus, Save, ShieldCheck, Trash2, X,
} from 'lucide-react';
import { brand } from './brand.js';
import BrokerPilotReport, { PilotRatingBadge } from './BrokerPilotReport.jsx';
import { savePilotLogbook } from './firebase-pilot-safety.js';
import { generatePilotReportPdf } from './pilot-report-pdf.js';
import {
  CERTIFICATE_LEVELS,
  HOUR_FIELDS,
  brokerPilotReport,
  emptyLogbook,
  evaluatePilot,
  normalizeCertificateLevel,
  normalizeLogbook,
  summarizeDutyFlightHours,
} from './pilot-safety.js';
import { usePilotSafetyData } from './use-pilot-safety-data.js';

const TIER_ORDER = { doesNotMeet: 0, caution: 1, meets: 2 };

export default function PilotSafetyScreen({ currentUser, users = [] }) {
  const data = usePilotSafetyData(currentUser);
  const [query, setQuery] = useState('');
  const [selectedUid, setSelectedUid] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [showEmail, setShowEmail] = useState(false);

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

  const liveRating = selected && draft
    ? evaluatePilot({
        pilot: selected.pilot,
        logbook: draft,
        currencyDoc: data.currencies[selected.pilot.uid],
        pilotDocs: data.docsByUid[selected.pilot.uid] || [],
        standards: data.standards,
        dutyHours: summarizeDutyFlightHours(data.periods, selected.pilot.uid, data.todayMs),
        todayMs: data.todayMs,
      })
    : selected?.rating;
  const report = liveRating ? toBrokerReport(liveRating) : null;
  const counts = {
    meets: pilots.filter((row) => row.rating.tier === 'meets').length,
    caution: pilots.filter((row) => row.rating.tier === 'caution').length,
    doesNotMeet: pilots.filter((row) => row.rating.tier === 'doesNotMeet').length,
  };

  const updateHours = (key, value) => {
    setDraft((current) => ({
      ...current,
      hours: { ...current.hours, [key]: value === '' ? null : Number(value) },
    }));
    setDirty(true);
  };

  const save = async () => {
    if (!selected || !draft) return;
    setSaving(true);
    setBanner(null);
    try {
      await savePilotLogbook(selected.pilot.uid, {
        ...draft,
        pilotName: selected.pilot.name || draft.pilotName,
      }, currentUser);
      setDirty(false);
      setBanner({ ok: true, text: 'Logbook saved.' });
    } catch (err) {
      setBanner({ ok: false, text: err?.message || 'Could not save the logbook.' });
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    if (!report) return;
    const file = await generatePilotReportPdf(report);
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-950">
      <header className="shrink-0 border-b border-slate-800 bg-slate-900/40 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-cyan-400" />
            <h1 className="text-sm tracking-widest text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              PILOT SAFETY RATING
            </h1>
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pilot…"
            className="w-full max-w-xs border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 sm:w-56"
          />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-amber-100/80">
          {data.standards?.customized
            ? 'Ratings use the minimums saved in Admin settings.'
            : 'Ratings use shipped defaults: industry-typical Part 135 charter figures, not a Wyvern score. Change them in Admin settings.'}
          {' '}Checks and training dates are maintained on Currency.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Count label="MEETS STANDARD" value={counts.meets} tone="text-emerald-300" />
          <Count label="CAUTION" value={counts.caution} tone="text-amber-200" />
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
                    Score {liveRating?.score} / 100 · {liveRating?.weights.experience}% experience, {liveRating?.weights.requirements}% requirements
                  </p>
                </div>
                <PilotRatingBadge rating={liveRating} />
              </div>

              <section className="border border-slate-800 p-4">
                <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>WHY THIS RATING</h3>
                <ul className="mt-2 space-y-1 text-sm text-slate-200">
                  {(liveRating?.reasons || []).map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </section>

              <section className="border border-slate-800 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>HOURS</h3>
                  {data.canEdit && (
                    <button type="button" onClick={save} disabled={saving || !dirty} className="inline-flex items-center gap-1 border border-cyan-500/40 px-2 py-1 text-[10px] tracking-widest text-cyan-200 disabled:opacity-40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      <Save className="h-3 w-3" /> {saving ? 'SAVING' : 'SAVE LOGBOOK'}
                    </button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {HOUR_FIELDS.filter((field) => !field.perType).map((field) => {
                    const line = liveRating?.experience.find((entry) => entry.key === field.key);
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
                          value={draft.hours[field.key] ?? ''}
                          onChange={(event) => updateHours(field.key, event.target.value)}
                          className="w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-70"
                        />
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          Minimum {line?.required ? line.minimum : 'not required'}
                          {line?.source === 'duty' ? ' · showing duty flight time until a logbook value is saved' : ''}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <div className="mb-1 text-[11px] text-slate-400">Time in type</div>
                  {(draft.hours.timeInType || []).map((row, index) => (
                    <div key={`${row.type}-${index}`} className="mb-1 flex gap-2">
                      <input
                        aria-label={`Aircraft type ${index + 1}`}
                        disabled={!data.canEdit}
                        value={row.type}
                        onChange={(event) => {
                          const timeInType = draft.hours.timeInType.slice();
                          timeInType[index] = { ...row, type: event.target.value };
                          setDraft({ ...draft, hours: { ...draft.hours, timeInType } });
                          setDirty(true);
                        }}
                        className="flex-1 border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                      />
                      <input
                        type="number"
                        min="0"
                        aria-label={`Hours in type ${index + 1}`}
                        disabled={!data.canEdit}
                        value={row.hours ?? ''}
                        onChange={(event) => {
                          const timeInType = draft.hours.timeInType.slice();
                          timeInType[index] = { ...row, hours: event.target.value === '' ? null : Number(event.target.value) };
                          setDraft({ ...draft, hours: { ...draft.hours, timeInType } });
                          setDirty(true);
                        }}
                        className="w-24 border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                      />
                      {data.canEdit && (
                        <button type="button" aria-label={`Remove type ${index + 1}`} onClick={() => {
                          const timeInType = draft.hours.timeInType.filter((_, i) => i !== index);
                          setDraft({ ...draft, hours: { ...draft.hours, timeInType } });
                          setDirty(true);
                        }} className="px-2 text-slate-500 hover:text-red-300">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  {data.canEdit && (
                    <button type="button" onClick={() => {
                      setDraft({
                        ...draft,
                        hours: { ...draft.hours, timeInType: [...draft.hours.timeInType, { type: '', hours: null }] },
                      });
                      setDirty(true);
                    }} className="mt-1 inline-flex items-center gap-1 text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      <Plus className="h-3 w-3" /> ADD TYPE
                    </button>
                  )}
                </div>
              </section>

              <CertificateBlock
                draft={draft}
                canEdit={data.canEdit}
                docs={data.docsByUid[selected.pilot.uid] || []}
                onChange={(certificate) => {
                  setDraft({ ...draft, certificate });
                  setDirty(true);
                }}
                onDrugChange={(drugAlcohol) => {
                  setDraft({ ...draft, drugAlcohol });
                  setDirty(true);
                }}
              />

              <section className="border border-slate-800 p-4">
                <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>REQUIREMENTS</h3>
                <p className="mt-1 text-[11px] text-slate-500">Completion and expiration dates are edited on Currency. This list is the rating’s reading of that record.</p>
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
              </section>

              {banner && (
                <p className={`text-xs ${banner.ok ? 'text-emerald-300' : 'text-red-300'}`}>{banner.text}</p>
              )}

              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setShowReport(true)} className="inline-flex items-center gap-1 border border-slate-600 px-3 py-2 text-[10px] tracking-widest text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <Eye className="h-3.5 w-3.5" /> PREVIEW REPORT
                </button>
                <button type="button" onClick={download} className="inline-flex items-center gap-1 border border-slate-600 px-3 py-2 text-[10px] tracking-widest text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <Download className="h-3.5 w-3.5" /> DOWNLOAD PDF
                </button>
                {data.canSend && (
                  <button type="button" onClick={() => setShowEmail(true)} className="inline-flex items-center gap-1 border border-cyan-500/50 px-3 py-2 text-[10px] tracking-widest text-cyan-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    <Mail className="h-3.5 w-3.5" /> EMAIL BROKER
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {showReport && report && (
        <Modal title="Pilot report" onClose={() => setShowReport(false)}>
          <BrokerPilotReport report={report} />
        </Modal>
      )}
      {showEmail && report && selected && (
        <EmailPilotReport
          pilot={selected.pilot}
          onClose={() => setShowEmail(false)}
        />
      )}
    </div>
  );
}

function toBrokerReport(rating) {
  const operator = brand();
  return brokerPilotReport(rating, {
    operatorName: operator.name,
    operatorLegalName: operator.legalName,
    generatedAt: new Date().toISOString(),
  });
}

function Count({ label, value, tone }) {
  return (
    <div className="border border-slate-800 bg-slate-950 px-3 py-2">
      <div className={`text-lg ${tone}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{value}</div>
      <div className="text-[9px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
    </div>
  );
}

function CertificateBlock({ draft, canEdit, docs, onChange, onDrugChange }) {
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
      <h3 className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CERTIFICATE, RATINGS, DRUG AND ALCOHOL</h3>
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
          placeholder="CE-525, LR-60"
          className="mt-1 w-full border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
        />
      </label>
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
          Sends {pilot.name}’s broker report as a PDF attachment. The file includes the safety rating, hours, certificate grade, and requirement dates. It leaves out certificate numbers, date of birth, home address, and medical detail beyond class and validity.
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
