// PilotDocs.jsx — crew personal document vault, v2.
//
// Two exported views:
//   <PilotDocsTab currentUser />        crew member sees/manages their OWN docs
//   <AllCrewDocs currentUser users />   admin/ops see ALL crew docs on one screen
//
// WHAT'S NEW IN V2:
// - Multiple files per doc type (front/back/supplementary). Most-recent
//   parsed values drive the card; older values fall through for fields the
//   newer scan missed.
// - Beautiful card visualizations per doc type — Skyway-themed renderings
//   mimicking the layout of real FAA cert, medical, passport, driver's
//   license cards. Original photos/PDFs stored separately and downloadable.
// - FAA-compliant medical expiration calculation per 14 CFR 61.23(d):
//   class + age at exam determines validity period. Three privilege levels
//   shown (ATP, Commercial, Private) so pilots see which expires first.
// - DOB sourced from passport or DL parse (whichever is on file). If
//   neither is uploaded, medical card shows a hint to upload one for
//   accurate expiration.
// - Bulk download (admin) includes ALL original files with unique
//   filenames so front/back/etc. don't collide.
// - Free-form employment documents section (W-4, I-9, contracts, etc.)
//
// Doc types: FAA airman certificate, medical, passport, driver's license,
//            employment (free-form).
// On structured-doc upload we send the file to /api/parse-pilot-doc for AI
// field extraction. Employment docs skip parsing.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText, Loader2, Trash2, Download, Upload, AlertTriangle,
  ChevronDown, ChevronRight, ShieldCheck, Plane, Contact, Stethoscope,
  Search, CheckCircle2, Clock, XCircle, Briefcase, Archive,
  Camera, Award, Globe, CalendarDays, User, Info,
} from 'lucide-react';

// ============================================================================
// CONSTANTS
// ============================================================================

const DOC_TYPES = [
  { id: 'certificate',     label: 'Airman Certificate', icon: ShieldCheck,  hasExpiration: false },
  { id: 'medical',         label: 'Medical',            icon: Stethoscope,  hasExpiration: true  },
  { id: 'passport',        label: 'Passport',           icon: Plane,        hasExpiration: true  },
  { id: 'drivers_license', label: "Driver's License",   icon: Contact,      hasExpiration: true  },
];

// Free-form bucket. Stored in the same `pilot-docs` collection with this
// docType so it shares storage rules, admin visibility, bulk-download
// inclusion, and PII access control with the structured docs.
const EMPLOYMENT_DOC_TYPE_ID = 'employment';

function typeMeta(id) {
  return DOC_TYPES.find((d) => d.id === id) || { id, label: id, icon: FileText, hasExpiration: false };
}

// ============================================================================
// FAA MEDICAL EXPIRATION (14 CFR 61.23(d))
// ============================================================================
// Medical certificate validity depends on:
//   - Class (1st / 2nd / 3rd)
//   - Pilot's age at time of examination
//   - Intended privileges (ATP / Commercial / Private)
//
// Rules (simplified — these are the validity periods used in 14 CFR 61.23):
//
//   FIRST-CLASS:
//     ATP duties:         12 calendar months if <40 at exam, 6 months if 40+
//     Commercial duties:  12 calendar months (any age)
//     Private duties:     60 calendar months if <40, 24 if 40+
//
//   SECOND-CLASS:
//     Commercial duties:  12 calendar months (any age)
//     Private duties:     60 calendar months if <40, 24 if 40+
//
//   THIRD-CLASS:
//     Private duties:     60 calendar months if <40 at exam, 24 if 40+
//
// "Calendar months" means the certificate expires on the LAST DAY of the
// month, N months after the month of examination. E.g. issued April 15
// 2025, class 1, commercial = expires April 30 2026.
//
// Skyway is Part 135 — pilots fly with commercial (or ATP) privileges in
// practice. The card highlights the COMMERCIAL date as the operationally
// relevant one. ATP and Private dates are shown for reference.

function parseISODate(s) {
  if (!s || typeof s !== 'string') return null;
  // Accept YYYY-MM-DD (the format the parser returns)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function ageAtDate(dob, atDate) {
  if (!dob || !atDate) return null;
  let age = atDate.getFullYear() - dob.getFullYear();
  const m = atDate.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && atDate.getDate() < dob.getDate())) age--;
  return age;
}

// Returns the last day of the calendar month that is `months` months
// after `from`. E.g. expAfterMonths(April 15 2025, 12) -> April 30 2026.
function expAfterMonths(from, months) {
  return new Date(from.getFullYear(), from.getMonth() + months + 1, 0);
}

// Returns array of expirations per privilege level, or null if inputs
// are insufficient.
//
// Each entry: { privilege, months, expires (Date), expiresISO, ageAtExam, note }
function calculateMedicalExpirations({ medicalClass, issueDate, dob }) {
  if (!medicalClass || !issueDate) return null;
  const issued = parseISODate(issueDate);
  if (!issued) return null;

  const birth = dob ? parseISODate(dob) : null;
  const age = birth ? ageAtDate(birth, issued) : null;

  const cls = String(medicalClass);
  const out = [];

  const push = (privilege, months) => {
    const exp = expAfterMonths(issued, months);
    out.push({
      privilege,
      months,
      expires: exp,
      expiresISO: exp.toISOString().slice(0, 10),
      ageAtExam: age,
      // Note for display when age affects the calculation
      ageAffected: age != null && (months === 6 || months === 24),
    });
  };

  if (cls === '1') {
    // First-class
    push('ATP', age != null && age >= 40 ? 6 : 12);
    push('Commercial', 12);
    push('Private', age != null && age >= 40 ? 24 : 60);
  } else if (cls === '2') {
    push('Commercial', 12);
    push('Private', age != null && age >= 40 ? 24 : 60);
  } else if (cls === '3') {
    push('Private', age != null && age >= 40 ? 24 : 60);
  }
  return out.length > 0 ? out : null;
}

// Pull a DOB from any doc that has one (passport > DL > medical record).
// Used to compute medical expirations.
function findUserDob(allDocs) {
  if (!allDocs?.length) return null;
  const passport = allDocs.find((d) => d.docType === 'passport' && d.dob);
  if (passport) return passport.dob;
  const dl = allDocs.find((d) => d.docType === 'drivers_license' && d.dob);
  if (dl) return dl.dob;
  return allDocs.find((d) => d.dob)?.dob || null;
}

// ============================================================================
// IMAGE COMPRESSION + BASE64 (unchanged from v1)
// ============================================================================

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

function formatLongDate(s) {
  const d = parseISODate(s);
  if (!d) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

// Merges fields across multiple records of the same docType. Newer
// non-empty values win, but empty values do NOT clobber older non-empty
// values. This way a back-side upload (with mostly empty fields) doesn't
// erase the front-side's parsed data.
function mergeDocData(docs) {
  if (!docs?.length) return null;
  const sorted = [...docs].sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
  const merged = {};
  for (const d of sorted) {
    for (const [k, v] of Object.entries(d)) {
      if (v !== null && v !== undefined && v !== '') merged[k] = v;
    }
  }
  // Preserve "primary record" reference for things like the canonical fileUrl
  merged.__primary = sorted[sorted.length - 1];
  return merged;
}

// ============================================================================
// EXPIRATION BADGE
// ============================================================================

// For non-medical docs: derives state from d.expiration directly.
// For medical: derives state from computed COMMERCIAL expiration (the
// operationally relevant date for Skyway 135 pilots).
function expState(d, allDocs = [], now = Date.now()) {
  if (!d) return { state: 'none', days: null };
  const meta = typeMeta(d.docType);

  if (d.docType === 'medical') {
    const dob = findUserDob(allDocs);
    const exps = calculateMedicalExpirations({
      medicalClass: d.medicalClass, issueDate: d.issueDate, dob,
    });
    const commercial = exps?.find((x) => x.privilege === 'Commercial')
      || exps?.find((x) => x.privilege === 'ATP')
      || exps?.[0];
    if (!commercial) return { state: 'unknown', days: null };
    const days = Math.floor((commercial.expires.getTime() - now) / 86400000);
    if (days < 0) return { state: 'expired', days };
    if (days <= 60) return { state: 'soon', days };
    return { state: 'ok', days };
  }

  if (!meta.hasExpiration || !d.expiration) return { state: 'none', days: null };
  const exp = Date.parse(d.expiration + 'T23:59:59');
  if (Number.isNaN(exp)) return { state: 'none', days: null };
  const days = Math.floor((exp - now) / 86400000);
  if (days < 0) return { state: 'expired', days };
  if (days <= 60) return { state: 'soon', days };
  return { state: 'ok', days };
}

function ExpBadge({ d, allDocs }) {
  const { state, days } = expState(d, allDocs);
  if (state === 'none') {
    if (d.docType === 'certificate') {
      return <span className="text-[10px] text-slate-500 tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>NO EXPIRY</span>;
    }
    return null;
  }
  if (state === 'unknown') {
    return <span className="text-[10px] text-slate-500 tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>UNKNOWN</span>;
  }
  const cls = state === 'expired'
    ? 'bg-red-500/15 text-red-300 border-red-500/40'
    : state === 'soon'
      ? 'bg-amber-500/15 text-amber-200 border-amber-500/40'
      : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  const label = state === 'expired'
    ? `EXPIRED ${Math.abs(days)}d`
    : `${days}d LEFT`;
  return (
    <span className={`px-1.5 py-0.5 border text-[10px] tracking-wider ${cls}`}
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {label}
    </span>
  );
}

// ============================================================================
// CARD VISUALIZATIONS
// ============================================================================
// Each docType has its own card layout that mirrors the real document's
// structure with Skyway dark/cyan styling. Cards render parsed data; the
// actual file copy is shown below in the files list.

// --- AIRMAN CERTIFICATE -----------------------------------------------------
// Layout mirrors an FAA airman certificate: name, certificate type
// (ATP/Commercial/Private), certificate number, issue date, ratings.
// FAA certs don't expire.
function AirmanCertificateCard({ data, owner }) {
  const name = (data?.holderName || owner?.name || owner?.displayName || '').toUpperCase();
  const certNo = data?.documentNumber || '';
  const certType = data?.certType || '';
  const ratings = data?.ratings || '';
  const issued = data?.issueDate;
  const issuingAuth = data?.issuingAuthority || 'FEDERAL AVIATION ADMINISTRATION';

  return (
    <div className="relative overflow-hidden border border-cyan-500/30 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950"
      style={{ aspectRatio: '1.6' }}>
      {/* Topographic backdrop */}
      <svg className="absolute inset-0 w-full h-full opacity-[0.05] pointer-events-none" viewBox="0 0 400 250" preserveAspectRatio="xMidYMid slice">
        {Array.from({ length: 8 }).map((_, i) => (
          <ellipse key={i} cx={200} cy={125} rx={50 + i * 30} ry={20 + i * 12} fill="none" stroke="cyan" strokeWidth="0.3" />
        ))}
      </svg>
      <div className="relative h-full p-5 flex flex-col">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[8px] tracking-[0.3em] text-cyan-300/70" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {issuingAuth.toUpperCase()}
            </div>
            <div className="text-[8px] tracking-[0.3em] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              UNITED STATES OF AMERICA
            </div>
          </div>
          {/* Aviator wings */}
          <svg className="w-12 h-7 text-cyan-400" viewBox="0 0 80 30" fill="currentColor">
            <path d="M 40 5 L 38 12 L 30 15 L 5 20 L 8 21 L 30 19 L 36 16 L 39 16 L 40 25 L 41 16 L 44 16 L 50 19 L 72 21 L 75 20 L 50 15 L 42 12 Z" />
            <circle cx="40" cy="14" r="3" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        </div>

        <div className="mt-1 text-[22px] leading-none tracking-[0.18em] text-slate-100"
          style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
          AIRMAN CERTIFICATE
        </div>
        <div className="h-px bg-gradient-to-r from-cyan-500/50 via-cyan-500/15 to-transparent mt-2 mb-3" />

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 flex-1">
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>NAME</div>
            <div className="text-sm text-slate-100 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {name || <span className="text-slate-600 italic font-normal">— not parsed —</span>}
            </div>
          </div>
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CERTIFICATE TYPE</div>
            <div className="text-sm text-cyan-300 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {certType || <span className="text-slate-600 italic font-normal">—</span>}
            </div>
          </div>
          <div className="col-span-2">
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CERTIFICATE NUMBER</div>
            <div className="text-base text-slate-200 tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {certNo || <span className="text-slate-600 italic">—</span>}
            </div>
          </div>
          {ratings && (
            <div className="col-span-2">
              <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>RATINGS / LIMITATIONS</div>
              <div className="text-[11px] text-slate-300 leading-snug" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                {ratings}
              </div>
            </div>
          )}
        </div>

        <div className="pt-2 mt-auto border-t border-slate-800 flex items-end justify-between">
          <div className="text-[8px] text-slate-600 tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            ISSUED {issued ? formatLongDate(issued).toUpperCase() : '—'}
          </div>
          <div className="text-[8px] text-cyan-500/40 tracking-[0.3em]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            14 CFR 61 · DOES NOT EXPIRE
          </div>
        </div>
      </div>
    </div>
  );
}

// --- MEDICAL CERTIFICATE ----------------------------------------------------
// Mirrors an FAA medical certificate. Crucially shows the FAA-computed
// expirations per privilege level (ATP/Commercial/Private), not just
// whatever the AI parsed (most medicals don't have an expiration printed).
function MedicalCertificateCard({ data, owner, allDocs }) {
  const name = (data?.holderName || owner?.name || owner?.displayName || '').toUpperCase();
  const cls = data?.medicalClass || '';
  const issued = data?.issueDate;
  const dob = findUserDob(allDocs);
  const expirations = useMemo(
    () => calculateMedicalExpirations({ medicalClass: cls, issueDate: issued, dob }),
    [cls, issued, dob]
  );
  const age = dob && issued ? ageAtDate(parseISODate(dob), parseISODate(issued)) : null;
  const limitations = data?.ratings || '';

  const classLabel = ({
    '1': 'FIRST-CLASS',
    '2': 'SECOND-CLASS',
    '3': 'THIRD-CLASS',
  })[String(cls)] || '—';

  return (
    <div className="relative overflow-hidden border border-amber-500/30 bg-gradient-to-br from-amber-950/30 via-slate-950 to-slate-900"
      style={{ aspectRatio: '1.6' }}>
      <div className="relative h-full p-5 flex flex-col">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[8px] tracking-[0.3em] text-amber-200/70" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              FEDERAL AVIATION ADMINISTRATION
            </div>
            <div className="text-[8px] tracking-[0.3em] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              AVIATION MEDICAL EXAMINER
            </div>
          </div>
          {/* Medical cross */}
          <svg className="w-8 h-8 text-amber-400" viewBox="0 0 32 32" fill="currentColor">
            <rect x="13" y="6" width="6" height="20" rx="1" />
            <rect x="6" y="13" width="20" height="6" rx="1" />
          </svg>
        </div>

        <div className="mt-1 text-[20px] leading-none tracking-[0.18em] text-slate-100"
          style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
          MEDICAL CERTIFICATE
        </div>
        <div className="mt-1 inline-block self-start px-2 py-0.5 bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[10px] tracking-[0.2em]"
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          {classLabel}
        </div>
        <div className="h-px bg-gradient-to-r from-amber-500/40 via-amber-500/10 to-transparent mt-2 mb-3" />

        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>NAME</div>
            <div className="text-sm text-slate-100 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {name || <span className="text-slate-600 italic font-normal">— not parsed —</span>}
            </div>
          </div>
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DATE OF EXAMINATION</div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {issued ? formatLongDate(issued) : <span className="text-slate-600 italic font-normal">—</span>}
            </div>
          </div>
        </div>

        {/* FAA-computed expirations table */}
        <div className="mt-3 flex-1">
          <div className="text-[8px] tracking-[0.2em] text-slate-500 mb-1.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            EXPIRATION BY PRIVILEGE · 14 CFR 61.23(d)
          </div>
          {expirations && expirations.length > 0 ? (
            <div className="space-y-0.5">
              {expirations.map((e) => {
                const isOps = e.privilege === 'Commercial' || e.privilege === 'ATP';
                const daysLeft = Math.floor((e.expires.getTime() - Date.now()) / 86400000);
                const status = daysLeft < 0 ? 'expired' : daysLeft <= 60 ? 'soon' : 'ok';
                const statusColor = status === 'expired' ? 'text-red-300'
                  : status === 'soon' ? 'text-amber-200' : 'text-emerald-300';
                return (
                  <div key={e.privilege} className={`flex items-center justify-between text-[11px] ${isOps ? 'text-slate-100' : 'text-slate-400'}`}
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    <span className={`tracking-wider ${isOps ? 'font-semibold' : ''}`}>
                      {e.privilege.toUpperCase()}
                      {e.ageAffected && age != null ? ` (age ${age})` : ''}
                    </span>
                    <span className={statusColor}>
                      {formatLongDate(e.expiresISO).toUpperCase()}
                      <span className="text-slate-600 ml-2">{daysLeft < 0 ? `−${Math.abs(daysLeft)}d` : `${daysLeft}d`}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : !cls || !issued ? (
            <div className="text-[11px] text-slate-500 italic" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              Need class + issue date to compute expirations.
            </div>
          ) : !dob ? (
            <div className="text-[11px] text-amber-300/80" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <Info className="w-3 h-3 inline mr-1 -mt-0.5" />
              Upload passport or driver's license for accurate expiration.
              Using under-40 estimates.
            </div>
          ) : (
            <div className="text-[11px] text-slate-500 italic" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              No expirations could be computed.
            </div>
          )}
        </div>

        {limitations && (
          <div className="mt-2 pt-2 border-t border-amber-500/10">
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>LIMITATIONS</div>
            <div className="text-[11px] text-slate-300 leading-snug" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {limitations}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- PASSPORT ---------------------------------------------------------------
// Mirrors a passport biographical data page with parsed fields.
function PassportCard({ data, owner }) {
  const name = (data?.holderName || owner?.name || owner?.displayName || '').toUpperCase();
  const passportNo = data?.documentNumber || '';
  const country = data?.issuingAuthority || 'USA';
  const dob = data?.dob;
  const issued = data?.issueDate;
  const expires = data?.expiration;

  return (
    <div className="relative overflow-hidden border border-blue-500/30 bg-gradient-to-br from-blue-950 via-slate-950 to-slate-900"
      style={{ aspectRatio: '1.6' }}>
      {/* Globe pattern */}
      <svg className="absolute inset-0 w-full h-full opacity-[0.04] pointer-events-none" viewBox="0 0 400 250" preserveAspectRatio="xMidYMid slice">
        <circle cx={320} cy={50} r={60} fill="none" stroke="white" strokeWidth="0.5" />
        <ellipse cx={320} cy={50} rx={60} ry={20} fill="none" stroke="white" strokeWidth="0.5" />
        <ellipse cx={320} cy={50} rx={60} ry={40} fill="none" stroke="white" strokeWidth="0.5" />
        <line x1={320} y1={-10} x2={320} y2={110} stroke="white" strokeWidth="0.5" />
      </svg>
      <div className="relative h-full p-5 flex flex-col">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[8px] tracking-[0.3em] text-blue-200/70" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {country.toUpperCase()}
            </div>
            <div className="text-[8px] tracking-[0.3em] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DEPARTMENT OF STATE
            </div>
          </div>
          <Globe className="w-7 h-7 text-blue-400/60" />
        </div>

        <div className="mt-1 text-[22px] leading-none tracking-[0.18em] text-slate-100"
          style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
          PASSPORT
        </div>
        <div className="h-px bg-gradient-to-r from-blue-500/50 via-blue-500/15 to-transparent mt-2 mb-3" />

        <div className="grid grid-cols-3 gap-x-4 gap-y-2 flex-1">
          <div className="col-span-2">
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>SURNAME / GIVEN NAMES</div>
            <div className="text-sm text-slate-100 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {name || <span className="text-slate-600 italic font-normal">— not parsed —</span>}
            </div>
          </div>
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>NATIONALITY</div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              {country || '—'}
            </div>
          </div>

          <div className="col-span-2">
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PASSPORT NUMBER</div>
            <div className="text-base text-slate-200 tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {passportNo || <span className="text-slate-600 italic">—</span>}
            </div>
          </div>
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DATE OF BIRTH</div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {dob ? formatLongDate(dob) : <span className="text-slate-600 italic">—</span>}
            </div>
          </div>

          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DATE OF ISSUE</div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {issued ? formatLongDate(issued) : <span className="text-slate-600 italic">—</span>}
            </div>
          </div>
          <div className="col-span-2">
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DATE OF EXPIRATION</div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {expires ? formatLongDate(expires) : <span className="text-slate-600 italic font-normal">—</span>}
            </div>
          </div>
        </div>

        <div className="pt-2 mt-auto border-t border-slate-800 flex items-center justify-between">
          <div className="text-[8px] text-slate-600 tracking-[0.3em]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            P&lt;{country}&lt;&lt;{(name || '').split(' ').slice(-1)[0].slice(0, 10)}
          </div>
          <div className="text-[8px] text-blue-500/40 tracking-[0.3em]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            MACHINE-READABLE
          </div>
        </div>
      </div>
    </div>
  );
}

// --- DRIVER'S LICENSE -------------------------------------------------------
// Mirrors a state-issued driver's license layout.
function DriversLicenseCard({ data, owner }) {
  const name = (data?.holderName || owner?.name || owner?.displayName || '').toUpperCase();
  const dlNo = data?.documentNumber || '';
  const state = data?.issuingAuthority || '';
  const dob = data?.dob;
  const issued = data?.issueDate;
  const expires = data?.expiration;

  return (
    <div className="relative overflow-hidden border border-emerald-500/30 bg-gradient-to-br from-emerald-950/40 via-slate-950 to-slate-900"
      style={{ aspectRatio: '1.6' }}>
      <div className="relative h-full p-5 flex flex-col">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[8px] tracking-[0.3em] text-emerald-200/70" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {state ? `STATE OF ${state.toUpperCase()}` : 'UNITED STATES'}
            </div>
            <div className="text-[8px] tracking-[0.3em] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DEPARTMENT OF MOTOR VEHICLES
            </div>
          </div>
          <Contact className="w-7 h-7 text-emerald-400/60" />
        </div>

        <div className="mt-1 text-[22px] leading-none tracking-[0.18em] text-slate-100"
          style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
          DRIVER&apos;S LICENSE
        </div>
        <div className="h-px bg-gradient-to-r from-emerald-500/50 via-emerald-500/15 to-transparent mt-2 mb-3" />

        <div className="grid grid-cols-3 gap-x-4 gap-y-2 flex-1">
          <div className="col-span-3">
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>NAME</div>
            <div className="text-sm text-slate-100 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {name || <span className="text-slate-600 italic font-normal">— not parsed —</span>}
            </div>
          </div>
          <div className="col-span-2">
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>LICENSE NUMBER</div>
            <div className="text-base text-slate-200 tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {dlNo || <span className="text-slate-600 italic">—</span>}
            </div>
          </div>
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>STATE</div>
            <div className="text-sm text-emerald-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              {state || '—'}
            </div>
          </div>

          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DATE OF BIRTH</div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {dob ? formatLongDate(dob) : <span className="text-slate-600 italic">—</span>}
            </div>
          </div>
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ISSUED</div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {issued ? formatLongDate(issued) : <span className="text-slate-600 italic">—</span>}
            </div>
          </div>
          <div>
            <div className="text-[8px] tracking-wider text-slate-500 mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>EXPIRES</div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {expires ? formatLongDate(expires) : <span className="text-slate-600 italic font-normal">—</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- EMPTY CARD -------------------------------------------------------------
function EmptyDocCard({ docType }) {
  const Icon = docType.icon;
  return (
    <div className="relative border border-dashed border-slate-800 bg-slate-900/20 flex items-center justify-center"
      style={{ aspectRatio: '1.6' }}>
      <div className="text-center">
        <Icon className="w-8 h-8 mx-auto mb-2 text-slate-700" />
        <div className="text-[11px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          NO {docType.label.toUpperCase()} ON FILE
        </div>
        <div className="text-[10px] text-slate-600 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          Upload below to populate this card
        </div>
      </div>
    </div>
  );
}

// Renders the correct card for a docType.
function DocCard({ docType, data, owner, allDocs }) {
  if (!data) return <EmptyDocCard docType={docType} />;
  switch (docType.id) {
    case 'certificate':     return <AirmanCertificateCard data={data} owner={owner} />;
    case 'medical':         return <MedicalCertificateCard data={data} owner={owner} allDocs={allDocs} />;
    case 'passport':        return <PassportCard data={data} owner={owner} />;
    case 'drivers_license': return <DriversLicenseCard data={data} owner={owner} />;
    default:                return null;
  }
}

// ============================================================================
// FILES LIST + UPLOAD UX (per doc type, allows multiple files)
// ============================================================================
// Renders below each card. Shows every file uploaded for this docType
// with thumbnail/icon, label, date, and OPEN/DELETE controls. Plus the
// add-another-file affordance with optional label (Front/Back/etc).

function FileRow({ d, onDelete, busy }) {
  const isImage = (d.fileContentType || '').startsWith('image/');
  return (
    <div className="flex items-center gap-2 border border-slate-800 bg-slate-900/40 p-2">
      <div className="w-10 h-10 shrink-0 border border-slate-700 bg-slate-950 flex items-center justify-center overflow-hidden">
        {isImage ? (
          <img src={d.fileUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <FileText className="w-4 h-4 text-slate-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-slate-200 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {d.fileLabel || d.fileName || 'Untitled'}
        </div>
        <div className="text-[9px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString() : ''}
          {d.fileSizeBytes ? ` · ${(d.fileSizeBytes / 1024).toFixed(0)} KB` : ''}
          {d.fileContentType ? ` · ${d.fileContentType.split('/').pop()}` : ''}
        </div>
      </div>
      <a href={d.fileUrl} target="_blank" rel="noreferrer"
        className="px-2 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-[10px] tracking-widest shrink-0"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <Download className="w-3 h-3 inline mr-1" />OPEN
      </a>
      <button
        onClick={() => onDelete(d)}
        disabled={busy}
        className="px-2 py-1 border border-red-700/40 text-red-400 hover:bg-red-500/10 text-[10px] tracking-widest shrink-0 disabled:opacity-40"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

// One doc-type section: card on top, files list, upload affordance.
function DocTypeSection({ docType, docs, currentUser, allDocs, onError }) {
  const merged = useMemo(() => mergeDocData(docs), [docs]);
  const owner = currentUser;
  const Icon = docType.icon;

  const [stagingFile, setStagingFile] = useState(null);
  const [stagingLabel, setStagingLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const fileInputRef = useRef(null);

  const uid = currentUser?.uid || currentUser?.id;

  const onPick = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setStagingFile(f);
    // Default label suggestion based on what's already uploaded
    const hasFront = docs.some((d) => /front/i.test(d.fileLabel || ''));
    const hasBack = docs.some((d) => /back/i.test(d.fileLabel || ''));
    if (docs.length === 0) setStagingLabel('Front');
    else if (hasFront && !hasBack) setStagingLabel('Back');
    else setStagingLabel(`Page ${docs.length + 1}`);
    onError('');
  };

  const resetStaging = () => {
    setStagingFile(null);
    setStagingLabel('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const doUpload = async () => {
    if (!stagingFile || !uid) return;
    setBusy(true);
    onError('');
    try {
      setStage('Preparing...');
      const isPdf = stagingFile.type === 'application/pdf'
        || (stagingFile.name || '').toLowerCase().endsWith('.pdf');
      const prepared = isPdf ? stagingFile : await compressIfImage(stagingFile);

      const m = await import('./firebase-pilotdocs.js');
      const storage = await import('./firebase-storage.js');
      const id = m.newPilotDocId();

      setStage('Uploading...');
      const [up, b64] = await Promise.all([
        storage.uploadPilotDoc(prepared, uid, docType.id),
        fileToBase64(prepared),
      ]);

      const base = {
        id, uid,
        ownerName: currentUser?.name || currentUser?.displayName || 'Unknown',
        ownerEmail: currentUser?.email || '',
        docType: docType.id,
        fileUrl: up.url, filePath: up.path, fileContentType: up.contentType,
        fileName: up.name, fileKind: up.kind, fileSizeBytes: up.sizeBytes,
        // NEW: user-entered label so front/back/etc. are distinguishable
        fileLabel: stagingLabel.trim() || 'Page 1',
        uploadedBy: uid,
        notes: 'Parsing document with AI...',
      };
      await m.savePilotDoc(base);

      // AI parse (skipped only for very obviously back-side uploads —
      // we still try, just don't worry if it returns mostly null)
      setStage('AI reading document...');
      let idToken = null;
      try {
        const { auth } = await import('./firebase.js');
        if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
      } catch (_) {}

      const body = isPdf
        ? { idToken, docType: docType.id, pdfBase64: b64 }
        : { idToken, docType: docType.id, imageBase64: b64, mediaType: up.contentType || 'image/jpeg' };

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
        await m.savePilotDoc({
          ...base,
          notes: fe.name === 'AbortError'
            ? 'AI parse timed out — file saved, fields can be entered manually.'
            : 'AI parse unreachable — file saved, fields can be entered manually.',
        });
        resetStaging();
        setBusy(false);
        setStage('');
        return;
      }
      clearTimeout(t);
      if (!resp.ok) {
        await m.savePilotDoc({ ...base, notes: `AI parse failed: ${data?.error || 'unknown'} — file saved.` });
        resetStaging();
        setBusy(false);
        setStage('');
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
      resetStaging();
      setBusy(false);
      setStage('');
    } catch (e) {
      const msg = e?.message || 'Upload failed';
      if (msg.includes('storage/unauthorized') || msg.includes('permission')) {
        onError('Permission denied. Storage rules need to be published. Ask Jake.');
      } else {
        onError(msg);
      }
      setBusy(false);
      setStage('');
    }
  };

  const doDelete = async (d) => {
    if (!window.confirm(`Delete this ${docType.label.toLowerCase()} file? The card will refresh with remaining files.`)) return;
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
    <div className="border border-slate-800 bg-slate-950/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-cyan-300" />
          <h3 className="text-sm tracking-widest text-slate-100"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            {docType.label.toUpperCase()}
          </h3>
        </div>
        {merged && <ExpBadge d={merged} allDocs={allDocs} />}
      </div>

      {/* CARD */}
      <DocCard docType={docType} data={merged} owner={owner} allDocs={allDocs} />

      {/* PARSE NOTES (warnings about AI parse) */}
      {merged?.notes && /manually|failed|timed out|unreachable/i.test(merged.notes) && (
        <div className="text-[11px] text-amber-400 flex items-start gap-1.5 p-2 border border-amber-500/20 bg-amber-500/5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {merged.notes}
        </div>
      )}

      {/* FILES LIST */}
      {docs.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            FILES ({docs.length})
          </div>
          {[...docs]
            .sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0))
            .map((d) => (
              <FileRow key={d.id} d={d} onDelete={doDelete} busy={busy} />
            ))}
        </div>
      )}

      {/* STAGING (label-then-upload) or UPLOAD BUTTON */}
      {stagingFile ? (
        <div className="border border-cyan-500/40 bg-cyan-500/5 p-3 space-y-2">
          <div className="text-[10px] tracking-widest text-cyan-300"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            STAGING NEW FILE
          </div>
          <div className="text-[11px] text-slate-400 truncate"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {stagingFile.name} · {(stagingFile.size / 1024).toFixed(0)} KB
          </div>
          <label className="block">
            <span className="text-[10px] tracking-widest text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              LABEL (e.g. Front, Back, Page 2)
            </span>
            <input
              type="text"
              value={stagingLabel}
              onChange={(e) => setStagingLabel(e.target.value)}
              disabled={busy}
              placeholder="Front / Back / Other"
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            />
          </label>
          <div className="flex gap-2">
            <button onClick={doUpload} disabled={busy}
              className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
              style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {busy ? (stage || 'UPLOADING...') : 'UPLOAD'}
            </button>
            <button onClick={resetStaging} disabled={busy}
              className="px-4 py-2 border border-slate-700 text-slate-300 text-sm"
              style={{ fontFamily: 'DM Sans, sans-serif' }}>
              CANCEL
            </button>
          </div>
        </div>
      ) : (
        <label className="block border border-dashed border-slate-700 hover:border-cyan-500/50 p-4 text-center cursor-pointer transition-colors">
          <Upload className="w-4 h-4 text-slate-600 mx-auto mb-1" />
          <span className="text-[11px] tracking-widest text-slate-500"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {docs.length === 0 ? `+ UPLOAD ${docType.label.toUpperCase()}` : `+ ADD ANOTHER FILE`}
          </span>
          <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onPick} disabled={busy} />
        </label>
      )}
    </div>
  );
}

// ============================================================================
// MAIN VIEWS
// ============================================================================

export function PilotDocsTab({ currentUser }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
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

  // Group all docs by docType (excluding employment which gets its own section)
  const byType = useMemo(() => {
    const out = {};
    for (const d of docs) {
      if (d.docType === EMPLOYMENT_DOC_TYPE_ID) continue;
      (out[d.docType] = out[d.docType] || []).push(d);
    }
    return out;
  }, [docs]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>MY PILOT DOCS</h2>
        <p className="text-xs text-slate-500 mt-1">
          Upload your certificate, medical, passport, and license — multiple files per type for front/back, AI parses each, original copies stored.
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
        <div className="space-y-4">
          {DOC_TYPES.map((t) => (
            <DocTypeSection
              key={t.id}
              docType={t}
              docs={byType[t.id] || []}
              currentUser={currentUser}
              allDocs={docs}
              onError={setErr}
            />
          ))}
        </div>
      )}

      <p className="text-[10px] text-slate-600 mt-2">
        FAA airman certificates do not expire. Medical expiration is computed per 14 CFR 61.23(d) from class + age at exam — accurate only if your passport or driver's license is uploaded (we read your DOB from there).
      </p>

      <EmploymentDocsSection
        currentUser={currentUser}
        docs={docs.filter((d) => d.docType === EMPLOYMENT_DOC_TYPE_ID)}
        onError={setErr}
      />
    </div>
  );
}

// ============================================================================
// EMPLOYMENT DOCS (unchanged from previous turn)
// ============================================================================
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

      setUploadStage('Saving...');
      await m.savePilotDoc({
        id, uid,
        ownerName: currentUser?.name || currentUser?.displayName || 'Unknown',
        ownerEmail: currentUser?.email || '',
        docType: EMPLOYMENT_DOC_TYPE_ID,
        fileUrl: up.url, filePath: up.path, fileContentType: up.contentType,
        fileName: up.name, fileKind: up.kind, fileSizeBytes: up.sizeBytes,
        holderName: pendingName.trim(),
        notes: pendingNotes.trim(),
        uploadedBy: uid,
      });

      reset();
      setUploadStage('');
    } catch (e) {
      const msg = e?.message || 'Upload failed';
      if (msg.includes('storage/unauthorized') || msg.includes('permission')) {
        onError('Permission denied. Storage rules need updating — ask Jake to publish the latest storage.rules.');
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
            W-4, I-9, contract, training records, signed acknowledgements — anything else related to your employment at Skyway.
          </p>
        </div>
        {!pendingFile && (
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 cursor-pointer text-[11px] tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <Upload className="w-3 h-3" /> + UPLOAD DOC
            <input ref={fileInputRef} type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt" className="hidden" onChange={onPick} disabled={uploading} />
          </label>
        )}
      </div>

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
            <input type="text" value={pendingName} onChange={(e) => setPendingName(e.target.value)}
              placeholder='e.g. "W-4 (2026)" or "Employment Agreement"'
              disabled={uploading}
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              NOTES (OPTIONAL)
            </span>
            <textarea value={pendingNotes} onChange={(e) => setPendingNotes(e.target.value)}
              placeholder='Any notes about this document...' rows={2} disabled={uploading}
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }} />
          </label>
          <div className="flex gap-2 pt-1">
            <button onClick={doUpload} disabled={uploading || !pendingName.trim()}
              className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
              style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {uploading ? (uploadStage || 'UPLOADING...') : 'UPLOAD'}
            </button>
            <button onClick={reset} disabled={uploading}
              className="px-4 py-2 border border-slate-700 text-slate-300 text-sm"
              style={{ fontFamily: 'DM Sans, sans-serif' }}>
              CANCEL
            </button>
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 border border-dashed border-slate-800 px-3 text-center"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          No employment documents yet. Tap UPLOAD DOC to add your first.
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((d) => (
            <div key={d.id} className="border border-slate-700 bg-slate-900/40 p-3 flex items-start justify-between gap-3">
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

// ============================================================================
// ADMIN / OPS: all crew docs on one screen
// ============================================================================

export function AllCrewDocs({ currentUser, users = [] }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    let unsub = null, cancelled = false;
    (async () => {
      const m = await import('./firebase-pilotdocs.js');
      if (cancelled) return;
      unsub = m.subscribeToAllPilotDocs((list) => { setDocs(list); setLoading(false); });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  const groups = useMemo(() => {
    const map = new Map();
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
    arr.sort((a, b) => (b.docs.length - a.docs.length) || a.name.localeCompare(b.name));
    return arr;
  }, [docs, users, search]);

  // Group a crew member's docs by docType (multiple files per type now)
  const groupByDocType = (list) => {
    const out = {};
    for (const d of list) {
      (out[d.docType] = out[d.docType] || []).push(d);
    }
    return out;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>ALL CREW DOCS</h2>
          <p className="text-xs text-slate-500 mt-1">Every crew member's documents in one place. Expand to view cards, download originals, or bulk-ZIP everything.</p>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search crew…"
            className="bg-slate-800 border border-slate-700 pl-8 pr-3 py-1.5 text-sm text-slate-100 w-48"
            style={{ fontFamily: 'DM Sans, sans-serif' }} />
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…</div>
      ) : groups.length === 0 ? (
        <div className="border border-dashed border-slate-700 p-12 text-center text-sm text-slate-500">No crew found.</div>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => {
            const groupedByType = groupByDocType(g.docs);
            const isOpen = expanded[g.uid];
            const flags = g.docs.map((d) => expState(d, g.docs).state).filter((s) => s === 'soon' || s === 'expired');
            const hasExpired = g.docs.some((d) => expState(d, g.docs).state === 'expired');
            return (
              <div key={g.uid} className="border border-slate-700 bg-slate-900/40">
                <button
                  onClick={() => setExpanded((p) => ({ ...p, [g.uid]: !p[g.uid] }))}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/40">
                  <div className="flex items-center gap-3 min-w-0">
                    {isOpen ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
                    <div className="text-left min-w-0">
                      <div className="text-sm text-slate-100 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>{g.name}</div>
                      {g.role && <div className="text-[10px] text-slate-500 tracking-widest uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{g.role}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="hidden sm:flex items-center gap-1">
                      {DOC_TYPES.map((t) => {
                        const has = groupedByType[t.id]?.length > 0;
                        return (
                          <span key={t.id} title={`${t.label}: ${has ? `${groupedByType[t.id].length} file(s)` : 'missing'}`}
                            className={`w-2 h-2 rounded-full ${has ? 'bg-emerald-500' : 'bg-slate-700'}`} />
                        );
                      })}
                    </div>
                    <span className="text-[11px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {g.docs.length} FILE{g.docs.length === 1 ? '' : 'S'}
                    </span>
                    {flags.length > 0 && (
                      <span className={`w-2 h-2 rounded-full ${hasExpired ? 'bg-red-500' : 'bg-amber-400'}`} title={hasExpired ? 'Has expired docs' : 'Has docs expiring soon'} />
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-slate-800 p-3 space-y-3">
                    <BulkDownloadButton crewUid={g.uid} crewName={g.name} docs={g.docs} />

                    {/* Cards + files per doc type */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      {DOC_TYPES.map((t) => {
                        const typeDocs = groupedByType[t.id] || [];
                        const merged = mergeDocData(typeDocs);
                        return (
                          <div key={t.id} className="border border-slate-800 bg-slate-950/40 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <t.icon className="w-3.5 h-3.5 text-cyan-300" />
                                <span className="text-[11px] tracking-wider text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{t.label.toUpperCase()}</span>
                              </div>
                              {merged && <ExpBadge d={merged} allDocs={g.docs} />}
                            </div>
                            <DocCard docType={t} data={merged} owner={g} allDocs={g.docs} />
                            {typeDocs.length > 0 && (
                              <div className="space-y-1">
                                <div className="text-[9px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                  FILES · {typeDocs.length}
                                </div>
                                {typeDocs.sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0)).map((d) => (
                                  <div key={d.id} className="flex items-center gap-2 border border-slate-800 px-2 py-1">
                                    <span className="text-[10px] text-slate-400 truncate flex-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                      {d.fileLabel || d.fileName}
                                    </span>
                                    <a href={d.fileUrl} target="_blank" rel="noreferrer"
                                      className="text-[9px] tracking-widest px-1.5 py-0.5 border border-slate-700 text-slate-300 hover:border-cyan-400 hover:text-cyan-300"
                                      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                      OPEN
                                    </a>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Employment docs */}
                    {g.docs.some((d) => d.docType === EMPLOYMENT_DOC_TYPE_ID) && (
                      <div className="border border-slate-800 p-3 space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Briefcase className="w-3.5 h-3.5 text-cyan-300" />
                          <span className="text-[11px] tracking-wider text-slate-200"
                            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                            EMPLOYMENT DOCUMENTS · {g.docs.filter((d) => d.docType === EMPLOYMENT_DOC_TYPE_ID).length}
                          </span>
                        </div>
                        <div className="space-y-1.5">
                          {g.docs.filter((d) => d.docType === EMPLOYMENT_DOC_TYPE_ID)
                            .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
                            .map((d) => (
                              <div key={d.id} className="flex items-start justify-between gap-2 border-b border-slate-800/50 pb-1.5 last:border-0">
                                <div className="min-w-0 flex-1">
                                  <a href={d.fileUrl} target="_blank" rel="noreferrer"
                                    className="text-[12px] text-cyan-300 hover:text-cyan-200 truncate block"
                                    style={{ fontFamily: 'DM Sans, sans-serif' }}>
                                    {d.holderName || d.fileName || 'Untitled'}
                                  </a>
                                  {d.notes && <div className="text-[10px] text-slate-500 truncate">{d.notes}</div>}
                                  <div className="text-[9px] text-slate-600" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                    {d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString() : ''}
                                  </div>
                                </div>
                                <a href={d.fileUrl} target="_blank" rel="noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-0.5 border border-slate-700 text-slate-300 hover:border-cyan-400 hover:text-cyan-300 text-[9px] tracking-widest shrink-0"
                                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                  OPEN
                                </a>
                              </div>
                            ))}
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

// ============================================================================
// BULK DOWNLOAD BUTTON — ZIPs all of one crew member's docs (originals)
// ============================================================================
//
// When admin clicks DOWNLOAD ZIP, every uploaded file for this crew member
// is fetched (from its storage URL) and packed into a ZIP. Unique filenames
// per file prevent collisions when multiple files exist for the same
// docType (front, back, etc.).
//
// JSZip is loaded from CDN on first click (no npm dependency to add).
function BulkDownloadButton({ crewUid, crewName, docs }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');

  if (!docs || docs.length === 0) return null;

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

      // Pre-build a unique-filename mapping per docType so multiple
      // files don't collide in the same folder.
      const byType = docs.reduce((acc, d) => {
        (acc[d.docType || 'misc'] = acc[d.docType || 'misc'] || []).push(d);
        return acc;
      }, {});

      let i = 0;
      const total = docs.length;
      for (const [type, list] of Object.entries(byType)) {
        const folder = root.folder(type);
        // Order by uploadedAt for stable, meaningful filenames
        list.sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
        for (let idx = 0; idx < list.length; idx++) {
          const d = list[idx];
          i++;
          const dispName = d.fileLabel || d.holderName || `file-${idx + 1}`;
          setProgress(`Downloading ${i} / ${total}: ${type}/${dispName}...`);
          if (!d.fileUrl) {
            folder.file(`MISSING_${dispName}.txt`, 'No file URL stored — skipped.');
            continue;
          }
          try {
            const resp = await fetch(d.fileUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            // Use the storage object's actual filename for uniqueness
            const storageBaseName = (d.filePath || '').split('/').pop()
              || d.fileName || `file-${idx + 1}`;
            // But prefix with the user-friendly label if present
            const labelPrefix = d.fileLabel
              ? d.fileLabel.replace(/[^a-zA-Z0-9 ._-]/g, '_') + '__'
              : '';
            folder.file(`${labelPrefix}${storageBaseName}`, blob);
          } catch (fetchErr) {
            console.warn(`[bulk-download] skipped ${dispName}:`, fetchErr?.message);
            folder.file(
              `ERROR_${dispName}.txt`,
              `Failed to download: ${fetchErr?.message || 'unknown error'}`
            );
          }
        }
      }

      setProgress('Building ZIP file...');
      const blob = await zip.generateAsync({ type: 'blob' }, (m) => {
        setProgress(`Building ZIP: ${Math.round(m.percent)}%`);
      });

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
          DOWNLOAD ALL ORIGINALS · {docs.length} FILE{docs.length === 1 ? '' : 'S'}
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
      <button onClick={handleDownload} disabled={busy}
        className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[11px] tracking-widest font-medium disabled:opacity-40 shrink-0"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {busy ? 'WORKING...' : 'DOWNLOAD ZIP'}
      </button>
    </div>
  );
}
