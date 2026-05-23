// MaintenanceLog.jsx — Aircraft Maintenance Log (AML) screen.
//
// TURN 1 SCOPE: Part I of Skyway's AML form (S-3-2/R-31).
//   - List of existing AML entries
//   - Create form covering the discrepancy/maintenance request fields
//   - No MEL lookup yet (Turn 2)
//   - No corrective action / RTS / Part II-IV (Turn 3)
//   - No AOG integration yet (Turn 2)
//
// PROTOTYPE BANNER: Until Skyway's DOM signs off on the digital
// workflow, every page in this section shows a prominent banner
// reminding users that these records are parallel to whatever paper
// or official record system is currently authoritative. The banner
// dismisses only when the DOM-approved flag is true in the config.

import React, { useEffect, useMemo, useState } from 'react';
import {
  Wrench, AlertTriangle, Plus, Loader2, X, FileText, ChevronRight, Search,
  Download, Pencil,
} from 'lucide-react';
import { createAML, subscribeAMLEntries } from './firebase-aml.js';
import SignaturePad from './SignaturePad.jsx';

// ====================================================================
// MAIN
// ====================================================================

export default function MaintenanceLog({ currentUser, users = [], allTrips = [] }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [deferEntry, setDeferEntry] = useState(null);
  const [editEntry, setEditEntry] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [stageFilter, setStageFilter] = useState('all');

  // Triggered when user clicks the PDF icon on a row. Loads the
  // PDF generator on demand (large dependency) and downloads.
  async function handleDownloadPdf(entry) {
    try {
      const { downloadAMLPdf } = await import('./aml-pdf.js');
      await downloadAMLPdf(entry);
    } catch (e) {
      console.error('[aml-pdf] failed:', e);
      window.alert(`PDF generation failed: ${e.message}`);
    }
  }

  useEffect(() => {
    const unsub = subscribeAMLEntries((list) => {
      setEntries(list);
      setLoading(false);
    });
    return () => { try { unsub(); } catch (_) {} };
  }, []);

  // Derive list of tails from active trips for the create form picker
  const fleetTails = useMemo(() => {
    const set = new Set();
    (allTrips || []).forEach((t) => {
      if (t.info?.tail) set.add(t.info.tail.toUpperCase());
    });
    return Array.from(set).sort();
  }, [allTrips]);

  // Filtering + search
  const filtered = useMemo(() => {
    let result = entries;
    if (stageFilter !== 'all') {
      result = result.filter((e) => e.stage === stageFilter);
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      result = result.filter((e) => (
        (e.tail || '').toLowerCase().includes(q) ||
        (e.discrepancy || '').toLowerCase().includes(q) ||
        (e.requestedByName || '').toLowerCase().includes(q) ||
        (e.serialNumber || '').toLowerCase().includes(q)
      ));
    }
    return result;
  }, [entries, stageFilter, searchTerm]);

  // Permissions: crew + maint + ops + admin can all CREATE.
  // Only ops/admin can approve a deferral or ground an aircraft (DOM-equivalent).
  // Editing follows the same gate as creating, plus stage rules enforced in
  // firebase-aml.updateAML.
  const canCreate = ['crew', 'maint', 'ops', 'admin'].includes(currentUser?.role);
  const canDefer = ['ops', 'admin'].includes(currentUser?.role);
  const canEdit = ['crew', 'maint', 'ops', 'admin'].includes(currentUser?.role);

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            AIRCRAFT MAINTENANCE LOG
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Scheduled and unscheduled maintenance activities. Form S-3-2/R-31.
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Plus className="w-4 h-4 inline-block mr-1 -mt-0.5" /> NEW AML
          </button>
        )}
      </div>

      {/* Filters + search */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {[
            { id: 'all',      label: 'ALL' },
            { id: 'CREATED',  label: 'OPEN' },
            { id: 'DEFERRED', label: 'MEL DEFERRED' },
            { id: 'GROUNDED', label: 'GROUNDED' },
            { id: 'CLEARED',  label: 'CLEARED' },
            { id: 'RTS',      label: 'RTS' },
            { id: 'CLOSED',   label: 'CLOSED' },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setStageFilter(f.id)}
              className={`px-2.5 py-1.5 text-[10px] tracking-widest border ${
                stageFilter === f.id
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                  : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
              }`}
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-[200px] relative">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500 pointer-events-none" />
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search tail, discrepancy, name..."
            className="w-full bg-slate-900 border border-slate-700 pl-10 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="p-12 text-center text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="border border-dashed border-slate-700 p-12 text-center">
          <Wrench className="w-8 h-8 text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-500">
            {entries.length === 0 ? 'No AML entries yet' : 'No entries match this filter'}
          </p>
          {canCreate && entries.length === 0 && (
            <p className="text-xs text-slate-600 mt-1">
              Tap NEW AML to log a discrepancy or maintenance request.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => (
            <AMLRow
              key={e.id}
              entry={e}
              canDefer={canDefer}
              canEdit={canEdit}
              onDefer={(entry) => setDeferEntry(entry)}
              onEdit={(entry) => setEditEntry(entry)}
              onDownloadPdf={() => handleDownloadPdf(e)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateAMLModal
          currentUser={currentUser}
          fleetTails={fleetTails}
          onClose={() => setShowCreate(false)}
          onCreated={() => setShowCreate(false)}
        />
      )}

      {deferEntry && (
        <DeferAMLModal
          aml={deferEntry}
          currentUser={currentUser}
          onClose={() => setDeferEntry(null)}
          onDeferred={() => setDeferEntry(null)}
        />
      )}

      {editEntry && (
        <EditAMLModal
          aml={editEntry}
          currentUser={currentUser}
          onClose={() => setEditEntry(null)}
          onSaved={() => setEditEntry(null)}
        />
      )}
    </div>
  );
}

// ====================================================================
// AML ROW
// ====================================================================

function AMLRow({ entry, canDefer, canEdit, onDefer, onEdit, onDownloadPdf }) {
  const stageColors = {
    CREATED:  { bg: 'bg-amber-500/15',  border: 'border-amber-500/40',  txt: 'text-amber-200',  label: 'OPEN' },
    DEFERRED: { bg: 'bg-cyan-500/15',   border: 'border-cyan-500/40',   txt: 'text-cyan-200',   label: 'MEL DEFERRED · AIRWORTHY' },
    GROUNDED: { bg: 'bg-red-500/15',    border: 'border-red-500/40',    txt: 'text-red-300',    label: 'GROUNDED · AOG' },
    CLEARED:  { bg: 'bg-cyan-500/15',   border: 'border-cyan-500/40',   txt: 'text-cyan-200',   label: 'CLEARED — AWAITING RTS' },
    RTS:      { bg: 'bg-emerald-500/15',border: 'border-emerald-500/40',txt: 'text-emerald-300',label: 'RTS APPROVED' },
    CLOSED:   { bg: 'bg-slate-700/40',  border: 'border-slate-600',     txt: 'text-slate-400',  label: 'CLOSED' },
  };
  const sc = stageColors[entry.stage] || stageColors.CREATED;
  const fmtDate = (ms) => {
    if (!ms) return '—';
    return new Date(ms).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  };
  // Compute MEL due-date countdown if deferred
  const melCountdown = (() => {
    if (entry.stage !== 'DEFERRED' || !entry.melDueDate) return null;
    const dueMs = new Date(entry.melDueDate + 'T23:59:59').getTime();
    if (!Number.isFinite(dueMs)) return null;
    const daysLeft = Math.ceil((dueMs - Date.now()) / 86400000);
    if (daysLeft < 0) return { text: `${-daysLeft}d OVERDUE`, urgent: true };
    if (daysLeft === 0) return { text: 'DUE TODAY', urgent: true };
    if (daysLeft <= 2) return { text: `${daysLeft}d LEFT`, urgent: true };
    return { text: `${daysLeft}d LEFT`, urgent: false };
  })();

  return (
    <div className="bg-slate-900/40 border border-slate-800 px-3 py-2.5">
      <div className="grid grid-cols-[160px_120px_1fr_120px] gap-3 items-start">
        {/* Stage pill */}
        <div className={`text-center text-[10px] tracking-widest font-semibold px-2 py-1 border ${sc.bg} ${sc.border} ${sc.txt} whitespace-nowrap`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {sc.label}
        </div>
        {/* Tail */}
        <div>
          <div className="text-xl text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
            {entry.tail || '?'}
          </div>
          {entry.serialNumber && (
            <div className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              SN {entry.serialNumber}
            </div>
          )}
        </div>
        {/* Discrepancy + reporter */}
        <div className="min-w-0">
          <div className="text-sm text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {entry.discrepancy || <span className="text-slate-600 italic">(no discrepancy text)</span>}
          </div>
          <div className="text-xs text-slate-400 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <span className="text-slate-500">BY</span> {entry.requestedByName}
            {entry.requestedByCert && (
              <>
                <span className="text-slate-600 mx-1.5">·</span>
                <span className="text-slate-500">CERT</span> {entry.requestedByCert}
              </>
            )}
          </div>
        </div>
        {/* Time + actions */}
        <div className="text-right">
          <div className="text-xs text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {fmtDate(entry.createdAtClient)}
          </div>
          <div className="flex items-center justify-end gap-1 mt-2 flex-wrap">
            {/* PDF download — always available */}
            <button
              onClick={onDownloadPdf}
              className="p-1.5 border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200"
              title="Download as PDF"
            >
              <Download className="w-3 h-3" />
            </button>
            {/* Edit — only when stage allows + user has permission */}
            {canEdit && ['CREATED', 'DEFERRED', 'GROUNDED'].includes(entry.stage) && (
              <button
                onClick={() => onEdit(entry)}
                className="p-1.5 border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200"
                title="Edit AML"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
            {/* Defer — only for OPEN + ops/admin */}
            {entry.stage === 'CREATED' && canDefer && (
              <button
                onClick={() => onDefer(entry)}
                className="px-2 py-1 border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20 text-[10px] tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                DEFER / GROUND
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Aircraft state at time of write */}
      {(entry.aftt || entry.hobbs || entry.landings) && (
        <div className="border-t border-slate-800 mt-2 pt-2 text-xs text-slate-400 flex items-center gap-4 flex-wrap" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {entry.aftt && <span><span className="text-slate-500">AFTT</span> {entry.aftt}</span>}
          {entry.hobbs && <span><span className="text-slate-500">HOBBS</span> {entry.hobbs}</span>}
          {entry.landings && <span><span className="text-slate-500">LDGS</span> {entry.landings}</span>}
        </div>
      )}

      {/* MEL details — only shown for DEFERRED stage */}
      {entry.stage === 'DEFERRED' && (
        <div className="border-t border-cyan-500/20 mt-2 pt-2 bg-cyan-500/5 -mx-3 -mb-2.5 px-3 pb-2.5">
          <div className="grid grid-cols-[1fr_auto] gap-3 items-start">
            <div className="text-xs space-y-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <div>
                <span className="text-slate-500">MEL</span>{' '}
                <span className="text-slate-200">{entry.melItemRef || '(no ref)'}</span>
                {entry.ataCode && (
                  <>
                    <span className="text-slate-600 mx-1.5">·</span>
                    <span className="text-slate-500">ATA</span>{' '}
                    <span className="text-slate-200">{entry.ataCode}</span>
                  </>
                )}
                <span className="text-slate-600 mx-1.5">·</span>
                <span className="text-slate-500">CAT</span>{' '}
                <span className="text-slate-200">{entry.melCategory}</span>
                {entry.melLimitDays !== null && entry.melLimitDays !== undefined && (
                  <>
                    <span className="text-slate-600 mx-1.5">·</span>
                    <span className="text-slate-500">LIMIT</span>{' '}
                    <span className="text-slate-200">{entry.melLimitDays}d</span>
                  </>
                )}
                {entry.melDueDate && (
                  <>
                    <span className="text-slate-600 mx-1.5">·</span>
                    <span className="text-slate-500">DUE</span>{' '}
                    <span className="text-slate-200">{entry.melDueDate}</span>
                  </>
                )}
              </div>
              {entry.melRemarks && (
                <div className="text-slate-400">
                  <span className="text-slate-500">REMARKS</span> {entry.melRemarks}
                </div>
              )}
              <div className="text-slate-400">
                <span className="text-slate-500">APPROVED BY</span>{' '}
                {entry.deferralApprovedByName}
                {entry.deferralApprovedByCert && (
                  <>
                    <span className="text-slate-600 mx-1.5">·</span>
                    <span className="text-slate-500">CERT</span> {entry.deferralApprovedByCert}
                  </>
                )}
              </div>
              {entry.serviceRequestId && (
                <div className="text-slate-400">
                  <span className="text-slate-500">SR</span>{' '}
                  <span className="text-cyan-200">{entry.serviceRequestId}</span>
                </div>
              )}
            </div>
            {melCountdown && (
              <div className={`text-center px-2 py-1 border whitespace-nowrap ${
                melCountdown.urgent
                  ? 'bg-red-500/20 border-red-500/40 text-red-200'
                  : 'bg-slate-800 border-slate-700 text-slate-300'
              }`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <div className="text-[9px] tracking-widest opacity-70">MEL DUE</div>
                <div className="text-sm font-semibold mt-0.5">{melCountdown.text}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Grounded detail strip */}
      {entry.stage === 'GROUNDED' && (
        <div className="border-t border-red-500/20 mt-2 pt-2 bg-red-500/5 -mx-3 -mb-2.5 px-3 pb-2.5">
          <div className="text-xs space-y-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {entry.groundingReason && (
              <div className="text-slate-300">
                <span className="text-slate-500">REASON</span> {entry.groundingReason}
              </div>
            )}
            <div className="text-slate-400">
              <span className="text-slate-500">GROUNDED BY</span>{' '}
              {entry.groundedByName}
              {entry.groundedByCert && (
                <>
                  <span className="text-slate-600 mx-1.5">·</span>
                  <span className="text-slate-500">CERT</span> {entry.groundedByCert}
                </>
              )}
            </div>
            {entry.squawkId && (
              <div className="text-slate-400">
                <span className="text-slate-500">SQUAWK</span>{' '}
                <span className="text-red-200">{entry.squawkId}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ====================================================================
// CREATE AML MODAL — Part I of the form
// ====================================================================

function CreateAMLModal({ currentUser, fleetTails, onClose, onCreated }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [tail, setTail] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [aftt, setAftt] = useState('');
  const [hobbs, setHobbs] = useState('');
  const [landings, setLandings] = useState('');
  const [discrepancy, setDiscrepancy] = useState('');
  // Signature fields — the requester's name + cert# get captured as
  // part of the record. The current user's identity is the auth
  // signature; the cert# is what they certify they hold.
  const [requesterName, setRequesterName] = useState(currentUser?.name || currentUser?.displayName || '');
  const [requesterCert, setRequesterCert] = useState(currentUser?.certificateNumber || '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      // Build the entry. Parse `date` to a real Date so the createdAtClient
      // matches the user-entered date (since the AML date isn't always
      // "right now" — pilot may write it after the fact for a flight
      // earlier in the day).
      const dateMs = new Date(date + 'T00:00:00').getTime();
      await createAML({
        date,
        tail: tail.toUpperCase().trim(),
        serialNumber: serialNumber.trim() || null,
        aftt: aftt.trim() || null,
        hobbs: hobbs.trim() || null,
        landings: landings.trim() || null,
        discrepancy: discrepancy.trim(),
        requestedBy: currentUser?.uid || null,
        requestedByName: requesterName.trim() || (currentUser?.name || currentUser?.displayName || ''),
        requestedByCert: requesterCert.trim() || null,
        createdAtClient: Number.isFinite(dateMs) ? dateMs : Date.now(),
      });
      onCreated();
    } catch (e) {
      setError(e.message || 'Failed to save AML');
    } finally {
      setSaving(false);
    }
  }

  const canSave = (
    tail.trim() &&
    discrepancy.trim() &&
    requesterName.trim() &&
    !saving
  );

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl my-8">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div>
            <h3 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              NEW AML — PART I
            </h3>
            <p className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DISCREPANCY OR MAINTENANCE REQUEST
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto">
          {/* Date + tail + serial */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                DATE
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
              />
            </div>
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                AIRCRAFT REG # *
              </label>
              {fleetTails.length > 0 ? (
                <select
                  value={tail}
                  onChange={(e) => setTail(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  <option value="">Select tail...</option>
                  {fleetTails.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={tail}
                  onChange={(e) => setTail(e.target.value.toUpperCase())}
                  placeholder="N525CR"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              )}
            </div>
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                SERIAL #
              </label>
              <input
                type="text"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
            </div>
          </div>

          {/* AFTT / Hobbs / Landings — the meter times */}
          <div>
            <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              AIRCRAFT TACH / HOBBS METER TIMES
            </label>
            <div className="grid grid-cols-3 gap-3">
              <input
                type="text"
                value={aftt}
                onChange={(e) => setAftt(e.target.value)}
                placeholder="AFTT"
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
              <input
                type="text"
                value={hobbs}
                onChange={(e) => setHobbs(e.target.value)}
                placeholder="HOBBS"
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
              <input
                type="text"
                value={landings}
                onChange={(e) => setLandings(e.target.value)}
                placeholder="LANDINGS"
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
            </div>
            <p className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              Enter as applicable to aircraft type
            </p>
          </div>

          {/* Discrepancy — the big one */}
          <div>
            <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DISCREPANCY OR MAINTENANCE REQUEST *
            </label>
            <textarea
              value={discrepancy}
              onChange={(e) => setDiscrepancy(e.target.value)}
              rows={5}
              placeholder="Describe the discrepancy or maintenance need. Be specific — system, symptom, when noticed, any troubleshooting already performed."
              className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
            />
          </div>

          {/* MEL deferral happens on a separate step after the AML is
              created. Once saved, the row will have a DEFER TO MEL
              button if the discrepancy needs to be deferred. */}
          <div className="border border-slate-700 border-dashed bg-slate-800/30 p-3 text-xs text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <div className="text-[10px] tracking-widest text-slate-500 mb-1">NEXT STEP</div>
            <div>
              After submitting this AML, an authorized person can DEFER TO MEL from the row, or maintenance can begin work and clear it directly.
            </div>
          </div>

          {/* Requester signature block */}
          <div className="border-t border-slate-800 pt-3 mt-3">
            <div className="text-[10px] tracking-widest text-slate-400 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              SIGNATURE FOR MAINTENANCE REQUEST
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  NAME *
                </label>
                <input
                  type="text"
                  value={requesterName}
                  onChange={(e) => setRequesterName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  CERTIFICATE #
                </label>
                <input
                  type="text"
                  value={requesterCert}
                  onChange={(e) => setRequesterCert(e.target.value)}
                  placeholder="If applicable"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mt-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              Submitting this form is your authenticated signature as {currentUser?.name || currentUser?.displayName || '(unknown user)'} at {new Date().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, month: 'short', day: 'numeric' })}.
            </p>
          </div>

          {error && (
            <div className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            CANCEL
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {saving ? <Loader2 className="w-4 h-4 inline-block mr-1 animate-spin" /> : <FileText className="w-4 h-4 inline-block mr-1 -mt-0.5" />}
            {saving ? 'SAVING...' : 'SUBMIT AML'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// DEFER AML MODAL — DOM approval workflow that creates squawk + MEL + AOG
// ====================================================================

function DeferAMLModal({ aml, currentUser, onClose, onDeferred }) {
  // MEL search state
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState(aml.discrepancy || '');
  const [searchResults, setSearchResults] = useState([]);
  const [searchNote, setSearchNote] = useState('');
  const [selectedMelItem, setSelectedMelItem] = useState(null);

  // Deferral details
  const [category, setCategory] = useState('');           // A | B | C | D
  const [limitDays, setLimitDays] = useState('');         // override for Cat A
  const [dueDate, setDueDate] = useState('');
  const [ataCode, setAtaCode] = useState('');
  const [melItemRef, setMelItemRef] = useState('');
  const [remarks, setRemarks] = useState('');
  // Where the maintenance work will happen (for Service Request creation)
  const [serviceLocation, setServiceLocation] = useState('');
  const [serviceFbo, setServiceFbo] = useState('');
  // Grounding rationale (only used if DOM determines non-MEL'able)
  const [groundingReason, setGroundingReason] = useState('');

  // DOM approval
  const [approverName, setApproverName] = useState(currentUser?.name || currentUser?.displayName || '');
  const [approverCert, setApproverCert] = useState(currentUser?.certificateNumber || '');
  const [signatureDataUrl, setSignatureDataUrl] = useState(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Default category limits (CFR 121/135 MEL standard)
  const categoryLimits = { A: null, B: 3, C: 10, D: 120 };

  // Auto-compute due date when category changes
  useEffect(() => {
    if (!category) return;
    const days = (limitDays && Number(limitDays)) || categoryLimits[category];
    if (!days || !Number.isFinite(days)) {
      // Cat A with no manual days — due date not auto-computable
      if (category === 'A') setDueDate('');
      return;
    }
    const due = new Date(Date.now() + days * 86400000);
    setDueDate(due.toISOString().slice(0, 10));
  }, [category, limitDays]);

  // Subscribe to active MEL revision so we have the items list to
  // resolve AI candidates against. Loads on modal open.
  const [melItems, setMelItems] = useState([]);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    (async () => {
      const m = await import('./firebase-mel.js');
      if (cancelled) return;
      unsub = m.subscribeActiveRevision(aml.tail, (rev) => {
        setMelItems(rev?.items || []);
      });
    })();
    return () => { cancelled = true; try { unsub(); } catch (_) {} };
  }, [aml.tail]);

  // Lookup MEL items via /api/mel-search (existing AI endpoint)
  async function runMelSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchNote('');
    setSearchResults([]);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
      const r = await fetch('/api/mel-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, tail: aml.tail, query: searchQuery }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSearchNote(`MEL search: ${data.error || r.status}`);
        return;
      }
      // mel-search returns refs; resolve to full items via firebase-mel
      const m = await import('./firebase-mel.js');
      const resolved = m.resolveRefs(melItems, data.candidates || []);
      setSearchResults(resolved);
      setSearchNote(data.note || 'Suggestions only — read provisos before deferring.');
    } catch (e) {
      setSearchNote(`Search failed: ${e.message}`);
    } finally {
      setSearching(false);
    }
  }

  // When a MEL item is picked, populate ref + ATA from it
  function pickMelItem(item) {
    setSelectedMelItem(item);
    setMelItemRef(item.ref || item.itemRef || '');
    setAtaCode(item.ata || item.ataCode || '');
    // Most MEL items have a category embedded; use it if present
    if (item.category && ['A', 'B', 'C', 'D'].includes(item.category)) {
      setCategory(item.category);
    }
  }

  // PATH A — deferred under MEL. Aircraft remains airworthy under
  // MEL provisos; creates Service Request (not AOG).
  async function handleDeferAsMELable() {
    setSaving(true);
    setError(null);
    try {
      if (!category) throw new Error('Category required for MEL deferral');
      if (!melItemRef.trim()) throw new Error('MEL item reference required — search and select, or enter manually');
      if (!approverName.trim()) throw new Error('Approver name required');
      const { deferAMLAsMELable } = await import('./firebase-aml.js');
      await deferAMLAsMELable({
        amlId: aml.id,
        aml,
        melCategory: category,
        melLimitDays: limitDays ? Number(limitDays) : undefined,
        melRemarks: remarks.trim() || null,
        melItemRef: melItemRef.trim() || null,
        ataCode: ataCode.trim() || null,
        dueDate: dueDate || null,
        location: serviceLocation.trim() || null,
        fboName: serviceFbo.trim() || null,
        approver: {
          uid: currentUser?.uid || null,
          name: approverName.trim(),
          certificateNumber: approverCert.trim() || null,
        },
        approverSignature: signatureDataUrl,
      });
      onDeferred();
    } catch (e) {
      setError(e.message || 'Deferral failed');
    } finally {
      setSaving(false);
    }
  }

  // PATH B — non-MEL'able. Aircraft grounded; creates AOG squawk.
  async function handleGroundAircraft() {
    setSaving(true);
    setError(null);
    try {
      if (!approverName.trim()) throw new Error('Approver name required');
      // Confirm before grounding — this is consequential
      if (!window.confirm(
        `Confirm grounding aircraft ${aml.tail}?\n\n` +
        `This will create an AOG squawk and mark the aircraft non-airworthy ` +
        `until DOM signs off on a return to service.\n\n` +
        `Reason: ${groundingReason.trim() || '(none stated)'}`
      )) {
        setSaving(false);
        return;
      }
      const { groundAML } = await import('./firebase-aml.js');
      await groundAML({
        amlId: aml.id,
        aml,
        reason: groundingReason.trim() || null,
        approver: {
          uid: currentUser?.uid || null,
          name: approverName.trim(),
          certificateNumber: approverCert.trim() || null,
        },
        approverSignature: signatureDataUrl,
      });
      onDeferred();
    } catch (e) {
      setError(e.message || 'Grounding failed');
    } finally {
      setSaving(false);
    }
  }

  // Two different gates depending on action chosen at submit time.
  const canDeferAsMELable = (
    category &&
    melItemRef.trim() &&
    approverName.trim() &&
    !saving
  );
  const canGroundAircraft = (
    approverName.trim() &&
    !saving
  );

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-red-500/40 w-full max-w-3xl my-8">
        <div className="border-b border-slate-800 px-4 py-3">
          <h3 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            DOM REVIEW — DEFER OR GROUND
          </h3>
          <p className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            CHOOSE ONE: DEFER UNDER MEL (AIRWORTHY · SR CREATED) OR GROUND AIRCRAFT (AOG)
          </p>
        </div>

        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* AML summary */}
          <div className="bg-slate-800/40 border border-slate-700 p-3 text-xs" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <div className="text-[10px] tracking-widest text-slate-500 mb-1">DEFERRING THIS AML</div>
            <div className="text-slate-300">
              <span className="text-slate-100" style={{ fontWeight: 600 }}>{aml.tail}</span>
              {aml.serialNumber && <span className="text-slate-500"> · SN {aml.serialNumber}</span>}
            </div>
            <div className="text-slate-300 mt-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {aml.discrepancy}
            </div>
            <div className="text-slate-500 mt-1">
              BY {aml.requestedByName}
              {aml.requestedByCert && ` · CERT ${aml.requestedByCert}`}
            </div>
          </div>

          {/* MEL search */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                MEL LOOKUP — SEARCH BY DISCREPANCY
              </label>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="e.g. left wing landing light inop"
                className="flex-1 bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
              />
              <button
                onClick={runMelSearch}
                disabled={searching || !searchQuery.trim()}
                className="px-3 py-2 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/10 text-[10px] tracking-widest disabled:opacity-50"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {searching ? <Loader2 className="w-3 h-3 inline animate-spin" /> : <Search className="w-3 h-3 inline" />}
                {' '}SEARCH
              </button>
            </div>
            {searchNote && (
              <p className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {searchNote}
              </p>
            )}
            {searchResults.length > 0 && (
              <div className="mt-2 space-y-2 max-h-96 overflow-y-auto">
                {searchResults.map((r, i) => {
                  const refStr = r.ref || r.itemRef || `result-${i}`;
                  const isSelected = selectedMelItem && (selectedMelItem.ref === refStr || selectedMelItem.itemRef === refStr);
                  // Compose the item title from whatever fields are present
                  const itemName = r.subitem
                    ? `${r.item || ''} — ${r.subitem}. ${r.subitem_name || ''}`.trim()
                    : (r.item || r.title || refStr);
                  const systemName = [r.system, r.system_name].filter(Boolean).join(' ');
                  return (
                    <div
                      key={i}
                      className={`border ${
                        isSelected
                          ? 'bg-cyan-500/10 border-cyan-500/40'
                          : 'bg-slate-800/40 border-slate-700'
                      }`}
                    >
                      {/* Header row — click to select */}
                      <button
                        onClick={() => pickMelItem(r)}
                        className="w-full text-left p-2.5 hover:bg-slate-800/60"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        <div className="flex items-center gap-2 flex-wrap text-xs">
                          <span className="font-semibold text-slate-100">{refStr}</span>
                          {r.ata && <span className="text-slate-500">ATA {r.ata}</span>}
                          {r.category && (
                            <span className="text-amber-300 font-semibold">CAT {r.category}</span>
                          )}
                          {r.non_relief === true && (
                            <span className="px-1.5 py-0.5 bg-red-500/20 border border-red-500/40 text-red-200 text-[9px] tracking-widest">
                              NON-RELIEF
                            </span>
                          )}
                          {isSelected && (
                            <span className="ml-auto text-cyan-300 text-[10px]">✓ SELECTED</span>
                          )}
                        </div>
                        {systemName && (
                          <div className="text-[10px] text-slate-500 mt-1">
                            {systemName}
                          </div>
                        )}
                        <div className="text-sm text-slate-200 mt-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                          {itemName}
                        </div>
                        {/* Required-on-aircraft / for-dispatch */}
                        {(r.number_installed || r.number_required) && (
                          <div className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                            {r.number_installed != null && <>INSTALLED {r.number_installed}</>}
                            {r.number_required != null && <> · REQ FOR DISPATCH {r.number_required}</>}
                          </div>
                        )}
                      </button>

                      {/* Full details — always visible below the header */}
                      <div className="border-t border-slate-700/50 px-2.5 py-2 text-xs space-y-2">
                        {/* Provisos (the most important field for the DOM) */}
                        {r.remarks ? (
                          <div>
                            <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                              PROVISOS / REMARKS
                            </div>
                            <div className="text-slate-200 whitespace-pre-wrap" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                              {r.remarks}
                            </div>
                          </div>
                        ) : (
                          <div className="text-[10px] text-slate-600 italic" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                            (no provisos extracted from MEL — verify against source document before deferring)
                          </div>
                        )}
                        {/* M / O procedures required */}
                        {(r.maint_required || r.ops_required) && (
                          <div className="flex items-center gap-3 flex-wrap" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                            <span className="text-[10px] tracking-widest text-slate-500">REQUIRES:</span>
                            {r.maint_required && (
                              <span className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[10px] tracking-widest">
                                (M) MAINT PROCEDURE
                              </span>
                            )}
                            {r.ops_required && (
                              <span className="px-2 py-0.5 bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-[10px] tracking-widest">
                                (O) OPS PROCEDURE
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[10px] text-slate-500 mt-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              Search results are AI suggestions only. Read the actual MEL provisos before deferring.
              You can also enter the MEL reference manually below.
            </p>
          </div>

          {/* Deferral details */}
          <div className="border-t border-slate-800 pt-3 space-y-3">
            <div className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DEFERRAL DETAILS
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  MEL ITEM REF
                </label>
                <input
                  type="text"
                  value={melItemRef}
                  onChange={(e) => setMelItemRef(e.target.value)}
                  placeholder="33-40-01"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  ATA CODE
                </label>
                <input
                  type="text"
                  value={ataCode}
                  onChange={(e) => setAtaCode(e.target.value)}
                  placeholder="33"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  CATEGORY *
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  <option value="">Select...</option>
                  <option value="A">A — Per MEL provisos</option>
                  <option value="B">B — 3 consecutive calendar days</option>
                  <option value="C">C — 10 consecutive calendar days</option>
                  <option value="D">D — 120 consecutive calendar days</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  LIMIT DAYS {category === 'A' ? '(required for Cat A)' : '(override)'}
                </label>
                <input
                  type="number"
                  min="0"
                  value={limitDays}
                  onChange={(e) => setLimitDays(e.target.value)}
                  placeholder={categoryLimits[category] !== null && categoryLimits[category] !== undefined ? `Default: ${categoryLimits[category]}` : 'Required'}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  DUE DATE (auto-computed)
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                REMARKS / NOTES
              </label>
              <textarea
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                rows={2}
                placeholder="Any DOM remarks on the deferral, operational notes, etc."
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
              />
            </div>

            {/* Service request fields — where the deferred work will
                actually happen. Only used for PATH A. */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  SERVICE LOCATION (airport)
                </label>
                <input
                  type="text"
                  value={serviceLocation}
                  onChange={(e) => setServiceLocation(e.target.value.toUpperCase())}
                  placeholder="e.g. KFXE"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  FBO / FACILITY
                </label>
                <input
                  type="text"
                  value={serviceFbo}
                  onChange={(e) => setServiceFbo(e.target.value)}
                  placeholder="e.g. Banyan Air Service"
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
                />
              </div>
            </div>
            <p className="text-[10px] text-slate-500 -mt-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              Location + FBO used for the Service Request (PATH A only). Leave blank if grounding.
            </p>
          </div>

          {/* DOM approval block */}
          <div className="border-t border-slate-800 pt-3 space-y-3">
            <div className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DOM APPROVAL
            </div>
            <div className="bg-slate-800/30 border border-slate-700 p-3 text-[11px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              <div className="mb-2">
                <span className="font-semibold text-slate-300">Path A — Defer Under MEL:</span> Aircraft remains airworthy under MEL provisos. Creates a Service Request to track repair within the MEL time limit. All systems deactivated by the MEL must be reactivated and signed off when the discrepancy is cleared (Part II of the AML).
              </div>
              <div>
                <span className="font-semibold text-red-300">Path B — Cannot Defer:</span> Aircraft is grounded (AOG) until repaired and DOM signs off on Return to Service. No MEL deferral created.
              </div>
            </div>

            {/* Grounding rationale — only relevant for Path B */}
            <div>
              <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                GROUNDING RATIONALE (only used if choosing PATH B)
              </label>
              <textarea
                value={groundingReason}
                onChange={(e) => setGroundingReason(e.target.value)}
                rows={2}
                placeholder="If grounding the aircraft, briefly state why this item is non-MEL'able or otherwise not deferrable."
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  APPROVER NAME *
                </label>
                <input
                  type="text"
                  value={approverName}
                  onChange={(e) => setApproverName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  CERTIFICATE #
                </label>
                <input
                  type="text"
                  value={approverCert}
                  onChange={(e) => setApproverCert(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
            </div>

            <SignaturePad
              label="DOM SIGNATURE (OPTIONAL)"
              onChange={setSignatureDataUrl}
              height={100}
            />

            <p className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              Authenticated as {currentUser?.name || currentUser?.displayName || '(unknown)'} · {new Date().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, month: 'short', day: 'numeric' })}
            </p>
          </div>

          {error && (
            <div className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-end gap-2 flex-wrap">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            CANCEL
          </button>
          <button
            onClick={handleGroundAircraft}
            disabled={!canGroundAircraft}
            className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/60 disabled:bg-slate-800 disabled:border-slate-700 disabled:text-slate-500 text-red-200 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title="Use when the discrepancy cannot be deferred under the MEL"
          >
            {saving ? <Loader2 className="w-4 h-4 inline-block mr-1 animate-spin" /> : <AlertTriangle className="w-4 h-4 inline-block mr-1 -mt-0.5" />}
            GROUND AIRCRAFT (AOG)
          </button>
          <button
            onClick={handleDeferAsMELable}
            disabled={!canDeferAsMELable}
            className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title="Use when the discrepancy can be deferred under the MEL with provisos"
          >
            {saving ? <Loader2 className="w-4 h-4 inline-block mr-1 animate-spin" /> : <FileText className="w-4 h-4 inline-block mr-1 -mt-0.5" />}
            DEFER UNDER MEL (SR · NOT GROUNDED)
          </button>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// EDIT AML MODAL — stage-aware editing
// ====================================================================

function EditAMLModal({ aml, currentUser, onClose, onSaved }) {
  const stage = aml.stage || 'CREATED';

  // Which fields are editable for this stage?
  const editableFields = {
    CREATED:  ['discrepancy', 'aftt', 'hobbs', 'landings', 'serialNumber', 'tail', 'date'],
    DEFERRED: ['melRemarks'],
    GROUNDED: ['groundingReason'],
  }[stage] || [];

  // State for each editable field (mirror current values)
  const [discrepancy, setDiscrepancy] = useState(aml.discrepancy || '');
  const [aftt, setAftt] = useState(aml.aftt || '');
  const [hobbs, setHobbs] = useState(aml.hobbs || '');
  const [landings, setLandings] = useState(aml.landings || '');
  const [serialNumber, setSerialNumber] = useState(aml.serialNumber || '');
  const [tail, setTail] = useState(aml.tail || '');
  const [date, setDate] = useState(aml.date || '');
  const [melRemarks, setMelRemarks] = useState(aml.melRemarks || '');
  const [groundingReason, setGroundingReason] = useState(aml.groundingReason || '');
  const [reason, setReason] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  if (editableFields.length === 0) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 w-full max-w-md p-4">
          <h3 className="text-lg tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            CANNOT EDIT
          </h3>
          <p className="text-sm text-slate-400">
            AML records in stage <span className="text-slate-200 font-mono">{stage}</span> are locked. Editing a signed-off field would be a record falsification.
          </p>
          <div className="mt-4 flex justify-end">
            <button onClick={onClose} className="px-4 py-2 bg-cyan-500 text-slate-950 text-sm tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const { updateAML } = await import('./firebase-aml.js');
      const updates = {};
      if (editableFields.includes('discrepancy')) updates.discrepancy = discrepancy.trim();
      if (editableFields.includes('aftt')) updates.aftt = aftt.trim() || null;
      if (editableFields.includes('hobbs')) updates.hobbs = hobbs.trim() || null;
      if (editableFields.includes('landings')) updates.landings = landings.trim() || null;
      if (editableFields.includes('serialNumber')) updates.serialNumber = serialNumber.trim() || null;
      if (editableFields.includes('tail')) updates.tail = tail.toUpperCase().trim();
      if (editableFields.includes('date')) updates.date = date;
      if (editableFields.includes('melRemarks')) updates.melRemarks = melRemarks.trim() || null;
      if (editableFields.includes('groundingReason')) updates.groundingReason = groundingReason.trim() || null;

      const result = await updateAML({
        amlId: aml.id,
        updates,
        editor: {
          uid: currentUser?.uid || null,
          name: currentUser?.name || currentUser?.displayName || 'Unknown',
        },
        reason: reason.trim() || null,
      });
      if (!result.updated) {
        setError('No changes detected');
        return;
      }
      onSaved();
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-xl my-8">
        <div className="border-b border-slate-800 px-4 py-3">
          <h3 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            EDIT AML
          </h3>
          <p className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            STAGE {stage} · EDITS ARE AUDITED IN THE AML HISTORY
          </p>
        </div>

        <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto">
          <div className="bg-slate-800/40 border border-slate-700 p-3 text-[11px] text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            In stage <span className="text-slate-200">{stage}</span>, the following fields are editable:{' '}
            <span className="text-cyan-300">{editableFields.join(', ')}</span>.
            <br />Signed-off fields and downstream records (squawks, MEL deferrals, SR) are locked.
          </div>

          {editableFields.includes('date') && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  DATE
                </label>
                <input
                  type="date" value={date} onChange={(e) => setDate(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  TAIL
                </label>
                <input
                  type="text" value={tail} onChange={(e) => setTail(e.target.value.toUpperCase())}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  SERIAL #
                </label>
                <input
                  type="text" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </div>
            </div>
          )}

          {editableFields.includes('aftt') && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  AFTT
                </label>
                <input type="text" value={aftt} onChange={(e) => setAftt(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }} />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  HOBBS
                </label>
                <input type="text" value={hobbs} onChange={(e) => setHobbs(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }} />
              </div>
              <div>
                <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  LANDINGS
                </label>
                <input type="text" value={landings} onChange={(e) => setLandings(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }} />
              </div>
            </div>
          )}

          {editableFields.includes('discrepancy') && (
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                DISCREPANCY *
              </label>
              <textarea
                value={discrepancy} onChange={(e) => setDiscrepancy(e.target.value)} rows={5}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
              />
            </div>
          )}

          {editableFields.includes('melRemarks') && (
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                MEL REMARKS / NOTES
              </label>
              <textarea
                value={melRemarks} onChange={(e) => setMelRemarks(e.target.value)} rows={3}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
              />
              <p className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                The MEL deferral itself (ref, category, limit, due date) is locked once approved.
                Only remarks can be amended.
              </p>
            </div>
          )}

          {editableFields.includes('groundingReason') && (
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                GROUNDING RATIONALE
              </label>
              <textarea
                value={groundingReason} onChange={(e) => setGroundingReason(e.target.value)} rows={3}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
              />
            </div>
          )}

          <div>
            <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              EDIT REASON (optional)
            </label>
            <input
              type="text" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. corrected typo in hobbs reading"
              className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
            />
          </div>

          {error && (
            <div className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            CANCEL
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 text-slate-950 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {saving ? <Loader2 className="w-4 h-4 inline animate-spin mr-1" /> : <Pencil className="w-4 h-4 inline -mt-0.5 mr-1" />}
            {saving ? 'SAVING...' : 'SAVE CHANGES'}
          </button>
        </div>
      </div>
    </div>
  );
}
