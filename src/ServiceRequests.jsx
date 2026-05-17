// Service Requests UI — full AOG-parity feature for routine/scheduled
// maintenance, isolated in its own component file (App.jsx stays a monolith;
// this is the first cross-component import, dynamically loaded the same way
// App.jsx lazy-loads its firebase-* modules).
//
// Uses the slice 1-3 data/API layer:
//   src/firebase-service.js   (data)
//   api/service-link.js       (mint/revoke vendor link)
//   api/service-public.js     (vendor portal — used by /service-tech page)
//   api/send-service-references.js
//
// Mirrors AogEventsTab / AogDetail / NewAogModal / AogTechChatPanel behavior.

import React, { useState, useEffect, useRef } from 'react';
import {
  AlertTriangle, FileText, Loader2, ArrowLeft, Plus, Trash2, Link2,
  Send, X, Check, Clock, Wrench, ExternalLink, Upload,
} from 'lucide-react';

const MONO = { fontFamily: 'JetBrains Mono, monospace' };
const SANS = { fontFamily: 'DM Sans, sans-serif', fontWeight: 600 };

function fmtTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch { return String(ts); }
}

/* =========================================================================
   LIST TAB
   ========================================================================= */
export default function ServiceRequestsTab({ currentUser, fleetTails }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('open'); // open | completed

  useEffect(() => {
    let unsub = null, cancelled = false;
    (async () => {
      const m = await import('./firebase-service.js');
      if (cancelled) return;
      unsub = m.subscribeToServiceRequests((list) => {
        setItems(list);
        setLoading(false);
      });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  const openCount = items.filter(e => e.status === 'open').length;
  const doneCount = items.filter(e => e.status === 'completed').length;
  const filtered = items.filter(e => e.status === tab);
  const selected = items.find(e => e.id === selectedId);

  if (selected) {
    return (
      <ServiceDetail
        sr={selected}
        currentUser={currentUser}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-slate-500">{openCount} open · {doneCount} completed</p>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs tracking-widest font-medium"
          style={MONO}
        >
          <Wrench className="w-4 h-4" /> REQUEST SERVICE
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTab('open')}
          className={`text-xs px-3 py-1.5 tracking-widest ${tab === 'open'
            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
            : 'bg-slate-900 text-slate-500 border border-slate-800 hover:text-slate-300'}`}
          style={MONO}
        >
          OPEN ({openCount})
        </button>
        <button
          onClick={() => setTab('completed')}
          className={`text-xs px-3 py-1.5 tracking-widest ${tab === 'completed'
            ? 'bg-slate-700/40 text-slate-300 border border-slate-600'
            : 'bg-slate-900 text-slate-500 border border-slate-800 hover:text-slate-300'}`}
          style={MONO}
        >
          COMPLETED ({doneCount})
        </button>
      </div>

      {loading ? (
        <div className="p-12 text-center text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-12 text-center border border-slate-800 bg-slate-950">
          <Wrench className="w-8 h-8 text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-500">
            {tab === 'open' ? 'No open service requests' : 'No completed requests yet'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(sr => (
            <ServiceCard key={sr.id} sr={sr} onClick={() => setSelectedId(sr.id)} />
          ))}
        </div>
      )}

      {showNew && (
        <NewServiceModal
          currentUser={currentUser}
          fleetTails={fleetTails}
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); setSelectedId(id); }}
        />
      )}
    </div>
  );
}

/* =========================================================================
   CARD
   ========================================================================= */
function ServiceCard({ sr, onClick }) {
  const done = sr.status === 'completed';
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 border bg-slate-950 hover:bg-slate-900 transition-colors ${
        done ? 'border-slate-800' : 'border-cyan-500/30'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base text-slate-100" style={SANS}>{sr.tail || '—'}</span>
            <span className="text-[10px] tracking-widest px-1.5 py-0.5 border border-slate-700 text-slate-500 rounded" style={MONO}>
              {sr.serviceType || 'SERVICE'}
            </span>
            {!done && sr.linkTokenIssuedAt && !sr.linkRevoked && (
              <span className="text-[9px] tracking-widest px-1.5 py-0.5 bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 rounded" style={MONO}>
                VENDOR LINK ACTIVE
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1" style={MONO}>
            {sr.location || '—'}{sr.fboName ? ` · ${sr.fboName}` : ''}
          </div>
          {sr.serviceDescription && (
            <div className="text-xs text-slate-400 mt-2 line-clamp-2">{sr.serviceDescription}</div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className={`text-[10px] tracking-widest ${done ? 'text-slate-500' : 'text-cyan-300'}`} style={MONO}>
            {done ? 'COMPLETED' : 'OPEN'}
          </div>
          <div className="text-[10px] text-slate-600 mt-1" style={MONO}>
            {fmtTime(sr.requestedAt)}
          </div>
        </div>
      </div>
    </button>
  );
}

/* =========================================================================
   DETAIL
   ========================================================================= */
function srPartStatusTone(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('deliver') || s.includes('install')) return 'bg-green-500/20 text-green-300';
  if (s.includes('transit') || s.includes('ship')) return 'bg-cyan-500/20 text-cyan-300';
  if (s.includes('order') || s.includes('back')) return 'bg-amber-500/20 text-amber-300';
  return 'bg-slate-700 text-slate-300';
}
function SrPartStatusBadge({ status }) {
  if (!status) return <span className="text-slate-600">—</span>;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 tracking-widest font-medium ${srPartStatusTone(status)}`} style={MONO}>
      {String(status).toUpperCase()}
    </span>
  );
}
function srDetectCarrier(tn) {
  const t = String(tn || '').replace(/\s/g, '').toUpperCase();
  if (!t) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS';
  if (/^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(t)) return 'FedEx';
  if (/^(\d{20,22})$/.test(t)) return 'USPS';
  return null;
}
function srTrackingUrl(carrier, tn) {
  const t = encodeURIComponent(String(tn || '').trim());
  if (!t) return null;
  if (carrier === 'UPS') return `https://www.ups.com/track?tracknum=${t}`;
  if (carrier === 'FedEx') return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (carrier === 'USPS') return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  return null;
}

function ServiceDetail({ sr, currentUser, onBack }) {
  const [editing, setEditing] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkMsg, setLinkMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState('');
  const [uploadingRef, setUploadingRef] = useState(false);
  const [refError, setRefError] = useState('');
  const [sendRefPicker, setSendRefPicker] = useState(null); // { docIds } | null
  const [addingLogbook, setAddingLogbook] = useState(false);
  const [logbookEnabling, setLogbookEnabling] = useState(false);
  const refFileInputRef = useRef(null);

  const canEdit = ['admin', 'ops', 'maint'].includes(currentUser?.role);
  const done = sr.status === 'completed';
  const reporter = {
    uid: currentUser?.uid || currentUser?.id,
    displayName: currentUser?.displayName || currentUser?.name || currentUser?.email || 'Unknown',
  };

  async function handleMintLink() {
    setLinkBusy(true); setLinkMsg(''); setLinkUrl('');
    try {
      const { auth } = await import('./firebase.js');
      let idToken = null;
      if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/service-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mint', srId: sr.id, idToken }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
      setLinkUrl(data.url);
      setLinkMsg('Link minted. Copy and send to the vendor.');
    } catch (e) { setLinkMsg('Mint failed: ' + e.message); }
    finally { setLinkBusy(false); }
  }

  async function handleRevokeLink() {
    if (!window.confirm('Revoke the vendor link? All existing links stop working immediately.')) return;
    setLinkBusy(true); setLinkMsg('');
    try {
      const { auth } = await import('./firebase.js');
      let idToken = null;
      if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/service-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', srId: sr.id, idToken }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
      setLinkUrl(''); setLinkMsg('Vendor link revoked.');
    } catch (e) { setLinkMsg('Revoke failed: ' + e.message); }
    finally { setLinkBusy(false); }
  }

  async function handleToggleLogbook() {
    setLogbookEnabling(true);
    try {
      const { auth } = await import('./firebase.js');
      let idToken = null;
      if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/service-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-logbook', srId: sr.id, enabled: !sr.externalLogbookEnabled, idToken }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
    } catch (e) { alert('Failed: ' + e.message); }
    finally { setLogbookEnabling(false); }
  }

  async function handleComplete() {
    if (!window.confirm(`Mark this service request for ${sr.tail} as completed?`)) return;
    try {
      const m = await import('./firebase-service.js');
      await m.completeServiceRequest(sr.id, reporter);
    } catch (e) { alert('Failed to complete: ' + e.message); }
  }

  async function handleRefFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    if (refFileInputRef.current) refFileInputRef.current.value = '';
    if (!file) return;
    setRefError(''); setUploadingRef(true);
    try {
      const storageMod = await import('./firebase-storage.js');
      const meta = await storageMod.uploadServiceReference(file, sr.id);
      const m = await import('./firebase-service.js');
      await m.addReferenceDoc(sr.id, meta, reporter);
    } catch (err) {
      setRefError(err.message || 'Upload failed');
    } finally { setUploadingRef(false); }
  }

  async function handleRemoveRef(refDoc) {
    if (!window.confirm(`Remove "${refDoc.filename}"? This deletes the file.`)) return;
    try {
      const m = await import('./firebase-service.js');
      await m.removeReferenceDoc(sr.id, refDoc.id, reporter);
    } catch (err) { alert('Failed to remove: ' + err.message); }
  }

  async function handleShareLog() {
    if (!Array.isArray(sr.recipients) || sr.recipients.length === 0) {
      setSendStatus('No recipients configured. Edit to add mx/ops/admin email addresses.');
      return;
    }
    setSending(true); setSendStatus('');
    try {
      const m = await import('./firebase-service.js');
      await m.appendServiceLogEntry(sr.id, reporter.displayName,
        `Service request details shared with: ${sr.recipients.join(', ')}`);
      setSendStatus(`Logged. Recipients on file: ${sr.recipients.join(', ')}`);
      setTimeout(() => setSendStatus(''), 8000);
    } catch (e) { setSendStatus('Failed: ' + e.message); }
    finally { setSending(false); }
  }

  const parts = Array.isArray(sr.parts) ? sr.parts : [];
  const refs = Array.isArray(sr.referenceDocs) ? sr.referenceDocs : [];
  const logbook = Array.isArray(sr.logbookEntries) ? sr.logbookEntries : [];
  const techUpdates = Array.isArray(sr.techUpdates) ? sr.techUpdates : [];

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 mb-4" style={MONO}>
        <ArrowLeft className="w-4 h-4" /> BACK TO LIST
      </button>

      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl text-slate-100" style={SANS}>{sr.tail || '—'}</h2>
            <span className={`text-[10px] tracking-widest px-2 py-0.5 rounded border ${done
              ? 'border-slate-600 text-slate-400'
              : 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'}`} style={MONO}>
              {done ? 'COMPLETED' : 'OPEN'}
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-1" style={MONO}>
            {sr.serviceType || 'Service'} · {sr.location || '—'}{sr.fboName ? ` · ${sr.fboName}` : ''}
            {sr.requestedDate ? ` · requested ${sr.requestedDate}` : ''}
          </div>
        </div>
        {canEdit && !done && (
          <div className="flex gap-2 shrink-0">
            <button onClick={() => setEditing(true)} className="px-3 py-1.5 text-xs tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700" style={MONO}>EDIT</button>
            <button onClick={handleComplete} className="px-3 py-1.5 text-xs tracking-widest bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/30" style={MONO}>MARK COMPLETE</button>
          </div>
        )}
      </div>

      <Section label="SERVICE REQUESTED">
        <p className="text-sm text-slate-300 whitespace-pre-wrap">{sr.serviceDescription || '—'}</p>
      </Section>

      <Section label="COORDINATION TEAM">
        <Field label="Maint lead" value={sr.coordination?.maintLead} />
        <Field label="Technician" value={sr.coordination?.technician} />
        <Field label="Vendor" value={sr.coordination?.vendor} />
        <Field label="Ops contact" value={sr.coordination?.opsContact} />
      </Section>

      <Section label="DIAGNOSTICS / NOTES">
        <Field label="Discrepancy" value={sr.diagnostics?.pilotDiscrepancy} />
        <Field label="Troubleshooting" value={sr.diagnostics?.troubleshooting} />
        <Field label="OEM recommendation" value={sr.diagnostics?.oemRecommendation} />
      </Section>

      <Section label={`PARTS STATUS (${parts.length})`}>
        {parts.length === 0 ? (
          <p className="text-xs text-slate-500">No parts recorded yet. Use EDIT to add parts the vendor needs to order.</p>
        ) : (
          <div className="bg-slate-900 border border-slate-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr className="text-slate-500 text-left">
                  <th className="px-3 py-2 font-normal">Part #</th>
                  <th className="px-3 py-2 font-normal">Description</th>
                  <th className="px-3 py-2 font-normal">Status</th>
                  <th className="px-3 py-2 font-normal">ETA</th>
                  <th className="px-3 py-2 font-normal">Ship method</th>
                  <th className="px-3 py-2 font-normal">Tracking</th>
                  <th className="px-3 py-2 font-normal">Tech</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p, idx) => {
                  const carrier = srDetectCarrier(p.trackingNumber);
                  const trackUrl = srTrackingUrl(carrier, p.trackingNumber);
                  return (
                    <tr key={idx} className="border-b border-slate-800 last:border-b-0">
                      <td className="px-3 py-2 text-slate-300" style={MONO}>{p.partNumber || '—'}</td>
                      <td className="px-3 py-2 text-slate-300">{p.description || '—'}</td>
                      <td className="px-3 py-2"><SrPartStatusBadge status={p.status} /></td>
                      <td className="px-3 py-2 text-slate-300">{p.eta || '—'}</td>
                      <td className="px-3 py-2 text-slate-300">{p.shipMethod || '—'}</td>
                      <td className="px-3 py-2">
                        {p.trackingNumber ? (
                          trackUrl ? (
                            <a href={trackUrl} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300 underline" style={{ ...MONO, fontSize: '11px' }}>
                              {carrier ? `${carrier} ` : ''}{p.trackingNumber}
                            </a>
                          ) : (
                            <span className="text-slate-400" style={{ ...MONO, fontSize: '11px' }}>{p.trackingNumber}</span>
                          )
                        ) : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {p.techUsage === 'used' ? (
                          <span className="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-300 tracking-widest font-medium" style={MONO} title={`${p.techUsageBy || ''}${p.techUsageNote ? ' · ' + p.techUsageNote : ''}`}>USED</span>
                        ) : p.techUsage === 'not_used' ? (
                          <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 text-slate-300 tracking-widest font-medium" style={MONO} title={`${p.techUsageBy || ''}${p.techUsageNote ? ' · ' + p.techUsageNote : ''}`}>NOT USED</span>
                        ) : <span className="text-slate-600">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {(sr.shipTo?.address || sr.shipTo?.fboName) && (
          <p className="text-xs text-slate-500 mt-2">
            Ship to: {sr.shipTo?.fboName || sr.fboName}{sr.shipTo?.address ? ', ' + sr.shipTo.address : ''}{sr.shipTo?.attn ? ' · ATTN ' + sr.shipTo.attn : ''}
          </p>
        )}
      </Section>

      {/* Personnel + RTS side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="bg-slate-900 border border-slate-800 p-3">
          <div className="text-[10px] text-slate-500 tracking-widest mb-2" style={MONO}>PERSONNEL</div>
          <div className="text-xs text-slate-300 space-y-1">
            <div><span className="text-slate-500">Tech departure:</span> {sr.personnel?.techDeparture || '—'}</div>
            <div><span className="text-slate-500">Tech arrival ETA:</span> {sr.personnel?.techArrivalEta || '—'}</div>
            <div><span className="text-slate-500">Transport:</span> {sr.personnel?.transport || '—'}</div>
          </div>
        </div>
        <div className={`${done ? 'bg-slate-800/40 border-slate-700' : 'bg-amber-500/10 border-amber-500/30'} border p-3`}>
          <div className={`text-[10px] tracking-widest mb-2 ${done ? 'text-slate-400' : 'text-amber-400'}`} style={MONO}>
            {done ? 'COMPLETED AT' : 'ESTIMATED RETURN TO SERVICE'}
          </div>
          <div className={`text-lg font-medium ${done ? 'text-slate-300' : 'text-amber-200'}`}>
            {done ? fmtTime(sr.completedAt) : (sr.rtsEstimate || 'TBD')}
          </div>
        </div>
      </div>

      <Section label="CURRENT STATUS">
        <p className="text-sm text-slate-300 whitespace-pre-wrap">{sr.currentStatus || '—'}</p>
      </Section>

      <Section label="OPEN ITEMS">
        {!sr.openItems || sr.openItems.length === 0 ? (
          <p className="text-xs text-slate-500">No open items.</p>
        ) : (
          <ul className="text-xs text-slate-300 list-disc pl-4 space-y-1">
            {sr.openItems.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        )}
      </Section>

      <Section label="NEXT UPDATE DUE">
        <p className="text-sm text-slate-300">{sr.nextUpdateDue || '—'}</p>
      </Section>

      {/* Maintenance Logbook Entries */}
      <Section label={`MAINTENANCE LOGBOOK ENTRIES (${logbook.length})`}>
        {logbook.length === 0 ? (
          <p className="text-xs text-slate-500">No logbook entries yet. Use ADD LOGBOOK ENTRY below to record work performed.</p>
        ) : (
          <div className="space-y-2">
            {logbook.map((e) => (
              <div key={e.id} className="bg-slate-900 border border-slate-800 p-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {e.rtsApproved && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-300 tracking-widest font-medium" style={MONO}>RTS APPROVED</span>
                    )}
                    {e.external && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-300 tracking-widest font-medium" style={MONO}>EXTERNAL — UNVERIFIED</span>
                    )}
                    <span className="text-sm text-slate-200">{e.technicianName || 'Tech'}</span>
                    <span className="text-[10px] text-slate-500">{e.technicianCertType}{e.technicianCertNumber ? `: ${e.technicianCertNumber}` : ''}</span>
                  </div>
                  <span className="text-[10px] text-slate-500" style={MONO}>{fmtTime(e.timestamp)}</span>
                </div>
                <p className="text-xs text-slate-400 whitespace-pre-wrap">{e.workPerformed}</p>
                {e.pdfDownloadUrl && (
                  <a href={e.pdfDownloadUrl} target="_blank" rel="noopener noreferrer"
                    className="text-[10px] text-cyan-400 hover:text-cyan-300 mt-1 inline-flex items-center gap-1">
                    DOWNLOAD PDF
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        {canEdit && !done && (
          <button onClick={() => setAddingLogbook(true)}
            className="mt-3 flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-cyan-500/30 text-cyan-300 text-xs tracking-widest font-medium" style={MONO}>
            <Plus className="w-3 h-3" /> ADD LOGBOOK ENTRY
          </button>
        )}
      </Section>

      {/* Manual References */}
      <Section label={`MANUAL REFERENCES (${refs.length})`}>
        {refs.length === 0 ? (
          <p className="text-xs text-slate-500">No reference documents. Upload OEM bulletins, wiring diagrams, or manual excerpts to share with the vendor.</p>
        ) : (
          <div className="space-y-2">
            {refs.map((d) => (
              <div key={d.id} className="bg-slate-900 border border-slate-800 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-sm text-cyan-400 hover:text-cyan-300 truncate">{d.filename}</a>
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1" style={MONO}>
                      {d.sizeBytes ? `${(d.sizeBytes / 1024).toFixed(0)} KB · ` : ''}
                      uploaded by {d.uploadedBy?.displayName || 'Unknown'}
                      {d.emailedAt ? (
                        <span className="text-green-500"> · sent {fmtTime(d.emailedAt)}{Array.isArray(d.emailedTo) && d.emailedTo.length ? ` to ${d.emailedTo.join(', ')}` : ''}</span>
                      ) : (
                        <span className="text-slate-600"> · not sent</span>
                      )}
                    </div>
                  </div>
                  {canEdit && !done && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => setSendRefPicker({ docIds: [d.id] })} title="Send to vendor" className="p-1.5 text-cyan-400 hover:text-cyan-300 hover:bg-slate-800">
                        <Send className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleRemoveRef(d)} title="Remove" className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-slate-800">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {canEdit && !done && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input ref={refFileInputRef} type="file" accept="application/pdf,.pdf" onChange={handleRefFilePicked} className="hidden" />
            <button onClick={() => refFileInputRef.current && refFileInputRef.current.click()} disabled={uploadingRef}
              className="flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-cyan-500/30 text-cyan-300 text-xs tracking-widest font-medium disabled:opacity-50" style={MONO}>
              {uploadingRef ? <><Loader2 className="w-3 h-3 animate-spin" /> UPLOADING...</> : <><Upload className="w-3 h-3" /> UPLOAD REFERENCE PDF</>}
            </button>
            {refs.length > 1 && (
              <button onClick={() => setSendRefPicker({ docIds: refs.map(d => d.id) })}
                className="flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs tracking-widest font-medium" style={MONO}>
                <Send className="w-3 h-3" /> SEND ALL TO VENDOR
              </button>
            )}
          </div>
        )}
        {refError && <div className="mt-2 text-xs text-amber-400">{refError}</div>}
      </Section>

      {/* External vendor link */}
      {canEdit && (
        <Section label="EXTERNAL VENDOR LINK">
          <p className="text-[11px] text-slate-500 mb-2 leading-relaxed">
            Token-gated portal for an assigned outside maintenance vendor —
            same mechanism as AOG. They can view this request, post status
            updates, request/mark parts, chat, and (if enabled) submit an
            external logbook entry. No Skyway account needed.
          </p>
          <div className="flex gap-2 flex-wrap">
            <button onClick={handleMintLink} disabled={linkBusy || done}
              className="px-3 py-2 text-xs tracking-widest bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-medium flex items-center gap-1" style={MONO}>
              <Link2 className="w-4 h-4" /> {linkBusy ? 'WORKING…' : (sr.linkTokenIssuedAt ? 'RE-MINT LINK' : 'MINT VENDOR LINK')}
            </button>
            {sr.linkTokenIssuedAt && !sr.linkRevoked && (
              <button onClick={handleRevokeLink} disabled={linkBusy}
                className="px-3 py-2 text-xs tracking-widest bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 disabled:opacity-50" style={MONO}>REVOKE</button>
            )}
            <button onClick={handleToggleLogbook} disabled={logbookEnabling}
              className={`px-3 py-2 text-xs tracking-widest border disabled:opacity-50 ${sr.externalLogbookEnabled
                ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                : 'bg-slate-800 text-slate-300 border-slate-700'}`} style={MONO}>
              {logbookEnabling ? 'WORKING…' : (sr.externalLogbookEnabled ? 'EXTERNAL LOGBOOK: ON — TURN OFF' : 'ENABLE EXTERNAL LOGBOOK')}
            </button>
          </div>
          {linkUrl && (
            <div className="mt-2 p-2 bg-slate-950 border border-slate-800">
              <div className="text-[9px] text-slate-600 tracking-widest mb-1" style={MONO}>VENDOR URL — COPY &amp; SEND</div>
              <div className="text-[11px] text-cyan-300 break-all" style={MONO}>{linkUrl}</div>
            </div>
          )}
          {linkMsg && <div className={`mt-2 text-xs ${linkMsg.includes('failed') ? 'text-amber-400' : 'text-green-400'}`}>{linkMsg}</div>}
          {sr.linkRevoked && <div className="mt-2 text-[11px] text-amber-400">Vendor link is currently REVOKED.</div>}
        </Section>
      )}

      {/* Team notification */}
      {canEdit && (
        <Section label="TEAM NOTIFICATION">
          <div className="text-[11px] text-slate-500 mb-2">
            Recipients on file: {Array.isArray(sr.recipients) && sr.recipients.length ? sr.recipients.join(', ') : '(none — edit to add mx/ops/admin emails)'}
          </div>
          <button onClick={handleShareLog} disabled={sending}
            className="px-3 py-2 text-xs tracking-widest bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 disabled:opacity-50 flex items-center gap-1" style={MONO}>
            <Send className="w-4 h-4" /> {sending ? 'WORKING…' : 'LOG / SHARE DETAILS'}
          </button>
          {sendStatus && <div className="mt-2 text-xs text-slate-400">{sendStatus}</div>}
        </Section>
      )}

      {/* Technician Updates */}
      <Section label={`TECHNICIAN UPDATES (${techUpdates.length})`}>
        {techUpdates.length === 0 ? (
          <p className="text-xs text-slate-600">No technician updates yet.</p>
        ) : (
          <div className="space-y-2">
            {[...techUpdates].reverse().map((u, i) => (
              <div key={i} className="text-xs p-2 bg-slate-900 border border-slate-800">
                <div className="text-[9px] text-slate-600 tracking-widest mb-0.5" style={MONO}>
                  {u.author}{u.company ? ` — ${u.company}` : ''} · {fmtTime(u.timestamp)}
                </div>
                <div className="text-slate-300 whitespace-pre-wrap">{u.message}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Vendor tech chat */}
      <ServiceTechChatPanel sr={sr} currentUser={currentUser} reporter={reporter} canEdit={canEdit} />

      {/* Activity log */}
      <Section label="ACTIVITY LOG">
        {(Array.isArray(sr.logEntries) ? [...sr.logEntries].reverse() : []).map((l, i) => (
          <div key={i} className="text-[11px] text-slate-500 border-l border-slate-800 pl-2 py-1 leading-relaxed">
            <span className="text-slate-400">{l.author}</span> · {fmtTime(l.timestamp)}<br />
            {l.message}
          </div>
        ))}
      </Section>

      {editing && (
        <ServiceEditModal sr={sr} currentUser={currentUser} onClose={() => setEditing(false)} />
      )}
      {addingLogbook && (
        <AddServiceLogbookModal sr={sr} currentUser={currentUser} onClose={() => setAddingLogbook(false)} />
      )}
      {sendRefPicker && (
        <SendServiceRefPicker
          sr={sr}
          docIds={sendRefPicker.docIds}
          currentUser={currentUser}
          reporter={reporter}
          onClose={() => setSendRefPicker(null)}
        />
      )}
    </div>
  );
}

/* =========================================================================
   TECH CHAT PANEL (Skyway side — replies to vendor)
   ========================================================================= */
function ServiceTechChatPanel({ sr, currentUser, reporter, canEdit }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const chat = Array.isArray(sr.techChat) ? sr.techChat : [];
  const replies = Array.isArray(sr.skywayChatReplies) ? sr.skywayChatReplies : [];
  // Merge tech + skyway messages chronologically
  const merged = [
    ...chat.map(m => ({ ...m, side: 'tech' })),
    ...replies.map(m => ({ ...m, side: 'skyway' })),
  ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  async function send() {
    const text = msg.trim();
    if (!text) return;
    setBusy(true);
    try {
      const m = await import('./firebase-service.js');
      await m.postSkywayChatReply(sr.id, text, reporter);
      // also stamp lastSkywayReplyAt so the nudge cron knows we replied
      await m.updateServiceRequest(sr.id, { lastSkywayReplyAt: Date.now() });
      setMsg('');
    } catch (e) {
      alert('Send failed: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  if (merged.length === 0 && !canEdit) return null;

  return (
    <Section label="VENDOR TECH CHAT">
      {merged.length === 0 ? (
        <p className="text-[11px] text-slate-600">No messages yet. The vendor can start a chat from their link.</p>
      ) : (
        <div className="space-y-2 mb-3">
          {merged.map((m, i) => (
            <div key={i} className={`text-xs p-2 border ${m.side === 'tech'
              ? 'bg-slate-950 border-slate-800'
              : 'bg-cyan-500/5 border-cyan-500/20 ml-6'}`}>
              <div className="text-[9px] text-slate-600 tracking-widest mb-0.5" style={MONO}>
                {m.side === 'tech' ? `${m.author || 'Vendor'}${m.company ? ` — ${m.company}` : ''}` : `${m.author || 'Skyway'} (Skyway)`}
                {' · '}{fmtTime(m.timestamp)}
              </div>
              <div className="text-slate-300 whitespace-pre-wrap">{m.message}</div>
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="flex gap-2">
          <input
            value={msg}
            onChange={e => setMsg(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Reply to the vendor…"
            className="flex-1 bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none"
          />
          <button onClick={send} disabled={busy || !msg.trim()}
            className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs tracking-widest font-medium" style={MONO}>
            {busy ? '…' : 'SEND'}
          </button>
        </div>
      )}
    </Section>
  );
}

/* =========================================================================
   NEW SERVICE REQUEST MODAL
   ========================================================================= */
function NewServiceModal({ currentUser, fleetTails, onClose, onCreated }) {
  const [tail, setTail] = useState('');
  const [location, setLocation] = useState('');
  const [fboName, setFboName] = useState('');
  const [serviceType, setServiceType] = useState('Scheduled');
  const [requestedDate, setRequestedDate] = useState('');
  const [desc, setDesc] = useState('');
  const [recipients, setRecipients] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const tails = Array.isArray(fleetTails) && fleetTails.length
    ? fleetTails
    : ['N20UF', 'N168ZZ', 'N286N', 'N444AM', 'N651TW', 'N551FP', 'N85AH', 'N525CR'];

  async function submit() {
    if (!tail) { setErr('Select an aircraft.'); return; }
    if (!desc.trim()) { setErr('Describe the service requested.'); return; }
    setBusy(true); setErr('');
    try {
      const m = await import('./firebase-service.js');
      const id = await m.createServiceRequest({
        tail, location, fboName,
        serviceDescription: desc,
        serviceType,
        requestedDate,
        recipients: recipients.split(',').map(s => s.trim()).filter(Boolean),
        requester: {
          uid: currentUser?.uid || currentUser?.id,
          displayName: currentUser?.displayName || currentUser?.name || currentUser?.email || 'Unknown',
        },
      });
      onCreated(id);
    } catch (e) {
      setErr('Failed: ' + e.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 overflow-y-auto p-4">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-lg my-8">
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <h3 className="text-sm tracking-widest text-cyan-300" style={MONO}>NEW SERVICE REQUEST</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>AIRCRAFT *</label>
            <select value={tail} onChange={e => setTail(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1" style={MONO}>
              <option value="">— Select tail —</option>
              {tails.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>LOCATION (ICAO)</label>
              <input value={location} onChange={e => setLocation(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1" />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>FBO / SHOP</label>
              <input value={fboName} onChange={e => setFboName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>SERVICE TYPE</label>
              <select value={serviceType} onChange={e => setServiceType(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1" style={MONO}>
                <option>Scheduled</option>
                <option>Inspection</option>
                <option>Discrepancy</option>
                <option>AD / SB</option>
                <option>Other</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>DESIRED DATE/WINDOW</label>
              <input value={requestedDate} onChange={e => setRequestedDate(e.target.value)}
                placeholder="e.g. week of Jun 2"
                className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1" />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>SERVICE REQUESTED / SQUAWKS *</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={4}
              className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1 resize-none" />
          </div>
          <div>
            <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>TEAM EMAILS (comma-separated)</label>
            <input value={recipients} onChange={e => setRecipients(e.target.value)}
              placeholder="mx@flyskyway.com, ops@flyskyway.com"
              className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1" />
          </div>
          {err && <div className="text-xs text-amber-400">{err}</div>}
        </div>
        <div className="flex gap-2 p-4 border-t border-slate-800">
          <button onClick={submit} disabled={busy}
            className="flex-1 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs tracking-widest font-medium" style={MONO}>
            {busy ? 'CREATING…' : 'CREATE REQUEST'}
          </button>
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs tracking-widest font-medium" style={MONO}>
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   EDIT MODAL
   ========================================================================= */
function ServiceEditModal({ sr, currentUser, onClose }) {
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(sr)));
  const [recipientsText, setRecipientsText] = useState(
    Array.isArray(sr.recipients) ? sr.recipients.join(', ') : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reporter = {
    uid: currentUser?.uid || currentUser?.id,
    displayName: currentUser?.displayName || currentUser?.name || currentUser?.email || 'Unknown',
  };

  function updateField(path, value) {
    setDraft(d => {
      const next = { ...d };
      const keys = path.split('.');
      let cur = next;
      for (let i = 0; i < keys.length - 1; i++) {
        cur[keys[i]] = { ...(cur[keys[i]] || {}) };
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
      return next;
    });
  }
  function updatePart(idx, field, value) {
    setDraft(d => {
      const parts = Array.isArray(d.parts) ? [...d.parts] : [];
      parts[idx] = { ...parts[idx], [field]: value };
      return { ...d, parts };
    });
  }
  function addPart() {
    setDraft(d => ({
      ...d,
      parts: [...(d.parts || []), { partNumber: '', description: '', status: 'Ordered', eta: '', shipMethod: '', trackingNumber: '' }],
    }));
  }
  function removePart(idx) {
    setDraft(d => ({ ...d, parts: (d.parts || []).filter((_, i) => i !== idx) }));
  }
  function updateOpenItem(idx, value) {
    setDraft(d => {
      const items = Array.isArray(d.openItems) ? [...d.openItems] : [];
      items[idx] = value;
      return { ...d, openItems: items };
    });
  }
  function addOpenItem() {
    setDraft(d => ({ ...d, openItems: [...(d.openItems || []), ''] }));
  }
  function removeOpenItem(idx) {
    setDraft(d => ({ ...d, openItems: (d.openItems || []).filter((_, i) => i !== idx) }));
  }

  async function handleSave() {
    setError(''); setSaving(true);
    try {
      const recipients = recipientsText
        .split(/[,;\s]+/).map(e => e.trim())
        .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

      const patch = {
        location: String(draft.location || '').toUpperCase().trim(),
        fboName: draft.fboName || '',
        serviceDescription: draft.serviceDescription || '',
        serviceType: draft.serviceType || 'Scheduled',
        requestedDate: draft.requestedDate || '',
        coordination: draft.coordination || {},
        diagnostics: draft.diagnostics || {},
        parts: (draft.parts || []).filter(p => p.partNumber || p.description),
        shipTo: draft.shipTo || {},
        personnel: draft.personnel || {},
        rtsEstimate: draft.rtsEstimate || '',
        currentStatus: draft.currentStatus || '',
        openItems: (draft.openItems || []).filter(i => i && i.trim()),
        nextUpdateDue: draft.nextUpdateDue || '',
        recipients,
      };

      const rtsChanged = (sr.rtsEstimate || '') !== (draft.rtsEstimate || '') && draft.rtsEstimate;
      if (rtsChanged) patch.rtsEstimatePrevious = sr.rtsEstimate || '';
      const logMsg = rtsChanged
        ? `RTS estimate updated: ${sr.rtsEstimate || 'TBD'} → ${draft.rtsEstimate}`
        : 'Service request details updated';

      const m = await import('./firebase-service.js');
      await m.updateServiceRequest(sr.id, patch, { author: reporter.displayName, message: logMsg });
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur flex items-start justify-center overflow-y-auto px-4 pb-4 pt-4">
      <div className="bg-slate-950 border border-slate-700 max-w-3xl w-full my-8">
        <div className="bg-slate-900 px-5 py-3 flex items-center justify-between border-b border-slate-700 sticky top-0 z-10">
          <h3 className="text-sm tracking-widest text-slate-200" style={MONO}>EDIT SERVICE REQUEST — {sr.tail}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <EditRow label="LOCATION" value={draft.location || ''} set={v => updateField('location', v.toUpperCase())} />
            <EditRow label="FBO / SHOP" value={draft.fboName || ''} set={v => updateField('fboName', v)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>SERVICE TYPE</label>
              <select value={draft.serviceType || 'Scheduled'} onChange={e => updateField('serviceType', e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1" style={MONO}>
                <option>Scheduled</option><option>Inspection</option><option>Discrepancy</option><option>AD / SB</option><option>Other</option>
              </select>
            </div>
            <EditRow label="DESIRED DATE/WINDOW" value={draft.requestedDate || ''} set={v => updateField('requestedDate', v)} />
          </div>

          <EditRow label="SERVICE REQUESTED / SQUAWKS" value={draft.serviceDescription || ''} set={v => updateField('serviceDescription', v)} area />

          <div>
            <div className="text-[10px] text-slate-500 tracking-widest mb-2" style={MONO}>COORDINATION TEAM</div>
            <div className="grid grid-cols-2 gap-3">
              <EditRow label="Maintenance Lead" value={draft.coordination?.maintLead || ''} set={v => updateField('coordination.maintLead', v)} />
              <EditRow label="Technician" value={draft.coordination?.technician || ''} set={v => updateField('coordination.technician', v)} />
              <EditRow label="Vendor / OEM" value={draft.coordination?.vendor || ''} set={v => updateField('coordination.vendor', v)} />
              <EditRow label="Ops Contact" value={draft.coordination?.opsContact || ''} set={v => updateField('coordination.opsContact', v)} />
            </div>
          </div>

          <div>
            <div className="text-[10px] text-slate-500 tracking-widest mb-2" style={MONO}>DIAGNOSTICS</div>
            <div className="space-y-2">
              <EditRow label="Discrepancy" value={draft.diagnostics?.pilotDiscrepancy || ''} set={v => updateField('diagnostics.pilotDiscrepancy', v)} area />
              <EditRow label="Troubleshooting Completed" value={draft.diagnostics?.troubleshooting || ''} set={v => updateField('diagnostics.troubleshooting', v)} area />
              <EditRow label="OEM Recommendation" value={draft.diagnostics?.oemRecommendation || ''} set={v => updateField('diagnostics.oemRecommendation', v)} area />
            </div>
          </div>

          {/* Parts editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] text-slate-500 tracking-widest" style={MONO}>PARTS</div>
              <button onClick={addPart} className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"><Plus className="w-3 h-3" /> Add part</button>
            </div>
            {(draft.parts || []).length === 0 ? (
              <p className="text-xs text-slate-500">No parts yet. Click "Add part" to list one the vendor needs to order.</p>
            ) : (
              <div className="space-y-2">
                {(draft.parts || []).map((p, idx) => (
                  <div key={idx} className="bg-slate-900 border border-slate-800 p-2 space-y-2">
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <input placeholder="Part #" value={p.partNumber || ''} onChange={e => updatePart(idx, 'partNumber', e.target.value)}
                        className="col-span-2 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                      <input placeholder="Description" value={p.description || ''} onChange={e => updatePart(idx, 'description', e.target.value)}
                        className="col-span-3 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                      <select value={p.status || 'Ordered'} onChange={e => updatePart(idx, 'status', e.target.value)}
                        className="col-span-2 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none">
                        <option>Ordered</option><option>In Transit</option><option>Delivered</option><option>Installed</option>
                      </select>
                      <input placeholder="ETA" value={p.eta || ''} onChange={e => updatePart(idx, 'eta', e.target.value)}
                        className="col-span-2 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                      <input placeholder="Ship" value={p.shipMethod || ''} onChange={e => updatePart(idx, 'shipMethod', e.target.value)}
                        className="col-span-2 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                      <button onClick={() => removePart(idx)} className="col-span-1 text-slate-500 hover:text-red-400 flex justify-center"><Trash2 className="w-3 h-3" /></button>
                    </div>
                    <input placeholder="Tracking # (FedEx or UPS)" value={p.trackingNumber || ''} onChange={e => updatePart(idx, 'trackingNumber', e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" style={MONO} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Ship-to */}
          <div>
            <div className="text-[10px] text-slate-500 tracking-widest mb-2" style={MONO}>PARTS SHIPPING ADDRESS</div>
            <div className="space-y-2">
              <EditRow label="FBO/Recipient" value={draft.shipTo?.fboName || ''} set={v => updateField('shipTo.fboName', v)} />
              <EditRow label="Street address" value={draft.shipTo?.address || ''} set={v => updateField('shipTo.address', v)} />
              <EditRow label="ATTN / Hangar" value={draft.shipTo?.attn || ''} set={v => updateField('shipTo.attn', v)} />
            </div>
          </div>

          {/* Personnel */}
          <div>
            <div className="text-[10px] text-slate-500 tracking-widest mb-2" style={MONO}>PERSONNEL LOGISTICS</div>
            <div className="grid grid-cols-2 gap-3">
              <EditRow label="Tech Departure Time" value={draft.personnel?.techDeparture || ''} set={v => updateField('personnel.techDeparture', v)} />
              <EditRow label="Tech Arrival ETA" value={draft.personnel?.techArrivalEta || ''} set={v => updateField('personnel.techArrivalEta', v)} />
            </div>
            <div className="mt-2">
              <EditRow label="Transportation Arranged" value={draft.personnel?.transport || ''} set={v => updateField('personnel.transport', v)} />
            </div>
          </div>

          {/* RTS */}
          <div className="bg-amber-500/5 border border-amber-500/30 p-3">
            <EditRow label="ESTIMATED RETURN TO SERVICE (RTS)" value={draft.rtsEstimate || ''} set={v => updateField('rtsEstimate', v)} />
          </div>

          {/* Current status */}
          <EditRow label="CURRENT STATUS UPDATE" value={draft.currentStatus || ''} set={v => updateField('currentStatus', v)} area />

          {/* Open items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] text-slate-500 tracking-widest" style={MONO}>OPEN ITEMS</div>
              <button onClick={addOpenItem} className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"><Plus className="w-3 h-3" /> Add item</button>
            </div>
            {(draft.openItems || []).length === 0 ? (
              <p className="text-xs text-slate-500">No open items.</p>
            ) : (
              <div className="space-y-1">
                {(draft.openItems || []).map((item, idx) => (
                  <div key={idx} className="flex gap-2 items-center">
                    <input value={item} onChange={e => updateOpenItem(idx, e.target.value)} placeholder="Describe item..."
                      className="flex-1 bg-slate-900 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                    <button onClick={() => removeOpenItem(idx)} className="text-slate-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <EditRow label="NEXT UPDATE EXPECTED" value={draft.nextUpdateDue || ''} set={v => updateField('nextUpdateDue', v)} />

          <div>
            <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>TEAM EMAIL RECIPIENTS (comma-separated)</label>
            <textarea value={recipientsText} onChange={e => setRecipientsText(e.target.value)} rows={2}
              className="w-full mt-1 bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-slate-200 focus:border-cyan-400 outline-none resize-none" />
          </div>

          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-xs p-2">{error}</div>}

          <div className="flex gap-2 pt-3 border-t border-slate-800 sticky bottom-0 bg-slate-950 -mx-5 -mb-5 px-5 pb-5">
            <button onClick={handleSave} disabled={saving}
              className="flex-1 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs tracking-widest font-medium" style={MONO}>
              {saving ? 'SAVING...' : 'SAVE CHANGES'}
            </button>
            <button onClick={onClose} disabled={saving}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs tracking-widest font-medium" style={MONO}>CANCEL</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   small shared bits
   ========================================================================= */
function Section({ label, children }) {
  return (
    <div className="mb-4 border border-slate-800 bg-slate-950">
      <div className="px-3 py-2 border-b border-slate-800 text-[10px] text-slate-500 tracking-widest" style={MONO}>
        {label}
      </div>
      <div className="p-3 space-y-1">{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-slate-600 w-32 shrink-0" style={MONO}>{label}</span>
      <span className="text-slate-300">{value || '—'}</span>
    </div>
  );
}

// Module-level (stable identity) — defining this inside a component caused
// inputs to remount and lose focus after every keystroke.
function EditRow({ label, value, set, area }) {
  return (
    <div>
      <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>{label}</label>
      {area ? (
        <textarea value={value} onChange={e => set(e.target.value)} rows={3}
          className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1 resize-none" />
      ) : (
        <input value={value} onChange={e => set(e.target.value)}
          className="w-full bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mt-1" />
      )}
    </div>
  );
}

/* =========================================================================
   PUBLIC VENDOR PORTAL  (/service-tech?token=...)
   Mirror of ExternalTechPage — calls /api/service-public only. No Skyway
   account, no Firebase, fully sandboxed to one service request via token.
   ========================================================================= */
export function ServiceTechPage({ token }) {
  const [sr, setSr] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('status'); // status | parts | chat

  const load = React.useCallback(async () => {
    setLoading(true); setLoadErr('');
    try {
      const r = await fetch(`/api/service-public?action=get&token=${encodeURIComponent(token)}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSr(data.sr);
    } catch (e) {
      setLoadErr(e.message || 'Could not load');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  // Light polling so Skyway replies appear for the vendor.
  useEffect(() => {
    const iv = setInterval(load, 12000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (loadErr || !sr) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-4" />
          <h1 className="text-lg text-slate-200 mb-2">Link unavailable</h1>
          <p className="text-sm text-slate-400">{loadErr || 'This service link is not valid.'}</p>
          <p className="text-xs text-slate-600 mt-4">Contact Skyway Operations if you believe this is an error.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="max-w-2xl mx-auto p-4 md:p-6">
        <div className="mb-4 pb-4 border-b border-slate-800">
          <div className="text-[10px] tracking-widest text-cyan-400" style={MONO}>SKYWAY AVIATION · SERVICE REQUEST</div>
          <h1 className="text-2xl mt-1" style={SANS}>{sr.tail} — {sr.serviceType || 'Service'}</h1>
          <div className="text-xs text-slate-500 mt-1" style={MONO}>
            {sr.location || '—'}{sr.fboName ? ` · ${sr.fboName}` : ''}{sr.requestedDate ? ` · ${sr.requestedDate}` : ''}
          </div>
        </div>

        <ServiceSection label="SERVICE REQUESTED">
          <p className="text-sm text-slate-300 whitespace-pre-wrap">{sr.serviceDescription || '—'}</p>
        </ServiceSection>
        {(sr.diagnostics?.pilotDiscrepancy || sr.diagnostics?.troubleshooting || sr.diagnostics?.oemRecommendation) && (
          <ServiceSection label="NOTES">
            {sr.diagnostics.pilotDiscrepancy && <p className="text-xs text-slate-400 mb-1">Discrepancy: {sr.diagnostics.pilotDiscrepancy}</p>}
            {sr.diagnostics.troubleshooting && <p className="text-xs text-slate-400 mb-1">Troubleshooting: {sr.diagnostics.troubleshooting}</p>}
            {sr.diagnostics.oemRecommendation && <p className="text-xs text-slate-400">OEM: {sr.diagnostics.oemRecommendation}</p>}
          </ServiceSection>
        )}

        <div className="flex gap-2 my-4">
          {['status', 'parts', 'chat'].map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`text-xs px-3 py-1.5 tracking-widest ${tab === t
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'bg-slate-900 text-slate-500 border border-slate-800'}`} style={MONO}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        {tab === 'status' && <VendorStatusTab sr={sr} token={token} onPosted={load} />}
        {tab === 'parts' && <VendorPartsTab sr={sr} token={token} onPosted={load} />}
        {tab === 'chat' && <VendorChatTab sr={sr} token={token} onPosted={load} />}

        <p className="text-[10px] text-slate-700 mt-6 leading-relaxed">
          Submissions here are coordination records, not official 14 CFR Part
          43/91/135 maintenance entries. Skyway Operations reviews and verifies
          all entries.
        </p>
      </div>
    </div>
  );
}

function ServiceSection({ label, children }) {
  return (
    <div className="mb-3 border border-slate-800 bg-slate-900/40">
      <div className="px-3 py-2 border-b border-slate-800 text-[10px] text-slate-500 tracking-widest" style={MONO}>{label}</div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function VendorStatusTab({ sr, token, onPosted }) {
  const [author, setAuthor] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const updates = Array.isArray(sr.techUpdates) ? sr.techUpdates : [];

  async function post() {
    if (!author.trim() || !message.trim()) { setMsg('Name and update required.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/service-public?action=status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, update: { author, company, message } }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setMessage(''); setMsg('Update sent to Skyway.'); onPosted();
    } catch (e) { setMsg('Failed: ' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      {updates.length > 0 && (
        <div className="space-y-2 mb-3">
          {[...updates].reverse().map((u, i) => (
            <div key={i} className="text-xs p-2 bg-slate-900 border border-slate-800">
              <div className="text-[9px] text-slate-600 tracking-widest mb-0.5" style={MONO}>
                {u.author}{u.company ? ` — ${u.company}` : ''}
              </div>
              <div className="text-slate-300 whitespace-pre-wrap">{u.message}</div>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="Your name *"
          className="bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
        <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Company"
          className="bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
      </div>
      <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} placeholder="Status update for Skyway *"
        className="w-full bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none resize-none mb-2" />
      {msg && <div className={`text-xs mb-2 ${msg.startsWith('Failed') ? 'text-amber-400' : 'text-green-400'}`}>{msg}</div>}
      <button onClick={post} disabled={busy}
        className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs tracking-widest font-medium" style={MONO}>
        {busy ? 'SENDING…' : 'SEND UPDATE'}
      </button>
    </div>
  );
}

function VendorPartsTab({ sr, token, onPosted }) {
  const [busyIdx, setBusyIdx] = useState(-1);
  const [author, setAuthor] = useState('');
  const parts = Array.isArray(sr.parts) ? sr.parts : [];

  async function mark(idx, usage) {
    setBusyIdx(idx);
    try {
      const r = await fetch('/api/service-public?action=part-usage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, partIdx: idx, usage, author }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onPosted();
    } catch (e) { alert('Failed: ' + e.message); }
    finally { setBusyIdx(-1); }
  }

  if (parts.length === 0) return <p className="text-xs text-slate-500">No parts listed for this request.</p>;
  return (
    <div>
      <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="Your name (recorded with part marks)"
        className="w-full bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none mb-3" />
      <div className="space-y-2">
        {parts.map((p, i) => (
          <div key={i} className="p-2 bg-slate-900 border border-slate-800">
            <div className="text-xs text-slate-300" style={MONO}>{p.partNumber || '(no P/N)'} {p.description ? `· ${p.description}` : ''}</div>
            <div className="text-[10px] text-slate-600 mb-2">{p.techUsage ? `Currently: ${p.techUsage.toUpperCase()}` : 'Not marked'}</div>
            <div className="flex gap-2">
              <button onClick={() => mark(i, 'used')} disabled={busyIdx === i}
                className="px-2 py-1 text-[10px] tracking-widest bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 disabled:opacity-50" style={MONO}>USED</button>
              <button onClick={() => mark(i, 'not_used')} disabled={busyIdx === i}
                className="px-2 py-1 text-[10px] tracking-widest bg-slate-800 text-slate-300 border border-slate-700 disabled:opacity-50" style={MONO}>NOT USED</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VendorChatTab({ sr, token, onPosted }) {
  const [author, setAuthor] = useState('');
  const [company, setCompany] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const chat = Array.isArray(sr.techChat) ? sr.techChat : [];
  const replies = Array.isArray(sr.skywayChatReplies) ? sr.skywayChatReplies : [];
  const merged = [
    ...chat.map(m => ({ ...m, side: 'tech' })),
    ...replies.map(m => ({ ...m, side: 'skyway' })),
  ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  async function send() {
    if (!author.trim() || !text.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/service-public?action=chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, message: { author, company, text } }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setText(''); onPosted();
    } catch (e) { alert('Failed: ' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      {merged.length > 0 && (
        <div className="space-y-2 mb-3">
          {merged.map((m, i) => (
            <div key={i} className={`text-xs p-2 border ${m.side === 'tech'
              ? 'bg-slate-900 border-slate-800' : 'bg-cyan-500/5 border-cyan-500/20 ml-6'}`}>
              <div className="text-[9px] text-slate-600 tracking-widest mb-0.5" style={MONO}>
                {m.side === 'tech' ? `${m.author || 'You'}${m.company ? ` — ${m.company}` : ''}` : `${m.author || 'Skyway'} (Skyway)`}
              </div>
              <div className="text-slate-300 whitespace-pre-wrap">{m.message}</div>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="Your name *"
          className="bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
        <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Company"
          className="bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
      </div>
      <div className="flex gap-2">
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Message Skyway…"
          className="flex-1 bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
        <button onClick={send} disabled={busy || !text.trim()}
          className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs tracking-widest font-medium" style={MONO}>
          {busy ? '…' : 'SEND'}
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   SIGNATURE PAD (self-contained — not coupled to App.jsx)
   ========================================================================= */
function SrSignaturePad({ onSave, onCancel }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
  }, []);

  function pos(e) {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) };
  }
  function start(e) { e.preventDefault(); drawing.current = true; last.current = pos(e); }
  function move(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const c = canvasRef.current;
    const ctx = c.getContext('2d');
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  }
  function end() { drawing.current = false; }
  function clear() {
    const c = canvasRef.current;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={520}
        height={160}
        className="w-full bg-white border border-slate-700 touch-none"
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      <div className="flex gap-2 mt-3">
        <button onClick={() => onSave(canvasRef.current.toDataURL('image/png'))}
          className="flex-1 px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs tracking-widest font-medium" style={MONO}>
          USE SIGNATURE
        </button>
        <button onClick={clear} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs tracking-widest" style={MONO}>CLEAR</button>
        <button onClick={onCancel} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs tracking-widest" style={MONO}>CANCEL</button>
      </div>
    </div>
  );
}

/* =========================================================================
   ADD SERVICE LOGBOOK MODAL  (mirror of AddLogbookEntryModal)
   ========================================================================= */
function AddServiceLogbookModal({ sr, currentUser, onClose }) {
  const [workPerformed, setWorkPerformed] = useState('');
  const [inspectionPerformed, setInspectionPerformed] = useState('');
  const [aircraftTotalTime, setAircraftTotalTime] = useState('');
  const [aircraftCycles, setAircraftCycles] = useState('');
  const [srPartsUsed, setSrPartsUsed] = useState(() => {
    const ps = Array.isArray(sr.parts) ? sr.parts : [];
    return ps.map((p, idx) => ({
      sourceIdx: idx,
      partNumber: p.partNumber || '',
      description: p.description || '',
      status: p.status || '',
      used: ['delivered', 'installed'].includes(String(p.status || '').toLowerCase()),
      serialOff: '', serialOn: '',
    }));
  });
  const [extraParts, setExtraParts] = useState([]);
  const [technicianName, setTechnicianName] = useState(currentUser?.name || currentUser?.displayName || '');
  const [technicianCertType, setTechnicianCertType] = useState(currentUser?.certType || 'A&P');
  const [technicianCertNumber, setTechnicianCertNumber] = useState(currentUser?.certNumber || '');
  const [rtsApproved, setRtsApproved] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState(null);
  const [showPad, setShowPad] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  function toggleSrPart(i) { setSrPartsUsed(prev => prev.map((p, x) => x === i ? { ...p, used: !p.used } : p)); }
  function updateSrPart(i, f, v) { setSrPartsUsed(prev => prev.map((p, x) => x === i ? { ...p, [f]: v } : p)); }
  function addExtra() { setExtraParts(prev => [...prev, { partNumber: '', description: '', serialOff: '', serialOn: '' }]); }
  function updExtra(i, f, v) { setExtraParts(prev => prev.map((p, x) => x === i ? { ...p, [f]: v } : p)); }
  function rmExtra(i) { setExtraParts(prev => prev.filter((_, x) => x !== i)); }

  async function handleSubmit() {
    setError('');
    if (!workPerformed.trim()) { setError('Work performed is required'); return; }
    if (!technicianName.trim()) { setError('Technician name is required'); return; }
    if (!technicianCertNumber.trim()) { setError('Certificate number is required'); return; }
    if (!signatureDataUrl) { setError('Signature is required — tap SIGN HERE'); return; }
    if (!acknowledged) { setError('Please acknowledge the certification statement'); return; }
    setSaving(true); setStatus('Saving entry...');
    try {
      const entry = {
        workPerformed: workPerformed.trim(),
        inspectionPerformed: inspectionPerformed.trim(),
        aircraftTotalTime: aircraftTotalTime.trim(),
        aircraftCycles: aircraftCycles.trim(),
        partsReplaced: [
          ...srPartsUsed.filter(p => p.used).map(p => ({
            partNumber: p.partNumber, description: p.description,
            serialOff: p.serialOff, serialOn: p.serialOn, fromOrder: true,
          })),
          ...extraParts.filter(p => p.partNumber || p.description).map(p => ({ ...p, fromOrder: false })),
        ],
        technicianName: technicianName.trim(),
        technicianCertType: technicianCertType.trim(),
        technicianCertNumber: technicianCertNumber.trim(),
        signatureDataUrl,
        rtsApproved,
        signedBy: {
          uid: currentUser?.uid || currentUser?.id,
          displayName: currentUser?.displayName || currentUser?.name || currentUser?.email,
          email: currentUser?.email,
        },
      };
      const m = await import('./firebase-service.js');
      const entryId = await m.addLogbookEntry(sr.id, entry);
      const fullEntry = { ...entry, id: entryId, timestamp: Date.now(), signedAt: Date.now() };

      // Reuse the existing logbook PDF generator via a field adapter — it
      // only reads tail/location/fboName/reportedAt/issueDescription.
      setStatus('Generating PDF...');
      let pdfBase64 = null, pdfFilename = null;
      try {
        const pdfMod = await import('./aog-logbook-pdf.js');
        const adapter = {
          ...sr,
          reportedAt: sr.requestedAt,
          issueDescription: sr.serviceDescription,
        };
        const { blob, base64, filename } = await pdfMod.generateLogbookEntryPdf(adapter, fullEntry);
        pdfBase64 = base64; pdfFilename = filename;
        setStatus('Storing record...');
        const { getStorage, ref, uploadBytes, getDownloadURL } = await import('firebase/storage');
        const storage = getStorage();
        const path = `service-logbook/${sr.id}/${filename}`;
        const fileRef = ref(storage, path);
        await uploadBytes(fileRef, blob, { contentType: 'application/pdf' });
        const url = await getDownloadURL(fileRef);
        await m.updateLogbookEntryPdf(sr.id, entryId, url, path);
      } catch (pdfErr) {
        console.warn('[service-logbook] PDF/storage step failed (non-fatal):', pdfErr);
      }

      setStatus('Sending email...');
      try {
        const { auth } = await import('./firebase.js');
        let idToken = null;
        if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
        if (pdfBase64) {
          await fetch('/api/send-service-references', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sr: { id: sr.id, tail: sr.tail, location: sr.location, fboName: sr.fboName,
                    serviceDescription: sr.serviceDescription },
              docs: [{ id: entryId, filename: pdfFilename, url: '' }],
              recipients: Array.isArray(sr.recipients) ? sr.recipients : [],
              note: `Logbook entry by ${technicianName} (${technicianCertType} ${technicianCertNumber}). RTS: ${rtsApproved ? 'YES' : 'no'}.`,
              inlinePdfBase64: pdfBase64,
              inlinePdfFilename: pdfFilename,
              idToken,
            }),
          }).catch(e => console.warn('logbook email failed (non-fatal):', e));
        }
        setStatus('Saved.');
      } catch (emailErr) {
        console.warn('[service-logbook] email failed (non-fatal):', emailErr);
        setStatus('Saved (email skipped).');
      }
      setTimeout(() => onClose(), 1200);
    } catch (err) {
      setError(err.message || 'Save failed');
      setSaving(false);
    }
  }

  if (showPad) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-950/95 flex items-center justify-center p-4">
        <div className="bg-slate-950 border border-cyan-500/40 max-w-lg w-full p-5">
          <h3 className="text-sm tracking-widest text-cyan-300 mb-2" style={MONO}>SIGNATURE</h3>
          <p className="text-xs text-slate-400 mb-3">Sign below using finger, stylus, or mouse.</p>
          <SrSignaturePad
            onSave={(d) => { setSignatureDataUrl(d); setShowPad(false); }}
            onCancel={() => setShowPad(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur flex items-start justify-center overflow-y-auto px-4 pb-4 pt-4">
      <div className="bg-slate-950 border border-cyan-500/40 max-w-3xl w-full my-8">
        <div className="bg-cyan-500/10 px-5 py-3 flex items-center justify-between border-b border-cyan-500/30 sticky top-0 z-10">
          <h3 className="text-sm tracking-widest text-cyan-300" style={MONO}>
            ADD MAINTENANCE LOGBOOK ENTRY — {sr.tail}
          </h3>
          <button onClick={onClose} disabled={saving} className="text-cyan-300 hover:text-white disabled:opacity-50"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-5">
          <div className="bg-slate-900 border border-slate-800 p-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-slate-500">Aircraft:</span> <span className="text-slate-200 font-medium">{sr.tail}</span></div>
              <div><span className="text-slate-500">Location:</span> <span className="text-slate-200">{sr.location}{sr.fboName ? ' / ' + sr.fboName : ''}</span></div>
              <div className="col-span-2"><span className="text-slate-500">Service:</span> <span className="text-slate-300">{sr.serviceDescription || '—'}</span></div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>AIRCRAFT TOTAL TIME (HRS)</label>
              <input value={aircraftTotalTime} onChange={e => setAircraftTotalTime(e.target.value)} placeholder="e.g. 4,238.6"
                className="w-full mt-1 bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>AIRCRAFT CYCLES</label>
              <input value={aircraftCycles} onChange={e => setAircraftCycles(e.target.value)} placeholder="e.g. 3,021"
                className="w-full mt-1 bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
            </div>
          </div>

          <div>
            <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>WORK PERFORMED *</label>
            <textarea value={workPerformed} onChange={e => setWorkPerformed(e.target.value)} rows={5}
              placeholder="Describe the work performed: corrective action, components touched, manual references, run-up/leak check results, etc."
              className="w-full mt-1 bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none resize-none" />
          </div>

          <div>
            <div className="text-[10px] text-slate-500 tracking-widest mb-2" style={MONO}>PARTS REPLACED</div>
            {srPartsUsed.length > 0 && (
              <div className="space-y-1.5 mb-3">
                <p className="text-[10px] text-slate-500 italic">From this service request. Toggle off any part ordered but not used.</p>
                {srPartsUsed.map((p, idx) => (
                  <div key={idx} className={`border ${p.used ? 'border-cyan-500/30 bg-cyan-500/5' : 'border-slate-800 bg-slate-900'}`}>
                    <label className="flex items-center gap-3 p-2 cursor-pointer">
                      <input type="checkbox" checked={p.used} onChange={() => toggleSrPart(idx)} className="w-4 h-4 accent-cyan-500 shrink-0" />
                      <div className="flex-1 flex items-center gap-3 min-w-0">
                        <span className={`text-xs ${p.used ? 'text-slate-200' : 'text-slate-500 line-through'} truncate`} style={MONO}>{p.partNumber || '—'}</span>
                        <span className={`text-xs ${p.used ? 'text-slate-300' : 'text-slate-600'} truncate`}>{p.description || '(no description)'}</span>
                      </div>
                    </label>
                    {p.used && (
                      <div className="px-2 pb-2 pt-1 border-t border-cyan-500/20 grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>S/N OFF</label>
                          <input value={p.serialOff} onChange={e => updateSrPart(idx, 'serialOff', e.target.value)} placeholder="Serial removed"
                            className="w-full mt-0.5 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" style={MONO} />
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>S/N ON</label>
                          <input value={p.serialOn} onChange={e => updateSrPart(idx, 'serialOn', e.target.value)} placeholder="Serial installed"
                            className="w-full mt-0.5 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" style={MONO} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] text-slate-500 tracking-widest" style={MONO}>
                {srPartsUsed.length > 0 ? 'OTHER PARTS USED' : 'PARTS USED'}
              </div>
              <button onClick={addExtra} className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"><Plus className="w-3 h-3" /> Add part</button>
            </div>
            {extraParts.length === 0 ? (
              srPartsUsed.length === 0 ? <p className="text-xs text-slate-500">No parts replaced. Click "Add part" if a part was used.</p> : null
            ) : (
              <div className="space-y-2">
                {extraParts.map((p, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center bg-slate-900 border border-slate-800 p-2">
                    <input placeholder="Part #" value={p.partNumber} onChange={e => updExtra(idx, 'partNumber', e.target.value)} className="col-span-3 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                    <input placeholder="Description" value={p.description} onChange={e => updExtra(idx, 'description', e.target.value)} className="col-span-4 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                    <input placeholder="S/N OFF" value={p.serialOff} onChange={e => updExtra(idx, 'serialOff', e.target.value)} className="col-span-2 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                    <input placeholder="S/N ON" value={p.serialOn} onChange={e => updExtra(idx, 'serialOn', e.target.value)} className="col-span-2 bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:border-cyan-400 outline-none" />
                    <button onClick={() => rmExtra(idx)} className="col-span-1 text-slate-500 hover:text-red-400 flex justify-center"><Trash2 className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>INSPECTION PERFORMED (if applicable)</label>
            <textarea value={inspectionPerformed} onChange={e => setInspectionPerformed(e.target.value)} rows={2}
              placeholder="e.g. Operational check satisfactory. Engine run-up, normal indications."
              className="w-full mt-1 bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none resize-none" />
          </div>

          <div>
            <div className="text-[10px] text-slate-500 tracking-widest mb-2" style={MONO}>TECHNICIAN</div>
            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-6">
                <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>NAME *</label>
                <input value={technicianName} onChange={e => setTechnicianName(e.target.value)}
                  className="w-full mt-1 bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
              </div>
              <div className="col-span-3">
                <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>CERT TYPE *</label>
                <select value={technicianCertType} onChange={e => setTechnicianCertType(e.target.value)}
                  className="w-full mt-1 bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-400 outline-none">
                  <option>A&P</option><option>IA</option><option>A&P/IA</option><option>Repairman</option><option>Other</option>
                </select>
              </div>
              <div className="col-span-3">
                <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>CERT # *</label>
                <input value={technicianCertNumber} onChange={e => setTechnicianCertNumber(e.target.value)} placeholder="e.g. 3458291"
                  className="w-full mt-1 bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-400 outline-none" style={MONO} />
              </div>
            </div>
          </div>

          <div className="border border-slate-700 bg-slate-900 p-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={rtsApproved} onChange={e => setRtsApproved(e.target.checked)} className="mt-1 w-4 h-4 accent-green-500" />
              <div>
                <div className="text-sm font-medium text-slate-200">APPROVE FOR RETURN TO SERVICE</div>
                <div className="text-xs text-slate-400 mt-1 leading-relaxed">By checking this box, you certify per 14 CFR § 43.9(a)(4):</div>
                <div className="text-xs text-slate-300 italic mt-2 leading-relaxed">"I certify that this aircraft has been inspected/repaired and is approved for return to service with respect to the work performed."</div>
              </div>
            </label>
          </div>

          <div>
            <div className="text-[10px] text-slate-500 tracking-widest mb-2" style={MONO}>SIGNATURE *</div>
            {signatureDataUrl ? (
              <div className="bg-white border border-slate-700 p-2 inline-block">
                <img src={signatureDataUrl} alt="Signature" style={{ height: '60px' }} />
                <div className="mt-2 flex gap-2">
                  <button onClick={() => setShowPad(true)} className="text-[10px] text-cyan-400 hover:text-cyan-300">Re-sign</button>
                  <button onClick={() => setSignatureDataUrl(null)} className="text-[10px] text-red-400 hover:text-red-300">Clear</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowPad(true)}
                className="px-4 py-3 border-2 border-dashed border-slate-700 hover:border-cyan-500/50 text-slate-400 hover:text-cyan-300 text-xs tracking-widest" style={MONO}>
                SIGN HERE
              </button>
            )}
          </div>

          <div className="bg-amber-500/5 border border-amber-500/30 p-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} className="mt-1 w-4 h-4 accent-amber-500" />
              <div className="text-xs text-amber-200 leading-relaxed">
                I acknowledge this entry is an attestation of the work I performed. I confirm my technician name and
                certificate number above are accurate. I understand this record is retained in Skyway Aviation's
                maintenance coordination system and that the official Part 43/91/135 record is made in Skyway's
                primary maintenance tracking system per OpSpecs.
              </div>
            </label>
          </div>

          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-xs p-2">{error}</div>}
          {status && !error && (
            <div className="bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs p-2 flex items-center gap-2">
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}{status}
            </div>
          )}

          <div className="flex gap-2 pt-3 border-t border-slate-800">
            <button onClick={handleSubmit} disabled={saving}
              className="flex-1 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs tracking-widest font-medium" style={MONO}>
              {saving ? 'PROCESSING...' : 'SUBMIT ENTRY'}
            </button>
            <button onClick={onClose} disabled={saving}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs tracking-widest font-medium" style={MONO}>CANCEL</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   SEND SERVICE REFERENCE PICKER  (mirror of SendReferencePickerModal)
   ========================================================================= */
function SendServiceRefPicker({ sr, docIds, currentUser, reporter, onClose }) {
  const allDocs = (Array.isArray(sr.referenceDocs) ? sr.referenceDocs : [])
    .filter(d => docIds.includes(d.id));
  const [recipients, setRecipients] = useState(
    Array.isArray(sr.recipients) ? sr.recipients.join(', ') : ''
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function send() {
    const recips = recipients.split(',').map(s => s.trim()).filter(Boolean);
    if (recips.length === 0) { setMsg('Add at least one recipient email.'); return; }
    if (allDocs.length === 0) { setMsg('No documents selected.'); return; }
    setBusy(true); setMsg('');
    try {
      const { auth } = await import('./firebase.js');
      let idToken = null;
      if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/send-service-references', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sr: { id: sr.id, tail: sr.tail, location: sr.location, fboName: sr.fboName,
                serviceDescription: sr.serviceDescription },
          docs: allDocs.map(d => ({ id: d.id, filename: d.filename, url: d.url })),
          recipients: recips,
          note,
          idToken,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const m = await import('./firebase-service.js');
      await m.markReferenceEmailed(sr.id, allDocs.map(d => d.id), recips, reporter);
      setMsg(`Sent to ${recips.join(', ')}`);
      setTimeout(() => onClose(), 1400);
    } catch (e) {
      setMsg('Send failed: ' + e.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 overflow-y-auto p-4">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-lg my-8">
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <h3 className="text-sm tracking-widest text-cyan-300" style={MONO}>SEND REFERENCES TO VENDOR</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <div className="text-[10px] text-slate-500 tracking-widest mb-1" style={MONO}>DOCUMENTS ({allDocs.length})</div>
            <div className="space-y-1">
              {allDocs.map(d => (
                <div key={d.id} className="text-xs text-slate-300 flex items-center gap-2">
                  <FileText className="w-3 h-3 text-slate-500" /> {d.filename}
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>RECIPIENTS (comma-separated) *</label>
            <input value={recipients} onChange={e => setRecipients(e.target.value)}
              placeholder="tech@vendor.com, shop@vendor.com"
              className="w-full mt-1 bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none" />
          </div>
          <div>
            <label className="text-[10px] text-slate-500 tracking-widest" style={MONO}>NOTE TO VENDOR (optional)</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
              className="w-full mt-1 bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:border-cyan-400 outline-none resize-none" />
          </div>
          <div className="text-[10px] text-slate-600 leading-relaxed">
            These are coordination/reference copies — NOT official 14 CFR Part 43/91/135 maintenance records.
          </div>
          {msg && <div className={`text-xs ${msg.startsWith('Sent') ? 'text-green-400' : 'text-amber-400'}`}>{msg}</div>}
        </div>
        <div className="flex gap-2 p-4 border-t border-slate-800">
          <button onClick={send} disabled={busy}
            className="flex-1 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs tracking-widest font-medium" style={MONO}>
            {busy ? 'SENDING…' : 'SEND'}
          </button>
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs tracking-widest font-medium" style={MONO}>CANCEL</button>
        </div>
      </div>
    </div>
  );
}
