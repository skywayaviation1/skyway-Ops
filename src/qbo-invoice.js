// Accounts-receivable helpers shared by the QuickBooks workspace UI and the
// server. Pure functions only so invoice maths can be tested without Intuit.

export function invoiceStatus(invoice, today = new Date()) {
  const balance = Number(invoice?.balance || 0);
  if (balance <= 0.005) return 'paid';
  const due = invoice?.dueDate ? new Date(`${invoice.dueDate}T00:00:00`) : null;
  if (due && due.getTime() < new Date(today.toISOString().slice(0, 10)).getTime()) return 'overdue';
  return 'open';
}

export function normalizeQboInvoice(invoice) {
  const normalized = {
    id: String(invoice?.Id || ''),
    docNumber: invoice?.DocNumber || '',
    customerId: String(invoice?.CustomerRef?.value || ''),
    customerName: invoice?.CustomerRef?.name || '',
    date: invoice?.TxnDate || '',
    dueDate: invoice?.DueDate || '',
    total: Number(invoice?.TotalAmt || 0),
    balance: Number(invoice?.Balance || 0),
    email: invoice?.BillEmail?.Address || '',
    emailStatus: invoice?.EmailStatus || 'NotSet',
    privateNote: invoice?.PrivateNote || '',
    lines: (invoice?.Line || [])
      .filter((line) => line?.DetailType === 'SalesItemLineDetail')
      .map((line) => ({
        description: line?.Description || '',
        amount: Number(line?.Amount || 0),
        quantity: Number(line?.SalesItemLineDetail?.Qty || 0),
        unitPrice: Number(line?.SalesItemLineDetail?.UnitPrice || 0),
        itemId: String(line?.SalesItemLineDetail?.ItemRef?.value || ''),
        itemName: line?.SalesItemLineDetail?.ItemRef?.name || '',
      })),
  };
  normalized.status = invoiceStatus(normalized);
  return normalized;
}

export function normalizeQboCustomer(customer) {
  return {
    id: String(customer?.Id || ''),
    name: customer?.DisplayName || customer?.CompanyName || '',
    companyName: customer?.CompanyName || '',
    email: customer?.PrimaryEmailAddr?.Address || '',
    phone: customer?.PrimaryPhone?.FreeFormNumber || '',
    balance: Number(customer?.Balance || 0),
    active: customer?.Active !== false,
  };
}

export function normalizeQboItem(item) {
  return {
    id: String(item?.Id || ''),
    name: item?.FullyQualifiedName || item?.Name || '',
    type: item?.Type || '',
    unitPrice: Number(item?.UnitPrice || 0),
    incomeAccountId: String(item?.IncomeAccountRef?.value || ''),
  };
}

/** Age open receivables into the buckets QuickBooks reports use. */
export function agingBuckets(invoices, today = new Date()) {
  const buckets = { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0 };
  const todayMs = new Date(today.toISOString().slice(0, 10)).getTime();
  for (const invoice of invoices || []) {
    const balance = Number(invoice?.balance || 0);
    if (balance <= 0.005) continue;
    buckets.total += balance;
    const due = invoice?.dueDate ? new Date(`${invoice.dueDate}T00:00:00`).getTime() : null;
    const daysLate = due == null ? 0 : Math.floor((todayMs - due) / 86_400_000);
    if (daysLate <= 0) buckets.current += balance;
    else if (daysLate <= 30) buckets.d1to30 += balance;
    else if (daysLate <= 60) buckets.d31to60 += balance;
    else if (daysLate <= 90) buckets.d61to90 += balance;
    else buckets.d90plus += balance;
  }
  return buckets;
}

/**
 * Validate a new invoice and shape it for the QuickBooks API. Throws with a
 * plain-language reason so the UI never posts a malformed invoice.
 */
export function buildInvoicePayload({ customerId, lines, dueDate, txnDate, email, memo }) {
  const customer = String(customerId || '').trim();
  if (!customer) throw new Error('Choose a customer');
  const items = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      itemId: String(line?.itemId || '').trim(),
      description: String(line?.description || '').trim().slice(0, 4000),
      quantity: Number(line?.quantity ?? 1),
      unitPrice: Number(line?.unitPrice ?? 0),
    }))
    .filter((line) => line.itemId && Number.isFinite(line.quantity) && Number.isFinite(line.unitPrice));
  if (!items.length) throw new Error('Add at least one invoice line with an item and amount');
  if (items.some((line) => line.quantity <= 0)) throw new Error('Line quantity must be greater than zero');
  if (items.some((line) => line.unitPrice < 0)) throw new Error('Line rate cannot be negative');

  const payload = {
    CustomerRef: { value: customer },
    Line: items.map((line) => ({
      DetailType: 'SalesItemLineDetail',
      Amount: Number((line.quantity * line.unitPrice).toFixed(2)),
      Description: line.description || undefined,
      SalesItemLineDetail: {
        ItemRef: { value: line.itemId },
        Qty: line.quantity,
        UnitPrice: line.unitPrice,
      },
    })),
  };
  if (txnDate) payload.TxnDate = txnDate;
  if (dueDate) payload.DueDate = dueDate;
  if (memo) payload.PrivateNote = String(memo).slice(0, 4000);
  if (email) {
    payload.BillEmail = { Address: String(email).trim() };
    payload.EmailStatus = 'NeedToSend';
  }
  return payload;
}

/** Shape a customer payment applied against one invoice. */
export function buildPaymentPayload({ customerId, invoiceId, amount, txnDate, depositAccountId }) {
  const customer = String(customerId || '').trim();
  const invoice = String(invoiceId || '').trim();
  const value = Number(amount);
  if (!customer || !invoice) throw new Error('Payment needs a customer and an invoice');
  if (!Number.isFinite(value) || value <= 0) throw new Error('Payment amount must be greater than zero');
  const payload = {
    CustomerRef: { value: customer },
    TotalAmt: Number(value.toFixed(2)),
    Line: [{
      Amount: Number(value.toFixed(2)),
      LinkedTxn: [{ TxnId: invoice, TxnType: 'Invoice' }],
    }],
  };
  if (txnDate) payload.TxnDate = txnDate;
  if (depositAccountId) payload.DepositToAccountRef = { value: String(depositAccountId) };
  return payload;
}
