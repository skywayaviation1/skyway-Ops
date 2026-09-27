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
  const crew = (report.crew || []).slice(0, 2);
  const colWidth = crew.length > 1 ? 250 : 516;
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(14).text('Crew', left, 48);
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280');
  const stamp = [`Generated ${fmtGenerated(report.generatedAt)}`, report.hoursAsOf ? `Totals as of ${report.hoursAsOf}` : ''].filter(Boolean).join(' · ');
  doc.text(stamp, left, 68, { width: 516 });

  crew.forEach((member, index) => {
    const x = left + index * (colWidth + 16);
    let y = 92;
    doc.fillColor('#6b7280').font('Helvetica-Bold').fontSize(8).text(String(member.role || '').toUpperCase(), x, y, { width: colWidth });
    y += 14;
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(12).text(member.pilotName || 'Pilot', x, y, { width: colWidth });
    y += 16;
    doc.font('Helvetica').fontSize(8).fillColor('#374151');
    const identity = [
      member.certificateType,
      member.country,
      member.typeRating,
      [member.medicalClass, member.lastMedical ? `last medical ${member.lastMedical}` : ''].filter(Boolean).join(' · '),
    ].filter(Boolean);
    for (const line of identity) {
      doc.text(line, x, y, { width: colWidth });
      y = doc.y + 2;
    }
    y += 6;
    for (const row of member.rows || []) {
      if (y > 740) break;
      doc.fillColor('#374151').font('Helvetica').fontSize(7).text(row.label, x, y, { width: colWidth - 90 });
      const pill = `✓  ${row.value || '—'}`;
      const pillWidth = Math.min(120, doc.widthOfString(pill) + 10);
      const pillX = x + colWidth - pillWidth;
      doc.roundedRect(pillX, y - 8, pillWidth, 12, 6).fill('#e7f6ee');
      doc.fillColor('#0f7a48').font('Helvetica-Bold').fontSize(7).text(pill, pillX + 4, y - 5, { width: pillWidth - 6, lineBreak: false });
      y += 14;
    }
  });
}
