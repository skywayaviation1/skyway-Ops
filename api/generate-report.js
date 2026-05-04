// Vercel serverless function: generate Malfunction/Incident Report PDF
// and email to the recipient list.
//
// Layout matches the paper Skyway form: company logo header, table-style
// fields, and the same field labels in the same order.
//
// Recipients are HARDCODED to the four addresses required by company policy:
//   jake@flyskyway.com, zack@flyskyway.com, jim@flyskyway.com, mx@flyskyway.com
//
// 14 CFR § 135.65 reference:
//   "Each certificate holder shall maintain a record of each interruption
//   to a flight ... including: the type of aircraft, registration number,
//   date and time of interruption, ..."
//
// Body shape: { report: { ... }, previewOnly?: bool }
// Returns:    { ok, pdfBase64, emailId, emailError, recipients }

export const config = { runtime: 'nodejs' };

import PDFDocument from 'pdfkit';

const RECIPIENTS = [
  'jake@flyskyway.com',
  'zack@flyskyway.com',
  'jim@flyskyway.com',
  'mx@flyskyway.com',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  const report = body?.report;
  if (!report) return res.status(400).json({ error: 'Missing report' });
  const previewOnly = body?.previewOnly === true;

  try {
    const pdfBuffer = await buildReportPdf(report);
    const pdfBase64 = pdfBuffer.toString('base64');

    if (previewOnly) {
      return res.status(200).json({
        ok: true,
        pdfBase64,
        emailId: null,
        emailError: null,
        recipients: RECIPIENTS,
        previewOnly: true,
      });
    }

    // Email to the four addresses
    const apiKey = process.env.RESEND_API_KEY;
    let emailId = null;
    let emailError = null;
    if (apiKey) {
      try {
        const subject = `Malfunction Report — ${report.tail || 'Unknown'} ${report.date || ''}`.trim();
        const filename = `malfunction-report-${(report.tail || 'tail').replace(/[^A-Z0-9]/gi, '')}-${(report.date || '').replace(/[^0-9]/g, '')}.pdf`;
        const text = [
          `A new Malfunction/Incident Report has been submitted.`,
          ``,
          `Aircraft:        ${report.tail || ''}`,
          `Date:            ${report.date || ''}`,
          `Submitted by:    ${report.submittedByName || ''} (${report.submittedByEmail || ''})`,
          `Role:            ${report.submittedByRole || ''}`,
          `Departure:       ${report.departureId || ''}`,
          `Destination:     ${report.destinationId || ''}`,
          `Diversion:       ${report.diversion ? `Yes (to ${report.divertedTo || 'unspecified'})` : 'No'}`,
          `Emergency:       ${report.emergencyDeclared ? 'Yes' : 'No'}`,
          `Affected system: ${report.affectedSystem || ''}`,
          ``,
          `--- Description of event ---`,
          report.textOfEvent || '(no description provided)',
          ``,
          `PDF attached. Per 14 CFR § 135.65 this report is retained in the Skyway operations system.`,
        ].join('\n');

        const upstream = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Skyway Ops <noreply@send.flyskyway.com>',
            to: RECIPIENTS,
            subject,
            text,
            attachments: [{ filename, content: pdfBase64 }],
          }),
        });
        const upstreamData = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          emailError = upstreamData?.message || `Resend ${upstream.status}`;
          console.error('[generate-report] email send failed:', emailError);
        } else {
          emailId = upstreamData?.id || null;
        }
      } catch (err) {
        emailError = err.message;
        console.error('[generate-report] email exception:', err);
      }
    } else {
      emailError = 'RESEND_API_KEY not configured';
    }

    return res.status(200).json({
      ok: !emailError,
      pdfBase64,
      emailId,
      emailError,
      recipients: RECIPIENTS,
    });
  } catch (err) {
    console.error('[generate-report] PDF build error:', err);
    return res.status(500).json({ error: err.message || 'PDF generation failed' });
  }
}

// ============================================================
//   PDF BUILDER — matches the paper Malfunction/Incident form
// ============================================================

async function buildReportPdf(r) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  // Header: company name + form title
  doc.fillColor('#0891B2').fontSize(20).font('Helvetica-Bold');
  doc.text('SKYWAY AVIATION', { align: 'center' });
  doc.fillColor('#374151').fontSize(9).font('Helvetica');
  doc.text('PRIVATE JET AND HELICOPTER CHARTER SERVICES', { align: 'center' });
  doc.moveDown(1);

  // Form title bar
  const titleY = doc.y;
  doc.rect(54, titleY, 504, 24).fillAndStroke('#F3F4F6', '#9CA3AF');
  doc.fillColor('#000').fontSize(13).font('Helvetica-Bold');
  doc.text('MALFUNCTION / INCIDENT REPORT', 54, titleY + 6, { width: 504, align: 'center' });
  doc.moveDown(2);

  // Helper to draw a row with label + value(s)
  const rowH = 22;
  const cellPad = 4;
  let y = doc.y;

  function drawRow(cells) {
    // cells = [{ label, value, w }]
    let x = 54;
    for (const c of cells) {
      doc.rect(x, y, c.w, rowH).stroke('#9CA3AF');
      // Label (bold, top-left)
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151');
      doc.text(c.label, x + cellPad, y + 4, { width: c.w - cellPad * 2 });
      // Value (regular, indented under label)
      if (c.value !== undefined && c.value !== '') {
        doc.fontSize(9).font('Helvetica').fillColor('#000');
        doc.text(String(c.value), x + cellPad, y + 12, {
          width: c.w - cellPad * 2,
          height: rowH - 14,
          ellipsis: true,
        });
      }
      x += c.w;
    }
    y += rowH;
  }

  function drawSectionBar(label) {
    doc.rect(54, y, 504, 18).fillAndStroke('#E5E7EB', '#9CA3AF');
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000');
    doc.text(label, 54, y + 4, { width: 504, align: 'center' });
    y += 18;
  }

  // Date row
  drawRow([{ label: 'Date:', value: r.date || '', w: 504 }]);

  // AIRCRAFT section
  drawSectionBar('AIRCRAFT');
  drawRow([{ label: 'Aircraft Registration & Type:', value: r.tail || '', w: 504 }]);

  // FLIGHT CREW section
  drawSectionBar('FLIGHT CREW');
  drawRow([
    { label: 'PIC:', value: r.pic || '', w: 252 },
    { label: 'SIC:', value: r.sic || '', w: 252 },
  ]);

  // EVENT section
  drawSectionBar('EVENT');
  drawRow([{ label: 'Flight Mode:', value: r.flightMode || '', w: 504 }]);

  // Flight Condition row — show selected
  const imcLabel = r.flightConditionIMC ? '[X] IMC   [ ] VMC' : '[ ] IMC   [X] VMC';
  const dayLabel = r.flightConditionDay ? '[X] Day   [ ] Night' : '[ ] Day   [X] Night';
  drawRow([
    { label: 'Flight Condition:', value: imcLabel, w: 252 },
    { label: '', value: dayLabel, w: 252 },
  ]);

  drawRow([
    { label: 'Departure ID:', value: r.departureId || '', w: 252 },
    { label: 'Destination ID:', value: r.destinationId || '', w: 252 },
  ]);

  const divLabel = r.diversion ? '[X] Yes   [ ] No' : '[ ] Yes   [X] No';
  const emLabel = r.emergencyDeclared ? '[X] Yes   [ ] No' : '[ ] Yes   [X] No';
  drawRow([
    { label: 'Diversion:', value: divLabel, w: 252 },
    { label: 'Emergency Declared:', value: emLabel, w: 252 },
  ]);

  drawRow([{ label: 'If Yes, Diverted to:', value: r.divertedTo || '', w: 504 }]);

  // DESCRIPTION
  drawSectionBar('DESCRIPTION OF EVENT');
  drawRow([
    { label: 'Affected System:', value: r.affectedSystem || '', w: 252 },
    { label: 'Caution/Warning Light:', value: r.cautionWarningLight || '', w: 252 },
  ]);

  // Text of event — large multi-line area
  const textBoxH = 180;
  doc.rect(54, y, 504, textBoxH).stroke('#9CA3AF');
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151');
  doc.text('Text of event:', 54 + cellPad, y + 4);
  doc.fontSize(10).font('Helvetica').fillColor('#000');
  doc.text(r.textOfEvent || '', 54 + cellPad, y + 18, {
    width: 504 - cellPad * 2,
    height: textBoxH - 22,
  });
  y += textBoxH;

  // Submitted by
  const subLabel = r.submittedByRole === 'PIC' ? '[X] PIC   [ ] SIC' : '[ ] PIC   [X] SIC';
  drawRow([
    { label: 'By:', value: r.submittedByName || '', w: 252 },
    { label: '', value: subLabel, w: 252 },
  ]);
  drawRow([{ label: 'Certificate #:', value: r.certificateNumber || '', w: 504 }]);

  // Audit footer
  y += 8;
  doc.fontSize(7).font('Helvetica').fillColor('#6B7280');
  if (r.submittedAt) {
    doc.text(
      `Submitted electronically by ${r.submittedByName || ''} (${r.submittedByEmail || ''}) ` +
      `at ${new Date(r.submittedAt).toISOString()} · Skyway Ops System`,
      54, y, { width: 504 }
    );
  }
  doc.text(
    `Per 14 CFR § 135.65 — record of mechanical interruption.`,
    54, y + 12, { width: 504 }
  );

  doc.end();
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
