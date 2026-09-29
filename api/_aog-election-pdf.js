// Signed AOG election PDF. The terms body is the placeholder Jake replaces.

import PDFDocument from 'pdfkit';
import { AOG_COVERAGE_TERMS_TEXT, AOG_COVERAGE_TERMS_VERSION } from '../src/aog-recovery-terms.js';
import { fmtMoney } from '../src/aog-recovery.js';

function line(doc, label, value) {
  doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
  doc.font('Helvetica').text(value || '—');
}

export function renderElectionPdf({ record, signature }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, size: 'LETTER', compress: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#92400e')
      .text('PLACEHOLDER TERMS — JAKE: REPLACE THIS DOCUMENT BEFORE GOING LIVE.');
    doc.moveDown(0.6);
    doc.fillColor('#111827').fontSize(16).text('AOG coverage election');
    doc.font('Helvetica').fontSize(10).fillColor('#374151')
      .text(`Charter Flight Support mechanical recovery coverage · terms ${signature.termsVersion || AOG_COVERAGE_TERMS_VERSION}`);
    doc.moveDown();

    doc.fontSize(11).fillColor('#111827');
    line(doc, 'Trip ID', record.tripId);
    line(doc, 'Tail', record.tail);
    line(doc, 'Aircraft', record.aircraftType);
    line(doc, 'Dates', record.datesLabel || [record.departDate, record.returnDate].filter(Boolean).join(' – '));
    line(doc, 'Route', record.route);
    line(doc, 'Trip total', fmtMoney(record.tripTotal));
    line(doc, 'Coverage elected', '100%');
    line(doc, 'Premium charged', fmtMoney(signature.premium ?? record.premium));
    doc.moveDown();
    doc.font('Helvetica-Oblique').fontSize(10)
      .text('The amount charged is a one-time premium, charged separately from the charter.');
    doc.moveDown();

    doc.font('Helvetica-Bold').fontSize(12).text('Terms');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).text(AOG_COVERAGE_TERMS_TEXT, { align: 'left' });
    doc.moveDown();

    doc.font('Helvetica-Bold').fontSize(12).text('Signature');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11);
    line(doc, 'Typed full name', signature.fullName);
    line(doc, 'Agreed', signature.agreed ? 'Yes' : 'No');
    line(doc, 'Signed at', signature.signedAt);
    line(doc, 'IP address', signature.ip);
    line(doc, 'User agent', String(signature.userAgent || '').slice(0, 300));
    line(doc, 'Terms version', signature.termsVersion || AOG_COVERAGE_TERMS_VERSION);
    doc.end();
  });
}
