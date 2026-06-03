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
// CARD VISUALIZATIONS — photorealistic renderings of each document type
// ============================================================================
// Each card renders parsed fields in the layout of the real document so the
// crew member sees their cert/medical/passport/DL the way they'd recognize
// it. All four cards use a 1.586 aspect ratio (ISO/IEC 7810 ID-1, the
// standard credit-card / driver's-license / FAA-cert size). Photos and
// signatures are placeholders — we store the original file separately and
// surface it via the FILES list below the card.

// --- SHARED SVG ASSETS ------------------------------------------------------

// FAA "meatball" — stylized seal used on airman + medical certificates.
function FaaMeatball({ className = '', size = 40 }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100">
      <defs>
        <radialGradient id="faaBlue" cx="0.35" cy="0.35">
          <stop offset="0%" stopColor="#3b6db5" />
          <stop offset="100%" stopColor="#0e2d5e" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="url(#faaBlue)" stroke="#0a1f42" strokeWidth="2" />
      {/* Stylized wing/chevron */}
      <path d="M 18 58 Q 50 32 82 58 L 78 62 Q 50 42 22 62 Z" fill="#ffffff" opacity="0.95" />
      <path d="M 28 64 L 50 56 L 72 64 L 70 67 L 50 60 L 30 67 Z" fill="#ffffff" opacity="0.7" />
      <circle cx="50" cy="55" r="2.2" fill="#ffffff" />
      {/* Subtle inner ring */}
      <circle cx="50" cy="50" r="42" fill="none" stroke="#ffffff" strokeWidth="0.6" opacity="0.3" />
    </svg>
  );
}

// US Great Seal — gold eagle for passport cover.
function GreatSeal({ className = '', size = 56 }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100">
      <defs>
        <radialGradient id="goldGrad" cx="0.5" cy="0.4">
          <stop offset="0%" stopColor="#e6c989" />
          <stop offset="60%" stopColor="#c5a572" />
          <stop offset="100%" stopColor="#8a7349" />
        </radialGradient>
      </defs>
      {/* Outer ring */}
      <circle cx="50" cy="50" r="46" fill="none" stroke="url(#goldGrad)" strokeWidth="1.5" opacity="0.6" />
      <circle cx="50" cy="50" r="42" fill="none" stroke="url(#goldGrad)" strokeWidth="0.6" opacity="0.4" />
      {/* Eagle silhouette */}
      <g fill="url(#goldGrad)">
        {/* Wings spread */}
        <path d="M 50 35 Q 25 35 14 50 Q 22 46 32 47 L 36 50 Q 28 52 22 56 Q 30 54 38 55 L 42 58 L 50 60 L 58 58 L 62 55 Q 70 54 78 56 Q 72 52 64 50 L 68 47 Q 78 46 86 50 Q 75 35 50 35 Z" />
        {/* Body / shield */}
        <rect x="44" y="48" width="12" height="20" rx="1" />
        <rect x="44" y="48" width="12" height="3" fill="#0a1f42" opacity="0.6" />
        {/* Vertical stripes on shield */}
        <line x1="46.5" y1="51" x2="46.5" y2="68" stroke="#0a1f42" strokeWidth="0.8" opacity="0.6" />
        <line x1="50" y1="51" x2="50" y2="68" stroke="#0a1f42" strokeWidth="0.8" opacity="0.6" />
        <line x1="53.5" y1="51" x2="53.5" y2="68" stroke="#0a1f42" strokeWidth="0.8" opacity="0.6" />
        {/* Head */}
        <circle cx="50" cy="42" r="4" />
        <path d="M 50 42 L 56 44 L 52 45 Z" />
        {/* Olive branch + arrows hint */}
        <path d="M 32 70 L 44 66 M 36 72 L 42 70" stroke="url(#goldGrad)" strokeWidth="1" fill="none" />
        <path d="M 68 70 L 56 66 M 64 72 L 58 70" stroke="url(#goldGrad)" strokeWidth="1" fill="none" />
      </g>
      {/* Stars above */}
      <g fill="url(#goldGrad)">
        <circle cx="40" cy="30" r="0.8" />
        <circle cx="45" cy="28" r="0.8" />
        <circle cx="50" cy="27" r="0.8" />
        <circle cx="55" cy="28" r="0.8" />
        <circle cx="60" cy="30" r="0.8" />
      </g>
    </svg>
  );
}

// Generic state seal — used on driver's license.
function StateSeal({ className = '', size = 40, state = '' }) {
  const initial = (state || '').slice(0, 2).toUpperCase();
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100">
      <defs>
        <linearGradient id="stateGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1a4480" />
          <stop offset="100%" stopColor="#0a2a5e" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="url(#stateGrad)" stroke="#c5a572" strokeWidth="1.5" />
      <circle cx="50" cy="50" r="42" fill="none" stroke="#c5a572" strokeWidth="0.4" opacity="0.7" />
      {/* Star */}
      <path d="M 50 28 L 53 42 L 67 42 L 56 50 L 60 64 L 50 56 L 40 64 L 44 50 L 33 42 L 47 42 Z"
        fill="#c5a572" opacity="0.85" />
      <text x="50" y="80" textAnchor="middle" fontSize="11" fontWeight="700"
        fill="#c5a572" fontFamily="serif">
        {initial}
      </text>
    </svg>
  );
}

// Generic person silhouette — placeholder for the photo area.
function PhotoPlaceholder({ className = '', tone = 'dark' }) {
  const bg = tone === 'dark' ? '#0a1428' : '#d8dde6';
  const fg = tone === 'dark' ? '#2a3a55' : '#8a95a8';
  return (
    <svg className={className} viewBox="0 0 80 100" preserveAspectRatio="none">
      <rect x="0" y="0" width="80" height="100" fill={bg} />
      {/* Subtle security pattern */}
      <g stroke={fg} strokeWidth="0.3" opacity="0.35">
        {Array.from({ length: 20 }).map((_, i) => (
          <line key={i} x1="0" y1={i * 5} x2="80" y2={i * 5 - 10} />
        ))}
      </g>
      {/* Person silhouette */}
      <g fill={fg} opacity="0.55">
        <circle cx="40" cy="38" r="11" />
        <path d="M 18 90 Q 18 60 40 60 Q 62 60 62 90 L 62 100 L 18 100 Z" />
      </g>
    </svg>
  );
}

// Tiny helper used on most cards.
function Field({ label, value, mono, big, accent, className = '' }) {
  return (
    <div className={className}>
      <div
        className="text-[7.5px] tracking-[0.18em] uppercase mb-0.5"
        style={{ fontFamily: 'JetBrains Mono, monospace', color: accent || '#5f7a52' }}
      >
        {label}
      </div>
      <div
        className={(big ? 'text-[15px]' : 'text-[11.5px]') + ' leading-tight'}
        style={{
          fontFamily: mono ? 'JetBrains Mono, monospace' : 'Georgia, "Times New Roman", serif',
          fontWeight: big ? 600 : 500,
          color: '#1a1a1a',
        }}
      >
        {value || <span style={{ color: '#9aa1ad', fontStyle: 'italic' }}>—</span>}
      </div>
    </div>
  );
}

// Combine surname + given names into display variants.
function combineName(data, owner) {
  const surname = (data?.surname || '').trim();
  const given = (data?.givenNames || '').trim();
  if (surname && given) {
    return { surname: surname.toUpperCase(), given: given.toUpperCase(), full: `${given} ${surname}`.toUpperCase() };
  }
  const full = (data?.holderName || owner?.name || owner?.displayName || '').trim();
  if (!full) return { surname: '', given: '', full: '' };
  const parts = full.split(/\s+/);
  if (parts.length === 1) return { surname: parts[0].toUpperCase(), given: '', full: full.toUpperCase() };
  return { surname: parts[parts.length - 1].toUpperCase(), given: parts.slice(0, -1).join(' ').toUpperCase(), full: full.toUpperCase() };
}

// Build a formatted address from parsed fields.
function formatAddress(data) {
  const parts = [];
  if (data?.addressLine1) parts.push(data.addressLine1);
  if (data?.addressLine2) parts.push(data.addressLine2);
  const cityLine = [data?.addressCity, data?.addressState].filter(Boolean).join(', ');
  const cityZip = [cityLine, data?.addressZip].filter(Boolean).join(' ');
  if (cityZip) parts.push(cityZip);
  return parts;
}

// --- 1. AIRMAN CERTIFICATE --------------------------------------------------
// Photorealistic plastic-card style mimicking the FAA Airman Certificate
// issued post-2003. Cream background, FAA blue + green field labels,
// holographic eagle watermark in the center.

function AirmanCertificateCard({ data, owner }) {
  const n = combineName(data, owner);
  const certNo = data?.documentNumber || '';
  const certType = data?.certType || '';
  const ratings = data?.ratings || '';
  const limitations = data?.limitations || '';
  const issued = data?.issueDate;
  const addressLines = formatAddress(data);
  const FAA_BLUE = '#1a4480';
  const FAA_GREEN = '#5f7a52';
  const CREAM = '#f8f3e6';

  return (
    <div
      className="relative overflow-hidden shadow-lg"
      style={{
        aspectRatio: '1.586',
        background: `linear-gradient(135deg, ${CREAM} 0%, #ede4cc 100%)`,
        border: '1px solid #c8b88e',
        borderRadius: 12,
      }}
    >
      {/* Holographic eagle watermark */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 400 250"
        preserveAspectRatio="xMidYMid slice"
        style={{ opacity: 0.06 }}
      >
        <g transform="translate(200 130)" fill="#1a4480">
          <path d="M 0 -40 Q -80 -30 -110 0 Q -85 -10 -55 -8 L -45 0 Q -65 5 -80 15 Q -55 8 -30 10 L -20 18 L 0 22 L 20 18 L 30 10 Q 55 8 80 15 Q 65 5 45 0 L 55 -8 Q 85 -10 110 0 Q 80 -30 0 -40 Z" />
          <rect x="-12" y="-2" width="24" height="40" />
        </g>
      </svg>

      {/* Subtle guilloche security pattern */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20"
        viewBox="0 0 400 250" preserveAspectRatio="none">
        {Array.from({ length: 14 }).map((_, i) => (
          <ellipse key={i} cx="200" cy="125" rx={30 + i * 18} ry={15 + i * 8}
            fill="none" stroke={FAA_BLUE} strokeWidth="0.2" />
        ))}
      </svg>

      <div className="relative h-full px-4 py-3 flex flex-col" style={{ color: '#1a1a1a' }}>
        {/* HEADER ROW */}
        <div className="flex items-start justify-between">
          <FaaMeatball size={42} />
          <div className="text-center flex-1 px-3">
            <div className="text-[9px] tracking-[0.3em]" style={{ fontFamily: 'Georgia, serif', color: FAA_BLUE, fontWeight: 700 }}>
              UNITED STATES OF AMERICA
            </div>
            <div className="text-[7px] tracking-[0.25em] mt-0.5" style={{ fontFamily: 'Georgia, serif', color: '#444' }}>
              DEPARTMENT OF TRANSPORTATION
            </div>
            <div className="text-[7px] tracking-[0.25em]" style={{ fontFamily: 'Georgia, serif', color: '#444' }}>
              FEDERAL AVIATION ADMINISTRATION
            </div>
          </div>
          <div className="text-right">
            <div className="text-[6.5px] tracking-[0.18em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: FAA_GREEN, fontWeight: 700 }}>
              CERTIFICATE NO.
            </div>
            <div className="text-[10px] tracking-wider mt-0.5" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: FAA_BLUE }}>
              {certNo || <span style={{ color: '#aaa', fontStyle: 'italic' }}>—</span>}
            </div>
          </div>
        </div>

        <div className="text-center mt-1.5 mb-2">
          <div
            className="text-[14px] tracking-[0.32em] inline-block px-3 py-0.5"
            style={{
              fontFamily: 'Georgia, serif',
              fontWeight: 700,
              color: FAA_BLUE,
              borderTop: `1px solid ${FAA_BLUE}`,
              borderBottom: `1px solid ${FAA_BLUE}`,
            }}
          >
            AIRMAN CERTIFICATE
          </div>
        </div>

        {/* BIO GRID */}
        <div className="grid grid-cols-12 gap-x-2 gap-y-1.5 flex-1 text-[10.5px]">
          <Field className="col-span-7" label="Name" value={n.full} big />
          <Field className="col-span-5" label="Date of Birth" value={data?.dob ? formatLongDate(data.dob) : null} />

          {addressLines.length > 0 && (
            <div className="col-span-12">
              <div className="text-[7.5px] tracking-[0.18em] uppercase mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace', color: FAA_GREEN }}>Address</div>
              <div className="text-[11px] leading-tight" style={{ fontFamily: 'Georgia, serif', color: '#1a1a1a' }}>
                {addressLines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          )}

          <Field className="col-span-2" label="Sex"    value={data?.sex} mono />
          <Field className="col-span-3" label="Height" value={data?.height} mono />
          <Field className="col-span-3" label="Weight" value={data?.weight} mono />
          <Field className="col-span-2" label="Hair"   value={data?.hairColor} mono />
          <Field className="col-span-2" label="Eyes"   value={data?.eyeColor} mono />

          <div className="col-span-12 border-t pt-1.5" style={{ borderColor: '#c8b88e' }}>
            <div className="text-[7.5px] tracking-[0.18em] uppercase mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace', color: FAA_GREEN }}>
              Grade of Certificate
            </div>
            <div className="text-[13px] font-bold" style={{ fontFamily: 'Georgia, serif', color: FAA_BLUE }}>
              {certType ? certType.toUpperCase() : <span style={{ color: '#aaa', fontStyle: 'italic' }}>—</span>}
            </div>
          </div>

          {(ratings || limitations) && (
            <div className="col-span-12">
              <div className="text-[7.5px] tracking-[0.18em] uppercase mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace', color: FAA_GREEN }}>
                Ratings and Limitations
              </div>
              <div className="text-[10px] leading-snug" style={{ fontFamily: 'Georgia, serif', color: '#1a1a1a' }}>
                {[ratings, limitations].filter(Boolean).join(' · ')}
              </div>
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div className="mt-1.5 pt-1.5 border-t flex items-end justify-between" style={{ borderColor: '#c8b88e' }}>
          <div>
            <div className="text-[6.5px] tracking-[0.18em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: FAA_GREEN, fontWeight: 700 }}>
              DATE OF ISSUE
            </div>
            <div className="text-[10px]" style={{ fontFamily: 'Georgia, serif', color: '#1a1a1a' }}>
              {issued ? formatLongDate(issued).toUpperCase() : '—'}
            </div>
          </div>
          <div className="text-[6.5px] tracking-[0.3em] text-right" style={{ fontFamily: 'Georgia, serif', color: FAA_BLUE, fontWeight: 700 }}>
            14 CFR 61 · DOES NOT EXPIRE
          </div>
        </div>
      </div>
    </div>
  );
}

// --- 2. MEDICAL CERTIFICATE -------------------------------------------------
// Paper-document style (real FAA medicals are paper, not plastic). White
// background, formal serif headings, large class badge, and the FAA-
// computed expiration table — which is the key feature pilots care about.

function MedicalCertificateCard({ data, owner, allDocs }) {
  const n = combineName(data, owner);
  const cls = data?.medicalClass || '';
  const issued = data?.issueDate;
  const examDate = data?.examinationDate || issued;
  const dob = findUserDob(allDocs);
  const expirations = useMemo(
    () => calculateMedicalExpirations({ medicalClass: cls, issueDate: examDate, dob }),
    [cls, examDate, dob]
  );
  const age = dob && examDate ? ageAtDate(parseISODate(dob), parseISODate(examDate)) : null;
  const restrictions = data?.medicalRestrictions || data?.ratings || '';
  const ameName = data?.ameName || '';
  const ameNumber = data?.ameNumber || '';

  const classText = ({ '1': 'FIRST-CLASS', '2': 'SECOND-CLASS', '3': 'THIRD-CLASS' })[String(cls)] || '—';
  const classBadgeColor = ({ '1': '#c5a572', '2': '#9aa1ad', '3': '#a07647' })[String(cls)] || '#888';
  const FAA_BLUE = '#1a4480';
  const FAA_GREEN = '#5f7a52';

  return (
    <div
      className="relative overflow-hidden shadow-lg"
      style={{
        aspectRatio: '1.586',
        background: 'linear-gradient(180deg, #fefefe 0%, #f8f6ef 100%)',
        border: '1px solid #d8d3c4',
        borderRadius: 12,
      }}
    >
      {/* Faint paper lines */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-30"
        viewBox="0 0 400 250" preserveAspectRatio="none">
        {Array.from({ length: 12 }).map((_, i) => (
          <line key={i} x1="0" y1={i * 22 + 10} x2="400" y2={i * 22 + 10}
            stroke="#d8d3c4" strokeWidth="0.3" />
        ))}
      </svg>

      <div className="relative h-full px-4 py-3 flex flex-col" style={{ color: '#1a1a1a' }}>
        {/* HEADER */}
        <div className="flex items-start gap-3">
          <FaaMeatball size={36} />
          <div className="flex-1">
            <div className="text-[8px] tracking-[0.3em]" style={{ fontFamily: 'Georgia, serif', color: FAA_BLUE, fontWeight: 700 }}>
              FEDERAL AVIATION ADMINISTRATION
            </div>
            <div className="text-[12px] tracking-[0.22em] mt-0.5" style={{ fontFamily: 'Georgia, serif', fontWeight: 700, color: '#1a1a1a' }}>
              AIRMAN MEDICAL CERTIFICATE
            </div>
          </div>
          <div className="text-right">
            <div className="px-2 py-0.5 text-[8.5px] tracking-[0.18em]"
              style={{
                fontFamily: 'Georgia, serif',
                fontWeight: 700,
                color: '#1a1a1a',
                background: classBadgeColor,
                borderRadius: 2,
              }}>
              {classText}
            </div>
            {data?.documentNumber && (
              <div className="text-[8px] mt-0.5 tracking-wider"
                style={{ fontFamily: 'JetBrains Mono, monospace', color: '#555' }}>
                {data.documentNumber}
              </div>
            )}
          </div>
        </div>

        <div className="h-px mt-2 mb-2" style={{ background: FAA_BLUE, opacity: 0.4 }} />

        {/* BIO ROW */}
        <div className="grid grid-cols-12 gap-x-2 gap-y-1 text-[10px]">
          <Field className="col-span-7" label="Holder Name" value={n.full} big />
          <Field className="col-span-3" label="Date of Birth" value={dob ? formatLongDate(dob) : null} />
          <Field className="col-span-2" label="Sex" value={data?.sex} mono />
          <Field className="col-span-6" label="Date of Examination" value={examDate ? formatLongDate(examDate) : null} />
          <Field className="col-span-6" label="Date of Issue" value={issued ? formatLongDate(issued) : null} />
        </div>

        {/* EXPIRATION TABLE — the key dynamic feature */}
        <div className="mt-2 flex-1 min-h-0">
          <div className="text-[7.5px] tracking-[0.2em] mb-1"
            style={{ fontFamily: 'JetBrains Mono, monospace', color: FAA_GREEN, fontWeight: 700 }}>
            EXPIRATION OF PRIVILEGES · 14 CFR 61.23(d){age != null ? ` · AGE AT EXAM ${age}` : ''}
          </div>
          {expirations && expirations.length > 0 ? (
            <div className="space-y-0.5">
              {expirations.map((e) => {
                const isOps = e.privilege === 'Commercial' || e.privilege === 'ATP';
                const daysLeft = Math.floor((e.expires.getTime() - Date.now()) / 86400000);
                const status = daysLeft < 0 ? 'expired' : daysLeft <= 60 ? 'soon' : 'ok';
                const statusColor = status === 'expired' ? '#b71c1c' : status === 'soon' ? '#bf6b00' : '#2e7d32';
                return (
                  <div key={e.privilege}
                    className="flex items-center justify-between text-[10px]"
                    style={{ fontFamily: 'JetBrains Mono, monospace', color: isOps ? '#1a1a1a' : '#666' }}>
                    <span style={{ fontWeight: isOps ? 700 : 400 }}>
                      {e.privilege.toUpperCase()}
                      <span style={{ color: '#999', fontWeight: 400 }}> · {e.months}MO</span>
                      {e.ageAffected && age != null ? <span style={{ color: '#999', fontWeight: 400 }}> · age-restricted</span> : ''}
                    </span>
                    <span>
                      <span style={{ color: '#1a1a1a' }}>{formatLongDate(e.expiresISO).toUpperCase()}</span>
                      <span className="ml-2" style={{ color: statusColor, fontWeight: 700 }}>
                        {daysLeft < 0 ? `EXPIRED ${Math.abs(daysLeft)}D` : `${daysLeft}D`}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : !cls || !examDate ? (
            <div className="text-[10px] italic" style={{ color: '#999' }}>
              Need class + exam date to compute expirations.
            </div>
          ) : !dob ? (
            <div className="text-[10px]" style={{ color: '#bf6b00' }}>
              <Info className="w-3 h-3 inline mr-1 -mt-0.5" />
              Upload passport or driver's license for accurate expiration.
              Showing under-40 estimates.
            </div>
          ) : (
            <div className="text-[10px] italic" style={{ color: '#999' }}>
              No expirations computed.
            </div>
          )}
        </div>

        {/* RESTRICTIONS */}
        {restrictions && (
          <div className="mt-1 px-2 py-1" style={{ background: '#fff3d6', border: '1px solid #ecd49a' }}>
            <div className="text-[7px] tracking-[0.2em] mb-0.5" style={{ fontFamily: 'JetBrains Mono, monospace', color: '#7a5a00', fontWeight: 700 }}>
              LIMITATIONS / RESTRICTIONS
            </div>
            <div className="text-[10px] leading-snug" style={{ fontFamily: 'Georgia, serif', color: '#1a1a1a' }}>
              {restrictions}
            </div>
          </div>
        )}

        {/* AME / FOOTER */}
        <div className="mt-1.5 pt-1.5 border-t flex items-end justify-between" style={{ borderColor: '#d8d3c4' }}>
          <div>
            <div className="text-[6.5px] tracking-[0.18em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: FAA_GREEN, fontWeight: 700 }}>
              AVIATION MEDICAL EXAMINER
            </div>
            <div className="text-[10px]" style={{ fontFamily: 'Georgia, serif', color: '#1a1a1a' }}>
              {ameName || <span style={{ color: '#aaa', fontStyle: 'italic' }}>—</span>}
              {ameNumber && <span className="ml-2" style={{ fontFamily: 'JetBrains Mono, monospace', color: '#555' }}>#{ameNumber}</span>}
            </div>
          </div>
          <div className="text-[6.5px] tracking-[0.3em] text-right" style={{ fontFamily: 'Georgia, serif', color: FAA_BLUE, fontWeight: 700 }}>
            14 CFR 67
          </div>
        </div>
      </div>
    </div>
  );
}

// --- 3. PASSPORT ------------------------------------------------------------
// Deep navy passport bio-page style with gold Great Seal, photo
// placeholder, and machine-readable zone at the bottom.

function PassportCard({ data, owner }) {
  const n = combineName(data, owner);
  const country = data?.passportCountryCode || data?.issuingAuthority || 'USA';
  const passportNo = data?.documentNumber || '';
  const type = data?.passportType || 'P';
  const NAVY = '#0F1B3D';
  const GOLD = '#c5a572';
  const CREAM = '#f5f0e4';

  // MRZ — use parsed values if present, else build a plausible-looking one.
  const buildMrz = () => {
    if (data?.mrzLine1 && data?.mrzLine2) {
      return { l1: data.mrzLine1, l2: data.mrzLine2 };
    }
    const cc = (country || 'USA').toUpperCase().slice(0, 3).padEnd(3, '<');
    const surname = (n.surname || '').replace(/[^A-Z]/g, '').slice(0, 20);
    const given = (n.given || '').replace(/[^A-Z\s]/g, '').replace(/\s+/g, '<').slice(0, 20);
    const l1 = `P<${cc}${surname}<<${given}`.padEnd(44, '<').slice(0, 44);
    const pn = (passportNo || '').replace(/[^A-Z0-9]/g, '').slice(0, 9).padEnd(9, '<');
    const l2 = `${pn}${cc}`.padEnd(44, '<').slice(0, 44);
    return { l1, l2 };
  };
  const mrz = buildMrz();

  return (
    <div
      className="relative overflow-hidden shadow-lg"
      style={{
        aspectRatio: '1.586',
        background: `linear-gradient(135deg, ${NAVY} 0%, #1B2855 60%, #243370 100%)`,
        border: '1px solid #0a1228',
        borderRadius: 12,
        color: CREAM,
      }}
    >
      {/* Subtle weave texture */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20"
        viewBox="0 0 400 250" preserveAspectRatio="none">
        {Array.from({ length: 30 }).map((_, i) => (
          <line key={`h-${i}`} x1="0" y1={i * 9} x2="400" y2={i * 9 + 2}
            stroke={GOLD} strokeWidth="0.2" />
        ))}
        {Array.from({ length: 50 }).map((_, i) => (
          <line key={`v-${i}`} x1={i * 9} y1="0" x2={i * 9 - 4} y2="250"
            stroke={GOLD} strokeWidth="0.15" />
        ))}
      </svg>

      <div className="relative h-full px-4 py-3 flex flex-col">
        {/* HEADER */}
        <div className="flex items-start gap-3">
          <GreatSeal size={44} />
          <div className="flex-1 text-center">
            <div className="text-[10px] tracking-[0.3em]" style={{ fontFamily: 'Georgia, serif', color: GOLD, fontWeight: 700 }}>
              UNITED STATES OF AMERICA
            </div>
            <div className="text-[7.5px] tracking-[0.4em] mt-0.5" style={{ fontFamily: 'Georgia, serif', color: GOLD, opacity: 0.8 }}>
              PASSPORT · PASSEPORT · PASAPORTE
            </div>
          </div>
          <div className="w-11" />
        </div>

        <div className="h-px mt-2 mb-2" style={{ background: GOLD, opacity: 0.4 }} />

        {/* BODY: photo + bio */}
        <div className="flex gap-3 flex-1 min-h-0">
          {/* Photo column */}
          <div className="w-[28%] flex flex-col gap-1">
            <div style={{ height: '70%', border: `1px solid ${GOLD}`, opacity: 0.85 }}>
              <PhotoPlaceholder className="w-full h-full" tone="dark" />
            </div>
            <div className="text-[6.5px] text-center tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.7 }}>
              SIGNATURE
            </div>
            <div className="h-px" style={{ background: GOLD, opacity: 0.4 }} />
          </div>

          {/* Data column */}
          <div className="flex-1 grid grid-cols-12 gap-x-2 gap-y-1.5 text-[10px] min-w-0">
            <div className="col-span-3">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Type</div>
              <div className="text-[12px]" style={{ fontFamily: 'JetBrains Mono, monospace', color: CREAM, fontWeight: 700 }}>{type}</div>
            </div>
            <div className="col-span-3">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Code</div>
              <div className="text-[12px]" style={{ fontFamily: 'JetBrains Mono, monospace', color: CREAM, fontWeight: 700 }}>{country}</div>
            </div>
            <div className="col-span-6">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Passport No.</div>
              <div className="text-[12px] tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace', color: CREAM, fontWeight: 700 }}>
                {passportNo || <span style={{ color: '#888', fontStyle: 'italic', fontWeight: 400 }}>—</span>}
              </div>
            </div>

            <div className="col-span-12">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Surname</div>
              <div className="text-[12px]" style={{ fontFamily: 'Georgia, serif', color: CREAM, fontWeight: 600 }}>
                {n.surname || <span style={{ color: '#888', fontStyle: 'italic' }}>—</span>}
              </div>
            </div>
            <div className="col-span-12">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Given Names</div>
              <div className="text-[12px]" style={{ fontFamily: 'Georgia, serif', color: CREAM, fontWeight: 600 }}>
                {n.given || <span style={{ color: '#888', fontStyle: 'italic' }}>—</span>}
              </div>
            </div>

            <div className="col-span-4">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Nationality</div>
              <div className="text-[10px]" style={{ fontFamily: 'Georgia, serif', color: CREAM }}>
                {data?.nationality || country || '—'}
              </div>
            </div>
            <div className="col-span-5">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Date of Birth</div>
              <div className="text-[10px]" style={{ fontFamily: 'Georgia, serif', color: CREAM }}>
                {data?.dob ? formatLongDate(data.dob) : <span style={{ color: '#888', fontStyle: 'italic' }}>—</span>}
              </div>
            </div>
            <div className="col-span-3">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Sex</div>
              <div className="text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace', color: CREAM, fontWeight: 700 }}>
                {data?.sex || '—'}
              </div>
            </div>

            <div className="col-span-12">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Place of Birth</div>
              <div className="text-[10px]" style={{ fontFamily: 'Georgia, serif', color: CREAM }}>
                {data?.placeOfBirth || <span style={{ color: '#888', fontStyle: 'italic' }}>—</span>}
              </div>
            </div>

            <div className="col-span-6">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Date of Issue</div>
              <div className="text-[10px]" style={{ fontFamily: 'Georgia, serif', color: CREAM }}>
                {data?.issueDate ? formatLongDate(data.issueDate) : <span style={{ color: '#888', fontStyle: 'italic' }}>—</span>}
              </div>
            </div>
            <div className="col-span-6">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: GOLD, opacity: 0.75 }}>Date of Expiration</div>
              <div className="text-[10px]" style={{ fontFamily: 'Georgia, serif', color: CREAM, fontWeight: 700 }}>
                {data?.expiration ? formatLongDate(data.expiration) : <span style={{ color: '#888', fontStyle: 'italic', fontWeight: 400 }}>—</span>}
              </div>
            </div>
          </div>
        </div>

        {/* MRZ */}
        <div className="mt-2 pt-1.5 border-t" style={{ borderColor: GOLD, borderTopWidth: 1, borderTopStyle: 'solid', opacity: 1 }}>
          <div className="text-[8.5px] leading-tight tracking-[0.05em]"
            style={{ fontFamily: 'JetBrains Mono, monospace', color: CREAM, opacity: 0.85, letterSpacing: '0.02em' }}>
            <div>{mrz.l1}</div>
            <div>{mrz.l2}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- 4. DRIVER'S LICENSE ----------------------------------------------------
// Modern American DL style. Blue header strip with state seal, light
// background, prominent DL number + expiration, photo placeholder,
// full address, restrictions, donor/veteran badges.

function DriversLicenseCard({ data, owner }) {
  const n = combineName(data, owner);
  const state = (data?.addressState || data?.issuingAuthority || '').toUpperCase();
  const dlNo = data?.documentNumber || '';
  const cls = data?.licenseClass || '';
  const issued = data?.issueDate;
  const expires = data?.expiration;
  const restrictions = data?.licenseRestrictions || '';
  const endorsements = data?.licenseEndorsements || '';
  const isDonor = data?.organDonor === true;
  const isVeteran = data?.veteran === true;
  const addressLines = formatAddress(data);

  const DARK_BLUE = '#1a4480';
  const LIGHT_BG = 'linear-gradient(135deg, #f0f4fc 0%, #dfe7f4 60%, #c3d3ea 100%)';

  return (
    <div
      className="relative overflow-hidden shadow-lg"
      style={{
        aspectRatio: '1.586',
        background: LIGHT_BG,
        border: '1px solid #a8b8d0',
        borderRadius: 12,
        color: '#1a1a1a',
      }}
    >
      {/* Holographic security overlay */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-25"
        viewBox="0 0 400 250" preserveAspectRatio="none">
        {Array.from({ length: 16 }).map((_, i) => (
          <line key={i} x1={-50 + i * 30} y1="0" x2={i * 30} y2="250"
            stroke="#1a4480" strokeWidth="0.4" />
        ))}
      </svg>

      {/* Header strip */}
      <div className="absolute top-0 left-0 right-0 px-3 py-1.5 flex items-center justify-between"
        style={{ background: DARK_BLUE, color: '#fff' }}>
        <div className="flex items-center gap-2">
          <StateSeal size={26} state={state} />
          <div>
            <div className="text-[10px] tracking-[0.25em]" style={{ fontFamily: 'Georgia, serif', fontWeight: 700 }}>
              {state ? state : 'UNITED STATES'}
            </div>
            <div className="text-[7px] tracking-[0.28em] opacity-80" style={{ fontFamily: 'Georgia, serif' }}>
              DRIVER LICENSE
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {isVeteran && (
            <div className="px-1.5 py-0.5 text-[7px] tracking-widest" style={{ background: '#c5a572', color: '#1a1a1a', fontWeight: 700, borderRadius: 2 }}>
              VETERAN
            </div>
          )}
          {isDonor && (
            <div className="px-1.5 py-0.5 text-[7px] tracking-widest" style={{ background: '#b71c1c', color: '#fff', fontWeight: 700, borderRadius: 2 }}>
              ♥ DONOR
            </div>
          )}
          {cls && (
            <div className="px-2 py-0.5 text-[10px] tracking-wider"
              style={{ background: '#c5a572', color: '#1a1a1a', fontWeight: 700, borderRadius: 2, fontFamily: 'JetBrains Mono, monospace' }}>
              CLASS {cls}
            </div>
          )}
        </div>
      </div>

      <div className="relative h-full pt-10 px-3 pb-2 flex gap-3" style={{ color: '#1a1a1a' }}>
        {/* Photo column */}
        <div className="w-[26%] flex flex-col gap-1">
          <div style={{ height: '78%', border: '1px solid #8090a8' }}>
            <PhotoPlaceholder className="w-full h-full" tone="light" />
          </div>
          <div className="text-[6px] text-center tracking-[0.2em]"
            style={{ fontFamily: 'JetBrains Mono, monospace', color: '#5a6478' }}>
            SIGNATURE
          </div>
          <div className="h-px" style={{ background: '#8090a8' }} />
        </div>

        {/* Data column */}
        <div className="flex-1 grid grid-cols-12 gap-x-2 gap-y-1 text-[10px] min-w-0">
          <div className="col-span-12">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>
              4d DL NO.
            </div>
            <div className="text-[14px] tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: DARK_BLUE }}>
              {dlNo || <span style={{ color: '#aaa', fontStyle: 'italic', fontWeight: 400 }}>—</span>}
            </div>
          </div>

          <div className="col-span-6">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>
              4b EXP
            </div>
            <div className="text-[12px]" style={{ fontFamily: 'Georgia, serif', fontWeight: 700 }}>
              {expires ? formatLongDate(expires) : <span style={{ color: '#aaa', fontStyle: 'italic', fontWeight: 400 }}>—</span>}
            </div>
          </div>
          <div className="col-span-6">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>
              4a ISS
            </div>
            <div className="text-[12px]" style={{ fontFamily: 'Georgia, serif' }}>
              {issued ? formatLongDate(issued) : <span style={{ color: '#aaa', fontStyle: 'italic' }}>—</span>}
            </div>
          </div>

          <div className="col-span-12 mt-0.5">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>
              1 LN, FN
            </div>
            <div className="text-[12px] leading-tight" style={{ fontFamily: 'Georgia, serif', fontWeight: 700 }}>
              {n.surname || '—'}{n.given ? `, ${n.given}` : ''}
            </div>
          </div>

          {addressLines.length > 0 && (
            <div className="col-span-12">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>
                8 ADDRESS
              </div>
              <div className="text-[9.5px] leading-tight" style={{ fontFamily: 'Georgia, serif' }}>
                {addressLines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          )}

          <div className="col-span-3">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>3 DOB</div>
            <div className="text-[10px]" style={{ fontFamily: 'Georgia, serif' }}>
              {data?.dob ? formatLongDate(data.dob) : '—'}
            </div>
          </div>
          <div className="col-span-2">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>15 SEX</div>
            <div className="text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
              {data?.sex || '—'}
            </div>
          </div>
          <div className="col-span-3">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>16 HT</div>
            <div className="text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {data?.height || '—'}
            </div>
          </div>
          <div className="col-span-2">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>18 EYES</div>
            <div className="text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {data?.eyeColor || '—'}
            </div>
          </div>
          <div className="col-span-2">
            <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>17 WT</div>
            <div className="text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {data?.weight || '—'}
            </div>
          </div>

          {(restrictions || endorsements) && (
            <div className="col-span-12">
              <div className="text-[6.5px] tracking-[0.2em]" style={{ fontFamily: 'JetBrains Mono, monospace', color: DARK_BLUE, fontWeight: 700 }}>
                12 RESTR · 9 END
              </div>
              <div className="text-[10px] leading-snug" style={{ fontFamily: 'Georgia, serif' }}>
                {[restrictions, endorsements].filter(Boolean).join(' · ')}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- EMPTY CARD -------------------------------------------------------------
function EmptyDocCard({ docType }) {
  const Icon = docType.icon;
  return (
    <div
      className="relative flex items-center justify-center"
      style={{
        aspectRatio: '1.586',
        background: 'linear-gradient(135deg, rgba(30,192,233,0.04) 0%, rgba(30,192,233,0.01) 100%)',
        border: '1.5px dashed rgba(30,192,233,0.25)',
        borderRadius: 12,
      }}
    >
      <div className="text-center px-6">
        <Icon className="w-9 h-9 mx-auto mb-2 text-cyan-400/40" />
        <div className="text-[11px] tracking-[0.25em] text-cyan-300/70"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          NO {docType.label.toUpperCase()} ON FILE
        </div>
        <div className="text-[10px] text-slate-500 mt-1.5"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          Upload below to render
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

  // The OLD client-side approach used fetch() against Firebase Storage URLs,
  // which fails on Safari with "Failed to download: Load failed" because
  // Firebase Storage requires bucket-level CORS configuration to allow
  // cross-origin browser fetches. We now POST the file manifest to
  // /api/bulk-download-pilot-docs which fetches + zips server-side and
  // streams the ZIP back as an attachment — no CORS issues, no JSZip CDN
  // dependency, no client memory pressure on large crews.

  const handleDownload = async () => {
    setBusy(true);
    setErr('');
    setProgress('Preparing manifest...');
    try {
      const safeName = String(crewName || crewUid || 'crew')
        .replace(/[^a-zA-Z0-9 ._-]/g, '_').trim() || 'crew';

      // Build manifest: one entry per file with friendly folder + filename.
      // Order by docType then uploadedAt so the ZIP layout is stable.
      const byType = docs.reduce((acc, d) => {
        (acc[d.docType || 'misc'] = acc[d.docType || 'misc'] || []).push(d);
        return acc;
      }, {});

      const files = [];
      for (const [type, list] of Object.entries(byType)) {
        list.sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
        list.forEach((d, idx) => {
          if (!d.fileUrl) return;
          // Storage path's basename for uniqueness; prefix with the user
          // label so front/back/etc. are distinguishable.
          const storageBaseName = (d.filePath || '').split('/').pop()
            || d.fileName || `file-${idx + 1}`;
          const labelPrefix = d.fileLabel
            ? d.fileLabel.replace(/[^a-zA-Z0-9 ._-]/g, '_') + '__'
            : '';
          files.push({
            url: d.fileUrl,
            folder: type,
            filename: `${labelPrefix}${storageBaseName}`,
          });
        });
      }

      if (files.length === 0) {
        throw new Error('No downloadable files (all entries missing fileUrl).');
      }

      // Auth: forward Firebase ID token so the API can verify the caller.
      setProgress('Authenticating...');
      let idToken = null;
      try {
        const { auth } = await import('./firebase.js');
        if (auth.currentUser) idToken = await auth.currentUser.getIdToken();
      } catch (_) {}

      setProgress(`Building ZIP server-side · ${files.length} file${files.length === 1 ? '' : 's'}...`);
      const resp = await fetch('/api/bulk-download-pilot-docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, crewName: safeName, files }),
      });

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          if (j?.error) detail = j.error;
        } catch (_) {}
        throw new Error(detail);
      }

      setProgress('Streaming ZIP to browser...');
      const blob = await resp.blob();
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
