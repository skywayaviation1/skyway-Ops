// aml-pdf.js — render an AML record as a PDF matching the Skyway
// Aviation form S-3-2/R-31. Uses jsPDF (browser-side PDF generation,
// no server roundtrip).
//
// Layout choices:
//   - Letter size, portrait
//   - 0.5" margins
//   - Skyway logo embedded top-left at 1.25" wide
//   - Form title centered, subtitle below
//   - Four sections matching the paper form
//   - Signature blocks render the drawn signature image if present,
//     else show the typed name + cert# (the click-as-signature path)
//   - Form revision number S-3-2/R-31 in footer of last page
//
// Currently Parts II/III/IV render with blank fields if the AML hasn't
// progressed through those stages — same as the paper form would
// look when filled progressively. When those workflows are built
// (next turn), the fields will populate from the AML record.

import jsPDF from 'jspdf';

// Cache the logo as a data URL after first fetch so generating
// multiple PDFs doesn't re-download it.
//
// Deliberately the base wordmark rather than the `-reverse` variant the app
// chrome uses: the page is white, so this needs the navy ink.
let logoDataUrlCache = null;
async function getLogoDataUrl() {
  if (logoDataUrlCache) return logoDataUrlCache;
  try {
    const r = await fetch('/skyway-logo.png');
    if (!r.ok) return null;
    const blob = await r.blob();
    const dataUrl = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.onerror = rej;
      reader.readAsDataURL(blob);
    });
    logoDataUrlCache = dataUrl;
    return dataUrl;
  } catch (e) {
    console.warn('[aml-pdf] logo fetch failed:', e);
    return null;
  }
}

// === Page geometry (inches) ===
const PAGE_W = 8.5;
const PAGE_H = 11;
const MARGIN = 0.5;
const CONTENT_W = PAGE_W - 2 * MARGIN;

// === Helpers ===

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

function fmtDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * Draw a labeled field box. Returns the y after the field (for chaining).
 */
function drawField(doc, x, y, w, h, label, value, opts = {}) {
  doc.setDrawColor(180);
  doc.setLineWidth(0.005);
  doc.rect(x, y, w, h);
  // Label
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(110);
  doc.text(label, x + 0.04, y + 0.11);
  // Value
  doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
  doc.setFontSize(opts.fontSize || 9);
  doc.setTextColor(20);
  const valueY = y + (opts.valueY != null ? opts.valueY : 0.28);
  if (value) {
    // Wrap long values
    const lines = doc.splitTextToSize(String(value), w - 0.08);
    doc.text(lines.slice(0, opts.maxLines || 2), x + 0.04, valueY);
  }
  return y + h;
}

/**
 * Section header — label with underline. Returns y after the header.
 */
function drawSectionHeader(doc, y, romanNumeral, text) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(20);
  doc.text(`${romanNumeral}. ${text}`, MARGIN, y);
  // Thin rule under
  doc.setDrawColor(80);
  doc.setLineWidth(0.008);
  doc.line(MARGIN, y + 0.05, PAGE_W - MARGIN, y + 0.05);
  return y + 0.18;
}

/**
 * Insert a signature block. If `signatureDataUrl` is provided, render
 * the image into the signature box. Otherwise leave it blank with
 * just the typed name/cert as "click-signature" evidence.
 */
function drawSignatureBlock(doc, x, y, w, opts) {
  const { name, cert, signatureDataUrl, label, capturedAt } = opts;
  const H = 0.55;
  // Outer container
  doc.setDrawColor(180);
  doc.setLineWidth(0.005);
  doc.rect(x, y, w, H);
  // Label
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(110);
  doc.text(label || 'Signature', x + 0.04, y + 0.11);

  // Three columns inside: signature image, name, cert
  const sigW = w * 0.45;
  const nameW = w * 0.35;
  // const certW = w * 0.20;  // implicit
  // Column dividers
  doc.line(x + sigW, y + 0.15, x + sigW, y + H);
  doc.line(x + sigW + nameW, y + 0.15, x + sigW + nameW, y + H);

  // Signature image (if drawn)
  if (signatureDataUrl && typeof signatureDataUrl === 'string' && signatureDataUrl.startsWith('data:image')) {
    try {
      // Fit inside box with padding
      doc.addImage(signatureDataUrl, 'PNG', x + 0.05, y + 0.18, sigW - 0.1, H - 0.22);
    } catch (e) {
      console.warn('[aml-pdf] sig image embed failed:', e);
    }
  } else if (name) {
    // Click-signature: italicize the name in the sig field
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(11);
    doc.setTextColor(20);
    doc.text(name, x + 0.05, y + 0.42);
  }

  // Sub-label for signature column
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(140);
  doc.text('Signature', x + 0.05, y + H - 0.04);

  // Name column
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(110);
  doc.text('Name', x + sigW + 0.04, y + 0.11);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(20);
  if (name) {
    doc.text(name, x + sigW + 0.04, y + 0.32);
  }
  if (capturedAt) {
    doc.setFontSize(6);
    doc.setTextColor(140);
    doc.text(capturedAt, x + sigW + 0.04, y + H - 0.04);
  }

  // Cert column
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(110);
  doc.text('Certificate #', x + sigW + nameW + 0.04, y + 0.11);
  if (cert) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(20);
    doc.text(cert, x + sigW + nameW + 0.04, y + 0.32);
  }

  return y + H;
}

/**
 * Yes / No / NA checkbox row — used in Part II.
 */
function drawChecklist(doc, x, y, w, label, value) {
  // value: 'yes' | 'no' | 'na' | null
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(20);
  const lines = doc.splitTextToSize(label, w - 1.0);
  doc.text(lines, x, y + 0.1);
  // Boxes at right
  const optX = x + w - 0.95;
  const opts = [
    { k: 'yes', l: 'Yes' },
    { k: 'no',  l: 'No' },
    { k: 'na',  l: 'NA' },
  ];
  opts.forEach((o, i) => {
    const bx = optX + i * 0.32;
    doc.setDrawColor(120);
    doc.setLineWidth(0.005);
    doc.rect(bx, y, 0.12, 0.12);
    if (value === o.k) {
      doc.setLineWidth(0.012);
      doc.line(bx + 0.02, y + 0.06, bx + 0.05, y + 0.10);
      doc.line(bx + 0.05, y + 0.10, bx + 0.11, y + 0.02);
      doc.setLineWidth(0.005);
    }
    doc.setFontSize(7);
    doc.text(o.l, bx + 0.15, y + 0.09);
  });
  // Spacing per row, accounting for label wrap
  const labelHeight = Math.max(0.18, lines.length * 0.13);
  return y + labelHeight;
}

// ====================================================================
// MAIN — render an AML to a PDF and download it
// ====================================================================

/**
 * Generate and download a PDF of an AML record.
 *
 * @param {Object} aml  — the AML record from Firestore
 * @returns {Promise<void>}
 */
export async function downloadAMLPdf(aml) {
  if (!aml) throw new Error('downloadAMLPdf: aml required');
  const doc = new jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' });

  // === Header — logo + title ===
  const logoData = await getLogoDataUrl();
  if (logoData) {
    try {
      // Aspect: 4:1 roughly, fit to 1.4" wide
      doc.addImage(logoData, 'PNG', MARGIN, MARGIN, 1.4, 0.45);
    } catch (e) {
      console.warn('[aml-pdf] logo embed failed:', e);
    }
  }
  // Company / title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text('SKYWAY AVIATION SERVICES, INC.', PAGE_W / 2, MARGIN + 0.15, { align: 'center' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text('GENERAL OPERATIONS MANUAL', PAGE_W / 2, MARGIN + 0.32, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('AIRCRAFT SCHEDULED / UNSCHEDULED MAINTENANCE LOG', PAGE_W / 2, MARGIN + 0.5, { align: 'center' });

  // === PART I ===
  let y = MARGIN + 0.75;
  y = drawSectionHeader(doc, y, 'I', 'To be completed by individual requesting/reporting maintenance activity');

  // Row 1: Date | Aircraft Reg # | Serial #
  const col1W = CONTENT_W * 0.30;
  const col2W = CONTENT_W * 0.35;
  const col3W = CONTENT_W * 0.35;
  drawField(doc, MARGIN, y, col1W, 0.45, 'Date',
    aml.date ? new Date(aml.date + 'T00:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : fmtDate(aml.createdAtClient));
  drawField(doc, MARGIN + col1W, y, col2W, 0.45, 'Aircraft Registration #',
    aml.tail || '');
  drawField(doc, MARGIN + col1W + col2W, y, col3W, 0.45, 'Serial #',
    aml.serialNumber || '');
  y += 0.45;

  // Row 2: AFTT/Hobbs/Landings — three boxes
  const meterW = CONTENT_W / 3;
  drawField(doc, MARGIN, y, meterW, 0.45, 'Aircraft Tach / Hobbs AFTT',
    aml.aftt || '');
  drawField(doc, MARGIN + meterW, y, meterW, 0.45, 'Hobbs',
    aml.hobbs || '');
  drawField(doc, MARGIN + 2 * meterW, y, meterW, 0.45, 'Landings',
    aml.landings || '');
  y += 0.45;

  // Discrepancy — large block
  const discrepLines = doc.splitTextToSize(aml.discrepancy || '', CONTENT_W - 0.08);
  const discrepHeight = Math.max(1.1, 0.25 + (discrepLines.length * 0.13));
  drawField(doc, MARGIN, y, CONTENT_W, discrepHeight, 'Discrepancy or Maintenance Request',
    aml.discrepancy || '', { maxLines: 50, valueY: 0.32 });
  y += discrepHeight;

  // MEL row (only filled if DEFERRED)
  const isDeferred = aml.stage === 'DEFERRED';
  const melH = 0.5;
  const melColW = CONTENT_W / 5;
  doc.setDrawColor(180);
  doc.setLineWidth(0.005);
  doc.rect(MARGIN, y, CONTENT_W, melH);
  // Sub-header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(20);
  doc.text('MEL (If Applicable)', MARGIN + 0.04, y + 0.13);
  // Sub-columns
  const melLabels = [
    { l: 'Date Entered', v: isDeferred ? fmtDate(aml.deferralApprovedAt) : '' },
    { l: 'ATA Code',     v: isDeferred ? (aml.ataCode || '') : '' },
    { l: 'Deferred Item',v: isDeferred ? (aml.melItemRef || '') : '' },
    { l: 'Category',     v: isDeferred ? (aml.melCategory || '') : '' },
    { l: 'Due Date',     v: isDeferred ? (aml.melDueDate || '') : '' },
  ];
  melLabels.forEach((m, i) => {
    const cx = MARGIN + i * melColW;
    if (i > 0) doc.line(cx, y + 0.18, cx, y + melH);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(110);
    doc.text(m.l, cx + 0.04, y + 0.27);
    doc.setFontSize(9);
    doc.setTextColor(20);
    if (m.v) doc.text(String(m.v), cx + 0.04, y + 0.42);
  });
  y += melH;

  // MEL signature/cert# row — only for deferred
  if (isDeferred) {
    drawField(doc, MARGIN, y, CONTENT_W, 0.4, 'MEL Signature & Certificate Number',
      `${aml.deferralApprovedByName || ''}${aml.deferralApprovedByCert ? ` · Cert # ${aml.deferralApprovedByCert}` : ''}`);
    y += 0.4;
  }

  // Cleared row (placeholder — will populate when Part II is built)
  drawField(doc, MARGIN, y, CONTENT_W * 0.5, 0.4, 'Date Cleared', '');
  drawField(doc, MARGIN + CONTENT_W * 0.5, y, CONTENT_W * 0.5, 0.4, 'Corrective Action / RTS Authorization & Cert #', '');
  y += 0.4;

  // Requester signature block
  y += 0.05;
  drawSignatureBlock(doc, MARGIN, y, CONTENT_W, {
    label: 'Signature for Maintenance Request',
    name: aml.requestedByName || '',
    cert: aml.requestedByCert || '',
    signatureDataUrl: null,                 // Part I doesn't capture drawn sig
    capturedAt: aml.createdAtClient ? `Submitted ${fmtDateTime(aml.createdAtClient)}` : null,
  });
  y += 0.6;

  // === PART II ===
  // If we're close to the bottom margin, new page
  if (y > PAGE_H - 2.5) { doc.addPage(); y = MARGIN; }
  y = drawSectionHeader(doc, y, 'II', 'To be completed by mechanic/repair station performing corrective actions');
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(110);
  doc.text('(Third party maintenance providers must coordinate corrective action with Skyway management personnel)',
    MARGIN, y, { maxWidth: CONTENT_W });
  y += 0.18;

  // Corrective Action — large blank box (filled when Part II implemented)
  drawField(doc, MARGIN, y, CONTENT_W, 1.0, 'Corrective Action', aml.correctiveAction || '', { maxLines: 50, valueY: 0.32 });
  y += 1.0;

  // 145 Repair Station: Yes / No
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(20);
  doc.text('145 Repair Station:', MARGIN, y + 0.1);
  // Two boxes
  const rs = aml.repairStation145;
  ['YES', 'NO'].forEach((opt, i) => {
    const bx = MARGIN + 1.4 + i * 0.7;
    doc.setDrawColor(120);
    doc.setLineWidth(0.005);
    doc.rect(bx, y, 0.12, 0.12);
    if ((rs === 'yes' && opt === 'YES') || (rs === 'no' && opt === 'NO')) {
      doc.setLineWidth(0.012);
      doc.line(bx + 0.02, y + 0.06, bx + 0.05, y + 0.10);
      doc.line(bx + 0.05, y + 0.10, bx + 0.11, y + 0.02);
      doc.setLineWidth(0.005);
    }
    doc.setFontSize(8);
    doc.text(opt, bx + 0.16, y + 0.09);
  });
  doc.setFontSize(7);
  doc.setTextColor(110);
  doc.text('(Circle one — if "No", complete the checklist below)', MARGIN + 3.2, y + 0.09);
  y += 0.22;

  // Checklist — Y/N/NA per the form
  const checklistItems = [
    { key: 'toolsCurrent',        label: 'All calibrated tools used have current/non-expired dates?' },
    { key: 'consumablesShelfLife',label: 'All consumables (grease, oil, O-rings used) are within their shelf life.' },
    { key: 'partsServiceable',    label: 'All parts used have been verified as serviceable and were segregated from unserviceable parts?' },
    { key: 'approvedData',        label: 'All maintenance was performed using the appropriate approved data.' },
    { key: 'workScopeComplete',   label: 'All work scope items provided by Skyway Aviation have been completed.' },
    { key: 'melReactivated',      label: 'All items deactivated by MEL have been reactivated and signed off as completed.' },
  ];
  checklistItems.forEach((c) => {
    y = drawChecklist(doc, MARGIN, y, CONTENT_W, c.label, aml.partII?.[c.key] || null);
  });
  y += 0.05;

  // Third party note
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(110);
  const tpNote = doc.splitTextToSize(
    '** Third Party Maintenance Providers MUST provide additional aircraft maintenance record to Skyway personnel that meets the requirements of §43.9 or §43.11 and proof of FAA-approved Drug and Alcohol program before signing below.',
    CONTENT_W
  );
  doc.text(tpNote, MARGIN, y);
  y += tpNote.length * 0.1 + 0.05;

  // Mechanic signature block
  drawSignatureBlock(doc, MARGIN, y, CONTENT_W, {
    label: 'Repair Station / Individual',
    name: aml.partII?.mechanicName || '',
    cert: aml.partII?.mechanicCert || '',
    signatureDataUrl: aml.partII?.mechanicSignatureDataUrl || null,
    capturedAt: aml.partII?.mechanicSignedAt ? fmtDateTime(aml.partII.mechanicSignedAt) : null,
  });
  y += 0.65;

  // === Page 2 — Parts III and IV ===
  doc.addPage();
  y = MARGIN;

  // Logo + footer ref reprised on page 2
  if (logoData) {
    try { doc.addImage(logoData, 'PNG', MARGIN, MARGIN, 1.0, 0.32); } catch (e) {}
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(20);
  doc.text('SKYWAY AVIATION SERVICES, INC.', PAGE_W / 2, MARGIN + 0.10, { align: 'center' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text('GENERAL OPERATIONS MANUAL', PAGE_W / 2, MARGIN + 0.25, { align: 'center' });
  y = MARGIN + 0.55;

  // Aircraft RTS Section header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text('Aircraft Return to Service Section', PAGE_W / 2, y, { align: 'center' });
  y += 0.2;

  // MEL clearance statement
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(40);
  const melStmt = doc.splitTextToSize(
    `MEL statement (If Applicable) *Must be in logbook entry body releasing the MEL*: ` +
    `MEL ${isDeferred ? (aml.melItemRef || 'XX-XX-XX') : 'XX-XX-XX'} HAS BEEN CLEARED IN ACCORDANCE WITH (IAW) ` +
    `SKYWAY AVIATION SERVICES, INC. APPROVED MEL MANUAL, WORK PERFORMED IAW MANUFACTURER'S APPROVED DATA. ` +
    `ALL SYSTEMS DEACTIVATED BY THE ABOVE MEL HAVE BEEN REACTIVATED AND APPROVED FOR RETURN TO SERVICE.`,
    CONTENT_W
  );
  doc.text(melStmt, MARGIN, y);
  y += melStmt.length * 0.1 + 0.1;

  // Jet RTS statement
  const jetStmt = doc.splitTextToSize(
    `Return to Service Statement Jet – 14 CFR Part 91.409(F)(3): I CERTIFY THAT THE ABOVE INSPECTION / MAINTENANCE ` +
    `WAS PERFORMED IAW CFR 91.409(F)(3), MANUFACTURER'S RECOMMENDED INSPECTION PROGRAM AND THE AIRCRAFT IS PRESENTLY ` +
    `IN AN AIRWORTHY CONDITION WITH RESPECT TO THE WORK PERFORMED AND IS APPROVED FOR RETURN TO SERVICE.`,
    CONTENT_W
  );
  doc.text(jetStmt, MARGIN, y);
  y += jetStmt.length * 0.1 + 0.05;

  // Piston RTS statement
  const pistonStmt = doc.splitTextToSize(
    `Return to Service Statement Piston – 14 CFR Part 91.409(A)(1): I CERTIFY THAT THE ABOVE INSPECTION / MAINTENANCE ` +
    `WAS PERFORMED IAW CFR 91.409(A)(1), 100-HOUR / ANNUAL INSPECTIONS AND THE AIRCRAFT IS PRESENTLY IN AN AIRWORTHY ` +
    `CONDITION WITH RESPECT TO THE WORK PERFORMED AND IS APPROVED FOR RETURN TO SERVICE.`,
    CONTENT_W
  );
  doc.text(pistonStmt, MARGIN, y);
  y += pistonStmt.length * 0.1 + 0.15;

  // === PART III ===
  y = drawSectionHeader(doc, y, 'III', 'To be completed by Skyway DOM or operational control personnel authorizing aircraft to return to operation');
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(60);
  const partIIIStmt = doc.splitTextToSize(
    'I certify that this aircraft has been returned to service, and the corrective action has been documented IAW §43.9 or §43.11 and a permanent aircraft record has been completed/received.',
    CONTENT_W
  );
  doc.text(partIIIStmt, MARGIN, y);
  y += partIIIStmt.length * 0.12 + 0.05;

  drawSignatureBlock(doc, MARGIN, y, CONTENT_W, {
    label: 'DOM / Operational Control — Return to Service',
    name: aml.partIII?.domName || '',
    cert: aml.partIII?.domCert || '',
    signatureDataUrl: aml.partIII?.domSignatureDataUrl || null,
    capturedAt: aml.partIII?.signedAt ? fmtDateTime(aml.partIII.signedAt) : null,
  });
  y += 0.65;

  // === PART IV ===
  y = drawSectionHeader(doc, y, 'IV', 'To be completed by Skyway Aviation Services Director of Maintenance');
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(60);
  const partIVStmt = doc.splitTextToSize(
    'I have placed/verified the aircraft maintenance record entry in the permanent aircraft maintenance records. ' +
    'I have verified that all Instructions for Continued Airworthiness, Mandatory Service Bulletins, and Airworthiness Directives are current. ' +
    'I have verified, if applicable, that any new ICAs, ADs, and MSBs have been added to maintenance tracking system. ' +
    'I have verified no new items have expired since the inception of maintenance. ' +
    'If applicable, the appropriate computerized Maintenance Tracking Report has been updated and a new Maintenance Status Report (Status Sheet) has been generated and is available to the PIC.',
    CONTENT_W
  );
  doc.text(partIVStmt, MARGIN, y);
  y += partIVStmt.length * 0.10 + 0.05;

  drawSignatureBlock(doc, MARGIN, y, CONTENT_W, {
    label: 'Director of Maintenance',
    name: aml.partIV?.domName || '',
    cert: aml.partIV?.domCert || '',
    signatureDataUrl: aml.partIV?.domSignatureDataUrl || null,
    capturedAt: aml.partIV?.signedAt ? fmtDateTime(aml.partIV.signedAt) : null,
  });
  y += 0.65;

  // === Footer — form revision id on every page ===
  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(140);
    doc.text('S-3-2/R-31/07-09-25', PAGE_W - MARGIN, PAGE_H - MARGIN + 0.1, { align: 'right' });
    doc.text(`Page ${p} of ${pageCount}`, MARGIN, PAGE_H - MARGIN + 0.1);
    // Digital record disclosure
    doc.setFontSize(6);
    doc.text(
      'Digital record generated by Skyway Ops · Records of click-as-signature events are stored with authenticated user identity + timestamp · IAW AC 120-78A',
      PAGE_W / 2, PAGE_H - MARGIN + 0.18, { align: 'center' }
    );
  }

  // === Save ===
  const filename = `AML-${aml.tail || 'unknown'}-${(aml.id || '').slice(-6) || Date.now()}.pdf`;
  doc.save(filename);
}
