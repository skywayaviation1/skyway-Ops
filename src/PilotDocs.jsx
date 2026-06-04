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
// CARD VISUALIZATIONS v4 — restrained, typography-driven document renderings
// ============================================================================
// Design principles:
//   - One tasteful emblem per card, not multiple competing seals
//   - Typography carries the design; ornament is subtle and minimal
//   - Generous whitespace; cards read as premium digital IDs, not forgeries
//   - Every parsed field shown when present, em-dash when missing
//   - All four cards: ISO/IEC 7810 ID-1 aspect (1.586) so they feel like
//     real plastic cards / passport pages

// --- SHARED COMPONENTS ------------------------------------------------------

// Compact field renderer used across all cards.
function CardField({ label, value, accent = '#6b5e3f', valueColor = '#1a1a1a', mono = false, big = false, italic = false, className = '' }) {
  const empty = value == null || value === '';
  return (
    <div className={className}>
      <div
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 7,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: accent,
          fontWeight: 600,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? 'JetBrains Mono, ui-monospace, monospace' : 'Georgia, "Times New Roman", serif',
          fontSize: big ? 14 : 11,
          fontWeight: big ? 600 : 500,
          fontStyle: empty ? 'italic' : 'normal',
          color: empty ? '#aaa' : valueColor,
          lineHeight: 1.2,
        }}
      >
        {empty ? '—' : value}
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

// --- SHARED SVG EMBLEMS -----------------------------------------------------
// Restrained, elegant emblems — not attempting to forge official seals.

// FAA mark — clean blue roundel with a stylized aircraft silhouette.
function FaaMark({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id="faaRing" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1e4a8a" />
          <stop offset="100%" stopColor="#0a2d5e" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="url(#faaRing)" />
      <circle cx="50" cy="50" r="44" fill="none" stroke="#ffffff" strokeWidth="0.6" opacity="0.35" />
      {/* Stylized aircraft — clean silhouette */}
      <g fill="#ffffff">
        <path d="M 50 28 L 53 50 L 78 56 L 78 60 L 53 58 L 53 70 L 60 74 L 60 77 L 50 75 L 40 77 L 40 74 L 47 70 L 47 58 L 22 60 L 22 56 L 47 50 Z" />
      </g>
      <text
        x="50"
        y="92"
        textAnchor="middle"
        fill="#ffffff"
        fontFamily="Georgia, serif"
        fontWeight="700"
        fontSize="9"
        letterSpacing="0.15em"
      >
        FAA
      </text>
    </svg>
  );
}

// American shield — gold geometric mark for passport. Cleaner than a
// fake eagle at small sizes.
function ShieldMark({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id="goldShield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e6cd95" />
          <stop offset="50%" stopColor="#c5a572" />
          <stop offset="100%" stopColor="#8a7349" />
        </linearGradient>
      </defs>
      {/* Outer rim */}
      <path
        d="M 50 8 L 90 18 L 90 50 Q 90 78 50 92 Q 10 78 10 50 L 10 18 Z"
        fill="none"
        stroke="url(#goldShield)"
        strokeWidth="1.4"
      />
      {/* Inner shield */}
      <path
        d="M 50 16 L 82 24 L 82 48 Q 82 72 50 84 Q 18 72 18 48 L 18 24 Z"
        fill="none"
        stroke="url(#goldShield)"
        strokeWidth="0.8"
        opacity="0.7"
      />
      {/* Top blue/dark field representing chief */}
      <path
        d="M 50 16 L 82 24 L 82 38 L 18 38 L 18 24 Z"
        fill="url(#goldShield)"
        opacity="0.18"
      />
      {/* Star cluster */}
      <g fill="url(#goldShield)">
        {[
          [42, 24], [50, 22], [58, 24],
          [38, 30], [46, 28], [54, 28], [62, 30],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="0.9" />
        ))}
      </g>
      {/* Vertical stripes */}
      <g stroke="url(#goldShield)" strokeWidth="0.5" opacity="0.55">
        {[28, 34, 40, 46, 52, 58, 64, 70].map((x) => (
          <line key={x} x1={x} y1="42" x2={x} y2={68 - Math.abs(x - 49) * 0.4} />
        ))}
      </g>
    </svg>
  );
}

// State emblem for DL — clean star inside a thin gold ring on navy.
function StateMark({ size = 32, state = '' }) {
  const initial = (state || '').slice(0, 2).toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id="stateNavy" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1a3d70" />
          <stop offset="100%" stopColor="#0a2042" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill="url(#stateNavy)" />
      <circle cx="50" cy="50" r="42" fill="none" stroke="#c5a572" strokeWidth="0.6" />
      <path
        d="M 50 22 L 56 42 L 76 42 L 60 54 L 66 74 L 50 62 L 34 74 L 40 54 L 24 42 L 44 42 Z"
        fill="#c5a572"
        opacity="0.95"
      />
      {initial && (
        <text
          x="50"
          y="56"
          textAnchor="middle"
          fill="#0a2042"
          fontFamily="Georgia, serif"
          fontWeight="700"
          fontSize="12"
        >
          {initial}
        </text>
      )}
    </svg>
  );
}

// Photo placeholder — subtle silhouette only, no security pattern noise.
function PhotoFrame({ tone = 'dark' }) {
  const isDark = tone === 'dark';
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 100 130"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        <linearGradient id={isDark ? 'photoDarkBg' : 'photoLightBg'} x1="0" y1="0" x2="0" y2="1">
          {isDark ? (
            <>
              <stop offset="0%" stopColor="#1a2848" />
              <stop offset="100%" stopColor="#0a1530" />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="#dde4ee" />
              <stop offset="100%" stopColor="#bcc6d4" />
            </>
          )}
        </linearGradient>
      </defs>
      <rect width="100" height="130" fill={`url(#${isDark ? 'photoDarkBg' : 'photoLightBg'})`} />
      {/* Soft silhouette */}
      <g fill={isDark ? '#2d3d5e' : '#9ba8b8'} opacity="0.55">
        <circle cx="50" cy="48" r="14" />
        <path d="M 22 130 Q 22 84 50 84 Q 78 84 78 130 Z" />
      </g>
    </svg>
  );
}

// =============================================================================
// 1. AIRMAN CERTIFICATE
// =============================================================================
// Premium digital take on the FAA airman certificate. Warm sepia card,
// FAA navy + muted gold accents, Georgia serif throughout. No fake
// watermarks or security textures — typography and color do the work.

function AirmanCertificateCard({ data, owner }) {
  const n = combineName(data, owner);
  const certNo = data?.documentNumber || '';
  const certType = data?.certType || '';
  const ratings = data?.ratings || '';
  const limitations = data?.limitations || '';
  const issued = data?.issueDate;
  const addressLines = formatAddress(data);

  const NAVY = '#0a2d5e';
  const GOLD = '#a88a4f';
  const INK = '#231a0e';

  return (
    <div
      style={{
        aspectRatio: '1.586',
        background: 'linear-gradient(135deg, #f6efd9 0%, #ece2c0 100%)',
        borderRadius: 14,
        border: '1px solid #d4c592',
        boxShadow: '0 10px 30px -10px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.15) inset',
        color: INK,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Subtle corner ornament */}
      <div style={{
        position: 'absolute', top: 0, right: 0, width: 110, height: 110,
        background: `radial-gradient(circle at top right, ${GOLD}15, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      <div style={{ padding: '14px 18px', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* HEADER */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <FaaMark size={38} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontFamily: 'Georgia, serif', color: NAVY, fontWeight: 700, fontSize: 8.5, letterSpacing: '0.32em' }}>
              UNITED STATES OF AMERICA
            </div>
            <div style={{ fontFamily: 'Georgia, serif', color: '#5a4a2e', fontSize: 6.5, letterSpacing: '0.28em', marginTop: 1 }}>
              DEPARTMENT OF TRANSPORTATION · FEDERAL AVIATION ADMINISTRATION
            </div>
          </div>
          <div style={{ minWidth: 78, textAlign: 'right' }}>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 6.5, letterSpacing: '0.22em', color: GOLD, fontWeight: 600 }}>
              CERTIFICATE
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11, color: NAVY, fontWeight: 700, letterSpacing: '0.03em', marginTop: 1 }}>
              {certNo || <span style={{ color: '#bbb', fontStyle: 'italic', fontWeight: 400 }}>—</span>}
            </div>
          </div>
        </div>

        {/* TITLE */}
        <div style={{ textAlign: 'center', margin: '10px 0 8px' }}>
          <div style={{
            display: 'inline-block',
            fontFamily: 'Georgia, serif',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.38em',
            color: NAVY,
            borderTop: `0.5px solid ${GOLD}`,
            borderBottom: `0.5px solid ${GOLD}`,
            padding: '3px 14px',
          }}>
            AIRMAN CERTIFICATE
          </div>
        </div>

        {/* BIO BODY */}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '7px 12px', alignContent: 'start' }}>
          <CardField className="col-span-8" label="Name" value={n.full} accent={GOLD} valueColor={INK} big
            // tailwind doesn't grok inline col-span — use style fallback
          />
          <CardField className="col-span-4" label="Date of Birth" value={data?.dob ? formatLongDate(data.dob) : null} accent={GOLD} valueColor={INK} />

          {addressLines.length > 0 && (
            <div style={{ gridColumn: 'span 8 / span 8' }}>
              <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 7, letterSpacing: '0.22em', color: GOLD, fontWeight: 600, marginBottom: 2 }}>
                ADDRESS
              </div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: 10.5, lineHeight: 1.3, color: INK }}>
                {addressLines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          )}
          <div style={{ gridColumn: 'span 4 / span 4', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <CardField label="Sex" value={data?.sex} accent={GOLD} valueColor={INK} mono />
            <CardField label="Nationality" value={data?.nationality} accent={GOLD} valueColor={INK} />
          </div>

          <div style={{ gridColumn: 'span 12 / span 12', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <CardField label="Height" value={data?.height} accent={GOLD} valueColor={INK} mono />
            <CardField label="Weight" value={data?.weight} accent={GOLD} valueColor={INK} mono />
            <CardField label="Hair"   value={data?.hairColor} accent={GOLD} valueColor={INK} mono />
            <CardField label="Eyes"   value={data?.eyeColor}  accent={GOLD} valueColor={INK} mono />
          </div>

          <div style={{ gridColumn: 'span 12 / span 12', borderTop: `0.5px solid ${GOLD}66`, paddingTop: 6, marginTop: 2 }}>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 7, letterSpacing: '0.22em', color: GOLD, fontWeight: 600 }}>
              GRADE OF CERTIFICATE
            </div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 13, fontWeight: 700, color: NAVY, letterSpacing: '0.04em', marginTop: 1 }}>
              {certType ? certType.toUpperCase() : <span style={{ color: '#bbb', fontStyle: 'italic', fontWeight: 400 }}>—</span>}
            </div>
          </div>

          {(ratings || limitations) && (
            <div style={{ gridColumn: 'span 12 / span 12' }}>
              <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 7, letterSpacing: '0.22em', color: GOLD, fontWeight: 600 }}>
                RATINGS AND LIMITATIONS
              </div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: 10, lineHeight: 1.35, color: INK, marginTop: 1 }}>
                {[ratings, limitations].filter(Boolean).join(' · ')}
              </div>
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div style={{
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          marginTop: 8, paddingTop: 6, borderTop: `0.5px solid ${GOLD}66`,
        }}>
          <div>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 6.5, letterSpacing: '0.22em', color: GOLD, fontWeight: 600 }}>
              DATE OF ISSUE
            </div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 10, color: INK, marginTop: 1 }}>
              {issued ? formatLongDate(issued).toUpperCase() : '—'}
            </div>
          </div>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 8, letterSpacing: '0.32em', color: NAVY, fontWeight: 700 }}>
            14 CFR 61 · DOES NOT EXPIRE
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 2. MEDICAL CERTIFICATE
// =============================================================================
// Document-paper style. White card, FAA navy text, class as a colored
// ribbon in the corner. The FAA expiration table is the hero feature.

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

  const classText = ({ '1': 'FIRST CLASS', '2': 'SECOND CLASS', '3': 'THIRD CLASS' })[String(cls)] || '—';
  const classColor = ({
    '1': { bg: '#c9a861', fg: '#3a2a0a' },
    '2': { bg: '#a8a8a8', fg: '#1a1a1a' },
    '3': { bg: '#9a7547', fg: '#fff' },
  })[String(cls)] || { bg: '#999', fg: '#fff' };

  const NAVY = '#0a2d5e';
  const GOLD = '#9a7d3e';
  const INK = '#1a1a1a';

  return (
    <div
      style={{
        aspectRatio: '1.586',
        background: 'linear-gradient(180deg, #fefdf9 0%, #f8f5ec 100%)',
        borderRadius: 14,
        border: '1px solid #e2dac4',
        boxShadow: '0 10px 30px -10px rgba(0,0,0,0.4)',
        position: 'relative',
        overflow: 'hidden',
        color: INK,
      }}
    >
      {/* Class ribbon in top-right corner */}
      <div style={{
        position: 'absolute', top: 14, right: -28, transform: 'rotate(34deg)',
        background: classColor.bg, color: classColor.fg,
        padding: '3px 32px', fontFamily: 'Georgia, serif', fontWeight: 700,
        fontSize: 8, letterSpacing: '0.22em', textAlign: 'center',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }}>
        {classText}
      </div>

      <div style={{ padding: '14px 18px', height: '100%', display: 'flex', flexDirection: 'column' }}>
        {/* HEADER */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FaaMark size={32} />
          <div>
            <div style={{ fontFamily: 'Georgia, serif', color: NAVY, fontWeight: 700, fontSize: 7.5, letterSpacing: '0.28em' }}>
              FEDERAL AVIATION ADMINISTRATION
            </div>
            <div style={{ fontFamily: 'Georgia, serif', color: INK, fontWeight: 700, fontSize: 13, letterSpacing: '0.16em', marginTop: 1 }}>
              AIRMAN MEDICAL CERTIFICATE
            </div>
          </div>
        </div>

        <div style={{ height: 1, background: NAVY, opacity: 0.35, margin: '9px 0 9px' }} />

        {/* BIO ROW */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '6px 12px' }}>
          <div style={{ gridColumn: 'span 7' }}>
            <CardField label="Holder Name" value={n.full} accent={GOLD} valueColor={INK} big />
          </div>
          <div style={{ gridColumn: 'span 3' }}>
            <CardField label="Date of Birth" value={dob ? formatLongDate(dob) : null} accent={GOLD} valueColor={INK} />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <CardField label="Sex" value={data?.sex} accent={GOLD} valueColor={INK} mono />
          </div>
          <div style={{ gridColumn: 'span 6' }}>
            <CardField label="Date of Examination" value={examDate ? formatLongDate(examDate) : null} accent={GOLD} valueColor={INK} />
          </div>
          <div style={{ gridColumn: 'span 4' }}>
            <CardField label="Date of Issue" value={issued ? formatLongDate(issued) : null} accent={GOLD} valueColor={INK} />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <CardField label="Cert No." value={data?.documentNumber} accent={GOLD} valueColor={INK} mono />
          </div>
        </div>

        {/* EXPIRATION TABLE — the hero feature */}
        <div style={{ marginTop: 8, flex: 1, minHeight: 0 }}>
          <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 7, letterSpacing: '0.22em', color: GOLD, fontWeight: 700, marginBottom: 4 }}>
            EXPIRATION OF PRIVILEGES · 14 CFR 61.23(d){age != null ? ` · AGE AT EXAM ${age}` : ''}
          </div>
          {expirations && expirations.length > 0 ? (
            <div style={{ borderTop: `0.5px solid #d8cfb2` }}>
              {expirations.map((e) => {
                const isOps = e.privilege === 'Commercial' || e.privilege === 'ATP';
                const daysLeft = Math.floor((e.expires.getTime() - Date.now()) / 86400000);
                const status = daysLeft < 0 ? 'expired' : daysLeft <= 60 ? 'soon' : 'ok';
                const statusColor = status === 'expired' ? '#b71c1c' : status === 'soon' ? '#a66400' : '#2e7d32';
                return (
                  <div key={e.privilege} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '4px 0', borderBottom: `0.5px solid #ede5cc`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{
                        fontFamily: 'Georgia, serif',
                        fontSize: isOps ? 11 : 10,
                        fontWeight: isOps ? 700 : 500,
                        color: isOps ? INK : '#7a7568',
                        letterSpacing: '0.05em',
                      }}>
                        {e.privilege.toUpperCase()}
                      </span>
                      <span style={{
                        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                        fontSize: 8,
                        color: '#999',
                        letterSpacing: '0.08em',
                      }}>
                        {e.months} MO
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ fontFamily: 'Georgia, serif', fontSize: 10, color: INK }}>
                        {formatLongDate(e.expiresISO).toUpperCase()}
                      </span>
                      <span style={{
                        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                        fontSize: 9, fontWeight: 700, color: statusColor,
                        minWidth: 60, textAlign: 'right',
                      }}>
                        {daysLeft < 0 ? `EXPIRED ${Math.abs(daysLeft)}D` : `${daysLeft} D`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !cls || !examDate ? (
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 10, fontStyle: 'italic', color: '#999' }}>
              Need class + exam date to compute expirations.
            </div>
          ) : !dob ? (
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 10, color: '#a66400', fontStyle: 'italic' }}>
              <Info style={{ display: 'inline-block', width: 11, height: 11, marginRight: 4, verticalAlign: '-1px' }} />
              Upload passport or driver's license for accurate age-based expiration.
            </div>
          ) : null}
        </div>

        {/* RESTRICTIONS */}
        {restrictions && (
          <div style={{ marginTop: 6, padding: '5px 8px', background: '#fbf3df', borderLeft: `2px solid ${GOLD}` }}>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 7, letterSpacing: '0.22em', color: GOLD, fontWeight: 700, marginBottom: 1 }}>
              LIMITATIONS / RESTRICTIONS
            </div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 10, color: INK, lineHeight: 1.3 }}>
              {restrictions}
            </div>
          </div>
        )}

        {/* FOOTER */}
        <div style={{
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          marginTop: 6, paddingTop: 6, borderTop: `0.5px solid #d8cfb2`,
        }}>
          <div>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 6.5, letterSpacing: '0.22em', color: GOLD, fontWeight: 600 }}>
              AVIATION MEDICAL EXAMINER
            </div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 10, color: INK, marginTop: 1 }}>
              {ameName || <span style={{ color: '#bbb', fontStyle: 'italic' }}>—</span>}
              {ameNumber && (
                <span style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 9, color: '#777', marginLeft: 8 }}>
                  #{ameNumber}
                </span>
              )}
            </div>
          </div>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 7, letterSpacing: '0.32em', color: NAVY, fontWeight: 700 }}>
            14 CFR 67
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 3. PASSPORT
// =============================================================================
// Deep navy bio-page styling. Gold shield mark replaces my earlier fake-
// eagle attempt. Generous spacing, all bio fields visible, MRZ rendered
// in proper monospace at the bottom.

function PassportCard({ data, owner }) {
  const n = combineName(data, owner);
  const country = data?.passportCountryCode || data?.issuingAuthority || 'USA';
  const passportNo = data?.documentNumber || '';
  const type = data?.passportType || 'P';
  const NAVY_BG = 'linear-gradient(135deg, #0a1a38 0%, #122a52 100%)';
  const GOLD = '#c5a572';
  const GOLD_MUTED = '#8a7349';
  const CREAM = '#f0e8d5';
  const CREAM_DIM = '#b8ad95';

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
      style={{
        aspectRatio: '1.586',
        background: NAVY_BG,
        borderRadius: 14,
        border: '1px solid #050d20',
        boxShadow: '0 10px 30px -10px rgba(0,0,0,0.65)',
        color: CREAM,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Subtle gold edge accent */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(90deg, transparent 0%, ${GOLD} 50%, transparent 100%)`,
        opacity: 0.4,
      }} />

      <div style={{ padding: '14px 18px', height: '100%', display: 'flex', flexDirection: 'column' }}>
        {/* HEADER */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <ShieldMark size={42} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Georgia, serif', color: GOLD, fontWeight: 700, fontSize: 10, letterSpacing: '0.32em' }}>
              UNITED STATES OF AMERICA
            </div>
            <div style={{ fontFamily: 'Georgia, serif', color: GOLD_MUTED, fontWeight: 600, fontSize: 7, letterSpacing: '0.42em', marginTop: 1, fontStyle: 'italic' }}>
              PASSPORT · PASSEPORT · PASAPORTE
            </div>
          </div>
        </div>

        <div style={{ height: 0.5, background: GOLD, opacity: 0.35, margin: '8px 0 8px' }} />

        {/* BODY */}
        <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
          {/* Photo column */}
          <div style={{ width: '28%', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ flex: 1, border: `1px solid ${GOLD}`, overflow: 'hidden' }}>
              <PhotoFrame tone="dark" />
            </div>
            <div style={{ height: 0.5, background: GOLD, opacity: 0.5 }} />
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 7, letterSpacing: '0.28em', color: GOLD_MUTED, textAlign: 'center', fontStyle: 'italic' }}>
              Signature
            </div>
          </div>

          {/* Data column */}
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '5px 10px', alignContent: 'start', minWidth: 0 }}>
            <div style={{ gridColumn: 'span 3' }}>
              <CardField label="Type" value={type} accent={GOLD_MUTED} valueColor={CREAM} mono />
            </div>
            <div style={{ gridColumn: 'span 3' }}>
              <CardField label="Code" value={country} accent={GOLD_MUTED} valueColor={CREAM} mono />
            </div>
            <div style={{ gridColumn: 'span 6' }}>
              <CardField label="Passport No." value={passportNo} accent={GOLD_MUTED} valueColor={CREAM} mono />
            </div>

            <div style={{ gridColumn: 'span 12' }}>
              <CardField label="Surname" value={n.surname} accent={GOLD_MUTED} valueColor={CREAM} />
            </div>
            <div style={{ gridColumn: 'span 12' }}>
              <CardField label="Given Names" value={n.given} accent={GOLD_MUTED} valueColor={CREAM} />
            </div>

            <div style={{ gridColumn: 'span 5' }}>
              <CardField label="Nationality" value={data?.nationality || country} accent={GOLD_MUTED} valueColor={CREAM} />
            </div>
            <div style={{ gridColumn: 'span 4' }}>
              <CardField label="Date of Birth" value={data?.dob ? formatLongDate(data.dob) : null} accent={GOLD_MUTED} valueColor={CREAM} />
            </div>
            <div style={{ gridColumn: 'span 3' }}>
              <CardField label="Sex" value={data?.sex} accent={GOLD_MUTED} valueColor={CREAM} mono />
            </div>

            <div style={{ gridColumn: 'span 12' }}>
              <CardField label="Place of Birth" value={data?.placeOfBirth} accent={GOLD_MUTED} valueColor={CREAM} />
            </div>

            <div style={{ gridColumn: 'span 6' }}>
              <CardField label="Date of Issue" value={data?.issueDate ? formatLongDate(data.issueDate) : null} accent={GOLD_MUTED} valueColor={CREAM} />
            </div>
            <div style={{ gridColumn: 'span 6' }}>
              <CardField label="Date of Expiration" value={data?.expiration ? formatLongDate(data.expiration) : null} accent={GOLD_MUTED} valueColor={CREAM} />
            </div>
          </div>
        </div>

        {/* MRZ */}
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: `0.5px solid ${GOLD}55` }}>
          <div style={{
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 9, color: CREAM, opacity: 0.92, lineHeight: 1.35,
            letterSpacing: '0.06em',
          }}>
            <div>{mrz.l1}</div>
            <div>{mrz.l2}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 4. DRIVER'S LICENSE
// =============================================================================
// Clean two-tone DL. Navy header strip with state mark, light body with
// photo placeholder + structured data. No fake holograms; the design
// carries itself.

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

  const NAVY = '#0a2855';
  const GOLD = '#a88a4f';
  const INK = '#1a1a1a';
  const BG = 'linear-gradient(135deg, #f0f4fb 0%, #d8e2f0 50%, #c0cfe5 100%)';

  return (
    <div
      style={{
        aspectRatio: '1.586',
        background: BG,
        borderRadius: 14,
        border: '1px solid #aebbcc',
        boxShadow: '0 10px 30px -10px rgba(0,0,0,0.45)',
        color: INK,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Header bar */}
      <div style={{
        background: `linear-gradient(90deg, ${NAVY} 0%, #143270 100%)`,
        padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        color: '#fff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StateMark size={28} state={state} />
          <div>
            <div style={{ fontFamily: 'Georgia, serif', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.22em' }}>
              {state ? state : 'UNITED STATES'}
            </div>
            <div style={{ fontFamily: 'Georgia, serif', fontWeight: 500, fontSize: 7, letterSpacing: '0.34em', color: '#c5a572', marginTop: 1, fontStyle: 'italic' }}>
              DRIVER LICENSE
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {isVeteran && (
            <span style={{
              padding: '2px 7px', fontSize: 7, fontWeight: 700, letterSpacing: '0.18em',
              background: '#c5a572', color: '#1a1a1a', borderRadius: 2,
              fontFamily: 'Georgia, serif',
            }}>
              VETERAN
            </span>
          )}
          {isDonor && (
            <span style={{
              padding: '2px 7px', fontSize: 7, fontWeight: 700, letterSpacing: '0.18em',
              background: '#a82121', color: '#fff', borderRadius: 2,
              fontFamily: 'Georgia, serif',
            }}>
              ♥ DONOR
            </span>
          )}
          {cls && (
            <span style={{
              padding: '2px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
              background: '#c5a572', color: '#1a1a1a', borderRadius: 2,
              fontFamily: 'Georgia, serif',
            }}>
              CLASS {cls}
            </span>
          )}
        </div>
      </div>

      <div style={{ padding: '12px 16px', display: 'flex', gap: 14, height: 'calc(100% - 48px)' }}>
        {/* Photo */}
        <div style={{ width: '26%', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ flex: 1, border: `1px solid #6e7d92`, overflow: 'hidden' }}>
            <PhotoFrame tone="light" />
          </div>
          <div style={{ height: 0.5, background: '#6e7d92' }} />
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 6.5, letterSpacing: '0.28em', color: '#5a6478', textAlign: 'center', fontStyle: 'italic' }}>
            Signature
          </div>
        </div>

        {/* Data */}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '4px 10px', alignContent: 'start', minWidth: 0 }}>
          <div style={{ gridColumn: 'span 12' }}>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 6.5, letterSpacing: '0.2em', color: NAVY, fontWeight: 700 }}>
              DL NO.
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 14, fontWeight: 700, color: NAVY, letterSpacing: '0.06em' }}>
              {dlNo || <span style={{ color: '#aaa', fontStyle: 'italic', fontWeight: 400 }}>—</span>}
            </div>
          </div>

          <div style={{ gridColumn: 'span 6' }}>
            <CardField label="Expires" value={expires ? formatLongDate(expires) : null} accent={NAVY} valueColor={INK} />
          </div>
          <div style={{ gridColumn: 'span 6' }}>
            <CardField label="Issued" value={issued ? formatLongDate(issued) : null} accent={NAVY} valueColor={INK} />
          </div>

          <div style={{ gridColumn: 'span 12', marginTop: 1 }}>
            <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 6.5, letterSpacing: '0.2em', color: NAVY, fontWeight: 700, marginBottom: 1 }}>
              NAME
            </div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 12, fontWeight: 700, color: INK }}>
              {n.surname || '—'}{n.given ? `, ${n.given}` : ''}
            </div>
          </div>

          {addressLines.length > 0 && (
            <div style={{ gridColumn: 'span 12' }}>
              <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 6.5, letterSpacing: '0.2em', color: NAVY, fontWeight: 700, marginBottom: 1 }}>
                ADDRESS
              </div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: 10, lineHeight: 1.3, color: INK }}>
                {addressLines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          )}

          <div style={{ gridColumn: 'span 12', display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '0 8px' }}>
            <CardField label="DOB" value={data?.dob ? formatLongDate(data.dob) : null} accent={NAVY} valueColor={INK} />
            <CardField label="Sex" value={data?.sex} accent={NAVY} valueColor={INK} mono />
            <CardField label="Ht"  value={data?.height} accent={NAVY} valueColor={INK} mono />
            <CardField label="Wt"  value={data?.weight} accent={NAVY} valueColor={INK} mono />
            <CardField label="Eyes" value={data?.eyeColor} accent={NAVY} valueColor={INK} mono />
            <CardField label="Hair" value={data?.hairColor} accent={NAVY} valueColor={INK} mono />
          </div>

          {(restrictions || endorsements) && (
            <div style={{ gridColumn: 'span 12' }}>
              <div style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 6.5, letterSpacing: '0.2em', color: NAVY, fontWeight: 700, marginBottom: 1 }}>
                RESTRICTIONS · ENDORSEMENTS
              </div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: 10, color: INK, lineHeight: 1.3 }}>
                {[restrictions, endorsements].filter(Boolean).join(' · ')}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// EMPTY CARD
// =============================================================================

function EmptyDocCard({ docType }) {
  const Icon = docType.icon;
  return (
    <div
      style={{
        aspectRatio: '1.586',
        background: 'linear-gradient(135deg, rgba(30,192,233,0.04) 0%, rgba(30,192,233,0.01) 100%)',
        border: '1.5px dashed rgba(30,192,233,0.25)',
        borderRadius: 14,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{ textAlign: 'center', padding: 24 }}>
        <Icon style={{ width: 36, height: 36, color: 'rgba(30,192,233,0.4)', margin: '0 auto 8px' }} />
        <div style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 10, letterSpacing: '0.28em',
          color: 'rgba(30,192,233,0.75)',
        }}>
          NO {docType.label.toUpperCase()} ON FILE
        </div>
        <div style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 9, color: '#65748a', marginTop: 6,
        }}>
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
