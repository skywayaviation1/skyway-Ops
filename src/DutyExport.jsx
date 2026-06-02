// src/DutyExport.jsx
//
// =====================================================================
// DUTY RECORD EXPORT UI
// =====================================================================
//
// Two exports:
//   - <DutyExportButtons pilotUid pilotName />
//     Compact inline CSV/PDF buttons. Used by DutyV2 for self-export
//     and by other contexts where the pilot is already chosen.
//   - <DutyExportModal pilots open onClose />
//     Full modal for the crew board: pick pilot, pick date range,
//     export CSV or PDF. Admin/ops-only.
//
// Both share the same fetch + build pipeline.

import React, { useState, useMemo } from 'react';
import { Download, FileText, X, Calendar } from 'lucide-react';
import {
  fetchPeriodsForPilotInRange,
  fetchOutsideFlyingForPilotInRange,
  RETENTION_DAYS,
} from './firebase-duty-v2.js';
import {
  buildDutyCsv,
  buildDutyPrintableHtml,
  downloadCsv,
  openPrintWindow,
  buildFilename,
} from './duty-export.js';

const MS_DAY = 24 * 3600 * 1000;

// HTML <input type="date"> wants "YYYY-MM-DD" in local time.
function toDateInput(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fromDateInput(s, endOfDay = false) {
  if (!s) return null;
  // Parse as local date — append T00:00 or T23:59 explicitly. Using new
  // Date('2026-06-15') alone would interpret as UTC midnight.
  const t = new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime();
  return Number.isFinite(t) ? t : null;
}

// Internal hook — fetch periods + outside for export. Returns { fetch, busy, error }.
function useExportFetcher() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fetch = async ({ pilotUid, startMs, endMs }) => {
    setBusy(true); setError(null);
    try {
      const [periods, outside] = await Promise.all([
        fetchPeriodsForPilotInRange(pilotUid, startMs, endMs),
        fetchOutsideFlyingForPilotInRange(pilotUid, startMs, endMs),
      ]);
      return { periods, outsideFlying: outside };
    } catch (e) {
      setError(e?.message || 'Fetch failed');
      throw e;
    } finally {
      setBusy(false);
    }
  };

  return { fetch, busy, error, setError };
}

// =====================================================================
// COMPACT INLINE BUTTONS — for DutyV2 self-export
// =====================================================================
//
// Renders two small buttons: CSV + PDF. Date range defaults to last
// 365 days (RETENTION_DAYS) and is NOT user-adjustable in this compact
// view — pilots wanting custom ranges should ask ops to use the modal.

export function DutyExportButtons({ pilotUid, pilotName }) {
  const { fetch, busy, error, setError } = useExportFetcher();

  const handleCsv = async () => {
    if (!pilotUid) return;
    const endMs = Date.now();
    const startMs = endMs - RETENTION_DAYS * MS_DAY;
    try {
      const { periods, outsideFlying } = await fetch({ pilotUid, startMs, endMs });
      const csv = buildDutyCsv({ pilotName, startMs, endMs, periods, outsideFlying });
      downloadCsv(csv, buildFilename(pilotName, startMs, endMs, 'csv'));
    } catch (_) { /* error surfaced via state */ }
  };

  const handlePdf = async () => {
    if (!pilotUid) return;
    const endMs = Date.now();
    const startMs = endMs - RETENTION_DAYS * MS_DAY;
    try {
      const { periods, outsideFlying } = await fetch({ pilotUid, startMs, endMs });
      const html = buildDutyPrintableHtml({ pilotName, startMs, endMs, periods, outsideFlying });
      openPrintWindow(html);
    } catch (e) {
      setError(e.message || 'PDF export failed');
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <button
          onClick={handleCsv}
          disabled={busy || !pilotUid}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] tracking-widest text-slate-300 hover:text-cyan-300 border border-slate-700 hover:border-cyan-400 disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
          title={`Download CSV of last ${RETENTION_DAYS} days of duty records`}
        >
          <Download className="w-3 h-3" />
          {busy ? 'EXPORTING…' : 'EXPORT CSV'}
        </button>
        <button
          onClick={handlePdf}
          disabled={busy || !pilotUid}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] tracking-widest text-slate-300 hover:text-cyan-300 border border-slate-700 hover:border-cyan-400 disabled:opacity-40"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
          title={`Open print-friendly view (use Save as PDF)`}
        >
          <FileText className="w-3 h-3" />
          EXPORT PDF
        </button>
        <span className="text-[10px] text-slate-600" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          Last {RETENTION_DAYS} days
        </span>
      </div>
      {error && (
        <div className="text-[10px] text-red-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {error}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// MODAL — admin/ops choose pilot + date range + format
// =====================================================================
//
// `pilots` is an array of { uid, name } objects representing every
// pilot the caller has visibility into. Typically passed from
// CrewBoardV2 (which already has the list of seen pilots).
//
// `open` toggles visibility. `onClose` is called when user dismisses.

export function DutyExportModal({ open, onClose, pilots }) {
  const { fetch, busy, error, setError } = useExportFetcher();

  // Default range — last 365 days. User can adjust both ends.
  const defaultEnd = useMemo(() => Date.now(), []);
  const defaultStart = useMemo(() => defaultEnd - RETENTION_DAYS * MS_DAY, [defaultEnd]);
  const [pilotUid, setPilotUid] = useState('');
  const [startDate, setStartDate] = useState(toDateInput(defaultStart));
  const [endDate, setEndDate] = useState(toDateInput(defaultEnd));

  // Reset when modal opens — fresh state each time
  React.useEffect(() => {
    if (open) {
      setPilotUid('');
      setStartDate(toDateInput(defaultStart));
      setEndDate(toDateInput(defaultEnd));
      setError(null);
    }
  }, [open, defaultStart, defaultEnd, setError]);

  if (!open) return null;

  const selectedPilot = pilots.find(p => (p.uid || p.id) === pilotUid);
  const pilotName = selectedPilot?.name || '';
  const startMs = fromDateInput(startDate, false);
  const endMs = fromDateInput(endDate, true);
  const validRange = startMs != null && endMs != null && startMs <= endMs;
  const canExport = pilotUid && validRange;

  const handleCsv = async () => {
    if (!canExport) return;
    try {
      const { periods, outsideFlying } = await fetch({ pilotUid, startMs, endMs });
      const csv = buildDutyCsv({ pilotName, startMs, endMs, periods, outsideFlying });
      downloadCsv(csv, buildFilename(pilotName, startMs, endMs, 'csv'));
      onClose?.();
    } catch (_) {}
  };

  const handlePdf = async () => {
    if (!canExport) return;
    try {
      const { periods, outsideFlying } = await fetch({ pilotUid, startMs, endMs });
      const html = buildDutyPrintableHtml({ pilotName, startMs, endMs, periods, outsideFlying });
      openPrintWindow(html);
      onClose?.();
    } catch (e) {
      setError(e.message || 'PDF export failed');
    }
  };

  // Quick presets — common ranges
  const setRange = (days) => {
    const end = Date.now();
    setEndDate(toDateInput(end));
    setStartDate(toDateInput(end - days * MS_DAY));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}>
      <div className="bg-slate-950 border border-slate-700 max-w-md w-full"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <h3 className="text-sm tracking-widest text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            EXPORT DUTY RECORDS
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {/* Pilot picker */}
          <div>
            <label className="text-[10px] tracking-widest text-slate-500 block mb-1">
              PILOT
            </label>
            <select
              value={pilotUid}
              onChange={e => setPilotUid(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
            >
              <option value="">— select pilot —</option>
              {pilots.map(p => {
                const id = p.uid || p.id;
                return (
                  <option key={id} value={id}>
                    {p.name || p.displayName || id}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Date range */}
          <div>
            <label className="text-[10px] tracking-widest text-slate-500 block mb-1">
              DATE RANGE
            </label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <div className="text-[9px] text-slate-600 mb-0.5">FROM</div>
                <input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <div className="text-[9px] text-slate-600 mb-0.5">TO</div>
                <input
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>
            <div className="flex gap-1.5 text-[9px]">
              {[
                { label: '30D', days: 30 },
                { label: '90D', days: 90 },
                { label: '365D', days: 365 },
                { label: 'QTR', days: 92 },
              ].map(p => (
                <button
                  key={p.label}
                  onClick={() => setRange(p.days)}
                  className="px-2 py-0.5 border border-slate-700 text-slate-400 hover:border-cyan-500 hover:text-cyan-300 tracking-widest"
                >
                  {p.label}
                </button>
              ))}
            </div>
            {!validRange && startDate && endDate && (
              <div className="text-[10px] text-red-400 mt-1">End date must be after start.</div>
            )}
          </div>

          {error && (
            <div className="text-[10px] text-red-400 border border-red-500/30 bg-red-500/5 p-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 p-4 border-t border-slate-800">
          <button
            onClick={handleCsv}
            disabled={busy || !canExport}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-bold tracking-widest disabled:opacity-40"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Download className="w-4 h-4" />
            {busy ? 'WORKING…' : 'CSV'}
          </button>
          <button
            onClick={handlePdf}
            disabled={busy || !canExport}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-bold tracking-widest disabled:opacity-40"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <FileText className="w-4 h-4" />
            PDF
          </button>
        </div>
      </div>
    </div>
  );
}
