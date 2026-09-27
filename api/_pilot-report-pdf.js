// Server-side Pilot Report PDF. One letter page per pilot.
// Field order matches the on-screen broker sheet and the client download.

import PDFDocument from 'pdfkit';

function fmtGenerated(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function buildPilotReportPdf(reports) {
  const list = (Array.isArray(reports) ? reports : [reports]).filter(Boolean);
  const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  list.forEach((report, index) => {
    if (index > 0) doc.addPage();
    draw(doc, report);
  });
  doc.end();
  return done;
}

function draw(doc, report) {
  const left = 48;
  const width = 516;
  doc.save();
  doc.rect(0, 0, 612, 72).fill('#0c2a3a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16);
  doc.text(report.operatorName || 'Charter operator', left, 22, { width: 340 });
  doc.font('Helvetica').fontSize(9).fillColor('#d5e7ee');
  doc.text('PILOT REPORT', left, 44);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff');
  doc.text(report.tierLabel || '', left + 340, 22, { width: 176, align: 'right' });
  doc.font('Helvetica').fontSize(9);
  doc.text(`Score ${report.score ?? '—'} / 100`, left + 340, 42, { width: 176, align: 'right' });
  doc.restore();

  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(18);
  doc.text(report.pilotName || 'Pilot', left, 92, { width });
  doc.font('Helvetica').fontSize(10).fillColor('#4b5563');
  doc.text(
    [report.role, report.aircraftType, `Generated ${fmtGenerated(report.generatedAt)}`].filter(Boolean).join('  ·  '),
    left,
    116,
    { width },
  );

  let y = 146;
  y = heading(doc, left, y, 'CERTIFICATE AND RATINGS');
  const cert = report.certificate || {};
  const medical = report.medical || {};
  y = paragraph(doc, left, y, width, `Certificate: ${cert.level || 'Not on file'}    Instrument: ${cert.instrument || 'Not on file'}    Multi-engine: ${cert.multiEngine || 'Not on file'}`);
  y = paragraph(doc, left, y, width, `Type ratings: ${(cert.typeRatings || []).join(', ') || 'None on file'}`);
  y = paragraph(doc, left, y, width, `Medical: ${medical.class || 'Not on file'} · ${medical.status || 'Not on file'}`);

  y += 8;
  y = heading(doc, left, y, 'FLIGHT TIME');
  if (report.hoursAsOf) {
    const asOfLine = [
      `As of ${report.hoursAsOf}`,
      report.baselineAsOf ? `baseline ${report.baselineAsOf} plus flights after that date` : '',
      report.last6Months ? `last 6 months ${report.last6Months}` : '',
      report.landings != null ? `landings ${report.landings}` : '',
    ].filter(Boolean).join(' · ');
    y = paragraph(doc, left, y, width, asOfLine);
  }
  for (const row of report.hours || []) {
    y = paragraph(doc, left, y, width, `${row.label}: ${row.hours || '—'} / ${row.minimum ?? '—'} minimum`);
  }
  if ((report.timeInType || []).length) {
    y = paragraph(
      doc,
      left,
      y,
      width,
      `Time in type: ${report.timeInType.map((entry) => `${entry.type} ${entry.hours || '—'}`).join(', ')}`,
    );
  }

  y += 8;
  y = heading(doc, left, y, 'REQUIREMENTS');
  for (const item of report.requirements || []) {
    if (y > 700) break;
    y = paragraph(
      doc,
      left,
      y,
      width,
      `${item.label} — ${item.status}    Completed ${item.completedOn || '—'}    Due ${item.dueOn || '—'}`,
    );
  }

  y += 8;
  y = heading(doc, left, y, 'WHY THIS RATING');
  for (const reason of (report.summary || []).slice(0, 6)) {
    y = paragraph(doc, left, y, width, `• ${reason}`);
  }

  doc.font('Helvetica').fontSize(8).fillColor('#6b7280');
  const note = report.usingDefaultStandards
    ? 'Minimums are the operator’s shipped defaults (industry-typical Part 135 charter figures), not a third-party audit score.'
    : 'Minimums are the operator’s saved safety-rating settings.';
  doc.text(`${note} Certificate numbers, date of birth, home address, and medical limitations are omitted.`, left, 740, { width });
}

function heading(doc, x, y, text) {
  doc.fillColor('#0c2a3a').font('Helvetica-Bold').fontSize(9).text(text, x, y);
  return y + 16;
}

function paragraph(doc, x, y, width, text) {
  doc.fillColor('#111827').font('Helvetica').fontSize(9).text(text, x, y, { width });
  return doc.y + 4;
}
