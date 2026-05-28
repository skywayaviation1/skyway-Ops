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
  Search, CheckCircle2, Clock, XCircle,
} from 'lucide-react';

const DOC_TYPES = [
  { id: 'certificate',     label: 'Airman Certificate', icon: ShieldCheck,  hasExpiration: false },
  { id: 'medical',         label: 'Medical',            icon: Stethoscope,  hasExpiration: true  },
  { id: 'passport',        label: 'Passport',           icon: Plane,        hasExpiration: true  },
  { id: 'drivers_license', label: "Driver's License",   icon: Contact,      hasExpiration: true  },
];

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
                  <div className="border-t border-slate-800 p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
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
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
