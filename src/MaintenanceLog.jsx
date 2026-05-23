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
} from 'lucide-react';
import { createAML, subscribeAMLEntries } from './firebase-aml.js';

// ====================================================================
// MAIN
// ====================================================================

export default function MaintenanceLog({ currentUser, users = [], allTrips = [] }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [stageFilter, setStageFilter] = useState('all');

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
  // Only DOM (admin role here, since you don't have a separate DOM role)
  // can sign off in later turns.
  const canCreate = ['crew', 'maint', 'ops', 'admin'].includes(currentUser?.role);

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      {/* PROTOTYPE BANNER — visible until DOM signs off on digital workflow */}
      <div className="border border-amber-500/40 bg-amber-500/10 px-3 py-2 flex items-start gap-2">
        <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-100">
          <div className="font-semibold mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            PROTOTYPE — NOT YET APPROVED FOR OPERATIONAL USE
          </div>
          <div className="text-xs text-amber-200/90">
            Maintain paper AML records (or whatever system the DOM currently authorizes) alongside this digital log
            until the Director of Maintenance has signed off on the electronic workflow under
            AC 120-78A. The records below are for evaluation and review with the DOM only.
          </div>
        </div>
      </div>

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
            { id: 'DEFERRED', label: 'DEFERRED' },
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
          {filtered.map((e) => <AMLRow key={e.id} entry={e} />)}
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
    </div>
  );
}

// ====================================================================
// AML ROW
// ====================================================================

function AMLRow({ entry }) {
  const stageColors = {
    CREATED:  { bg: 'bg-amber-500/15',  border: 'border-amber-500/40',  txt: 'text-amber-200',  label: 'OPEN' },
    DEFERRED: { bg: 'bg-red-500/15',    border: 'border-red-500/40',    txt: 'text-red-300',    label: 'DEFERRED · AOG' },
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
        {/* Time */}
        <div className="text-right text-xs text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtDate(entry.createdAtClient)}
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
          {/* Banner inside the modal too, for safety */}
          <div className="border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <AlertTriangle className="w-3 h-3 inline-block mr-1 -mt-0.5" />
            PROTOTYPE — maintain paper AML alongside this digital record.
          </div>

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

          {/* MEL placeholder (Turn 2 will fill this in) */}
          <div className="border border-slate-700 border-dashed bg-slate-800/30 p-3 text-xs text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <div className="text-[10px] tracking-widest text-slate-500 mb-1">MEL DEFERRAL (TURN 2)</div>
            <div>
              If this discrepancy is to be deferred under the MEL, the deferral will be added in a separate step after creating the AML.
              The MEL lookup, DOM approval, and AOG creation are coming next.
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
