// Finance dashboard data sourced directly from the connected QBO company.

import {
  authorizeQboCaller,
  publicConnection,
  qboQuery,
  qboRequest,
  readConnection,
} from './_quickbooks.js';
import { normalizeQboPurchase } from '../src/qbo-reconciliation.js';

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    await authorizeQboCaller(req.body?.idToken, ['accounting', 'admin']);
    const now = new Date();
    const defaultStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const defaultEnd = now.toISOString().slice(0, 10);
    const startDate = validDate(req.body?.startDate) ? req.body.startDate : defaultStart;
    const endDate = validDate(req.body?.endDate) ? req.body.endDate : defaultEnd;
    const connection = await readConnection();
    if (!connection) {
      res.status(200).json({ connected: false });
      return;
    }

    const reportParams = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      accounting_method: req.body?.accountingMethod === 'Cash' ? 'Cash' : 'Accrual',
      minorversion: '70',
    });
    const [profitAndLoss, balanceSheet, accountBody, purchaseBody, billBody] = await Promise.all([
      qboRequest(`/reports/ProfitAndLoss?${reportParams.toString()}`),
      qboRequest(`/reports/BalanceSheet?${reportParams.toString()}`),
      qboQuery('select * from Account where Active = true maxresults 1000'),
      qboQuery(
        `select * from Purchase where TxnDate >= '${startDate}' and TxnDate <= '${endDate}' maxresults 1000`,
      ),
      qboQuery(
        `select * from Bill where TxnDate >= '${startDate}' and TxnDate <= '${endDate}' maxresults 1000`,
      ),
    ]);

    const accounts = (accountBody?.QueryResponse?.Account || []).map((account) => ({
      id: String(account.Id),
      name: account.FullyQualifiedName || account.Name || '',
      type: account.AccountType || '',
      subtype: account.AccountSubType || '',
      currentBalance: Number(account.CurrentBalance || 0),
      currency: account.CurrencyRef?.value || 'USD',
    }));
    const cardAccounts = accounts.filter((account) => account.type === 'Credit Card');
    const purchases = (purchaseBody?.QueryResponse?.Purchase || [])
      .map(normalizeQboPurchase)
      .filter((purchase) => cardAccounts.some((account) => account.id === purchase.accountId));
    const bills = (billBody?.QueryResponse?.Bill || []).map((bill) => ({
      id: String(bill.Id),
      date: bill.TxnDate || '',
      dueDate: bill.DueDate || '',
      amount: Number(bill.TotalAmt || 0),
      balance: Number(bill.Balance || 0),
      vendorName: bill.VendorRef?.name || '',
      docNumber: bill.DocNumber || '',
    }));

    res.status(200).json({
      ...publicConnection(connection),
      startDate,
      endDate,
      accounts,
      cardAccounts,
      purchases,
      bills,
      reports: { profitAndLoss, balanceSheet },
      bankingFeedLimitation: 'Only posted QBO register transactions are available. Banking “For Review” rows are not exposed by the QuickBooks API.',
    });
  } catch (err) {
    console.error('[quickbooks-accounting-data]', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not load QuickBooks accounting data' });
  }
}
