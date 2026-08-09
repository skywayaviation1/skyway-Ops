// Accounts-receivable workspace backed directly by the connected QuickBooks
// company: customers, invoices, emailing invoices and receiving payments.

import {
  authorizeQboCaller,
  createEntity,
  publicConnection,
  qboQuery,
  qboRequest,
  qboString,
  readConnection,
} from './_quickbooks.js';
import {
  agingBuckets,
  buildInvoicePayload,
  buildPaymentPayload,
  normalizeQboCustomer,
  normalizeQboInvoice,
  normalizeQboItem,
} from '../src/qbo-invoice.js';

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function safeId(value, label = 'ID') {
  const id = String(value || '').trim();
  if (!id || !/^[A-Za-z0-9-]{1,40}$/.test(id)) throw new Error(`Invalid ${label}`);
  return id;
}

async function overview() {
  const [invoiceBody, customerBody, itemBody, depositBody] = await Promise.all([
    qboQuery('select * from Invoice orderby TxnDate desc maxresults 200'),
    qboQuery('select * from Customer where Active = true orderby DisplayName maxresults 500'),
    qboQuery("select * from Item where Active = true and Type = 'Service' maxresults 200"),
    qboQuery("select * from Account where Active = true and AccountType = 'Bank' maxresults 100"),
  ]);
  const invoices = (invoiceBody?.QueryResponse?.Invoice || []).map(normalizeQboInvoice);
  return {
    invoices,
    customers: (customerBody?.QueryResponse?.Customer || []).map(normalizeQboCustomer),
    items: (itemBody?.QueryResponse?.Item || []).map(normalizeQboItem),
    depositAccounts: (depositBody?.QueryResponse?.Account || []).map((account) => ({
      id: String(account.Id),
      name: account.FullyQualifiedName || account.Name || '',
    })),
    aging: agingBuckets(invoices),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const caller = await authorizeQboCaller(req.body?.idToken, ['accounting', 'admin']);
    const connection = await readConnection();
    if (!connection) {
      res.status(200).json({ connected: false, ...publicConnection(null) });
      return;
    }
    const action = req.body?.action || 'overview';
    let result;

    if (action === 'overview') {
      result = await overview();
    } else if (action === 'invoice') {
      const body = await qboRequest(`/invoice/${safeId(req.body?.invoiceId, 'invoice ID')}?minorversion=70`);
      result = { invoice: normalizeQboInvoice(body?.Invoice) };
    } else if (action === 'createInvoice') {
      const payload = buildInvoicePayload({
        customerId: req.body?.customerId,
        lines: req.body?.lines,
        txnDate: validDate(req.body?.txnDate) ? req.body.txnDate : undefined,
        dueDate: validDate(req.body?.dueDate) ? req.body.dueDate : undefined,
        email: req.body?.email,
        memo: req.body?.memo,
      });
      const created = await createEntity('invoice', payload);
      result = { invoice: normalizeQboInvoice(created), createdBy: caller.name };
    } else if (action === 'sendInvoice') {
      const invoiceId = safeId(req.body?.invoiceId, 'invoice ID');
      const email = String(req.body?.email || '').trim();
      const path = email
        ? `/invoice/${invoiceId}/send?sendTo=${encodeURIComponent(email)}&minorversion=70`
        : `/invoice/${invoiceId}/send?minorversion=70`;
      const sent = await qboRequest(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      result = { invoice: normalizeQboInvoice(sent?.Invoice), sent: true };
    } else if (action === 'recordPayment') {
      const payload = buildPaymentPayload({
        customerId: req.body?.customerId,
        invoiceId: req.body?.invoiceId,
        amount: req.body?.amount,
        txnDate: validDate(req.body?.txnDate) ? req.body.txnDate : undefined,
        depositAccountId: req.body?.depositAccountId,
      });
      const payment = await createEntity('payment', payload);
      const refreshed = await qboRequest(
        `/invoice/${safeId(req.body?.invoiceId, 'invoice ID')}?minorversion=70`,
      );
      result = {
        paymentId: String(payment?.Id || ''),
        invoice: normalizeQboInvoice(refreshed?.Invoice),
      };
    } else if (action === 'createCustomer') {
      const name = String(req.body?.name || '').trim().slice(0, 100);
      if (!name) throw new Error('Customer name is required');
      const existing = await qboQuery(
        `select * from Customer where DisplayName = '${qboString(name)}' maxresults 1`,
      );
      const found = existing?.QueryResponse?.Customer?.[0];
      if (found) {
        result = { customer: normalizeQboCustomer(found), existing: true };
      } else {
        const payload = { DisplayName: name };
        const email = String(req.body?.email || '').trim();
        if (email) payload.PrimaryEmailAddr = { Address: email };
        const phone = String(req.body?.phone || '').trim();
        if (phone) payload.PrimaryPhone = { FreeFormNumber: phone };
        result = { customer: normalizeQboCustomer(await createEntity('customer', payload)) };
      }
    } else {
      throw new Error('Unknown QuickBooks workspace action');
    }

    res.status(200).json({ ok: true, ...publicConnection(connection), ...result });
  } catch (err) {
    console.error('[quickbooks-workspace]', err);
    res.status(err.status || 500).json({ error: err.message || 'QuickBooks request failed' });
  }
}
