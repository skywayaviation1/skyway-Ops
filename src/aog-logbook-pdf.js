// Client-side PDF generator for AOG maintenance logbook entries.
//
// Uses jspdf (dynamic import) so it only loads when a tech adds an entry.
// Returns a Blob and a base64 string (for email attachment).
//
// IMPORTANT: This PDF is a coordination/record-keeping document. The
// "FOR COORDINATION USE — Not an official 14 CFR § 43.9 record" footer
// makes the role of this document explicit. Official maintenance records
// belong in Veryon/CAMP/equivalent per OpSpecs.

const LOGO_URL = '/skyway-logo-nav.png';
// Fallback: large logo if nav logo isn't available
const LOGO_FALLBACK_URL = '/skyway-logo.png';

async function loadImageAsDataUrl(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('[aog-pdf] failed to load image:', url, e);
    return null;
  }
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

/**
 * Generate a PDF for a maintenance logbook entry.
 * @param {object} aog       — full AOG record
 * @param {object} entry     — the logbook entry being signed
 * @returns {{ blob, base64, filename }}
 */
export async function generateLogbookEntryPdf(aog, entry) {
  const jspdfMod = await import('jspdf');
  const jsPDF = jspdfMod.jsPDF || jspdfMod.default;

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const margin = 48;
  let y = margin;

  // ============ HEADER ============
  // Try to load Skyway logo
  let logoData = await loadImageAsDataUrl(LOGO_URL);
  if (!logoData) logoData = await loadImageAsDataUrl(LOGO_FALLBACK_URL);

  if (logoData) {
    try {
      // Embed at 140pt wide, auto height — top-left
      doc.addImage(logoData, 'PNG', margin, y, 140, 36);
    } catch (e) {
      console.warn('[aog-pdf] logo embed failed:', e);
    }
  } else {
    // Text fallback if logo unavailable
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(0, 180, 200);
    doc.text('SKYWAY AVIATION', margin, y + 18);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text('PRIVATE JET AND HELICOPTER CHARTER SERVICES', margin, y + 30);
  }

  // Right side — document title + date
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('MAINTENANCE LOGBOOK ENTRY', W - margin, y + 12, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  doc.text(fmtDate(entry.timestamp), W - margin, y + 26, { align: 'right' });
  doc.text(`Entry ID: ${entry.id}`, W - margin, y + 38, { align: 'right' });

  y += 60;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, W - margin, y);
  y += 18;

  // ============ AIRCRAFT BLOCK ============
  doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  doc.setFont('helvetica', 'bold');
  doc.text('AIRCRAFT', margin, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(20, 20, 20);

  const labelCol = margin;
  const valueCol = margin + 130;
  const colWidth = (W - margin * 2) / 2;
  const labelCol2 = margin + colWidth;
  const valueCol2 = labelCol2 + 130;

  function row(label, value, col1Label = labelCol, col1Val = valueCol) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(label, col1Label, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(20, 20, 20);
    doc.text(String(value || '—'), col1Val, y);
  }

  // Two-column layout: tail/location on left, total time/cycles on right
  row('TAIL NUMBER:', aog.tail);
  row('TOTAL TIME:', entry.aircraftTotalTime || '—', labelCol2, valueCol2);
  y += 16;
  row('LOCATION:', aog.location + (aog.fboName ? ' / ' + aog.fboName : ''));
  row('CYCLES:', entry.aircraftCycles || '—', labelCol2, valueCol2);
  y += 16;
  row('AOG REPORTED:', fmtDate(aog.reportedAt));
  y += 24;

  // ============ DISCREPANCY ============
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  doc.text('DISCREPANCY / REPORTED ISSUE', margin, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  const issueLines = doc.splitTextToSize(aog.issueDescription || '—', W - margin * 2);
  doc.text(issueLines, margin, y);
  y += issueLines.length * 12 + 12;

  // ============ WORK PERFORMED ============
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  doc.text('WORK PERFORMED', margin, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  const workLines = doc.splitTextToSize(entry.workPerformed || '—', W - margin * 2);
  doc.text(workLines, margin, y);
  y += workLines.length * 12 + 12;

  // ============ PARTS REPLACED ============
  if (Array.isArray(entry.partsReplaced) && entry.partsReplaced.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    doc.text('PARTS REPLACED', margin, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(20, 20, 20);
    entry.partsReplaced.forEach(p => {
      const line = `• ${p.partNumber || '—'} — ${p.description || ''}${p.serialOff ? ` · S/N off: ${p.serialOff}` : ''}${p.serialOn ? ` · S/N on: ${p.serialOn}` : ''}`;
      const wrapped = doc.splitTextToSize(line, W - margin * 2);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 11;
    });
    y += 10;
  }

  // ============ INSPECTION ============
  if (entry.inspectionPerformed) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    doc.text('INSPECTION PERFORMED', margin, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(20, 20, 20);
    const inspLines = doc.splitTextToSize(entry.inspectionPerformed, W - margin * 2);
    doc.text(inspLines, margin, y);
    y += inspLines.length * 12 + 12;
  }

  // Check we have room for the certification block; new page if not
  if (y > H - 240) {
    doc.addPage();
    y = margin;
  }

  // ============ APPROVAL FOR RETURN TO SERVICE ============
  if (entry.rtsApproved) {
    doc.setDrawColor(20, 20, 20);
    doc.setLineWidth(0.5);
    doc.rect(margin, y, W - margin * 2, 60);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(20, 20, 20);
    doc.text('APPROVAL FOR RETURN TO SERVICE', margin + 10, y + 18);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const statement = 'I certify that this aircraft has been inspected/repaired and is approved for return to service with respect to the work performed.';
    const stmtLines = doc.splitTextToSize(statement, W - margin * 2 - 20);
    doc.text(stmtLines, margin + 10, y + 34);

    y += 76;
  } else {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(150, 60, 60);
    doc.text('Work performed — aircraft NOT yet approved for return to service.', margin, y);
    y += 18;
  }

  // ============ SIGNATURE BLOCK ============
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  doc.text('TECHNICIAN', margin, y);
  y += 14;

  // Embed signature image if present
  if (entry.signatureDataUrl) {
    try {
      // Signature is on a transparent background — draw at 200x60
      doc.addImage(entry.signatureDataUrl, 'PNG', margin, y, 200, 50);
    } catch (e) {
      console.warn('[aog-pdf] signature embed failed:', e);
    }
  }

  // Signature line + name beneath signature
  doc.setDrawColor(60, 60, 60);
  doc.setLineWidth(0.5);
  doc.line(margin, y + 54, margin + 220, y + 54);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(20, 20, 20);
  doc.text(entry.technicianName || '—', margin, y + 66);

  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  const certText = `${entry.technicianCertType || 'CERT'}: ${entry.technicianCertNumber || '—'}`;
  doc.text(certText, margin, y + 78);

  doc.text(`Signed: ${fmtDate(entry.signedAt)}`, margin, y + 90);

  // ============ FOOTER ============
  const footerY = H - 32;
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(margin, footerY - 12, W - margin, footerY - 12);

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(140, 140, 140);
  doc.text(
    'Skyway Aviation maintenance coordination record.  This document is generated by the Skyway Ops platform for team coordination and broker communication.',
    margin, footerY - 2
  );
  doc.text(
    "Official Part 43 / 91 / 135 maintenance records are maintained in Skyway Aviation's primary maintenance tracking system per OpSpecs.",
    margin, footerY + 8
  );

  // ============ OUTPUT ============
  const blob = doc.output('blob');
  const base64Full = doc.output('datauristring'); // e.g. "data:application/pdf;base64,JVBERi0xLjMK..."
  const base64 = base64Full.split(',')[1] || '';

  // Format date for filename: 20260512
  const d = new Date(entry.timestamp);
  const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const filename = `Skyway_${aog.tail}_Logbook_${dateStr}_${entry.id.slice(-6)}.pdf`;

  return { blob, base64, filename };
}
