// Vercel serverless function: generate Skyway Load Manifest PDF (S-5/R-37)
// and email to Loadmanifest@flyskyway.com.
//
// Layout matches the paper form:
//   - Header: "Skyway Aviation Services, Inc. / General Operations Manual / S-5/R-37/10-30-23"
//   - Title: "Load Manifest"
//   - Top row: N#, Date | Hobbs Out, Hobbs In, Hobbs Total, Wait Time
//   - Duty Time block
//   - Per-leg columns (up to 7): From, To, Time Out/In/Total, Airport,
//     Cycles, Night Ldgs, Passengers (1-7), T/O weight, Max Allowable,
//     Fwd CG limit, T/O CG, Aft CG limit, # Passengers, Configuration
//   - Acceptance text block
//   - PIC Signature, SIC Signature with typed names + audit footer
//
// After generating the PDF, this endpoint emails it as an attachment to
// Loadmanifest@flyskyway.com using Resend.
//
// Required env vars:
//   RESEND_API_KEY — for sending the email
//
// Body shape:
//   { manifest: { ...full manifest doc... } }
//
// Returns:
//   { ok: true, pdfBase64: '...', emailId: 'resend-id' }

export const config = { runtime: 'nodejs' };

import PDFDocument from 'pdfkit';

const FORM_REV = 'S-5/R-37/10-30-23';

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
  const manifest = body?.manifest;
  if (!manifest) return res.status(400).json({ error: 'Missing manifest' });

  try {
    // Build PDF in-memory
    const pdfBuffer = await buildManifestPdf(manifest);
    const pdfBase64 = pdfBuffer.toString('base64');

    // Email to Loadmanifest@flyskyway.com
    const apiKey = process.env.RESEND_API_KEY;
    let emailId = null;
    let emailError = null;
    if (apiKey) {
      try {
        const subject = `Load Manifest — ${manifest.tail || 'Unknown'} ${manifest.tripDate || ''} ${manifest.tripCode ? `[${manifest.tripCode}]` : ''}`.trim();
        const filename = `manifest-${(manifest.tail || 'tail').replace(/[^A-Z0-9]/gi, '')}-${(manifest.tripDate || '').replace(/[^0-9]/g, '')}.pdf`;
        const text = [
          `Load Manifest submitted by ${manifest.submittedBy || 'crew'}.`,
          '',
          `Aircraft:       ${manifest.tail || ''}`,
          `Date:           ${manifest.tripDate || ''}`,
          `Trip code:      ${manifest.tripCode || ''}`,
          `Hobbs out:      ${manifest.hobbsOut || ''}`,
          `Hobbs in:       ${manifest.hobbsIn || ''}`,
          `Hobbs total:    ${manifest.hobbsTotal || ''}`,
          `Legs:           ${(manifest.legs || []).length}`,
          '',
          `PIC: ${manifest.picSig?.name || ''} (${manifest.picSig?.email || ''})`,
          `SIC: ${manifest.sicSig?.name || ''} (${manifest.sicSig?.email || ''})`,
          '',
          'PDF attached. This email was sent automatically by Skyway Ops.',
          `Form revision: ${FORM_REV}`,
        ].join('\n');

        const upstream = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Skyway Ops <noreply@send.flyskyway.com>',
            to: ['Loadmanifest@flyskyway.com'],
            subject,
            text,
            attachments: [{ filename, content: pdfBase64 }],
          }),
        });
        const upstreamData = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          emailError = upstreamData?.message || `Resend ${upstream.status}`;
          console.error('[generate-manifest] email send failed:', emailError);
        } else {
          emailId = upstreamData?.id || null;
        }
      } catch (err) {
        emailError = err.message;
        console.error('[generate-manifest] email exception:', err);
      }
    } else {
      emailError = 'RESEND_API_KEY not configured';
    }

    return res.status(200).json({
      ok: !emailError,
      pdfBase64,
      emailId,
      emailError,
    });
  } catch (err) {
    console.error('[generate-manifest] PDF build error:', err);
    return res.status(500).json({ error: err.message || 'PDF generation failed' });
  }
}

/**
 * Build the manifest PDF using pdfkit. Layout mirrors the paper S-5/R-37 form.
 * Returns a Buffer.
 */
async function buildManifestPdf(m) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 36, layout: 'landscape' });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  // Header band
  doc.fontSize(9).font('Helvetica').fillColor('#000');
  doc.text('SKYWAY AVIATION SERVICES, INC.', { align: 'left' });
  doc.text('GENERAL OPERATIONS MANUAL', { align: 'left' });
  doc.text(FORM_REV, { align: 'left' });

  doc.moveDown(0.3);
  doc.fontSize(16).font('Helvetica-Bold').text('Load Manifest', { align: 'center' });
  doc.moveDown(0.3);

  // Top row: tail/date | hobbs | duty | wait
  const topY = doc.y;
  doc.fontSize(8).font('Helvetica');
  // Tail + Date column
  doc.text(`N #: ${m.tail || ''}`, 36, topY, { width: 150 });
  doc.text(`Date: ${m.tripDate || ''}`, 36, topY + 14, { width: 150 });
  // Hobbs
  doc.text(`Hobbs Out: ${m.hobbsOut || ''}`, 200, topY, { width: 130 });
  doc.text(`Hobbs In:  ${m.hobbsIn || ''}`, 200, topY + 14, { width: 130 });
  doc.text(`Hobbs Total: ${m.hobbsTotal || ''}`, 200, topY + 28, { width: 130 });
  // Duty
  doc.text(`Duty Time In:    ${m.dutyTimeIn || ''}`, 360, topY, { width: 200 });
  doc.text(`Duty Time Out:   ${m.dutyTimeOut || ''}`, 360, topY + 14, { width: 200 });
  doc.text(`Duty Time Total: ${m.dutyTimeTotal || ''}`, 360, topY + 28, { width: 200 });
  // Wait
  doc.text(`Wait Time: ${m.waitTime || ''}`, 580, topY, { width: 180 });

  doc.y = topY + 50;
  doc.moveDown(0.3);

  // Per-leg table
  // Columns: label | 1st | 2nd | 3rd | 4th | 5th | 6th | 7th
  const labels = [
    { key: 'fromTo',       label: 'From → To' },
    { key: 'timeOut',      label: 'Time Out' },
    { key: 'timeIn',       label: 'Time In' },
    { key: 'total',        label: 'Total' },
    { key: 'airport',      label: 'Airport' },
    { key: 'cycles',       label: 'Cycles' },
    { key: 'nightLdgs',    label: 'Night Ldgs' },
    { key: 'pax1',         label: 'Pax 1' },
    { key: 'pax2',         label: 'Pax 2' },
    { key: 'pax3',         label: 'Pax 3' },
    { key: 'pax4',         label: 'Pax 4' },
    { key: 'pax5',         label: 'Pax 5' },
    { key: 'pax6',         label: 'Pax 6' },
    { key: 'pax7',         label: 'Pax 7' },
    { key: 'toWeight',     label: 'T/O weight' },
    { key: 'maxAllowable', label: 'Max Allowable' },
    { key: 'fwdCG',        label: 'Fwd C.G. limit' },
    { key: 'toCG',         label: 'T/O C.G.' },
    { key: 'aftCG',        label: 'Aft C.G. limit' },
    { key: 'numPax',       label: '# Passengers' },
    { key: 'configuration',label: 'Configuration' },
  ];

  const startY = doc.y;
  const labelW = 110;
  const colW = 86;
  const rowH = 13;

  doc.font('Helvetica-Bold').fontSize(7);
  // Header row
  doc.rect(36, startY, labelW, rowH).stroke();
  doc.text('', 40, startY + 3);
  for (let i = 0; i < 7; i++) {
    doc.rect(36 + labelW + i * colW, startY, colW, rowH).stroke();
    doc.text(`${i + 1}${i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'} Leg`, 36 + labelW + i * colW + 4, startY + 3);
  }

  doc.font('Helvetica').fontSize(7);
  let rowY = startY + rowH;
  for (const lab of labels) {
    // Label cell
    doc.rect(36, rowY, labelW, rowH).stroke();
    doc.text(lab.label, 40, rowY + 3, { width: labelW - 6 });
    // Leg cells
    for (let i = 0; i < 7; i++) {
      const cellX = 36 + labelW + i * colW;
      doc.rect(cellX, rowY, colW, rowH).stroke();
      const leg = (m.legs || [])[i] || {};
      let val = '';
      if (lab.key === 'fromTo') val = `${leg.from || ''} → ${leg.to || ''}`;
      else if (lab.key.startsWith('pax')) {
        const idx = parseInt(lab.key.replace('pax', ''), 10) - 1;
        val = (leg.passengers || [])[idx] || '';
      } else {
        val = leg[lab.key] != null ? String(leg[lab.key]) : '';
      }
      doc.text(val, cellX + 3, rowY + 3, { width: colW - 6 });
    }
    rowY += rowH;
  }

  // Acceptance block
  doc.moveDown(1);
  doc.y = rowY + 12;
  doc.fontSize(8).font('Helvetica-Oblique');
  doc.text(
    'Acceptance of Flight Release: I have completed a preflight inspection of the aircraft, ' +
    'checked the scale used for weight & balance purposes and completed all duties required by ' +
    'FAA regulations and Skyway Aviation\'s Operations Manual and hereby accept this aircraft for flight.',
    36, doc.y, { width: 740, align: 'left' }
  );

  doc.moveDown(0.5);
  // Signature blocks
  const sigY = doc.y;
  drawSignature(doc, 'PIC', m.picSig, 36, sigY);
  drawSignature(doc, 'SIC', m.sicSig, 410, sigY);

  // Audit footer
  doc.fontSize(6).font('Helvetica').fillColor('#444');
  const footerY = sigY + 100;
  doc.y = footerY;
  if (m.picSig?.timestamp) {
    doc.text(
      `Signed electronically by ${m.picSig.name} (${m.picSig.email}) at ${new Date(m.picSig.timestamp).toISOString()} — Skyway Ops form ${FORM_REV}`,
      36, footerY, { width: 740 }
    );
  }
  if (m.sicSig?.timestamp) {
    doc.text(
      `Signed electronically by ${m.sicSig.name} (${m.sicSig.email}) at ${new Date(m.sicSig.timestamp).toISOString()}`,
      36, doc.y, { width: 740 }
    );
  }

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function drawSignature(doc, role, sig, x, y) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#000');
  doc.text(`${role} Signature`, x, y);
  doc.text(`${role} Name (print): ${sig?.name || ''}`, x, y + 56);
  // Signature image
  if (sig?.signatureImg && sig.signatureImg.startsWith('data:image/')) {
    try {
      const base64 = sig.signatureImg.split(',')[1];
      const buf = Buffer.from(base64, 'base64');
      doc.image(buf, x, y + 12, { fit: [220, 40], align: 'left' });
    } catch (err) {
      console.warn('[manifest-pdf] signature image failed:', err.message);
    }
  } else {
    // Line for the signature
    doc.moveTo(x, y + 50).lineTo(x + 240, y + 50).stroke();
  }
  // Underline for printed name
  doc.moveTo(x, y + 70).lineTo(x + 240, y + 70).stroke();
}
