// Operator minimums for the pilot safety rating.
// Stored at app-config/pilot-safety. Blank means the shipped Registered Standard.

import { useEffect, useState } from 'react';
import { RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { Button, Card, CardHeader } from './ui.jsx';
import {
  DEFAULT_PILOT_SAFETY_STANDARDS,
  DEFAULT_STANDARDS_NOTE,
  POSITION_HOUR_FIELDS,
  normalizeStandards,
} from './pilot-safety.js';
import {
  savePilotSafetyStandards,
  subscribePilotSafetyStandards,
} from './firebase-pilot-safety.js';

const RULES = [
  { key: 'medicalMonths', label: 'Medical valid (months)' },
  { key: 'lineCheckMonths', label: 'Line check expiry (months)' },
  { key: 'ipcMonths', label: 'Instrument proficiency expiry (months)' },
  { key: 'maxActiveTypes', label: 'Max active type ratings' },
  { key: 'aircraftMonths', label: 'Aircraft-specific training (months)' },
  { key: 'recurrentMonths', label: 'Recurrent training (months)' },
  { key: 'simulatorMonths', label: 'Simulator training (months)' },
];

const FLAGS = [
  { key: 'indoctrination', label: 'Indoctrination required' },
  { key: 'lineCheck', label: 'Line check required' },
  { key: 'ipc', label: 'Instrument proficiency check required' },
  { key: 'confirmedType', label: 'Confirmed type rating required' },
  { key: 'motionSimulator', label: 'Motion-based simulator required' },
];

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

  const setPosition = (seat, patch) => {
    setDraft((current) => ({
      ...current,
      positions: {
        ...current.positions,
        [seat]: { ...current.positions[seat], ...patch },
      },
    }));
  };
  const setHour = (seat, key, value) => {
    setPosition(seat, {
      hours: {
        ...draft.positions[seat].hours,
        [key]: value,
      },
    });
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

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-content-subtle">Hour minimums</h3>
      <div className="mb-4 overflow-x-auto border border-edge">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-edge text-[10px] uppercase tracking-wide text-content-subtle">
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">PIC</th>
              <th className="px-3 py-2 font-medium">SIC</th>
            </tr>
          </thead>
          <tbody>
            {POSITION_HOUR_FIELDS.map((field) => (
              <tr key={field.key} className="border-b border-edge">
                <td className="px-3 py-2 text-content">{field.label}</td>
                <td className="px-3 py-2"><HourInput seat="PIC" field={field} draft={draft} onChange={setHour} /></td>
                <td className="px-3 py-2"><HourInput seat="SIC" field={field} draft={draft} onChange={setHour} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-content-subtle">Medical class</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {['PIC', 'SIC'].map((seat) => (
          <label key={seat} className="text-xs text-content-muted">
            {seat} minimum medical class
            <select
              aria-label={`${seat} medical class`}
              value={draft.positions[seat].medicalClass}
              onChange={(event) => setPosition(seat, { medicalClass: event.target.value })}
              className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content"
            >
              <option value="First">Class 1</option>
              <option value="Second">Class 2</option>
              <option value="Third">Class 3</option>
            </select>
          </label>
        ))}
      </div>

      <div className="mb-4 overflow-x-auto border border-edge">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-edge text-[10px] uppercase tracking-wide text-content-subtle">
              <th className="px-3 py-2 font-medium">Rule</th>
              <th className="px-3 py-2 font-medium">PIC</th>
              <th className="px-3 py-2 font-medium">SIC</th>
            </tr>
          </thead>
          <tbody>
            {RULES.map((rule) => (
              <tr key={rule.key} className="border-b border-edge">
                <td className="px-3 py-2 text-content">{rule.label}</td>
                {['PIC', 'SIC'].map((seat) => (
                  <td key={seat} className="px-3 py-2">
                    <input
                      type="number"
                      min="0"
                      aria-label={`${seat} ${rule.label}`}
                      value={draft.positions[seat][rule.key] ?? ''}
                      onChange={(event) => setPosition(seat, { [rule.key]: event.target.value })}
                      className="w-24 rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-content"
                    />
                  </td>
                ))}
              </tr>
            ))}
            {FLAGS.map((rule) => (
              <tr key={rule.key} className="border-b border-edge">
                <td className="px-3 py-2 text-content">{rule.label}</td>
                {['PIC', 'SIC'].map((seat) => (
                  <td key={seat} className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`${seat} ${rule.label}`}
                      checked={draft.positions[seat][rule.key] === true}
                      onChange={(event) => setPosition(seat, { [rule.key]: event.target.checked })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-content-subtle">
        Each pilot is scored against the PIC column and the SIC column. A position is Meets when every required hour is met and every required item is Current or expiring. Expires in 30 Days and Expires in 7 Days still meet the position and show as caution. Expired and Not Validated do not. A zero hour minimum means that item is not required for that seat. The standing rating meets when at least one position meets.
      </p>
      <p className="mb-3 text-[11px] text-content-subtle">
        Defaults match {DEFAULT_PILOT_SAFETY_STANDARDS.criteriaName}, version {DEFAULT_PILOT_SAFETY_STANDARDS.criteriaVersion}.
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

function HourInput({ seat, field, draft, onChange }) {
  const value = draft.positions[seat].hours[field.key];
  const shipped = DEFAULT_PILOT_SAFETY_STANDARDS.positions[seat].hours[field.key];
  return (
    <input
      type="number"
      min="0"
      step="1"
      aria-label={`${seat} ${field.label} minimum`}
      value={value ?? ''}
      onChange={(event) => onChange(seat, field.key, event.target.value)}
      className="w-24 rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm text-content"
      title={Number(value) === shipped ? 'Default' : 'Changed from the shipped default'}
    />
  );
}
