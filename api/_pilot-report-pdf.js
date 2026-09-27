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
  doc.text(report.operatorName || 'Charter operator', left, 18, { width: 300 });
  doc.font('Helvetica').fontSize(9).fillColor('#d5e7ee');
  doc.text(report.criteriaName || 'Pilot Report', left, 40);
  doc.fillColor('#ffffff').fontSize(8);
  doc.text((report.chips || []).map((chip) => `${chip.label}: ${chip.status}`).join('   '), left, 54, { width });
  doc.restore();

  let y = 90;
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(16);
  doc.text('Pilot Report', left, y, { width });
  y = 112;
  doc.font('Helvetica').fontSize(9).fillColor('#4b5563');
  doc.text(`Generated ${fmtGenerated(report.generatedAt)}${report.expiresAt ? ` · Expires ${fmtGenerated(report.expiresAt)}` : ''}`, left, y, { width });
  y = doc.y + 10;

  y = heading(doc, left, y, 'OPERATOR AND AIRCRAFT');
  const aircraft = report.aircraft || {};
  y = paragraph(doc, left, y, width, `Operator: ${report.operatorLegalName || report.operatorName || '—'}`);
  y = paragraph(doc, left, y, width, `Aircraft: ${[aircraft.registration, aircraft.type || report.aircraftType, aircraft.serial].filter(Boolean).join(' · ') || '—'}`);
  if (report.itinerary) {
    y = paragraph(doc, left, y, width, `Itinerary: ${[report.itinerary.from, report.itinerary.to].filter(Boolean).join(' → ')}`);
  }
  if (report.hoursAsOf) y = paragraph(doc, left, y, width, `Totals as of ${report.hoursAsOf}`);

  y = heading(doc, left, y, 'CREW');
  for (const member of (report.crew || []).slice(0, 2)) {
    if (y > 640) break;
    y = paragraph(doc, left, y, width, `${member.role} ${member.pilotName} — ${member.status}`);
    y = paragraph(doc, left, y, width, `Certificate ${member.certificateType || '—'} · ${member.country || '—'} · Type ${member.typeRating || '—'}`);
    y = paragraph(doc, left, y, width, `Medical ${member.medicalClass || '—'} · last medical ${member.lastMedical || '—'} · ${member.employment || '—'}`);
    const hours = member.hours || {};
    y = paragraph(doc, left, y, width, `Total ${hours.totalTime || '—'} · PIC ${hours.pic || '—'} · Fixed-wing ${hours.fixedWing || '—'} · Multi ${hours.multiEngine || '—'} · Turbine ${hours.turbine || '—'} · Instrument ${hours.instrument || '—'}`);
    y = paragraph(doc, left, y, width, `90 days ${hours.last90Days || '—'} · 12 months ${hours.last12Months || '—'} · Type ${member.timeInType || '—'} · PIC in type ${member.picTimeInType || '—'}`);
    y = paragraph(doc, left, y, width, `Accident/incident ${member.accident || '—'} · Enforcement ${member.enforcement || '—'}`);
    for (const check of (member.checks || []).slice(0, 8)) {
      y = paragraph(doc, left, y, width, `${check.label}: ${check.status}`);
    }
  }

  const unmet = (report.gapAnalysis || []).filter((row) => row.picMet === false || row.sicMet === false).slice(0, 8);
  if (unmet.length) {
    y = heading(doc, left, y, 'UNMET ITEMS');
    for (const row of unmet) {
      if (y > 700) break;
      y = paragraph(doc, left, y, width, `${row.label}: ${row.pilotValue} (PIC ${row.picCriteria} / SIC ${row.sicCriteria})`);
    }
  }

  doc.font('Helvetica').fontSize(8).fillColor('#6b7280');
  const note = [
    `Criteria ${report.criteriaVersion || 'registered-standard-1'}.`,
    report.shareUrl ? `Verify: ${report.shareUrl}` : '',
    'Certificate numbers, date of birth, and addresses are omitted. This is not a live WYVERN Ltd audit.',
  ].filter(Boolean).join(' ');
  doc.text(note, left, 730, { width });
}

function heading(doc, x, y, text) {
  doc.fillColor('#0c2a3a').font('Helvetica-Bold').fontSize(9).text(text, x, y);
  return y + 16;
}

function paragraph(doc, x, y, width, text) {
  doc.fillColor('#111827').font('Helvetica').fontSize(9).text(text, x, y, { width });
  return doc.y + 4;
}
