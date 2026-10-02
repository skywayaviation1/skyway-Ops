// Admin-only dry run / apply for the Oct 1, 2026 crew-change correction.
// Apply is a separate, explicit action. The panel never writes on open.

import React, { useState } from 'react';
import { auth } from './firebase.js';

function fmtHours(ms) {
  if (!Number.isFinite(ms)) return '—';
  return `${(ms / 3600000).toFixed(1)}h`;
}

export default function Oct1CrewCorrection() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [confirm, setConfirm] = useState('');

  const run = async (mode) => {
    setBusy(true);
    setError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error('Sign in as an administrator first.');
      const response = await fetch('/api/duty-oct1-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, mode }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || `Correction failed (${response.status})`);
      setResult(body);
    } catch (err) {
      setError(err.message || 'Correction failed');
    } finally {
      setBusy(false);
    }
  };

  const plan = result?.plan;
  return (
    <div className="space-y-3 text-xs text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <p className="text-slate-300 leading-relaxed">
        Oct 1, 2026: a paired duty-off closed the pilot who kept flying, and the
        rest of the day was recorded as single-pilot. This correction rebuilds
        one continuous two-pilot duty (Daniel, then Kameron) and recalculates
        14 CFR 135.267(b) / 135.267(d) rest. Dry run changes nothing.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => run('dry-run')}
        className="px-3 py-2 border border-cyan-500/50 text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-40"
      >
        {busy ? 'WORKING…' : 'DRY RUN'}
      </button>
      {error && <p className="text-red-300">{error}</p>}
      {plan && (
        <div className="space-y-2 border border-slate-700 p-3">
          <p>{plan.reason}</p>
          <p className="text-slate-400">
            16-hour block cleared: {String(plan.wrong16HourBlockCleared)} · sign-on at 08:00 ET Oct 2 allowed: {String(plan.signOnAllowedAt0800EtOct2)}
          </p>
          {['matt', 'daniel', 'kameron'].map((key) => (
            <div key={key}>
              <div className="text-cyan-300">{key.toUpperCase()}</div>
              {(plan.pilots?.[key]?.matches || []).map((user) => (
                <div key={user.uid} className="text-slate-400">{user.name} · {user.uid}</div>
              ))}
              {(plan.pilots?.[key]?.periods || []).map((period) => (
                <div key={period.id} className="text-slate-500">
                  {period.id} · {period.crewType} · {fmtHours(period.flightTimeMs)} · {period.status}
                </div>
              ))}
            </div>
          ))}
          {(plan.warnings || []).map((warning) => (
            <p key={warning} className="text-amber-300">{warning}</p>
          ))}
          <label className="block text-slate-400">
            Type APPLY to write these audited changes
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 px-2 py-1 text-slate-100"
            />
          </label>
          <button
            type="button"
            disabled={busy || confirm !== 'APPLY' || !plan.applicable}
            onClick={() => run('apply')}
            className="px-3 py-2 border border-red-500/50 text-red-200 disabled:opacity-40"
          >
            APPLY CORRECTION
          </button>
          {result.applied && <p className="text-emerald-300">Applied. Each record has an audit entry.</p>}
        </div>
      )}
    </div>
  );
}
