// src/DutyDataExport.jsx
//
// Admin-only "Export All Duty Data" button. Fetches every dutyRecords
// document across every pilot from Firestore, computes rest hours
// between consecutive duty periods per pilot, and downloads BOTH a
// CSV (for analysis) and a PDF (for FAA records / archive) in one
// click.
//
// Where to place it: anywhere inside an admin-gated view — the OPS
// tab, an admin drawer, the Duty Tools modal, wherever. This component
// does NOT do its own admin check; wrap the whole render in a role
// guard the way you already do for other admin actions.
//
// Usage:
//   import DutyDataExport from './DutyDataExport.jsx';
//   ...
//   {isAdmin && <DutyDataExport />}
//
// Deps already in package.json: firebase, jspdf.
// No new dependencies. No new Firestore rules needed if admin has full
// read on dutyRecords (which admins already do).

import React, { useState } from 'react';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { db } from './firebase.js';
import jsPDF from 'jspdf';

// ── Time helpers ───────────────────────────────────────────────────────
// All timestamps display in Eastern (ops timezone). Firestore Timestamps
// carry a .toDate() method; plain Date strings and numbers also work.
function tsToDate(ts) {
  if (!ts) return null;
  if (typeof ts?.toDate === 'function') return ts.toDate();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtET(ts, withSeconds = false) {
  const d = tsToDate(ts);
  if (!d) return '';
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  });
}

function hoursBetween(a, b) {
  const da = tsToDate(a);
  const db = tsToDate(b);
  if (!da || !db) return null;
  return (db.getTime() - da.getTime()) / 3600000;
}

function fmtHours(h) {
  if (h == null) return '';
  if (h < 0) return '0.0'; // treat overlapping records as 0 rather than negative
  return h.toFixed(1);
}

// ── CSV assembly ───────────────────────────────────────────────────────
// One row per duty period, sorted by pilot then chronologically ascending
// within pilot. rest_hours_before = hours between the PRIOR duty end and
// this duty start for the same pilot (blank for a pilot's first record).
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCSV(rows) {
  const header = [
    'pilot_name',
    'duty_start_et',
    'duty_end_et',
    'duty_duration_hours',
    'rest_hours_before',
    'status',
    'record_id',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      csvEscape(r.pilotName),
      csvEscape(fmtET(r.dutyStart)),
      csvEscape(fmtET(r.dutyEnd)),
      csvEscape(fmtHours(r.dutyHours)),
      csvEscape(fmtHours(r.restHoursBefore)),
      csvEscape(r.status || ''),
      csvEscape(r.id || ''),
    ].join(','));
  }
  return lines.join('\r\n');
}

// ── PDF assembly ───────────────────────────────────────────────────────
// Multi-page landscape PDF. Header on every page, page numbers, one
// section per pilot with a compact table. Auto page-break when the
// next row would collide with the bottom margin.
const PDF_MARGIN = 40;         // pt
const PDF_LINE_HEIGHT = 12;    // pt per row
const PDF_HEADER_H = 60;       // pt reserved at top
const PDF_FOOTER_H = 30;       // pt reserved at bottom

function drawPdfHeader(pdf, pageNum, meta) {
  const w = pdf.internal.pageSize.getWidth();
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(15, 23, 42);
  pdf.text('SKYWAY AVIATION SERVICES', PDF_MARGIN, PDF_MARGIN);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Duty Data Export — Full Record', PDF_MARGIN, PDF_MARGIN + 14);

  // Right-aligned meta on page 1 only
  if (pageNum === 1) {
    const rightX = w - PDF_MARGIN;
    pdf.setFontSize(8);
    pdf.text(`Generated: ${meta.generatedAt}`, rightX, PDF_MARGIN, { align: 'right' });
    pdf.text(`Records: ${meta.recordCount}   Pilots: ${meta.pilotCount}`, rightX, PDF_MARGIN + 10, { align: 'right' });
    if (meta.rangeStart && meta.rangeEnd) {
      pdf.text(`Range: ${meta.rangeStart} → ${meta.rangeEnd}`, rightX, PDF_MARGIN + 20, { align: 'right' });
    }
  }

  // Horizontal rule
  pdf.setDrawColor(203, 213, 225);
  pdf.setLineWidth(0.4);
  pdf.line(PDF_MARGIN, PDF_MARGIN + 30, w - PDF_MARGIN, PDF_MARGIN + 30);
}

function drawPdfFooter(pdf, pageNum, totalPages) {
  const w = pdf.internal.pageSize.getWidth();
  const h = pdf.internal.pageSize.getHeight();
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(148, 163, 184);
  pdf.text('Confidential — Part 135 duty and rest records per 14 CFR §135.267', PDF_MARGIN, h - PDF_MARGIN + 10);
  pdf.text(`Page ${pageNum} of ${totalPages}`, w - PDF_MARGIN, h - PDF_MARGIN + 10, { align: 'right' });
}

// Column layout for the duty table (landscape US Letter = 792 x 612 pt).
// Widths sum to ~712 (page width minus 2*margin).
const PDF_COLS = [
  { key: 'dutyStart',       label: 'DUTY START (ET)',        w: 130 },
  { key: 'dutyEnd',         label: 'DUTY END (ET)',          w: 130 },
  { key: 'dutyHours',       label: 'DURATION (h)',           w: 90, align: 'right' },
  { key: 'restHoursBefore', label: 'REST BEFORE (h)',        w: 100, align: 'right' },
  { key: 'status',          label: 'STATUS',                 w: 90 },
  { key: 'id',              label: 'RECORD ID',              w: 172 },
];

function drawPdfTableHeader(pdf, y) {
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(100, 116, 139);
  let x = PDF_MARGIN;
  for (const col of PDF_COLS) {
    pdf.text(col.label, col.align === 'right' ? x + col.w - 4 : x, y, { align: col.align || 'left' });
    x += col.w;
  }
  // Underline
  pdf.setDrawColor(203, 213, 225);
  pdf.setLineWidth(0.3);
  pdf.line(PDF_MARGIN, y + 3, PDF_MARGIN + PDF_COLS.reduce((s, c) => s + c.w, 0), y + 3);
}

function drawPdfDataRow(pdf, y, row) {
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(30, 41, 59);
  let x = PDF_MARGIN;
  for (const col of PDF_COLS) {
    let v = row[col.key];
    if (col.key === 'dutyStart') v = fmtET(row.dutyStart);
    else if (col.key === 'dutyEnd') v = fmtET(row.dutyEnd);
    else if (col.key === 'dutyHours') v = fmtHours(row.dutyHours);
    else if (col.key === 'restHoursBefore') v = fmtHours(row.restHoursBefore);
    else if (col.key === 'status') v = row.status || '';
    else if (col.key === 'id') v = row.id || '';
    const text = String(v ?? '');
    pdf.text(text, col.align === 'right' ? x + col.w - 4 : x, y, { align: col.align || 'left' });
    x += col.w;
  }
}

function drawPdfPilotHeading(pdf, y, pilotName, count) {
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(15, 23, 42);
  pdf.text(pilotName, PDF_MARGIN, y);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(100, 116, 139);
  pdf.text(`${count} duty period${count === 1 ? '' : 's'}`, PDF_MARGIN + 200, y);
}

function buildPDF(byPilot, meta) {
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const pageH = pdf.internal.pageSize.getHeight();
  const usableBottom = pageH - PDF_MARGIN - PDF_FOOTER_H;

  let pageNum = 1;
  drawPdfHeader(pdf, pageNum, meta);
  let y = PDF_MARGIN + PDF_HEADER_H;

  const pilots = Object.keys(byPilot).sort((a, b) => a.localeCompare(b));

  for (let pi = 0; pi < pilots.length; pi++) {
    const pilotName = pilots[pi];
    const rows = byPilot[pilotName];

    // Need enough room for pilot heading + column header + at least one row.
    // If we don't have it, jump to a fresh page.
    if (y + PDF_LINE_HEIGHT * 4 > usableBottom) {
      pdf.addPage();
      pageNum++;
      drawPdfHeader(pdf, pageNum, meta);
      y = PDF_MARGIN + PDF_HEADER_H;
    }

    drawPdfPilotHeading(pdf, y, pilotName, rows.length);
    y += PDF_LINE_HEIGHT + 4;
    drawPdfTableHeader(pdf, y);
    y += PDF_LINE_HEIGHT;

    for (const row of rows) {
      if (y + PDF_LINE_HEIGHT > usableBottom) {
        pdf.addPage();
        pageNum++;
        drawPdfHeader(pdf, pageNum, meta);
        y = PDF_MARGIN + PDF_HEADER_H;
        // Reprint the pilot section header on the new page so the reader
        // never sees an orphaned table without context.
        drawPdfPilotHeading(pdf, y, pilotName + ' (continued)', rows.length);
        y += PDF_LINE_HEIGHT + 4;
        drawPdfTableHeader(pdf, y);
        y += PDF_LINE_HEIGHT;
      }
      drawPdfDataRow(pdf, y, row);
      y += PDF_LINE_HEIGHT;
    }

    // Space between pilots
    y += PDF_LINE_HEIGHT;
  }

  // Draw footers on every page (need totalPages first)
  const totalPages = pdf.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p);
    drawPdfFooter(pdf, p, totalPages);
  }

  return pdf.output('blob');
}

// ── Download trigger ───────────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Small delay before revoking so Safari has time to hand off the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Main data assembly ─────────────────────────────────────────────────
// Loads every dutyRecords doc, groups by pilot, sorts chronologically
// per pilot, computes rest hours between consecutive periods.
async function loadAllDutyData() {
  const q = query(collection(db, 'dutyRecords'), orderBy('dutyStart', 'asc'));
  const snap = await getDocs(q);

  // Group by pilot
  const byPilot = {};
  snap.forEach(doc => {
    const d = doc.data();
    const pilotName = String(d.pilotName || d.pilotId || 'Unknown Pilot').trim();
    if (!byPilot[pilotName]) byPilot[pilotName] = [];

    // Duty duration — prefer stored value if present, else compute
    const dutyHours = (typeof d.dutyHours === 'number')
      ? d.dutyHours
      : hoursBetween(d.dutyStart, d.dutyEnd);

    byPilot[pilotName].push({
      id: doc.id,
      pilotName,
      dutyStart: d.dutyStart || null,
      dutyEnd: d.dutyEnd || null,
      dutyHours,
      restHoursBefore: null, // filled in below after per-pilot sort
      status: d.status || (d.dutyEnd ? 'complete' : 'active'),
    });
  });

  // Per-pilot: sort ascending, compute rest hours before each entry
  // (rest between prior entry's dutyEnd and this entry's dutyStart)
  for (const pilotName of Object.keys(byPilot)) {
    const rows = byPilot[pilotName];
    rows.sort((a, b) => {
      const ta = tsToDate(a.dutyStart)?.getTime() ?? 0;
      const tb = tsToDate(b.dutyStart)?.getTime() ?? 0;
      return ta - tb;
    });
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      curr.restHoursBefore = hoursBetween(prev.dutyEnd, curr.dutyStart);
    }
  }

  return byPilot;
}

// Flatten grouped structure into a single chronologically-sorted list,
// keeping the per-pilot rest computation intact. Used for CSV output —
// CSV is easier to filter/pivot in Excel with all rows in one flat list.
function flattenForCSV(byPilot) {
  const flat = [];
  for (const pilotName of Object.keys(byPilot)) {
    for (const row of byPilot[pilotName]) flat.push(row);
  }
  flat.sort((a, b) => {
    const pilotCmp = a.pilotName.localeCompare(b.pilotName);
    if (pilotCmp !== 0) return pilotCmp;
    const ta = tsToDate(a.dutyStart)?.getTime() ?? 0;
    const tb = tsToDate(b.dutyStart)?.getTime() ?? 0;
    return ta - tb;
  });
  return flat;
}

function buildMeta(byPilot) {
  const allRows = Object.values(byPilot).flat();
  let earliest = null, latest = null;
  for (const r of allRows) {
    const start = tsToDate(r.dutyStart)?.getTime();
    const end   = tsToDate(r.dutyEnd)?.getTime() ?? start;
    if (start != null) {
      if (earliest == null || start < earliest) earliest = start;
    }
    if (end != null) {
      if (latest == null || end > latest) latest = end;
    }
  }
  return {
    generatedAt: new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York', hour12: false,
    }) + ' ET',
    recordCount: allRows.length,
    pilotCount: Object.keys(byPilot).length,
    rangeStart: earliest ? fmtET(new Date(earliest)) : null,
    rangeEnd:   latest   ? fmtET(new Date(latest))   : null,
  };
}

// ── React component ────────────────────────────────────────────────────
export default function DutyDataExport({ compact = false }) {
  const [state, setState] = useState('idle'); // idle | loading | done | error
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState('');

  async function handleExport() {
    setState('loading');
    setErr('');
    setStats(null);
    try {
      const byPilot = await loadAllDutyData();
      const meta = buildMeta(byPilot);

      if (meta.recordCount === 0) {
        setErr('No duty records found in Firestore.');
        setState('error');
        return;
      }

      const flat = flattenForCSV(byPilot);
      const csv = buildCSV(flat);
      const pdfBlob = buildPDF(byPilot, meta);

      const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      downloadBlob(
        new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }),
        `skyway_duty_export_${stamp}.csv`
      );
      // Slight delay between downloads — some browsers block back-to-back triggers
      setTimeout(() => {
        downloadBlob(pdfBlob, `skyway_duty_export_${stamp}.pdf`);
      }, 400);

      setStats(meta);
      setState('done');
    } catch (e) {
      console.error('[DutyDataExport] failed:', e);
      setErr(e.message || 'Export failed');
      setState('error');
    }
  }

  // Compact variant: just the button. Non-compact: adds a small status
  // panel below with counts.
  return (
    <div style={{ fontFamily: 'inherit' }}>
      <button
        type="button"
        onClick={handleExport}
        disabled={state === 'loading'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '10px 16px',
          background: state === 'loading' ? '#334155' : '#0ea5e9',
          color: state === 'loading' ? '#94a3b8' : '#0b0f17',
          border: 'none', borderRadius: 4,
          fontSize: 13, fontWeight: 600,
          letterSpacing: '0.05em', textTransform: 'uppercase',
          fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
          cursor: state === 'loading' ? 'wait' : 'pointer',
          transition: 'background 0.15s',
        }}
      >
        {state === 'loading'
          ? 'Exporting…'
          : state === 'done'
            ? '↻ Export again'
            : 'Export all duty data'}
      </button>

      {!compact && state === 'done' && stats && (
        <div style={{
          marginTop: 12, padding: '10px 14px',
          background: 'rgba(16,185,129,0.08)',
          border: '1px solid rgba(16,185,129,0.25)',
          borderRadius: 4,
          fontSize: 12, color: '#6ee7b7',
          fontFamily: 'ui-monospace, monospace',
        }}>
          <div>✓ Exported {stats.recordCount} duty periods across {stats.pilotCount} pilots</div>
          {stats.rangeStart && stats.rangeEnd && (
            <div style={{ marginTop: 2, color: '#94a3b8' }}>Range: {stats.rangeStart} → {stats.rangeEnd}</div>
          )}
          <div style={{ marginTop: 4, color: '#94a3b8' }}>Downloaded: CSV + PDF</div>
        </div>
      )}

      {!compact && state === 'error' && err && (
        <div style={{
          marginTop: 12, padding: '10px 14px',
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.25)',
          borderRadius: 4,
          fontSize: 12, color: '#fca5a5',
          fontFamily: 'ui-monospace, monospace',
        }}>
          {err}
        </div>
      )}
    </div>
  );
}
