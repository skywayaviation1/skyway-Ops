// src/duty-export.js
//
// =====================================================================
// DUTY RECORD EXPORT — CSV and printable PDF
// =====================================================================
//
// Two output formats:
//   - CSV: rows of fields, machine-readable, opens in Excel/Numbers
//   - PDF: printable HTML opened in a new window with window.print() so
//     the user picks "Save as PDF" from the browser's native print
//     dialog. This avoids bundling a heavyweight PDF library and
//     produces clean output across Chrome, Safari, Firefox, Edge.
//
// Both are CLIENT-SIDE — no server endpoint required. The caller
// fetches periods via firebase-duty-v2.fetchPeriodsForPilotInRange()
// and hands the array to these functions.
//
// Both formats include the FULL audit trail (adminEdits[]) so the
// export is a complete legal record, not just a summary.

const MS_HR = 3600 * 1000;

// CSV field escaping — wraps in quotes if the value contains a comma,
// quote, or newline. Doubles any embedded quotes per RFC 4180.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Format a timestamp as ISO 8601 in the local timezone (with offset).
// Spreadsheets parse this correctly and humans can still read it.
function fmtIso(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  // Build "YYYY-MM-DDTHH:mm:ss±HH:MM" in local time
  const pad = n => String(n).padStart(2, '0');
  const tzMin = -d.getTimezoneOffset();
  const tzSign = tzMin >= 0 ? '+' : '-';
  const tzH = pad(Math.floor(Math.abs(tzMin) / 60));
  const tzM = pad(Math.abs(tzMin) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${tzSign}${tzH}:${tzM}`;
}

// Format a duration as "X.XXh" — matches how the legality engine
// reports flight time. Two decimals = quarter-tenths.
function fmtHours(ms) {
  if (!Number.isFinite(ms)) return '';
  return (ms / MS_HR).toFixed(2);
}

// Compress an adminEdits[] array to a single-cell string. JSON.stringify
// keeps full fidelity. Wrapped in csvCell so quotes/commas don't break
// the row structure.
function fmtAuditTrail(edits) {
  if (!Array.isArray(edits) || edits.length === 0) return '';
  return JSON.stringify(edits.map(e => ({
    by: e.by,
    at: e.at ? fmtIso(e.at) : null,
    field: e.field,
    from: e.from,
    to: e.to,
    note: e.note,
  })));
}

// =====================================================================
// CSV BUILDER
// =====================================================================

const CSV_HEADERS = [
  'Period ID',
  'Pilot UID',
  'Pilot Name',
  'Role',
  'Crew Type',
  'Assignment Type',
  'Duty On (local)',
  'Duty Off (local)',
  'Total Duty (hours)',
  'Flight Time (hours)',
  'Over 14h',
  'Location',
  'Tail',
  'Trip ID',
  'Status',
  'Confirm Status',
  'Partner Period ID',
  'Fit For Duty',
  'Prior Rest (hours)',
  'Excursion Reason',
  'Override Status',
  'Override Approved By',
  'Override Approved At',
  'Override Notes',
  'Created At',
  'Updated At',
  'Audit Trail (JSON)',
];

function periodToCsvRow(p) {
  const totalDutyMs = (Number.isFinite(p.dutyOffAt) && Number.isFinite(p.dutyOnAt))
    ? p.dutyOffAt - p.dutyOnAt
    : null;
  return [
    p.id,
    p.pilotUid,
    p.pilotName,
    p.role,
    p.crewType,
    p.assignmentType,
    fmtIso(p.dutyOnAt),
    fmtIso(p.dutyOffAt),
    totalDutyMs != null ? fmtHours(totalDutyMs) : '',
    fmtHours(p.flightTimeMs || 0),
    p.over14 ? 'YES' : '',
    p.location,
    p.tail,
    p.tripId,
    p.status,
    p.confirmStatus || 'self-attested',  // legacy docs default
    p.partnerPeriodId,
    p.fitForDuty === true ? 'YES' : p.fitForDuty === false ? 'NO' : '',
    p.priorRestMs ? fmtHours(p.priorRestMs) : '',
    p.excursionReason,
    p.overrideStatus,
    p.overrideApprovedBy,
    p.overrideApprovedAt ? fmtIso(p.overrideApprovedAt) : '',
    p.overrideApprovalNotes,
    fmtIso(p.createdAt),
    fmtIso(p.updatedAt),
    fmtAuditTrail(p.adminEdits),
  ].map(csvCell).join(',');
}

// Outside-flying gets its own small table appended after the main one.
// Keeps the file self-describing.
const OUTSIDE_CSV_HEADERS = [
  'Outside Flying ID',
  'Pilot UID',
  'Operator',
  'Aircraft',
  'Start (local)',
  'End (local)',
  'Flight Time (hours)',
  'Notes',
  'Created At',
];

function outsideToCsvRow(o) {
  return [
    o.id,
    o.pilotUid,
    o.source || o.operator,
    o.aircraft,
    fmtIso(o.startAt),
    fmtIso(o.endAt),
    fmtHours(o.flightTimeMs || 0),
    o.notes,
    fmtIso(o.createdAt),
  ].map(csvCell).join(',');
}

/**
 * Build the full CSV for a pilot's records over a date range.
 * Includes a header section with pilot name + date range, then
 * the duty periods table, then (optionally) the outside-flying table.
 *
 * @param {object} args
 * @param {string} args.pilotName
 * @param {number} args.startMs
 * @param {number} args.endMs
 * @param {Array}  args.periods
 * @param {Array}  args.outsideFlying  optional
 * @returns {string} CSV body
 */
export function buildDutyCsv({ pilotName, startMs, endMs, periods, outsideFlying }) {
  const lines = [];

  // Title block — these are comment-like rows that Excel renders as a
  // single column. Survives round-tripping.
  lines.push(csvCell(`Skyway Aviation Services — Duty Record Export`));
  lines.push(csvCell(`Pilot: ${pilotName || '(unknown)'}`));
  lines.push(csvCell(`Date range: ${fmtIso(startMs)}  to  ${fmtIso(endMs)}`));
  lines.push(csvCell(`Generated: ${fmtIso(Date.now())}`));
  lines.push(csvCell(`Records: ${periods.length} duty periods, ${(outsideFlying || []).length} outside-flying entries`));
  lines.push('');

  // Duty periods table
  lines.push(csvCell('DUTY PERIODS'));
  lines.push(CSV_HEADERS.map(csvCell).join(','));
  for (const p of periods) lines.push(periodToCsvRow(p));

  if (outsideFlying && outsideFlying.length) {
    lines.push('');
    lines.push(csvCell('OUTSIDE COMMERCIAL FLYING'));
    lines.push(OUTSIDE_CSV_HEADERS.map(csvCell).join(','));
    for (const o of outsideFlying) lines.push(outsideToCsvRow(o));
  }

  return lines.join('\r\n');
}

// =====================================================================
// PDF (PRINTABLE HTML) BUILDER
// =====================================================================
//
// Strategy: open a new browser window with a self-contained HTML page,
// call window.print() so the user can save as PDF via the browser's
// native dialog. The page is styled for print: white background, black
// text, page breaks between major sections, a proper header on every
// page (CSS @page rule).
//
// We don't trigger window.print() automatically because some browsers
// block it as a popup. The new window includes a prominent "PRINT /
// SAVE AS PDF" button at the top, plus instructions.

function escapeHtml(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function periodBlock(p) {
  const totalDutyMs = (Number.isFinite(p.dutyOffAt) && Number.isFinite(p.dutyOnAt))
    ? p.dutyOffAt - p.dutyOnAt
    : null;
  const rows = [
    ['Period ID', p.id],
    ['Duty On', fmtIso(p.dutyOnAt)],
    ['Duty Off', fmtIso(p.dutyOffAt) || '— still on duty —'],
    ['Total Duty', totalDutyMs != null ? `${fmtHours(totalDutyMs)} h` : ''],
    ['Flight Time', `${fmtHours(p.flightTimeMs || 0)} h`],
    ['Role / Crew', `${p.role || '?'} / ${p.crewType === 'two' ? 'two-pilot' : 'single-pilot'}`],
    ['Assignment Type', p.assignmentType === 'regular'
      ? '135.267(c) Regular (14h)'
      : '135.267(b) Unscheduled'],
    ['Location', p.location],
    ['Tail', p.tail],
    ['Trip ID', p.tripId],
    ['Status', p.status],
    ['Confirm Status', p.confirmStatus || 'self-attested'],
    ['Partner Period ID', p.partnerPeriodId],
    ['Fit For Duty', p.fitForDuty === true ? 'YES (attested)'
      : p.fitForDuty === false ? 'NO' : '—'],
    ['Prior Rest', p.priorRestMs ? `${fmtHours(p.priorRestMs)} h` : ''],
    ['Over 14h Flag', p.over14 ? 'YES' : 'no'],
    ['Excursion Reason', p.excursionReason || ''],
    ['Override Status', p.overrideStatus || 'none'],
    ['Override Approved By', p.overrideApprovedBy || ''],
    ['Override Approved At', p.overrideApprovedAt ? fmtIso(p.overrideApprovedAt) : ''],
    ['Override Notes', p.overrideApprovalNotes || ''],
    ['Created At', fmtIso(p.createdAt)],
    ['Updated At', fmtIso(p.updatedAt)],
  ];
  // Filter out empty rows for visual cleanliness — but always keep
  // the time fields (Duty On / Duty Off / Total Duty) and the status
  // fields even when empty, since the absence is meaningful (e.g.
  // "no duty off" means still on duty).
  const ALWAYS_SHOW = new Set(['Period ID', 'Duty On', 'Duty Off', 'Total Duty',
    'Role / Crew', 'Status', 'Confirm Status']);
  const visible = rows.filter(([k, v]) => ALWAYS_SHOW.has(k) || (v != null && v !== ''));

  const auditHtml = (Array.isArray(p.adminEdits) && p.adminEdits.length)
    ? `<div class="audit">
         <div class="audit-title">Audit trail (${p.adminEdits.length} ${p.adminEdits.length === 1 ? 'entry' : 'entries'}):</div>
         <ul>
           ${p.adminEdits.map(e => `<li>
             ${escapeHtml(fmtIso(e.at))} — <strong>${escapeHtml(e.by)}</strong>
             changed <em>${escapeHtml(e.field)}</em>
             ${e.note ? `<br><span class="note">${escapeHtml(e.note)}</span>` : ''}
           </li>`).join('')}
         </ul>
       </div>`
    : '';

  return `
    <section class="period">
      <table>
        ${visible.map(([k, v]) =>
          `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v == null ? '' : v)}</td></tr>`
        ).join('')}
      </table>
      ${auditHtml}
    </section>
  `;
}

function outsideBlock(o) {
  const rows = [
    ['Outside Flying ID', o.id],
    ['Operator', o.source || o.operator],
    ['Aircraft', o.aircraft],
    ['Start', fmtIso(o.startAt)],
    ['End', fmtIso(o.endAt)],
    ['Flight Time', `${fmtHours(o.flightTimeMs || 0)} h`],
    ['Notes', o.notes],
    ['Created At', fmtIso(o.createdAt)],
  ].filter(([k, v]) => v != null && v !== '');
  return `
    <section class="period outside">
      <table>
        ${rows.map(([k, v]) =>
          `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`
        ).join('')}
      </table>
    </section>
  `;
}

export function buildDutyPrintableHtml({ pilotName, startMs, endMs, periods, outsideFlying }) {
  const title = `Skyway Duty Record — ${pilotName || '(unknown)'}`;
  const css = `
    @page { size: letter; margin: 0.5in 0.5in 0.7in 0.5in; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 11px;
      color: #111;
      margin: 0;
      padding: 0;
      background: #fff;
    }
    .toolbar {
      position: sticky; top: 0;
      background: #f4f4f5; border-bottom: 1px solid #d4d4d8;
      padding: 12px 16px;
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
    }
    .toolbar button {
      background: #0ea5e9; color: white; border: 0;
      padding: 8px 16px; font-weight: 600; font-size: 13px;
      cursor: pointer; border-radius: 4px;
    }
    .toolbar button:hover { background: #0284c7; }
    .toolbar .note { font-size: 11px; color: #52525b; }
    @media print {
      .toolbar { display: none; }
    }
    .page {
      max-width: 7.5in;
      margin: 0 auto;
      padding: 24px;
    }
    header.main {
      border-bottom: 2px solid #111;
      padding-bottom: 12px;
      margin-bottom: 20px;
    }
    header.main h1 {
      font-size: 16px; margin: 0 0 6px 0;
      letter-spacing: 0.05em;
    }
    header.main .meta {
      font-size: 11px; color: #444;
      display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px;
    }
    header.main .meta strong { font-weight: 600; }
    h2.section {
      font-size: 13px; margin: 24px 0 8px 0;
      padding: 4px 0;
      border-bottom: 1px solid #888;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    section.period {
      page-break-inside: avoid;
      margin-bottom: 16px;
      border: 1px solid #ccc;
      padding: 10px;
      background: #fafafa;
    }
    section.outside { background: #f0f9ff; }
    section.period table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10.5px;
    }
    section.period th {
      text-align: left;
      width: 38%;
      padding: 3px 8px 3px 0;
      font-weight: 600;
      color: #444;
      vertical-align: top;
    }
    section.period td {
      padding: 3px 0;
      color: #111;
      word-break: break-word;
    }
    .audit {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px dashed #aaa;
      font-size: 10px;
    }
    .audit-title { font-weight: 600; color: #555; margin-bottom: 2px; }
    .audit ul { margin: 0; padding-left: 16px; }
    .audit li { margin-bottom: 3px; color: #333; }
    .audit .note { color: #555; font-style: italic; }
    .empty {
      padding: 20px; text-align: center;
      color: #777; font-style: italic;
      border: 1px dashed #ccc;
    }
    footer.legal {
      margin-top: 32px;
      padding-top: 12px;
      border-top: 1px solid #888;
      font-size: 9.5px;
      color: #444;
      line-height: 1.5;
    }
  `;

  const dutySection = periods.length
    ? periods.map(periodBlock).join('')
    : `<div class="empty">No duty periods recorded in this date range.</div>`;

  const outsideSection = (outsideFlying && outsideFlying.length)
    ? `<h2 class="section">Outside Commercial Flying (${outsideFlying.length})</h2>
       ${outsideFlying.map(outsideBlock).join('')}`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
  <div class="toolbar">
    <span class="note">
      Use your browser's print dialog → Destination: <strong>Save as PDF</strong>.
      Recommend: Letter, Portrait, Background graphics ON.
    </span>
    <button onclick="window.print()">PRINT / SAVE AS PDF</button>
  </div>

  <div class="page">
    <header class="main">
      <h1>Skyway Aviation Services — Duty Record</h1>
      <div class="meta">
        <strong>Pilot:</strong><span>${escapeHtml(pilotName || '(unknown)')}</span>
        <strong>Date range:</strong><span>${escapeHtml(fmtIso(startMs))} &nbsp;to&nbsp; ${escapeHtml(fmtIso(endMs))}</span>
        <strong>Records:</strong><span>${periods.length} duty period${periods.length === 1 ? '' : 's'}${
          (outsideFlying && outsideFlying.length)
            ? `, ${outsideFlying.length} outside-flying entr${outsideFlying.length === 1 ? 'y' : 'ies'}`
            : ''
        }</span>
        <strong>Generated:</strong><span>${escapeHtml(fmtIso(Date.now()))}</span>
      </div>
    </header>

    <h2 class="section">Duty Periods (${periods.length})</h2>
    ${dutySection}
    ${outsideSection}

    <footer class="legal">
      This document is a record of flight crewmember duty and rest periods
      required by 14 CFR Part 135. Contents are derived from Skyway
      Aviation Services' duty tracking system (Skyway Ops). Audit trail
      entries show every administrative edit to the underlying record.
      Records are retained for at least 365 days. For records older than
      365 days or questions about this export, contact Skyway operations.
    </footer>
  </div>
</body>
</html>`;
}

// =====================================================================
// DOWNLOAD TRIGGERS
// =====================================================================

/**
 * Trigger a CSV file download in the user's browser. Uses a blob URL
 * and a synthetic anchor click. Works in Chrome/Safari/Firefox/Edge.
 */
export function downloadCsv(csvString, filename) {
  // Prepend a UTF-8 BOM so Excel on Windows opens it correctly with
  // unicode characters (pilot names, em-dashes, etc).
  const bom = '\uFEFF';
  const blob = new Blob([bom + csvString], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'duty-records.csv';
  document.body.appendChild(a);
  a.click();
  // Cleanup — give the click a tick to register before removing
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Open the printable HTML in a new tab. The page has a "PRINT / SAVE
 * AS PDF" button the user clicks; we don't auto-print to avoid
 * popup-blocker conflicts and to let the user review before printing.
 */
export function openPrintWindow(htmlString) {
  const w = window.open('', '_blank', 'noopener');
  if (!w) {
    throw new Error('Popup blocked. Allow popups for this site to use PDF export.');
  }
  w.document.write(htmlString);
  w.document.close();
}

/**
 * Build a sensible filename for an export.
 *   "duty_smithj_2025-09-01_to_2026-06-03.csv"
 */
export function buildFilename(pilotName, startMs, endMs, ext) {
  const slug = (s) => String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const d = (ms) => {
    const x = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  };
  return `duty_${slug(pilotName)}_${d(startMs)}_to_${d(endMs)}.${ext}`;
}
