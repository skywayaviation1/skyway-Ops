// PilotDocs.jsx — crew personal document vault.
//
// Two exported views:
//   <PilotDocsTab currentUser />        crew member sees/manages their OWN docs
//   <AllCrewDocs currentUser users />   admin/ops see ALL crew docs on one screen
//
// Doc types: FAA airman certificate, medical, passport, driver's license.
// On upload we send the file to /api/parse-pilot-doc for AI field extraction,
// then store the actual file in Firebase Storage so a real copy persists.
//
// Styling matches the rest of the app: dark slate + cyan, Bebas Neue display,
// JetBrains Mono labels, DM Sans body.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText, Loader2, Trash2, Download, Upload, AlertTriangle,
  ChevronDown, ChevronRight, ShieldCheck, Plane, Contact, Stethoscope,
  Search, CheckCircle2, Clock, XCircle, Briefcase, Archive,
} from 'lucide-react';

// The four "primary" pilot doc types — these are the structured ones with
// AI-parsed fields (expiration date, document number, etc.) shown as a
// fixed grid in the UI. Each crew member has ONE current of each.
const DOC_TYPES = [
  { id: 'certificate',     label: 'Airman Certificate', icon: ShieldCheck,  hasExpiration: false },
  { id: 'medical',         label: 'Medical',            icon: Stethoscope,  hasExpiration: true  },
  { id: 'passport',        label: 'Passport',           icon: Plane,        hasExpiration: true  },
  { id: 'drivers_license', label: "Driver's License",   icon: Contact,      hasExpiration: true  },
];

// Free-form "employment" docs: W-4, I-9, contract, direct deposit form,
// company acknowledgements, training records, anything else related to
// employment at Skyway. Unlike DOC_TYPES, these are NOT a fixed list —
// crew uploads as many as they want, each with their own name and
// optional notes. Stored in the same `pilot-docs` collection with
// docType='employment', so existing storage rules + admin visibility
// + bulk download all work uniformly.
const EMPLOYMENT_DOC_TYPE_ID = 'employment';

function typeMeta(id) {
  return DOC_TYPES.find((d) => d.id === id) || { id, label: id, icon: FileText, hasExpiration: false };
}

// --- image compression (shared approach with expenses upload) -------------
async function compressIfImage(file, maxEdge = 2048, quality = 0.85) {
  if (!file || !(file.type || '').startsWith('image/')) return file;
  if (file.size < 500 * 1024) return file;
  try {
    let bitmap;
    if (typeof createImageBitmap === 'function') {
      try { bitmap = await createImageBitmap(file); } catch (_) {}
    }
    if (!bitmap) {
      const url = URL.createObjectURL(file);
      bitmap = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('decode failed'));
        i.src = url;
      }).finally(() => URL.revokeObjectURL(url));
    }
    const sw = bitmap.width || bitmap.naturalWidth;
    const sh = bitmap.height || bitmap.naturalHeight;
    if (!sw || !sh) return file;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
    const canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, dw, dh);
    ctx.drawImage(bitmap, 0, 0, dw, dh);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    const name = (file.name || 'doc').replace(/\.[^.]+$/, '') + '.jpg';
    try { return new File([blob], name, { type: 'image/jpeg' }); }
    catch (_) { blob.name = name; return blob; }
  } catch (e) {
    console.warn('[pilot-docs] compress failed:', e);
    return file;
  }
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// --- expiration badge -----------------------------------------------------
function expState(d, now = Date.now()) {
  const meta = typeMeta(d.docType);
  if (!meta.hasExpiration || !d.expiration) return { state: 'none', days: null };
  const exp = Date.parse(d.expiration + 'T23:59:59');
  if (Number.isNaN(exp)) return { state: 'none', days: null };
  const days = Math.floor((exp - now) / 86400000);
  if (days < 0) return { state: 'expired', days };
  if (days <= 60) return { state: 'soon', days };
  return { state: 'ok', days };
}

function ExpBadge({ d }) {
  const { state, days } = expState(d);
  if (state === 'none') {
    if (d.docType === 'certificate') {
      return <span className="text-[10px] text-slate-500 tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>NO EXPIRY</span>;
    }
    return null;
  }
  const map = {
    ok:      { cls: 'text-emerald-400', Icon: CheckCircle2, txt: `${days}d left` },
    soon:    { cls: 'text-amber-400',   Icon: Clock,        txt: `${days}d left` },
    expired: { cls: 'text-red-400',     Icon: XCircle,      txt: `expired ${Math.abs(days)}d ago` },
  }[state];
  const { cls, Icon, txt } = map;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] tracking-wider ${cls}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <Icon className="w-3 h-3" /> {txt.toUpperCase()}
    </span>
  );
}

// ==========================================================================
// CREW: own documents
// ==========================================================================
export function PilotDocsTab({ currentUser }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadType, setUploadType] = useState(null); // which type's uploader is active
  const [stage, setStage] = useState(null);            // 'compressing'|'uploading'|'parsing'
  const [err, setErr] = useState('');

  const uid = currentUser?.uid || currentUser?.id;

  useEffect(() => {
    if (!uid) return;
    let unsub = null, cancelled = false;
    (async () => {
      const m = await import('./firebase-pilotdocs.js');
      if (cancelled) return;
      unsub = m.subscribeToUserPilotDocs(uid, (list) => { setDocs(list); setLoading(false); });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [uid]);

  // Most recent doc per type (people typically keep one current cert/medical)
  const byType = useMemo(() => {
    const out = {};
    for (const d of docs) {
      if (!out[d.docType] || (d.uploadedAt || 0) > (out[d.docType].uploadedAt || 0)) {
        out[d.docType] = d;
      }
    }
    return out;
  }, [docs]);

  const handleUpload = async (file, docType) => {
    setErr('');
    if (!file || !uid) return;
    try {
      setStage('compressing');
      const isPdf = file.type === 'application/pdf' || (file.name || '').toLowerCase().endsWith('.pdf');
      const prepared = isPdf ? file : await compressIfImage(file);

      const m = await import('./firebase-pilotdocs.js');
      const storage = await import('./firebase-storage.js');
      const id = m.newPilotDocId();

      setStage('uploading');
      const [up, b64] = await Promise.all([
        storage.uploadPilotDoc(prepared, uid, docType),
        fileToBase64(prepared),
      ]);

      // Base record (file copy persisted even if parse fails)
      const base = {
        id, uid,
        ownerName: currentUser?.name || currentUser?.displayName || 'Unknown',
        ownerEmail: currentUser?.email || '',
        docType,
        fileUrl: up.url, filePath: up.path, fileContentType: up.contentType,
        fileName: up.name, fileKind: up.kind, fileSizeBytes: up.sizeBytes,
        uploadedBy: uid,
        notes: 'Parsing document with AI...',
      };
      await m.savePilotDoc(base);

      // Parse
      setStage('parsing');
      let idToken = null;
      try {
        const { auth } = await import('./firebase.js');
        if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
      } catch (_) {}

      const body = isPdf
        ? { idToken, docType, pdfBase64: b64 }
        : { idToken, docType, imageBase64: b64, mediaType: up.contentType || 'image/jpeg' };

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 60000);
      let resp, data;
      try {
        resp = await fetch('/api/parse-pilot-doc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        data = await resp.json();
      } catch (fe) {
        clearTimeout(t);
        await m.savePilotDoc({ ...base, notes: fe.name === 'AbortError'
          ? 'AI parse timed out — file saved, enter fields manually.'
          : 'AI parse unreachable — file saved, enter fields manually.' });
        setUploadType(null); setStage(null);
        return;
      }
      clearTimeout(t);
      if (!resp.ok) {
        await m.savePilotDoc({ ...base, notes: `AI parse failed: ${data?.error || 'unknown'} — file saved, enter manually.` });
        setUploadType(null); setStage(null);
        return;
      }
      const p = data.parsed || {};
      await m.savePilotDoc({
        ...base,
        holderName: p.holderName || base.ownerName,
        documentNumber: p.documentNumber || '',
        issuingAuthority: p.issuingAuthority || '',
        issueDate: p.issueDate || '',
        expiration: p.expiration || '',
        dob: p.dob || '',
        certType: p.certType || '',
        ratings: p.ratings || '',
        medicalClass: p.medicalClass || '',
        confidence: p.confidence || '',
        notes: p.notes || '',
        parsedAt: Date.now(), parsedBy: 'claude-vision',
      });
      setUploadType(null); setStage(null);
    } catch (e) {
      console.error('[pilot-docs] upload failed:', e);
      setErr(e.message || 'Upload failed');
      setStage(null);
    }
  };

  const handleDelete = async (d) => {
    if (!window.confirm(`Delete your ${typeMeta(d.docType).label}? This removes the stored copy.`)) return;
    try {
      const m = await import('./firebase-pilotdocs.js');
      const storage = await import('./firebase-storage.js');
      if (d.filePath) await storage.deletePilotDoc(d.filePath);
      await m.deletePilotDocRecord(d.id);
    } catch (e) {
      window.alert('Could not delete — try again.');
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>MY PILOT DOCS</h2>
        <p className="text-xs text-slate-500 mt-1">
          Upload your certificate, medical, passport, and license. AI reads the key fields; the actual file is stored so you and ops always have a copy.
        </p>
      </div>

      {err && (
        <div className="p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">{err}</div>
      )}

      {loading ? (
        <div className="p-8 text-center text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading documents...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {DOC_TYPES.map((t) => {
            const d = byType[t.id];
            const Icon = t.icon;
            const busy = stage && uploadType === t.id;
            return (
              <div key={t.id} className="border border-slate-700 bg-slate-900/40 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-cyan-300" />
                    <span className="text-sm tracking-wider text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      {t.label.toUpperCase()}
                    </span>
                  </div>
                  {d && <ExpBadge d={d} />}
                </div>

                {busy ? (
                  <div className="flex items-center gap-2 text-xs text-cyan-200 py-4">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {stage === 'compressing' && 'Preparing…'}
                    {stage === 'uploading' && 'Uploading…'}
                    {stage === 'parsing' && 'AI reading document…'}
                  </div>
                ) : d ? (
                  <div className="space-y-2">
                    {/* Parsed fields summary */}
                    <div className="text-xs text-slate-300 space-y-0.5">
                      {d.holderName && <div><span className="text-slate-500">Name:</span> {d.holderName}</div>}
                      {d.certType && <div><span className="text-slate-500">Level:</span> {d.certType}</div>}
                      {d.medicalClass && <div><span className="text-slate-500">Class:</span> {d.medicalClass}</div>}
                      {d.documentNumber && <div><span className="text-slate-500">No:</span> {d.documentNumber}</div>}
                      {d.issuingAuthority && <div><span className="text-slate-500">Issuer:</span> {d.issuingAuthority}</div>}
                      {d.expiration && <div><span className="text-slate-500">Expires:</span> {d.expiration}</div>}
                      {d.ratings && <div className="text-slate-400">{d.ratings}</div>}
                    </div>
                    {d.notes && /manually|failed|timed out|unreachable/i.test(d.notes) && (
                      <div className="text-[11px] text-amber-400 flex items-start gap-1">
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {d.notes}
                      </div>
                    )}
                    <div className="flex items-center gap-2 pt-1">
                      <a
                        href={d.fileUrl} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-[11px] tracking-wider"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        <Download className="w-3 h-3" /> VIEW COPY
                      </a>
                      <label className="inline-flex items-center gap-1 px-2 py-1 border border-slate-600 text-slate-300 hover:bg-slate-800 text-[11px] tracking-wider cursor-pointer" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        <Upload className="w-3 h-3" /> REPLACE
                        <input type="file" accept="image/*,application/pdf" className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) { setUploadType(t.id); handleUpload(f, t.id); } e.target.value=''; }} />
                      </label>
                      <button
                        onClick={() => handleDelete(d)}
                        className="inline-flex items-center gap-1 px-2 py-1 border border-red-700/40 text-red-400 hover:bg-red-500/10 text-[11px] tracking-wider"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        <Trash2 className="w-3 h-3" /> DELETE
                      </button>
                    </div>
                  </div>
                ) : (
                  <label className="block border border-dashed border-slate-700 hover:border-cyan-500/50 p-6 text-center cursor-pointer">
                    <Upload className="w-5 h-5 text-slate-600 mx-auto mb-1" />
                    <span className="text-xs text-slate-500">Tap to upload {t.label}</span>
                    <input type="file" accept="image/*,application/pdf" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) { setUploadType(t.id); handleUpload(f, t.id); } e.target.value=''; }} />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-slate-600 mt-2">
        FAA airman certificates don't expire. Medicals, passports, and licenses show a countdown — amber within 60 days, red once expired.
      </p>

      {/* EMPLOYMENT DOCS — free-form section for W-4, I-9, contract,
          direct deposit form, training records, anything else related
          to employment at Skyway. Each is named by the crew member;
          no AI parsing, no fixed list.
          Reuses the same `pilot-docs` Firestore collection + storage
          path (just docType='employment'), so admin visibility and
          storage rules already cover it. */}
      <EmploymentDocsSection
        currentUser={currentUser}
        docs={docs.filter(d => d.docType === EMPLOYMENT_DOC_TYPE_ID)}
        onError={setErr}
      />
    </div>
  );
}

// Renders the free-form employment-docs section under the standard
// pilot-docs grid. Self-contained: handles its own upload form state,
// reads its doc list from the parent's already-subscribed `docs` array
// (filtered to docType='employment'), shares the parent's error state.
function EmploymentDocsSection({ currentUser, docs, onError }) {
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingName, setPendingName] = useState('');
  const [pendingNotes, setPendingNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState('');
  const fileInputRef = useRef(null);

  const uid = currentUser?.uid || currentUser?.id;

  const onPick = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setPendingFile(f);
    const dot = f.name.lastIndexOf('.');
    setPendingName(dot > 0 ? f.name.slice(0, dot) : f.name);
    setPendingNotes('');
    onError('');
  };

  const reset = () => {
    setPendingFile(null);
    setPendingName('');
    setPendingNotes('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const doUpload = async () => {
    if (!pendingFile || !pendingName.trim() || !uid) return;
    setUploading(true);
    onError('');
    try {
      const isPdf = pendingFile.type === 'application/pdf'
        || (pendingFile.name || '').toLowerCase().endsWith('.pdf');
      setUploadStage('Preparing...');
      const prepared = isPdf ? pendingFile : await compressIfImage(pendingFile);

      const m = await import('./firebase-pilotdocs.js');
      const storage = await import('./firebase-storage.js');
      const id = m.newPilotDocId();

      setUploadStage('Uploading...');
      const up = await storage.uploadPilotDoc(prepared, uid, EMPLOYMENT_DOC_TYPE_ID);

      // Save metadata. We reuse the existing pilot-doc schema but
      // skip the AI parse step — employment docs don't have
      // structured fields like expiration or document number that
      // would benefit from extraction. The user-entered name goes in
      // `holderName` (displayed prominently) and notes in `notes`.
      setUploadStage('Saving...');
      await m.savePilotDoc({
        id, uid,
        ownerName: currentUser?.name || currentUser?.displayName || 'Unknown',
        ownerEmail: currentUser?.email || '',
        docType: EMPLOYMENT_DOC_TYPE_ID,
        fileUrl: up.url, filePath: up.path, fileContentType: up.contentType,
        fileName: up.name, fileKind: up.kind, fileSizeBytes: up.sizeBytes,
        // Re-purpose holderName as the user-entered display name.
        // Cleaner than adding a new field — existing admin views
        // already show holderName.
        holderName: pendingName.trim(),
        // Free-form description goes in notes.
        notes: pendingNotes.trim(),
        uploadedBy: uid,
      });

      reset();
      setUploadStage('');
    } catch (e) {
      const msg = e?.message || 'Upload failed';
      if (msg.includes('storage/unauthorized') || msg.includes('permission')) {
        onError(
          'Permission denied. Storage rules need updating — ask Jake to '
          + 'publish the latest storage.rules.'
        );
      } else {
        onError(msg);
      }
      setUploadStage('');
    } finally {
      setUploading(false);
    }
  };

  const doDelete = async (d) => {
    if (!window.confirm(`Delete "${d.holderName || d.fileName}"? This cannot be undone.`)) return;
    try {
      const m = await import('./firebase-pilotdocs.js');
      const storage = await import('./firebase-storage.js');
      if (d.filePath) await storage.deletePilotDoc(d.filePath);
      await m.deletePilotDocRecord(d.id);
    } catch (e) {
      window.alert('Could not delete — try again.');
    }
  };

  const fmtSize = (b) => {
    if (!b) return '';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  };
  const fmtDate = (ms) => {
    if (!ms) return '';
    try { return new Date(ms).toLocaleDateString(); }
    catch { return ''; }
  };

  // Sort newest first
  const sorted = [...docs].sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));

  return (
    <div className="mt-6 border-t border-slate-800 pt-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-lg tracking-wider text-slate-100 flex items-center gap-2"
            style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            <Briefcase className="w-4 h-4 text-cyan-300" />
            EMPLOYMENT DOCUMENTS
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            W-4, I-9, contract, training records, signed acknowledgements —
            anything else related to your employment at Skyway.
          </p>
        </div>
        {!pendingFile && (
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 cursor-pointer text-[11px] tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <Upload className="w-3 h-3" /> + UPLOAD DOC
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
              className="hidden"
              onChange={onPick}
              disabled={uploading}
            />
          </label>
        )}
      </div>

      {/* Staging form — name + notes before commit */}
      {pendingFile && (
        <div className="border border-cyan-500/40 bg-cyan-500/5 p-3 space-y-2">
          <div className="text-[10px] tracking-widest text-cyan-300"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            NEW EMPLOYMENT DOCUMENT
          </div>
          <div className="text-[11px] text-slate-400 truncate"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {pendingFile.name} · {fmtSize(pendingFile.size)}
          </div>
          <label className="block">
            <span className="text-[10px] tracking-widest text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DOCUMENT NAME *
            </span>
            <input
              type="text"
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value)}
              placeholder='e.g. "W-4 (2026)" or "Employment Agreement"'
              disabled={uploading}
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              NOTES (OPTIONAL)
            </span>
            <textarea
              value={pendingNotes}
              onChange={(e) => setPendingNotes(e.target.value)}
              placeholder='Any notes about this document...'
              rows={2}
              disabled={uploading}
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            />
          </label>
          <div className="flex gap-2 pt-1">
            <button
              onClick={doUpload}
              disabled={uploading || !pendingName.trim()}
              className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              {uploading ? (uploadStage || 'UPLOADING...') : 'UPLOAD'}
            </button>
            <button
              onClick={reset}
              disabled={uploading}
              className="px-4 py-2 border border-slate-700 text-slate-300 text-sm"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* Existing employment docs list */}
      {sorted.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 border border-dashed border-slate-800 px-3 text-center"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          No employment documents yet. Tap UPLOAD DOC to add your first.
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((d) => (
            <div key={d.id}
              className="border border-slate-700 bg-slate-900/40 p-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <a href={d.fileUrl} target="_blank" rel="noreferrer"
                  className="text-sm text-cyan-300 hover:text-cyan-200 truncate block"
                  style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                  {d.holderName || d.fileName || 'Untitled'}
                </a>
                {d.notes && (
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {d.notes}
                  </div>
                )}
                <div className="text-[10px] text-slate-500 mt-0.5"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {fmtDate(d.uploadedAt)}
                  {d.fileSizeBytes ? ` · ${fmtSize(d.fileSizeBytes)}` : ''}
                  {d.fileContentType ? ` · ${d.fileContentType}` : ''}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <a href={d.fileUrl} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-[10px] tracking-widest"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <Download className="w-3 h-3" /> OPEN
                </a>
                <button onClick={() => doDelete(d)}
                  className="inline-flex items-center gap-1 px-2 py-1 border border-red-700/40 text-red-400 hover:bg-red-500/10 text-[10px] tracking-widest"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <Trash2 className="w-3 h-3" /> DELETE
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==========================================================================
// ADMIN / OPS: all crew docs on one screen
// ==========================================================================
export function AllCrewDocs({ currentUser, users = [] }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({}); // uid -> bool

  useEffect(() => {
    let unsub = null, cancelled = false;
    (async () => {
      const m = await import('./firebase-pilotdocs.js');
      if (cancelled) return;
      unsub = m.subscribeToAllPilotDocs((list) => { setDocs(list); setLoading(false); });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  // Group docs by owner uid. Merge in known crew (from users) so people with
  // zero docs still show as "nothing uploaded yet".
  const groups = useMemo(() => {
    const map = new Map();
    // Seed with crew/pilot users so gaps are visible
    for (const u of users) {
      const role = u.role || '';
      if (!['crew', 'admin', 'ops', 'sales'].includes(role)) continue;
      const uid = u.uid || u.id;
      if (!uid) continue;
      map.set(uid, { uid, name: u.name || u.email || uid, email: u.email || '', role, docs: [] });
    }
    for (const d of docs) {
      if (!map.has(d.uid)) {
        map.set(d.uid, { uid: d.uid, name: d.ownerName || d.uid, email: d.ownerEmail || '', role: '', docs: [] });
      }
      map.get(d.uid).docs.push(d);
    }
    let arr = Array.from(map.values());
    const q = search.trim().toLowerCase();
    if (q) arr = arr.filter((g) => g.name.toLowerCase().includes(q) || (g.email || '').toLowerCase().includes(q));
    // People with docs first, then alphabetical
    arr.sort((a, b) => (b.docs.length - a.docs.length) || a.name.localeCompare(b.name));
    return arr;
  }, [docs, users, search]);

  // Most-recent doc per type for a crew member
  const latestByType = (list) => {
    const out = {};
    for (const d of list) {
      if (!out[d.docType] || (d.uploadedAt || 0) > (out[d.docType].uploadedAt || 0)) out[d.docType] = d;
    }
    return out;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>ALL CREW DOCS</h2>
          <p className="text-xs text-slate-500 mt-1">Every crew member's documents in one place. Tap to expand, download copies as needed.</p>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search crew…"
            className="bg-slate-800 border border-slate-700 pl-8 pr-3 py-1.5 text-sm text-slate-100 w-48"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          />
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…</div>
      ) : groups.length === 0 ? (
        <div className="border border-dashed border-slate-700 p-12 text-center text-sm text-slate-500">No crew found.</div>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => {
            const latest = latestByType(g.docs);
            const isOpen = expanded[g.uid];
            // Count any expiring/expired docs for the header warning dot
            const flags = g.docs.map((d) => expState(d).state).filter((s) => s === 'soon' || s === 'expired');
            const hasExpired = g.docs.some((d) => expState(d).state === 'expired');
            return (
              <div key={g.uid} className="border border-slate-700 bg-slate-900/40">
                <button
                  onClick={() => setExpanded((p) => ({ ...p, [g.uid]: !p[g.uid] }))}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/40"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {isOpen ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
                    <div className="text-left min-w-0">
                      <div className="text-sm text-slate-100 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>{g.name}</div>
                      {g.role && <div className="text-[10px] text-slate-500 tracking-widest uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{g.role}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {/* doc-type presence dots */}
                    <div className="hidden sm:flex items-center gap-1">
                      {DOC_TYPES.map((t) => {
                        const has = !!latest[t.id];
                        return (
                          <span key={t.id} title={`${t.label}: ${has ? 'on file' : 'missing'}`}
                            className={`w-2 h-2 rounded-full ${has ? 'bg-emerald-500' : 'bg-slate-700'}`} />
                        );
                      })}
                    </div>
                    <span className="text-[11px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {g.docs.length} DOC{g.docs.length === 1 ? '' : 'S'}
                    </span>
                    {flags.length > 0 && (
                      <span className={`w-2 h-2 rounded-full ${hasExpired ? 'bg-red-500' : 'bg-amber-400'}`} title={hasExpired ? 'Has expired docs' : 'Has docs expiring soon'} />
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-slate-800 p-3 space-y-3">
                    {/* Bulk-download button — ZIPs all of this crew
                        member's files in the browser. Loads JSZip from
                        CDN on demand. */}
                    <BulkDownloadButton
                      crewUid={g.uid}
                      crewName={g.name}
                      docs={g.docs}
                    />
                    {/* Primary docs grid (cert/medical/passport/license) */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {DOC_TYPES.map((t) => {
                        const d = latest[t.id];
                        const Icon = t.icon;
                        return (
                          <div key={t.id} className="border border-slate-800 p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <Icon className="w-3.5 h-3.5 text-cyan-300" />
                                <span className="text-[11px] tracking-wider text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{t.label.toUpperCase()}</span>
                              </div>
                              {d && <ExpBadge d={d} />}
                            </div>
                            {d ? (
                              <div className="space-y-1.5">
                                <div className="text-[11px] text-slate-400 space-y-0.5">
                                  {d.documentNumber && <div>No: {d.documentNumber}</div>}
                                  {d.certType && <div>Level: {d.certType}</div>}
                                  {d.medicalClass && <div>Class: {d.medicalClass}</div>}
                                  {d.expiration && <div>Expires: {d.expiration}</div>}
                                </div>
                                <a href={d.fileUrl} target="_blank" rel="noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-[10px] tracking-wider"
                                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                  <Download className="w-3 h-3" /> DOWNLOAD
                                </a>
                              </div>
                            ) : (
                              <div className="text-[11px] text-slate-600 italic">Not uploaded</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {/* Employment docs (free-form) — only show if any exist */}
                    {g.docs.some(d => d.docType === EMPLOYMENT_DOC_TYPE_ID) && (
                      <div className="border border-slate-800 p-3 space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Briefcase className="w-3.5 h-3.5 text-cyan-300" />
                          <span className="text-[11px] tracking-wider text-slate-200"
                            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                            EMPLOYMENT DOCUMENTS · {g.docs.filter(d => d.docType === EMPLOYMENT_DOC_TYPE_ID).length}
                          </span>
                        </div>
                        <div className="space-y-1.5">
                          {g.docs
                            .filter(d => d.docType === EMPLOYMENT_DOC_TYPE_ID)
                            .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
                            .map(d => (
                              <div key={d.id} className="flex items-start justify-between gap-2 border-b border-slate-800/50 pb-1.5 last:border-0">
                                <div className="min-w-0 flex-1">
                                  <a href={d.fileUrl} target="_blank" rel="noreferrer"
                                    className="text-[12px] text-cyan-300 hover:text-cyan-200 truncate block"
                                    style={{ fontFamily: 'DM Sans, sans-serif' }}>
                                    {d.holderName || d.fileName || 'Untitled'}
                                  </a>
                                  {d.notes && (
                                    <div className="text-[10px] text-slate-500 truncate">{d.notes}</div>
                                  )}
                                  <div className="text-[9px] text-slate-600"
                                    style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                    {d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString() : ''}
                                  </div>
                                </div>
                                <a href={d.fileUrl} target="_blank" rel="noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-0.5 border border-slate-700 text-slate-300 hover:border-cyan-400 hover:text-cyan-300 text-[9px] tracking-widest shrink-0"
                                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                  OPEN
                                </a>
                              </div>
                            ))
                          }
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// BULK DOWNLOAD BUTTON — ZIPs all of one crew member's docs
// ============================================================
//
// Used inside AllCrewDocs (admin/ops view). Given an expanded crew
// member, downloads every one of their pilot-docs files (across all
// doc types — certificate, medical, passport, license, employment),
// bundles them in a ZIP with one folder per category, and triggers
// a single browser download.
//
// IMPLEMENTATION NOTES:
//   - JSZip is loaded from a CDN on first click (no npm dep to add).
//     Cached on window.JSZip for subsequent invocations.
//   - Reads file URLs from the docs array we already have from
//     Firestore — no extra Firestore reads.
//   - Fetches each file's blob via the stored fileUrl. These URLs
//     are signed download tokens that work as long as the user has
//     read access to the underlying storage object. For admins,
//     Firestore rules already grant read access to all pilot-docs,
//     so this works.
//
// SECURITY NOTE: If you ever revoke an admin's access, any pre-loaded
// fileUrls in their browser still work until the download tokens
// expire. This is a Firebase Storage signed-URL behavior, not
// something this code controls.

function BulkDownloadButton({ crewUid, crewName, docs }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');

  // Skip if no docs to download
  if (!docs || docs.length === 0) return null;

  // Load JSZip from CDN on demand. Caches on window so repeated
  // calls don't re-fetch.
  const loadJSZip = () => {
    if (typeof window === 'undefined') return Promise.reject(new Error('Not in browser'));
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-jszip-loader]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.JSZip));
        existing.addEventListener('error', () => reject(new Error('JSZip script failed')));
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.setAttribute('data-jszip-loader', '1');
      s.onload = () => {
        if (window.JSZip) resolve(window.JSZip);
        else reject(new Error('JSZip loaded but window.JSZip is undefined'));
      };
      s.onerror = () => reject(new Error('Failed to load JSZip from CDN'));
      document.head.appendChild(s);
    });
  };

  const handleDownload = async () => {
    setBusy(true);
    setErr('');
    setProgress('Loading ZIP library...');
    try {
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      const safeName = String(crewName || crewUid || 'crew')
        .replace(/[^a-zA-Z0-9 ._-]/g, '_').trim() || 'crew';
      const root = zip.folder(safeName);

      // Iterate docs, group by docType for folder structure
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        const dispName = d.holderName || d.fileName || `doc-${i + 1}`;
        setProgress(`Downloading ${i + 1} / ${docs.length}: ${dispName}...`);
        if (!d.fileUrl) {
          // Skip metadata-only docs (no storage object). Add a
          // small marker so admin sees what happened.
          const folder = root.folder(d.docType || 'misc');
          folder.file(`MISSING_${dispName}.txt`, 'No file URL — skipped.');
          continue;
        }
        try {
          const resp = await fetch(d.fileUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          // Build a friendly filename — combine the user's display
          // name with the original file extension if present.
          const extMatch = (d.fileName || '').match(/\.[a-zA-Z0-9]+$/);
          const ext = extMatch ? extMatch[0] : '';
          const baseName = dispName.replace(/[^a-zA-Z0-9 ._-]/g, '_').slice(0, 80);
          const finalName = baseName.endsWith(ext) ? baseName : `${baseName}${ext}`;
          const folder = root.folder(d.docType || 'misc');
          folder.file(finalName, blob);
        } catch (fetchErr) {
          console.warn(`[bulk-download] skipped ${dispName}:`, fetchErr?.message);
          const folder = root.folder(d.docType || 'misc');
          folder.file(
            `ERROR_${dispName}.txt`,
            `Failed to download: ${fetchErr?.message || 'unknown error'}`
          );
        }
      }

      setProgress('Building ZIP file...');
      const blob = await zip.generateAsync({ type: 'blob' }, (m) => {
        setProgress(`Building ZIP: ${Math.round(m.percent)}%`);
      });

      // Trigger download
      setProgress('Triggering download...');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName} - skyway docs.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setProgress('');
    } catch (e) {
      setErr(e?.message || 'Failed to build ZIP');
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border border-slate-700 bg-slate-900/40 px-3 py-2">
      <div className="min-w-0">
        <div className="text-[11px] tracking-widest text-slate-300"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <Archive className="w-3 h-3 inline mr-1" />
          DOWNLOAD ALL · {docs.length} FILE{docs.length === 1 ? '' : 'S'}
        </div>
        {busy && progress && (
          <div className="text-[10px] text-cyan-300 mt-0.5"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {progress}
          </div>
        )}
        {err && (
          <div className="text-[10px] text-red-300 mt-0.5"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {err}
          </div>
        )}
      </div>
      <button
        onClick={handleDownload}
        disabled={busy}
        className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[11px] tracking-widest font-medium disabled:opacity-40 shrink-0"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        {busy ? 'WORKING...' : 'DOWNLOAD ZIP'}
      </button>
    </div>
  );
}
