// Public ops decision links from the invoice-request email. The token is the
// credential. GET only describes the request. POST approves or declines.

import { decideInvoice, findByInvoiceToken, invoiceDecisionView } from './_aog-invoice.js';
import { publicBaseUrl, readJson, recoveryDb } from './_aog-recovery.js';
import { paymentStatusLabel } from '../src/aog-recovery.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = req.method === 'POST' ? readJson(req) : {};
    const token = String(body.token || req.query?.token || '').trim();
    if (!token || token.length < 20) {
      res.status(400).json({ error: 'This invoice link is missing or invalid' });
      return;
    }
    const db = recoveryDb();
    const found = await findByInvoiceToken(db, token);
    if (!found) {
      res.status(404).json({ error: 'This invoice link is not valid' });
      return;
    }
    if (req.method === 'GET') {
      res.status(200).json({
        ok: true,
        invoice: {
          ...invoiceDecisionView({ id: found.id, ...found.data }),
          paymentLabel: paymentStatusLabel(found.data.paymentStatus),
        },
      });
      return;
    }
    const decision = String(body.decision || '').trim();
    const result = await decideInvoice(db, found.ref, { id: found.id, ...found.data }, {
      decision,
      actor: 'email-link',
      baseUrl: publicBaseUrl(req),
    });
    res.status(200).json({
      ok: true,
      duplicate: result.duplicate === true,
      invoice: {
        ...invoiceDecisionView(result.record),
        paymentLabel: paymentStatusLabel(result.record.paymentStatus),
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Invoice decision failed' });
  }
}
