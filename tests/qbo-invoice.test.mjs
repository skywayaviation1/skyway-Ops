import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  agingBuckets,
  buildInvoicePayload,
  buildPaymentPayload,
  invoiceStatus,
  normalizeQboCustomer,
  normalizeQboInvoice,
} from '../src/qbo-invoice.js';
import { publicConnection, qboApiBase, qboEnvironment } from '../api/_quickbooks.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('production is the default QuickBooks environment', () => {
  const original = process.env.INTUIT_ENV;
  try {
    delete process.env.INTUIT_ENV;
    assert.equal(qboEnvironment(), 'production');
    process.env.INTUIT_ENV = 'Production';
    assert.equal(qboEnvironment(), 'production');
    process.env.INTUIT_ENV = 'typo';
    assert.equal(qboEnvironment(), 'production', 'unknown values must not fall back to sandbox');
    process.env.INTUIT_ENV = 'sandbox';
    assert.equal(qboEnvironment(), 'sandbox');
  } finally {
    if (original === undefined) delete process.env.INTUIT_ENV;
    else process.env.INTUIT_ENV = original;
  }
});

test('API base resolves per environment and defaults to live', () => {
  assert.equal(qboApiBase('production'), 'https://quickbooks.api.intuit.com');
  assert.equal(qboApiBase('sandbox'), 'https://sandbox-quickbooks.api.intuit.com');
  assert.equal(qboApiBase(undefined), 'https://quickbooks.api.intuit.com');
});

test('connection status flags an environment mismatch', () => {
  const original = process.env.INTUIT_ENV;
  try {
    delete process.env.INTUIT_ENV;
    const stale = publicConnection({ realmId: '123', environment: 'sandbox' });
    assert.equal(stale.environmentMismatch, true);
    assert.equal(stale.serverEnvironment, 'production');
    const live = publicConnection({ realmId: '123', environment: 'production' });
    assert.equal(live.environmentMismatch, false);
  } finally {
    if (original === undefined) delete process.env.INTUIT_ENV;
    else process.env.INTUIT_ENV = original;
  }
});

test('invoice status reflects balance and due date', () => {
  const now = new Date('2026-08-08T00:00:00Z');
  assert.equal(invoiceStatus({ balance: 0 }, now), 'paid');
  assert.equal(invoiceStatus({ balance: 100, dueDate: '2026-08-01' }, now), 'overdue');
  assert.equal(invoiceStatus({ balance: 100, dueDate: '2026-09-01' }, now), 'open');
});

test('normalizes QuickBooks invoices and customers', () => {
  const invoice = normalizeQboInvoice({
    Id: '42',
    DocNumber: '1042',
    CustomerRef: { value: '7', name: 'Outlier Jets' },
    TxnDate: '2026-08-01',
    DueDate: '2026-08-31',
    TotalAmt: 12500,
    Balance: 12500,
    BillEmail: { Address: 'ap@outlierjets.com' },
    Line: [{
      DetailType: 'SalesItemLineDetail',
      Amount: 12500,
      Description: 'VNC-PIT charter',
      SalesItemLineDetail: { Qty: 2.5, UnitPrice: 5000, ItemRef: { value: '3', name: 'Charter' } },
    }],
  });
  assert.equal(invoice.customerName, 'Outlier Jets');
  assert.equal(invoice.status, 'open');
  assert.equal(invoice.lines[0].quantity, 2.5);
  const customer = normalizeQboCustomer({ Id: '7', DisplayName: 'Outlier Jets', Balance: 12500 });
  assert.equal(customer.name, 'Outlier Jets');
});

test('aging buckets split receivables by days late', () => {
  const now = new Date('2026-08-08T00:00:00Z');
  const buckets = agingBuckets([
    { balance: 100, dueDate: '2026-09-01' },
    { balance: 200, dueDate: '2026-07-25' },
    { balance: 300, dueDate: '2026-06-20' },
    { balance: 400, dueDate: '2026-01-01' },
    { balance: 0, dueDate: '2026-01-01' },
  ], now);
  assert.equal(buckets.current, 100);
  assert.equal(buckets.d1to30, 200);
  assert.equal(buckets.d31to60, 300);
  assert.equal(buckets.d90plus, 400);
  assert.equal(buckets.total, 1000);
});

test('invoice payload validates lines and computes amounts', () => {
  const payload = buildInvoicePayload({
    customerId: '7',
    txnDate: '2026-08-08',
    dueDate: '2026-09-07',
    email: 'ap@outlierjets.com',
    lines: [{ itemId: '3', description: 'Charter', quantity: 2, unitPrice: 5000 }],
  });
  assert.equal(payload.Line[0].Amount, 10000);
  assert.equal(payload.EmailStatus, 'NeedToSend');
  assert.throws(() => buildInvoicePayload({ customerId: '', lines: [] }), /Choose a customer/);
  assert.throws(() => buildInvoicePayload({ customerId: '7', lines: [] }), /at least one invoice line/);
  assert.throws(
    () => buildInvoicePayload({ customerId: '7', lines: [{ itemId: '3', quantity: 0, unitPrice: 5 }] }),
    /quantity must be greater than zero/,
  );
});

test('payment payload links to the invoice and rejects bad amounts', () => {
  const payload = buildPaymentPayload({ customerId: '7', invoiceId: '42', amount: 500, depositAccountId: '9' });
  assert.equal(payload.Line[0].LinkedTxn[0].TxnId, '42');
  assert.equal(payload.DepositToAccountRef.value, '9');
  assert.throws(() => buildPaymentPayload({ customerId: '7', invoiceId: '42', amount: 0 }), /greater than zero/);
  assert.throws(() => buildPaymentPayload({ customerId: '', invoiceId: '42', amount: 5 }), /customer and an invoice/);
});

test('workspace API exposes the live QuickBooks actions', async () => {
  const handler = await source('api/quickbooks-workspace.js');
  for (const action of ['overview', 'createInvoice', 'sendInvoice', 'recordPayment', 'createCustomer']) {
    assert.match(handler, new RegExp(`action === '${action}'`));
  }
  assert.match(handler, /authorizeQboCaller\(req\.body\?\.idToken, \['accounting', 'admin'\]\)/);
});

test('accounting page surfaces invoices and customers tabs', async () => {
  const page = await source('src/Accounting.jsx');
  assert.match(page, /'invoices', 'Invoices & A\/R'/);
  assert.match(page, /'customers', 'Customers'/);
  assert.match(page, /QuickBooksWorkspaceLazy/);
});

test('no code path defaults QuickBooks traffic to sandbox', async () => {
  const client = await source('api/_quickbooks.js');
  const callback = await source('api/quickbooks-oauth-callback.js');
  assert.doesNotMatch(client, /API_BASE\.sandbox/);
  assert.doesNotMatch(callback, /'sandbox'\)\.toLowerCase\(\)/);
  assert.match(callback, /qboEnvironment\(\)/);
});
