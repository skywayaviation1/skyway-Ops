// Client-side Pilot Report PDF. One letter page per pilot.
// The broker share page and the on-screen sheet show the same fields;
// this is the file ops attaches when they email a broker.

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
    ? `pilot-report-${slug(list[0].crew?.[0]?.pilotName)}.pdf`
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
  const crew = (report.crew || []).slice(0, 2);
  const gap = 16;
  const colWidth = crew.length > 1 ? (pageWidth - margin * 2 - gap) / 2 : pageWidth - margin * 2;
  line(doc, margin, margin, 'Crew', { size: 16, style: 'bold' });
  const stamp = [`Generated ${fmtGenerated(report.generatedAt)}`, report.hoursAsOf ? `Totals as of ${report.hoursAsOf}` : ''].filter(Boolean).join(' · ');
  line(doc, margin, margin + 16, stamp, { size: 8, color: MUTED });

  crew.forEach((member, index) => {
    const x = margin + index * (colWidth + gap);
    let y = margin + 36;
    line(doc, x, y, String(member.role || '').toUpperCase(), { size: 8, style: 'bold', color: MUTED });
    y += 14;
    line(doc, x, y, member.pilotName || 'Pilot', { size: 12, style: 'bold' });
    y += 14;
    for (const identity of [member.certificateType, member.country, member.typeRating, [member.medicalClass, member.lastMedical ? `last medical ${member.lastMedical}` : ''].filter(Boolean).join(' · ')]) {
      if (!identity) continue;
      line(doc, x, y, identity, { size: 8, color: INK, width: colWidth });
      y += 11;
    }
    y += 4;
    for (const row of member.rows || []) {
      if (y > 740) break;
      line(doc, x, y, row.label, { size: 7, color: INK, width: colWidth - 88 });
      const pill = `✓  ${row.value || '—'}`;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      const pillWidth = Math.min(110, doc.getTextWidth(pill) + 10);
      const pillX = x + colWidth - pillWidth;
      doc.setFillColor(231, 246, 238);
      doc.roundedRect(pillX, y - 8, pillWidth, 12, 6, 6, 'F');
      line(doc, pillX + 4, y, pill, { size: 7, style: 'bold', color: [15, 122, 72] });
      y += 14;
    }
  });
}

