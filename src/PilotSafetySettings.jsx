// Operator minimums for the pilot safety rating.
// Stored at app-config/pilot-safety. Blank means the shipped defaults.

import { useEffect, useState } from 'react';
import { RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { Button, Card, CardHeader } from './ui.jsx';
import {
  CERTIFICATE_LEVELS,
  DEFAULT_PILOT_SAFETY_STANDARDS,
  DEFAULT_STANDARDS_NOTE,
  HOUR_FIELDS,
  normalizeStandards,
} from './pilot-safety.js';
import {
  savePilotSafetyStandards,
  subscribePilotSafetyStandards,
} from './firebase-pilot-safety.js';

export default function PilotSafetySettings({ currentUser }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(() => normalizeStandards(null));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => subscribePilotSafetyStandards((value) => {
    setSaved(value);
    setDraft(normalizeStandards(value));
  }), []);

  const usingDefaults = !saved?.customized;
  const setHour = (key, value) => {
    setDraft((current) => ({
      ...current,
      hours: {
        ...current.hours,
        minimums: { ...current.hours.minimums, [key]: value },
      },
    }));
  };
  const setRequired = (key, required) => {
    setDraft((current) => ({
      ...current,
      hours: {
        ...current.hours,
        required: { ...current.hours.required, [key]: required },
      },
    }));
  };
  const setRequirement = (id, patch) => {
    setDraft((current) => ({
      ...current,
      requirements: current.requirements.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await savePilotSafetyStandards(draft, currentUser);
      setMessage({ ok: true, text: 'Safety-rating minimums saved for the whole operation.' });
    } catch (err) {
      setMessage({ ok: false, text: err?.message || 'Could not save minimums.' });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setDraft(normalizeStandards(null));
    setMessage({ ok: true, text: 'Form reset to shipped defaults. Save to apply them.' });
  };

  return (
    <Card>
      <CardHeader
        title="Pilot safety rating"
        subtitle={usingDefaults
          ? 'Using shipped defaults. Nothing has been saved for this operator yet.'
          : 'Using minimums saved for this operator.'}
        icon={ShieldCheck}
      />
      <p className="mb-4 text-xs leading-relaxed text-content-muted">{DEFAULT_STANDARDS_NOTE}</p>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-content-muted">
          Minimum certificate
          <select
            value={draft.certificate.minimumLevel}
            onChange={(event) => setDraft((current) => ({
              ...current,
              certificate: { ...current.certificate, minimumLevel: event.target.value },
            }))}
            className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content"
          >
            {CERTIFICATE_LEVELS.map((level) => (
              <option key={level.id} value={level.id}>{level.label}</option>
            ))}
          </select>
        </label>
        <NumberField
          label="Meets Standard at"
          value={draft.tiers.meetsAt}
          onChange={(value) => setDraft((current) => ({ ...current, tiers: { ...current.tiers, meetsAt: value } }))}
          hint="Score band published with the rating"
        />
        <NumberField
          label="Caution at"
          value={draft.tiers.cautionAt}
          onChange={(value) => setDraft((current) => ({ ...current, tiers: { ...current.tiers, cautionAt: value } }))}
          hint="Below the meets band"
        />
      </div>

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-content-subtle">Hour minimums</h3>
      <div className="mb-4 divide-y divide-edge border border-edge">
        {HOUR_FIELDS.map((field) => {
          const isDefault = Number(draft.hours.minimums[field.key]) === DEFAULT_PILOT_SAFETY_STANDARDS.hours.minimums[field.key]
            && draft.hours.required[field.key] === DEFAULT_PILOT_SAFETY_STANDARDS.hours.required[field.key];
          return (
            <div key={field.key} className="grid grid-cols-[1fr_7rem_auto] items-center gap-3 px-3 py-2">
              <div>
                <div className="text-sm text-content">{field.label}</div>
                {isDefault && <div className="text-[10px] uppercase tracking-wide text-content-subtle">Default</div>}
              </div>
              <input
                type="number"
                min="0"
                step="1"
                aria-label={`${field.label} minimum`}
                value={draft.hours.minimums[field.key] ?? ''}
                onChange={(event) => setHour(field.key, event.target.value)}
                className="rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-content"
              />
              <label className="flex items-center gap-2 text-xs text-content-muted">
                <input
                  type="checkbox"
                  checked={draft.hours.required[field.key] !== false}
                  onChange={(event) => setRequired(field.key, event.target.checked)}
                />
                Required
              </label>
            </div>
          );
        })}
      </div>

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-content-subtle">Requirements</h3>
      <div className="mb-4 divide-y divide-edge border border-edge">
        {draft.requirements.map((item) => (
          <label key={item.id} className="flex items-center gap-3 px-3 py-2 text-sm text-content">
            <input
              type="checkbox"
              checked={item.required !== false}
              onChange={(event) => setRequirement(item.id, { required: event.target.checked })}
            />
            <input
              value={item.label}
              aria-label={`${item.id} label`}
              onChange={(event) => setRequirement(item.id, { label: event.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-content"
            />
          </label>
        ))}
      </div>

      <div className="mb-3 grid gap-2 text-xs text-content-muted sm:grid-cols-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.certificate.requireInstrument !== false}
            onChange={(event) => setDraft((current) => ({
              ...current,
              certificate: { ...current.certificate, requireInstrument: event.target.checked },
            }))}
          />
          Instrument rating required
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.certificate.requireMultiEngine !== false}
            onChange={(event) => setDraft((current) => ({
              ...current,
              certificate: { ...current.certificate, requireMultiEngine: event.target.checked },
            }))}
          />
          Multi-engine rating required
        </label>
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-content-subtle">
        A pilot Does Not Meet when a required hour is short or missing, or a required item is expired or not on file.
        Caution means every minimum is met and at least one required item is expiring soon. Meets Standard means every required hour is met and every required item is current.
        PIC-only checks are not charged to a pilot sitting SIC on a broker report. The standing rating on the crew screen uses the PIC seat.
        Experience is {draft.weights.experience}% of the score and requirements are {draft.weights.requirements}%.
      </p>

      {message && (
        <p className={`mb-3 text-xs ${message.ok ? 'text-emerald-600' : 'text-red-500'}`}>{message.text}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button icon={Save} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save minimums'}</Button>
        <Button icon={RotateCcw} variant="secondary" onClick={reset} disabled={busy}>Reset to defaults</Button>
      </div>
    </Card>
  );
}

function NumberField({ label, value, onChange, hint }) {
  return (
    <label className="text-xs text-content-muted">
      {label}
      <input
        type="number"
        min="0"
        max="100"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content"
      />
      {hint && <span className="mt-1 block text-[10px] text-content-subtle">{hint}</span>}
    </label>
  );
}
