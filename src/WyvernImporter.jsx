// Admin import of a Wyvern ACES pilot export (JSON or CSV).
// Preview matches, conflicts, and unmatched rows before anything is written.

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2, Upload, X } from 'lucide-react';
import { savePilotCurrency } from './firebase-currency.js';
import { savePilotLogbook } from './firebase-pilot-safety.js';
import { rollUpPilotHours } from './flight-log.js';
import {
  parseWyvernText,
  planWyvernImport,
  relinkWyvernRow,
  wyvernConflictLabel,
  wyvernCurrencyPatch,
  wyvernLogbookDraft,
  wyvernRecordSummary,
} from './wyvern-import.js';

function PilotMatchPicker({ users, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = useMemo(() => users.find((user) => user.uid === value) || null, [users, value]);
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users
      .filter((user) => user.uid && user.approved !== false)
      .filter((user) => !needle
        || (user.name || '').toLowerCase().includes(needle)
        || (user.email || '').toLowerCase().includes(needle))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [users, query]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 border border-slate-700 bg-slate-950 px-2 py-1 text-left text-xs text-slate-100 hover:border-cyan-500/40"
      >
        <span className={selected ? 'text-slate-100' : 'text-amber-300'}>
          {selected ? (selected.name || selected.email) : 'Link to a pilot, or skip'}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-slate-500" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto border border-slate-700 bg-slate-900">
          <div className="sticky top-0 border-b border-slate-800 bg-slate-900 p-2">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pilots…"
              className="w-full border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            />
          </div>
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false); }}
            className="block w-full px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800"
          >
            Skip this pilot
          </button>
          {candidates.map((user) => (
            <button
              key={user.uid}
              type="button"
              onClick={() => { onChange(user); setOpen(false); }}
              className="block w-full px-2 py-1.5 text-left text-xs text-slate-100 hover:bg-slate-800"
            >
              <span className="block">{user.name || user.email}</span>
              <span className="text-[10px] text-slate-500">{user.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Bucket({ title, tone, rows, users, logbooks, currencies, onChange }) {
  if (!rows.length) return null;
  return (
    <section className="space-y-2">
      <h3 className={`text-[11px] tracking-widest ${tone}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {title} · {rows.length}
      </h3>
      <div className="divide-y divide-slate-800 border border-slate-800">
        {rows.map((row) => (
          <div key={`${row.record.wyvernId}-${row.record.email}-${row.record.name}`} className="grid gap-3 p-3 md:grid-cols-12">
            <div className="md:col-span-1">
              <input
                type="checkbox"
                aria-label={`Import ${row.record.name || row.record.email}`}
                disabled={!row.matchUid}
                checked={Boolean(row.include && row.matchUid)}
                onChange={(event) => onChange(row, { include: event.target.checked })}
                className="mt-1 h-4 w-4 accent-cyan-500 disabled:opacity-30"
              />
            </div>
            <div className="min-w-0 md:col-span-5">
              <div className="truncate text-sm text-slate-100">{row.record.name || row.record.email}</div>
              <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {[row.record.email, row.record.wyvernId && `Wyvern ${row.record.wyvernId}`, row.match.reason].filter(Boolean).join(' · ')}
              </div>
              <div className="mt-2">
                <PilotMatchPicker
                  users={users}
                  value={row.matchUid}
                  onChange={(user) => onChange(row, { user })}
                />
              </div>
            </div>
            <div className="min-w-0 md:col-span-6">
              <div className="text-[11px] text-slate-300">{wyvernRecordSummary(row.record)}</div>
              {(row.record.warnings || []).map((warning) => (
                <div key={warning} className="mt-1 text-[10px] text-amber-200">{warning}</div>
              ))}
              {row.conflicts.map((item) => (
                <div key={`${item.field}-${item.incoming}`} className="mt-1 text-[10px] text-amber-200">
                  {wyvernConflictLabel(item.field)}: {item.existing} on file → {item.incoming} from Wyvern
                </div>
              ))}
              {!row.conflicts.length && row.matchUid && (
                <div className="mt-1 text-[10px] text-slate-500">No conflicting values. Blank Wyvern fields stay as they are.</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function WyvernImporter({
  users = [],
  currentUser,
  logbooks = {},
  currencies = {},
  flightEntries = [],
  standards = null,
  onClose,
  onImported,
}) {
  const [step, setStep] = useState('upload');
  const [rows, setRows] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [err, setErr] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [doneSummary, setDoneSummary] = useState(null);

  const grouped = useMemo(() => ({
    matched: rows.filter((row) => row.bucket === 'matched'),
    conflict: rows.filter((row) => row.bucket === 'conflict'),
    unmatched: rows.filter((row) => row.bucket === 'unmatched'),
  }), [rows]);
  const selectedCount = rows.filter((row) => row.include && row.matchUid).length;

  const loadText = (text, filename) => {
    setErr(null);
    const parsed = parseWyvernText(text, filename);
    if (!parsed.records.length) {
      setWarnings(parsed.warnings);
      setErr(parsed.warnings[0] || 'No pilots found in that file.');
      return;
    }
    const plan = planWyvernImport(parsed.records, { users, logbooks, currencies, standards });
    if (!plan.rows.length) {
      setWarnings(parsed.warnings);
      setSkipped(plan.skipped);
      setErr('No active pilots to import. Inactive and unmarked records are skipped.');
      setStep('upload');
      return;
    }
    setWarnings(parsed.warnings);
    setSkipped(plan.skipped);
    setRows(plan.rows);
    setStep('preview');
  };

  const onFile = async (file) => {
    if (!file) return;
    if (!/\.(json|csv)$/i.test(file.name) && !/json|csv/.test(file.type || '')) {
      setErr('Upload a JSON or CSV export.');
      return;
    }
    try {
      loadText(await file.text(), file.name);
    } catch (error) {
      setErr(error?.message || 'Could not read that file.');
    }
  };

  const updateRow = (row, change) => {
    setRows((current) => current.map((entry) => {
      if (entry !== row && !(entry.record === row.record)) return entry;
      if (Object.prototype.hasOwnProperty.call(change, 'user')) {
        return relinkWyvernRow(entry, change.user, logbooks, currencies);
      }
      return { ...entry, include: change.include };
    }));
  };

  const commit = async () => {
    const chosen = rows.filter((row) => row.include && row.matchUid);
    if (!chosen.length) {
      setErr('Link or select at least one active pilot.');
      return;
    }
    setErr(null);
    setStep('committing');
    setProgress({ done: 0, total: chosen.length });
    let written = 0;
    let errors = 0;
    const now = Date.now();
    for (const row of chosen) {
      try {
        const user = users.find((candidate) => candidate.uid === row.matchUid);
        const draft = wyvernLogbookDraft(logbooks[row.matchUid], row.record, {
          uid: row.matchUid,
          pilotName: user?.name || row.record.name,
          now,
        });
        if (draft.baseline?.asOf) {
          const rolled = rollUpPilotHours({
            baseline: draft.baseline,
            entries: (flightEntries || []).filter((entry) => entry.uid === row.matchUid),
            now,
          });
          draft.hours = rolled.hours;
          draft.hoursMeta = rolled.meta;
        }
        await savePilotLogbook(row.matchUid, draft, currentUser);
        const currencyPatch = wyvernCurrencyPatch(currencies[row.matchUid], row.record, now);
        if (currencyPatch) {
          await savePilotCurrency(
            row.matchUid,
            currencyPatch,
            currentUser?.uid,
            user?.name || row.record.name,
          );
        }
        written += 1;
      } catch (error) {
        console.error('Wyvern import failed for', row.record.name, error);
        errors += 1;
      } finally {
        setProgress((current) => ({ ...current, done: current.done + 1 }));
      }
    }
    setDoneSummary({ written, errors });
    setStep('done');
    if (onImported) onImported({ written, errors });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
      <div className="flex max-h-[95vh] w-full max-w-5xl flex-col border border-slate-700 bg-slate-900">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 p-3">
          <h2 className="flex items-center gap-2 text-sm tracking-widest text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <Upload className="h-4 w-4" /> IMPORT FROM WYVERN
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        {step === 'upload' && (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="border border-cyan-500/40 bg-cyan-500/5 p-4">
              <p className="text-xs leading-relaxed text-slate-300">
                Upload the Wyvern ACES export as JSON or CSV. Active pilots are matched to existing crew by email, then by name. Nothing is written until you review the preview. Certificate numbers, dates of birth, addresses, and document files are not imported.
              </p>
              <label className="mt-3 flex cursor-pointer items-center justify-center gap-3 border-2 border-dashed border-cyan-500/40 bg-slate-950/40 p-6 hover:border-cyan-400">
                <input
                  type="file"
                  accept=".json,.csv,application/json,text/csv"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onFile(file);
                    event.target.value = '';
                  }}
                />
                <Upload className="h-5 w-5 text-cyan-300" />
                <span className="text-sm text-cyan-100">Choose a JSON or CSV file</span>
              </label>
            </div>
            {skipped.length > 0 && (
              <p className="text-xs text-slate-400">{skipped.length} record{skipped.length === 1 ? '' : 's'} skipped because they are not marked active.</p>
            )}
            {err && (
              <div className="flex items-start gap-2 border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>{err}</div>
              </div>
            )}
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="px-3 py-2 text-[11px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CANCEL</button>
            </div>
          </div>
        )}

        {step === 'preview' && (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <p className="text-xs leading-relaxed text-slate-400">
                {rows.length} active pilot{rows.length === 1 ? '' : 's'}. Conflicts replace the saved value with Wyvern. Unmatched rows are skipped unless you link them. Re-importing the same file updates these records and does not create a second copy.
                {skipped.length > 0 ? ` ${skipped.length} not marked active ${skipped.length === 1 ? 'was' : 'were'} left out.` : ''}
              </p>
              {warnings.map((warning) => (
                <div key={warning} className="border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">{warning}</div>
              ))}
              <Bucket title="MATCHED" tone="text-emerald-300" rows={grouped.matched} users={users} logbooks={logbooks} currencies={currencies} onChange={updateRow} />
              <Bucket title="CONFLICTS" tone="text-amber-200" rows={grouped.conflict} users={users} logbooks={logbooks} currencies={currencies} onChange={updateRow} />
              <Bucket title="UNMATCHED" tone="text-amber-300" rows={grouped.unmatched} users={users} logbooks={logbooks} currencies={currencies} onChange={updateRow} />
              {skipped.length > 0 && (
                <p className="text-[11px] text-slate-500">
                  Skipped (not active): {skipped.map((entry) => entry.record?.name || entry.record?.email || 'Unknown').join(', ')}
                </p>
              )}
              {err && (
                <div className="flex items-start gap-2 border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>{err}</div>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-800 p-3">
              <button type="button" onClick={() => { setStep('upload'); setRows([]); }} className="px-3 py-2 text-[11px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>← BACK</button>
              <button
                type="button"
                onClick={commit}
                className="inline-flex items-center gap-2 bg-cyan-500 px-4 py-2 text-[11px] tracking-widest text-slate-950"
                style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}
              >
                <Check className="h-3 w-3" /> IMPORT {selectedCount} PILOT{selectedCount === 1 ? '' : 'S'}
              </button>
            </div>
          </>
        )}

        {step === 'committing' && (
          <div className="flex flex-1 items-center justify-center p-10">
            <div className="space-y-3 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-cyan-400" />
              <div className="text-slate-300">Writing {progress.done} of {progress.total}…</div>
            </div>
          </div>
        )}

        {step === 'done' && doneSummary && (
          <>
            <div className="flex flex-1 items-center justify-center p-10">
              <div className="space-y-3 text-center">
                <Check className="mx-auto h-8 w-8 text-cyan-300" />
                <div className="text-lg text-slate-100">Import complete</div>
                <p className="text-sm text-slate-400">
                  {doneSummary.written} pilot record{doneSummary.written === 1 ? '' : 's'} updated. Safety ratings recompute from the saved hours and requirements.
                </p>
                {doneSummary.errors > 0 && (
                  <p className="text-sm text-red-300">{doneSummary.errors} record{doneSummary.errors === 1 ? '' : 's'} failed.</p>
                )}
              </div>
            </div>
            <div className="flex justify-end border-t border-slate-800 p-3">
              <button type="button" onClick={onClose} className="bg-cyan-500 px-4 py-2 text-[11px] tracking-widest text-slate-950" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>DONE</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
