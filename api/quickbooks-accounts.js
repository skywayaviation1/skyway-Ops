// Lists the connected QuickBooks chart of accounts and saves Skyway mappings.

import {
  authorizeQboCaller,
  getDb,
  qboQuery,
} from './_quickbooks.js';

const EXPENSE_TYPES = new Set(['Expense', 'Cost of Goods Sold', 'Other Expense']);
const PAYMENT_TYPES = new Set(['Credit Card', 'Bank', 'Other Current Liability']);

function safeMappings(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, raw] of Object.entries(value)) {
    const id = String(raw?.id || raw?.value || '').trim();
    const name = String(raw?.name || '').trim().slice(0, 200);
    if (key && id && name) result[String(key).slice(0, 100)] = { id, name };
  }
  return result;
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
    const action = req.body?.action || 'list';
    if (action === 'save') {
      const expenseAccountMap = safeMappings(req.body?.expenseAccountMap);
      const paymentAccountMap = safeMappings(req.body?.paymentAccountMap);
      await getDb().collection('quickbooks').doc('connection').set({
        expenseAccountMap,
        paymentAccountMap,
        mappingsUpdatedAt: Date.now(),
        mappingsUpdatedBy: caller.uid,
        mappingsUpdatedByName: caller.name,
      }, { merge: true });
      res.status(200).json({ ok: true, expenseAccountMap, paymentAccountMap });
      return;
    }
    const body = await qboQuery('select * from Account where Active = true maxresults 1000');
    const accounts = (body?.QueryResponse?.Account || []).map((account) => ({
      id: String(account.Id),
      name: account.FullyQualifiedName || account.Name || '',
      type: account.AccountType || '',
      subtype: account.AccountSubType || '',
    }));
    res.status(200).json({
      ok: true,
      expenseAccounts: accounts.filter((account) => EXPENSE_TYPES.has(account.type)),
      paymentAccounts: accounts.filter((account) => PAYMENT_TYPES.has(account.type)),
    });
  } catch (err) {
    console.error('[quickbooks-accounts]', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not load QuickBooks accounts' });
  }
}
