// src/CrewManagePanel.jsx
//
// =====================================================================
// ADMIN CREW MANAGEMENT PANEL
// =====================================================================
//
// Inline admin controls that expand below a pilot row on CrewBoardV2.
// Only visible/usable when the viewer is admin or ops. Exposes:
//
//   1. EDIT TIMES — adjust dutyOnAt / dutyOffAt of the pilot's active
//      duty period. Uses firebase-duty-v2.editPeriod which records the
//      change in adminEdits[] audit trail.
//
//   2. MANAGE PARTNER — three actions on the pairing relationship:
//      a) ADD PARTNER (when no partner today): pick a SIC from
//         the crew dropdown; defaults to creating a 'pending' SIC
//         period that the SIC confirms on their own DutyV2.
//      b) CHANGE PARTNER (when a partner exists): swap to a
//         different SIC. Old SIC's period is closed.
//      c) REMOVE PARTNER: convert paired duty back to solo.
//      All three support a FORCE-ATTEST escape hatch for cases
//      where the SIC is verifiably on duty but can't open the app
//      (phone dead, mid-flight). The resulting record is marked
//      'admin-attested' in the audit trail, distinct from
//      'self-attested', so a ramp inspector can tell who confirmed.
//
//   3. FORCE-END DUTY — close the active period now with an audit
//      note. Required when a pilot forgot to tap DUTY OFF.
//
// Component receives:
//   - period: the pilot's currently-active duty period doc
//   - partnerPeriod: the SIC's period doc if there's a pairing
//   - currentUser: viewer (for the editedBy audit field)
//   - crewUsers: list of other crew accounts for the partner picker
//   - onClose: collapse this panel
//
// Every action surfaces errors inline rather than throwing — the
// admin should see exactly what failed and why.

import React, { useState, useMemo } from 'react';
import { AlertTriangle, X, Edit3, Users, UserCheck, UserMinus, UserPlus, Square } from 'lucide-react';
import {
  editPeriod as fbEditPeriod,
  endDuty as fbEndDuty,
  addPartnerToActiveDuty,
  removePartnerFromDuty,
  changePartner,
} from './firebase-duty-v2.js';
import TzAwareDateTimeInput from './TzAwareInput.jsx';

const MS_HR = 3600 * 1000;

// HTML datetime-local helpers — local time, no Z suffix.
function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(s) {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

export default function CrewManagePanel({ period, partnerPeriod, currentUser, crewUsers, onClose }) {
  // Top-level mode: 'menu' shows the action buttons, 'edit-time' shows
  // a time editor, 'manage-partner' shows partner controls, 'end-duty'
  // shows force-close form.
  const [mode, setMode] = useState('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const editorName = currentUser?.name || currentUser?.displayName || currentUser?.email || 'admin';

  // Reset feedback when switching modes
  const setModeReset = (m) => {
    setMode(m);
    setError(null);
    setSuccess(null);
  };

  if (!period) {
    return (
      <div className="bg-slate-900/60 border-t border-slate-800 p-3 text-[11px] text-slate-500">
        No active duty period for this pilot. Nothing to manage.
      </div>
    );
  }

  return (
    <div className="bg-slate-900/60 border-t border-slate-800 p-3 space-y-2"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] tracking-widest text-cyan-300">
          ADMIN MANAGE · {period.pilotName} · period {period.id.slice(0, 12)}…
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Feedback row */}
      {error && (
        <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 px-2 py-1.5">
          {error}
        </div>
      )}
      {success && (
        <div className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 px-2 py-1.5">
          {success}
        </div>
      )}

      {/* Body — mode-specific */}
      {mode === 'menu' && (
        <MenuMode
          period={period}
          partnerPeriod={partnerPeriod}
          onPick={setModeReset}
        />
      )}
      {mode === 'edit-time' && (
        <EditTimeMode
          period={period}
          busy={busy}
          editorName={editorName}
          onBack={() => setModeReset('menu')}
          onSubmit={async ({ field, newMs, note }) => {
            setBusy(true); setError(null);
            try {
              await fbEditPeriod(period.id, field, newMs, { editedBy: editorName, note });
              setSuccess(`${field} updated`);
              setMode('menu');
            } catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }}
        />
      )}
      {mode === 'manage-partner' && (
        <ManagePartnerMode
          period={period}
          partnerPeriod={partnerPeriod}
          crewUsers={crewUsers}
          busy={busy}
          editorName={editorName}
          onBack={() => setModeReset('menu')}
          onAdd={async ({ pilotUid, pilotName, priorRestMs, forceAttest, reason }) => {
            setBusy(true); setError(null);
            try {
              await addPartnerToActiveDuty(period.id, { pilotUid, pilotName, priorRestMs },
                { editedBy: editorName, forceAttest, forceAttestReason: reason });
              setSuccess(forceAttest
                ? `${pilotName} added (admin-attested)`
                : `${pilotName} added — pending their confirmation`);
              setMode('menu');
            } catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }}
          onRemove={async () => {
            setBusy(true); setError(null);
            try {
              await removePartnerFromDuty(period.id, { editedBy: editorName });
              setSuccess('Partner removed');
              setMode('menu');
            } catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }}
          onChange={async ({ pilotUid, pilotName, priorRestMs, forceAttest, reason }) => {
            setBusy(true); setError(null);
            try {
              await changePartner(period.id, { pilotUid, pilotName, priorRestMs },
                { editedBy: editorName, forceAttest, forceAttestReason: reason });
              setSuccess(`Partner changed to ${pilotName}`);
              setMode('menu');
            } catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }}
        />
      )}
      {mode === 'end-duty' && (
        <ForceEndMode
          period={period}
          busy={busy}
          editorName={editorName}
          onBack={() => setModeReset('menu')}
          onSubmit={async ({ dutyOffAt, flightTimeHours, note }) => {
            setBusy(true); setError(null);
            try {
              const flightTimeMs = Math.round(parseFloat(flightTimeHours) * MS_HR) || 0;
              await fbEndDuty(period.id, {
                dutyOffAt,
                flightTimeMs,
                endedBy: editorName,
                note,
              });
              setSuccess('Duty ended');
              setMode('menu');
            } catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }}
        />
      )}
    </div>
  );
}

// =====================================================================
// Mode: menu
// =====================================================================

function MenuMode({ period, partnerPeriod, onPick }) {
  const hasPartner = Boolean(partnerPeriod && partnerPeriod.confirmStatus !== 'declined');

  return (
    <div className="space-y-1.5">
      <Btn onClick={() => onPick('edit-time')} icon={<Edit3 className="w-3.5 h-3.5" />}>
        EDIT DUTY ON / OFF TIME
      </Btn>
      <Btn onClick={() => onPick('manage-partner')} icon={<Users className="w-3.5 h-3.5" />}>
        {hasPartner ? `MANAGE PARTNER (${partnerPeriod.pilotName})` : 'ADD PARTNER (SIC)'}
      </Btn>
      {period.status === 'on' && (
        <Btn onClick={() => onPick('end-duty')} icon={<Square className="w-3.5 h-3.5" />} tone="red">
          FORCE-END DUTY NOW
        </Btn>
      )}
    </div>
  );
}

function Btn({ onClick, icon, children, tone }) {
  const toneCls = tone === 'red'
    ? 'border-red-500/40 text-red-300 hover:bg-red-500/10 hover:border-red-500'
    : 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:border-cyan-500 hover:text-cyan-200';
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 border ${toneCls} text-[11px] tracking-widest text-left`}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

// =====================================================================
// Mode: edit-time
// =====================================================================

function EditTimeMode({ period, busy, editorName, onBack, onSubmit }) {
  const [field, setField] = useState('dutyOnAt');
  // newMs holds the user-selected UTC timestamp directly. The TZ-aware
  // input component handles all conversion between this number and the
  // user-visible local-time string.
  const [newMs, setNewMs] = useState(() => period.dutyOnAt || Date.now());
  const [note, setNote] = useState('');

  // When field switches, repopulate from the period's current value
  React.useEffect(() => {
    if (field === 'dutyOnAt') setNewMs(period.dutyOnAt || Date.now());
    else setNewMs(period.dutyOffAt || Date.now());
  }, [field, period.dutyOnAt, period.dutyOffAt]);

  // Sanity warnings (non-blocking, just informational)
  const sanityWarnings = [];
  if (field === 'dutyOnAt' && period.dutyOffAt && newMs && newMs >= period.dutyOffAt) {
    sanityWarnings.push('Duty-on must be before duty-off.');
  }
  if (field === 'dutyOffAt' && period.dutyOnAt && newMs && newMs <= period.dutyOnAt) {
    sanityWarnings.push('Duty-off must be after duty-on.');
  }

  const canSubmit = newMs != null && sanityWarnings.length === 0 && !busy;

  return (
    <div className="space-y-2 text-[11px]">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setField('dutyOnAt')}
          className={`py-1.5 px-2 border tracking-widest ${
            field === 'dutyOnAt'
              ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
              : 'border-slate-700 text-slate-400'
          }`}
        >
          DUTY ON
        </button>
        <button
          onClick={() => setField('dutyOffAt')}
          disabled={!period.dutyOffAt && period.status === 'on'}
          className={`py-1.5 px-2 border tracking-widest disabled:opacity-30 ${
            field === 'dutyOffAt'
              ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
              : 'border-slate-700 text-slate-400'
          }`}
        >
          DUTY OFF{!period.dutyOffAt && ' (active)'}
        </button>
      </div>
      <TzAwareDateTimeInput value={newMs} onChange={setNewMs} compact />
      <input
        type="text"
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="reason for edit (optional, logged)"
        maxLength={300}
        className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-400 text-[10px]"
      />
      {sanityWarnings.map((w, i) => (
        <div key={i} className="text-[10px] text-red-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> {w}
        </div>
      ))}
      <div className="flex gap-2">
        <button
          onClick={() => onSubmit({ field, newMs, note: note || null })}
          disabled={!canSubmit}
          className="flex-1 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] tracking-widest font-bold disabled:opacity-40"
        >
          {busy ? 'SAVING…' : 'SAVE EDIT'}
        </button>
        <button
          onClick={onBack}
          disabled={busy}
          className="px-3 py-2 border border-slate-700 text-slate-300 text-[11px] tracking-widest hover:border-slate-500"
        >
          BACK
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// Mode: manage-partner
// =====================================================================

function ManagePartnerMode({ period, partnerPeriod, crewUsers, busy, editorName, onBack, onAdd, onRemove, onChange }) {
  // Effective state: do we have an active partner (not declined)?
  const hasPartner = Boolean(partnerPeriod && partnerPeriod.confirmStatus !== 'declined' && partnerPeriod.status === 'on');
  const action = hasPartner ? 'change-or-remove' : 'add';

  // Picker state (shared between add and change)
  const [sicUid, setSicUid] = useState('');
  const [priorRestHours, setPriorRestHours] = useState(
    period.priorRestMs ? (period.priorRestMs / MS_HR).toFixed(1) : '10'
  );
  const [forceAttest, setForceAttest] = useState(false);
  const [reason, setReason] = useState('');
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [changeMode, setChangeMode] = useState(false);

  // Filter crew users — exclude the PIC themselves and the current
  // partner (if any). Pilots with open duty elsewhere appear as
  // disabled options with a note.
  const eligible = useMemo(() => {
    return (crewUsers || []).filter(u => {
      const uid = u.uid || u.id;
      if (!uid) return false;
      if (uid === period.pilotUid) return false;
      if (partnerPeriod && uid === partnerPeriod.pilotUid && !changeMode) return false;
      return true;
    });
  }, [crewUsers, period.pilotUid, partnerPeriod, changeMode]);

  const sicUser = eligible.find(u => (u.uid || u.id) === sicUid);
  const sicName = sicUser?.name || sicUser?.displayName || '';

  const priorRestMs = (() => {
    const n = parseFloat(priorRestHours);
    return Number.isFinite(n) && n >= 0 ? n * MS_HR : null;
  })();

  const canSubmitAdd = Boolean(sicUid && (!forceAttest || reason.trim().length > 0));

  if (action === 'change-or-remove' && !changeMode) {
    // Show summary + Change / Remove options
    return (
      <div className="space-y-2 text-[11px]">
        <div className="p-2.5 bg-slate-950/50 border border-slate-700">
          <div className="text-[10px] tracking-widest text-slate-500 mb-1">CURRENT PARTNER</div>
          <div className="text-slate-100">{partnerPeriod.pilotName}</div>
          <div className="text-[10px] text-slate-500 mt-1">
            {partnerPeriod.confirmStatus === 'pending' && '⏳ awaiting their confirmation'}
            {partnerPeriod.confirmStatus === 'self-attested' && '✓ self-attested'}
            {partnerPeriod.confirmStatus === 'admin-attested' && '⚠ admin-attested'}
          </div>
        </div>
        {!showRemoveConfirm ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setChangeMode(true)}
              disabled={busy}
              className="py-2 px-2 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 tracking-widest"
            >
              CHANGE
            </button>
            <button
              onClick={() => setShowRemoveConfirm(true)}
              disabled={busy}
              className="py-2 px-2 border border-red-500/40 text-red-300 hover:bg-red-500/10 tracking-widest"
            >
              REMOVE
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-amber-300 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" />
              Remove {partnerPeriod.pilotName} from this duty?
            </div>
            <div className="text-[10px] text-slate-400">
              {partnerPeriod.confirmStatus === 'pending'
                ? 'Pending duty will be cancelled (zero-length close).'
                : 'Their period will be closed at the current time.'}
            </div>
            <div className="flex gap-2">
              <button onClick={onRemove} disabled={busy}
                className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white tracking-widest font-bold disabled:opacity-40">
                {busy ? 'REMOVING…' : 'CONFIRM REMOVE'}
              </button>
              <button onClick={() => setShowRemoveConfirm(false)} disabled={busy}
                className="px-3 py-2 border border-slate-700 text-slate-300 tracking-widest">
                CANCEL
              </button>
            </div>
          </div>
        )}
        <button onClick={onBack} disabled={busy}
          className="w-full py-1.5 text-slate-500 hover:text-slate-300 text-[10px] tracking-widest">
          BACK
        </button>
      </div>
    );
  }

  // Add or Change picker
  return (
    <div className="space-y-2 text-[11px]">
      {changeMode && (
        <div className="text-[10px] text-amber-400">
          Old partner ({partnerPeriod.pilotName}) will be removed before new one is added.
        </div>
      )}
      <div>
        <div className="text-[10px] tracking-widest text-slate-500 mb-1">SIC</div>
        <select
          value={sicUid}
          onChange={e => setSicUid(e.target.value)}
          className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-400"
        >
          <option value="">— select pilot —</option>
          {eligible.map(u => {
            const uid = u.uid || u.id;
            return (
              <option key={uid} value={uid}>
                {u.name || u.displayName || u.email}
              </option>
            );
          })}
        </select>
      </div>
      <div>
        <div className="text-[10px] tracking-widest text-slate-500 mb-1">SIC PRIOR REST (hrs)</div>
        <input
          type="number"
          step="0.5"
          min="0"
          max="48"
          value={priorRestHours}
          onChange={e => setPriorRestHours(e.target.value)}
          className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-400"
        />
      </div>

      <label className="flex items-start gap-2 p-2 border border-amber-500/30 bg-amber-500/5 cursor-pointer">
        <input
          type="checkbox"
          checked={forceAttest}
          onChange={e => { setForceAttest(e.target.checked); if (!e.target.checked) setReason(''); }}
          className="w-3.5 h-3.5 mt-0.5 accent-amber-500"
        />
        <span className="text-[10px] text-amber-200 leading-tight">
          <strong>FORCE ATTEST (no SIC present).</strong> Mark SIC as fit-for-duty
          on their behalf. Record will be tagged "admin-attested" in audit.
          Only use when SIC is verifiably on duty but cannot open the app.
        </span>
      </label>
      {forceAttest && (
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="REQUIRED: reason for force-attest (e.g. 'SIC mid-flight, phone dead, verified fit at brief')"
          rows={2}
          maxLength={500}
          className="w-full bg-slate-950 border border-amber-500/40 px-2 py-1.5 text-slate-100 focus:outline-none focus:border-amber-300 text-[10px]"
        />
      )}

      <div className="flex gap-2">
        <button
          onClick={() => (changeMode ? onChange : onAdd)({
            pilotUid: sicUid,
            pilotName: sicName,
            priorRestMs,
            forceAttest,
            reason: forceAttest ? reason.trim() : null,
          })}
          disabled={!canSubmitAdd || busy}
          className="flex-1 py-2 bg-cyan-600 hover:bg-cyan-500 text-white tracking-widest font-bold disabled:opacity-40"
        >
          {busy ? 'WORKING…' : changeMode ? 'SWAP PARTNER' : 'ADD PARTNER'}
        </button>
        <button
          onClick={() => { setChangeMode(false); onBack(); }}
          disabled={busy}
          className="px-3 py-2 border border-slate-700 text-slate-300 tracking-widest"
        >
          BACK
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// Mode: force-end
// =====================================================================

function ForceEndMode({ period, busy, editorName, onBack, onSubmit }) {
  // UTC ms — TZ handled by the input component
  const [dutyOffAt, setDutyOffAt] = useState(() => Date.now());
  const [flightTimeHours, setFlightTimeHours] = useState('0');
  const [note, setNote] = useState('');

  const offMs = dutyOffAt;
  const tooEarly = offMs != null && period.dutyOnAt && offMs <= period.dutyOnAt;

  return (
    <div className="space-y-2 text-[11px]">
      <div className="text-amber-300 flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>Force-ending {period.pilotName}'s duty. Use when the pilot forgot to tap DUTY OFF. Audit trail will show admin closed.</span>
      </div>
      <div>
        <div className="text-[10px] tracking-widest text-slate-500 mb-1">DUTY OFF TIME</div>
        <TzAwareDateTimeInput value={dutyOffAt} onChange={setDutyOffAt} compact />
        {tooEarly && (
          <div className="text-[10px] text-red-400 mt-1">Must be after duty-on time.</div>
        )}
      </div>
      <div>
        <div className="text-[10px] tracking-widest text-slate-500 mb-1">FLIGHT TIME (hours)</div>
        <input
          type="number"
          step="0.1"
          min="0"
          max="24"
          value={flightTimeHours}
          onChange={e => setFlightTimeHours(e.target.value)}
          className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-400"
        />
      </div>
      <input
        type="text"
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="reason for force-end (e.g. 'pilot forgot to tap, confirmed by trip log')"
        maxLength={300}
        className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-400 text-[10px]"
      />
      <div className="flex gap-2">
        <button
          onClick={() => onSubmit({ dutyOffAt: offMs, flightTimeHours, note: note || null })}
          disabled={busy || tooEarly || offMs == null}
          className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white tracking-widest font-bold disabled:opacity-40"
        >
          {busy ? 'ENDING…' : 'FORCE-END DUTY'}
        </button>
        <button onClick={onBack} disabled={busy}
          className="px-3 py-2 border border-slate-700 text-slate-300 tracking-widest">
          BACK
        </button>
      </div>
    </div>
  );
}
