// Client-side Pilot Report PDF. One letter page per pilot.
// The broker share page and the on-screen sheet show the same fields;
// this is the file ops attaches when they email a broker.

const NAVY = [12, 42, 58];
const RULE = [210, 214, 220];
const MUTED = [90, 98, 110];
const INK = [24, 28, 34];

function fmtGenerated(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '');
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function line(doc, x, y, text, { size = 9, style = 'normal', color = INK, width } = {}) {
  doc.setFont('helvetica', style);
  doc.setFontSize(size);
  doc.setTextColor(...color);
  const value = String(text ?? '');
  doc.text(value, x, y, width ? { maxWidth: width } : undefined);
}

/**
 * @param {object|object[]} reports sanitized broker report(s)
 * @returns {Promise<{ blob: Blob, base64: string, filename: string }>}
 */
export async function generatePilotReportPdf(reports) {
  const list = (Array.isArray(reports) ? reports : [reports]).filter(Boolean);
  if (list.length === 0) throw new Error('No pilot report to export');
  const jspdfMod = await import('jspdf');
  const JsPDF = jspdfMod.jsPDF || jspdfMod.default;
  const doc = new JsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;

  list.forEach((report, index) => {
    if (index > 0) doc.addPage();
    drawReport(doc, report, pageWidth, margin);
  });

  const filename = list.length === 1
    ? `pilot-report-${slug(list[0].pilotName)}.pdf`
    : 'pilot-reports.pdf';
  const blob = doc.output('blob');
  const dataUri = doc.output('datauristring');
  const base64 = String(dataUri).split(',')[1] || '';
  return { blob, base64, filename };
}

function slug(name) {
  return String(name || 'pilot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pilot';
}

function drawReport(doc, report, pageWidth, margin) {
  const right = pageWidth - margin;
  let y = margin;

  doc.setFillColor(...NAVY);
  doc.rect(0, 0, pageWidth, 64, 'F');
  line(doc, margin, 28, report.operatorName || 'Charter operator', { size: 14, style: 'bold', color: [255, 255, 255] });
  line(doc, margin, 46, report.criteriaName || 'PILOT REPORT', { size: 9, color: [186, 214, 224] });
  const chips = (report.chips || []).map((chip) => `${chip.label} ${chip.status}`).join('   ');
  line(doc, right - 280, 36, chips, { size: 8, color: [255, 255, 255], width: 270 });

  y = 84;
  line(doc, margin, y, 'Pilot Report', { size: 16, style: 'bold' });
  line(doc, right - 220, y, `Generated ${fmtGenerated(report.generatedAt)}`, { size: 8, color: MUTED });
  y += 14;
  if (report.expiresAt) {
    line(doc, margin, y, `Expires ${fmtGenerated(report.expiresAt)}`, { size: 8, color: MUTED });
    y += 12;
  }
  doc.setDrawColor(...RULE);
  doc.line(margin, y, right, y);
  y += 16;

  y = section(doc, margin, y, 'OPERATOR AND AIRCRAFT');
  const aircraft = report.aircraft || {};
  y = kvRow(doc, margin, right, y, [
    ['Operator', report.operatorLegalName || report.operatorName || '—'],
    ['Aircraft', [aircraft.registration, aircraft.type || report.aircraftType].filter(Boolean).join(' ') || '—'],
  ]);
  y = kvRow(doc, margin, right, y, [
    ['Serial', aircraft.serial || '—'],
    ['Insurance', aircraft.insuranceExpiry || '—'],
  ]);
  if (report.itinerary) {
    y = kvRow(doc, margin, right, y, [[
      'Itinerary',
      [report.itinerary.from, report.itinerary.to].filter(Boolean).join(' → ') || '—',
    ]]);
  }

  y = section(doc, margin, y, 'CREW');
  if (report.hoursAsOf) {
    line(doc, margin, y, `Totals as of ${report.hoursAsOf}`, { size: 8, color: MUTED });
    y += 12;
  }
  for (const member of (report.crew || []).slice(0, 2)) {
    if (y > 680) break;
    line(doc, margin, y, `${member.role} ${member.pilotName} — ${member.status}`, { size: 10, style: 'bold' });
    y += 12;
    y = kvRow(doc, margin, right, y, [
      ['Certificate', `${member.certificateType || '—'} · ${member.country || '—'}`],
      ['Type', member.typeRating || '—'],
    ]);
    y = kvRow(doc, margin, right, y, [
      ['Medical', `${member.medicalClass || '—'} · ${member.lastMedical || '—'}`],
      ['Employment', member.employment || '—'],
    ]);
    const hours = member.hours || {};
    y = kvRow(doc, margin, right, y, [
      ['Total / PIC', `${hours.totalTime || '—'} / ${hours.pic || '—'}`],
      ['Multi / turbine', `${hours.multiEngine || '—'} / ${hours.turbine || '—'}`],
    ]);
    y = kvRow(doc, margin, right, y, [
      ['90 days / 12 months', `${hours.last90Days || '—'} / ${hours.last12Months || '—'}`],
      ['Type / PIC in type', `${member.timeInType || '—'} / ${member.picTimeInType || '—'}`],
    ]);
    const checks = (member.checks || []).slice(0, 6).map((check) => `${check.label}: ${check.status}`).join('   ');
    if (checks) {
      const wrapped = doc.splitTextToSize(checks, right - margin).slice(0, 3);
      wrapped.forEach((row) => {
        line(doc, margin, y, row, { size: 7, color: MUTED, width: right - margin });
        y += 10;
      });
    }
    y += 6;
  }

  const unmet = (report.gapAnalysis || []).filter((row) => row.picMet === false || row.sicMet === false).slice(0, 6);
  if (unmet.length) {
    y = section(doc, margin, y, 'UNMET ITEMS');
    for (const row of unmet) {
      if (y > 730) break;
      line(doc, margin, y, `${row.label}: ${row.pilotValue} (PIC ${row.picCriteria}, SIC ${row.sicCriteria})`, { size: 8, width: right - margin });
      y += 12;
    }
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  const footer = [
    `Criteria ${report.criteriaVersion || 'registered-standard-1'}`,
    report.shareUrl ? `Verify: ${report.shareUrl}` : '',
    'Certificate numbers, date of birth, and addresses are omitted. This is not a live WYVERN Ltd audit.',
  ].filter(Boolean).join('  ');
  doc.text(doc.splitTextToSize(footer, right - margin), margin, 748);
}

function section(doc, x, y, title) {
  line(doc, x, y, title, { size: 8, style: 'bold', color: NAVY });
  return y + 14;
}

function kvRow(doc, left, right, y, pairs) {
  const width = (right - left) / 2;
  pairs.forEach((pair, index) => {
    if (!pair || !pair[0]) return;
    const x = left + index * width;
    line(doc, x, y, pair[0], { size: 7, color: MUTED });
    line(doc, x, y + 11, pair[1] || '—', { size: 9 });
  });
  return y + 26;
}

function hourCell(lineItem) {
  if (!lineItem) return '';
  const hours = lineItem.hours || '—';
  const minimum = lineItem.minimum != null ? ` / ${lineItem.minimum}` : '';
  return `${hours}${minimum}`;
}

function statusInk(status) {
  if (status === 'Current' || status === 'Meets' || status === 'None') return [16, 122, 72];
  if (status === 'Expires in 30 Days' || status === 'Expires in 7 Days') return [161, 98, 7];
  if (status === 'Expired' || status === 'Not Validated' || status === 'Does Not Meet' || status === 'Yes') return [153, 27, 27];
  return INK;
}
