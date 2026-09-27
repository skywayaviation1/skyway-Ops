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
  line(doc, margin, 46, 'PILOT REPORT', { size: 9, color: [186, 214, 224] });
  line(doc, right - 150, 28, report.tierLabel || '', { size: 11, style: 'bold', color: [255, 255, 255] });
  line(doc, right - 150, 46, `Score ${report.score ?? '—'} / 100`, { size: 9, color: [220, 228, 232] });

  y = 84;
  line(doc, margin, y, report.pilotName || 'Pilot', { size: 16, style: 'bold' });
  y += 16;
  const seat = [report.role, report.aircraftType].filter(Boolean).join(' · ');
  line(doc, margin, y, seat || 'Crew', { size: 10, color: MUTED });
  line(doc, right - 160, y, `Generated ${fmtGenerated(report.generatedAt)}`, { size: 9, color: MUTED });
  y += 16;
  doc.setDrawColor(...RULE);
  doc.line(margin, y, right, y);
  y += 18;

  y = section(doc, margin, y, 'CERTIFICATE AND RATINGS');
  const cert = report.certificate || {};
  y = kvRow(doc, margin, right, y, [
    ['Certificate', cert.level || 'Not on file'],
    ['Instrument', cert.instrument || 'Not on file'],
    ['Multi-engine', cert.multiEngine || 'Not on file'],
  ]);
  const types = (cert.typeRatings || []).join(', ') || 'None on file';
  y = kvRow(doc, margin, right, y, [['Type ratings', types]]);
  const medical = report.medical || {};
  y = kvRow(doc, margin, right, y, [[
    'Medical',
    `${medical.class || 'Not on file'} · ${medical.status || 'Not on file'}`,
  ]]);
  y += 8;

  y = section(doc, margin, y, 'FLIGHT TIME');
  if (report.hoursAsOf) {
    const asOfLine = [
      `As of ${report.hoursAsOf}`,
      report.baselineAsOf ? `baseline ${report.baselineAsOf}` : '',
    ].filter(Boolean).join(' · ');
    line(doc, margin, y, asOfLine, { size: 8, color: MUTED });
    y += 12;
  }
  const hours = report.hours || [];
  for (let i = 0; i < hours.length; i += 2) {
    const left = hours[i];
    const rightCol = hours[i + 1];
    y = kvRow(doc, margin, right, y, [
      [left.label, hourCell(left)],
      rightCol ? [rightCol.label, hourCell(rightCol)] : ['', ''],
    ]);
  }
  const scored = report.timeInTypeScored;
  if (scored) {
    y = kvRow(doc, margin, right, y, [[
      'Time in type (scored)',
      `${scored.hours || '—'} / ${scored.minimum ?? '—'} min${scored.detail ? ` · ${scored.detail}` : ''}`,
    ]]);
  }
  const typeLines = (report.timeInType || []).map((entry) => `${entry.type} ${entry.hours || '—'}`).join('   ');
  if (typeLines) y = kvRow(doc, margin, right, y, [['Time in type', typeLines]]);
  y += 8;

  y = section(doc, margin, y, 'REQUIREMENTS');
  line(doc, margin, y, 'Item', { size: 8, color: MUTED });
  line(doc, margin + 250, y, 'Status', { size: 8, color: MUTED });
  line(doc, margin + 340, y, 'Completed', { size: 8, color: MUTED });
  line(doc, margin + 430, y, 'Due', { size: 8, color: MUTED });
  y += 6;
  doc.line(margin, y, right, y);
  y += 12;
  for (const item of report.requirements || []) {
    if (y > 730) break;
    line(doc, margin, y, item.label, { size: 8, width: 240 });
    line(doc, margin + 250, y, item.status || '', { size: 8, color: statusInk(item.status) });
    line(doc, margin + 340, y, item.completedOn || '—', { size: 8, color: MUTED });
    line(doc, margin + 430, y, item.dueOn || '—', { size: 8, color: MUTED });
    y += 13;
  }
  y += 8;

  y = section(doc, margin, y, 'RATING');
  const reasons = (report.summary || []).slice(0, 5);
  for (const reason of reasons) {
    const wrapped = doc.splitTextToSize(`• ${reason}`, right - margin).slice(0, 2);
    wrapped.forEach((row, index) => {
      line(doc, margin + (index ? 10 : 0), y, row, { size: 8, color: index ? MUTED : INK, width: right - margin });
      y += 11;
    });
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  const note = report.usingDefaultStandards
    ? 'Minimums shown are the operator’s shipped defaults (industry-typical Part 135 charter figures), not a third-party audit score.'
    : 'Minimums are the operator’s saved safety-rating settings.';
  doc.text(doc.splitTextToSize(note, right - margin), margin, 760);
  doc.text('Prepared for charter crew vetting. Certificate numbers, date of birth, home address, and medical limitations are omitted.', margin, 774);
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
  if (status === 'Current' || status === 'Valid') return [16, 122, 72];
  if (status === 'Expiring soon') return [161, 98, 7];
  if (status === 'Expired' || status === 'Not on file' || status === 'No') return [153, 27, 27];
  return INK;
}
