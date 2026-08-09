// Commits reviewed receipt ↔ existing QBO credit-card Purchase links.

import {
  authorizeQboCaller,
  getDb,
  qboRequest,
  readConnection,
} from './_quickbooks.js';
import {
  matchQboPurchases,
  normalizeQboPurchase,
  qboLinkPatch,
} from '../src/qbo-reconciliation.js';
import { paymentAccountLabel } from '../src/expense-export.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const caller = await authorizeQboCaller(req.body?.idToken, ['accounting', 'admin']);
    const links = (Array.isArray(req.body?.links) ? req.body.links : []).slice(0, 50);
    if (!links.length) {
      res.status(400).json({ error: 'No QuickBooks matches selected' });
      return;
    }
    const connection = await readConnection();
    if (!connection?.realmId) {
      res.status(409).json({ error: 'QuickBooks is not connected' });
      return;
    }
    const db = getDb();
    const results = [];

    for (const link of links) {
      const expenseId = String(link?.expenseId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
      const purchaseId = String(link?.purchaseId || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 100);
      try {
        if (!expenseId || !purchaseId) throw new Error('Expense and Purchase IDs are required');
        // eslint-disable-next-line no-await-in-loop
        const expenseSnap = await db.collection('expenses').doc(expenseId).get();
        if (!expenseSnap.exists) throw new Error('Expense not found');
        const expense = { ...expenseSnap.data(), id: expenseSnap.id };
        if (expense.qbTransactionId) {
          if (String(expense.qbTransactionId) === purchaseId) {
            results.push({ expenseId, purchaseId, ok: true, status: 'already-linked' });
            continue;
          }
          throw new Error('Expense is already linked to another QuickBooks transaction');
        }
        // No QBO transaction may be claimed by two receipts.
        // eslint-disable-next-line no-await-in-loop
        const duplicate = await db.collection('expenses')
          .where('qbTransactionId', '==', purchaseId)
          .limit(1)
          .get();
        if (!duplicate.empty) throw new Error('QuickBooks transaction is already linked to another expense');

        // Read the transaction from QBO at commit time; never trust client money.
        // eslint-disable-next-line no-await-in-loop
        const body = await qboRequest(`/purchase/${purchaseId}?minorversion=70`);
        const purchase = normalizeQboPurchase(body?.Purchase);
        if (!purchase.id) throw new Error('QuickBooks Purchase not found');
        const paymentMap = { ...(connection.paymentAccountMap || {}) };
        if (!paymentMap[expense.paidWith]?.id) {
          const expected = paymentAccountLabel(expense).toLowerCase().replace(/[^a-z0-9]/g, '');
          const actual = purchase.accountName.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (expected && (actual.includes(expected) || expected.includes(actual))) {
            paymentMap[expense.paidWith] = { id: purchase.accountId, name: purchase.accountName };
          }
        }
        const proposal = matchQboPurchases(
          [expense],
          [purchase],
          paymentMap,
        ).matched[0];
        if (!proposal) {
          throw new Error('The QBO charge no longer matches this receipt amount, date, or mapped card');
        }

        const patch = qboLinkPatch(proposal, caller, connection.realmId);
        patch.qbSyncHistory = [
          ...(Array.isArray(expense.qbSyncHistory) ? expense.qbSyncHistory.slice(-19) : []),
          {
            at: patch.syncedAt,
            by: caller.uid,
            byName: caller.name,
            entityType: 'Purchase',
            transactionId: purchaseId,
            mode: 'linked',
            matchScore: proposal.score,
          },
        ];
        // eslint-disable-next-line no-await-in-loop
        await expenseSnap.ref.set(patch, { merge: true });
        results.push({ expenseId, purchaseId, ok: true, status: 'linked' });
      } catch (err) {
        results.push({ expenseId, purchaseId, ok: false, error: err.message || 'Link failed' });
      }
    }

    const succeeded = results.filter((item) => item.ok).length;
    await db.collection('quickbooks').doc('connection').set({
      lastSyncAt: Date.now(),
      lastSyncBy: caller.uid,
      lastSyncByName: caller.name,
      lastSyncCount: succeeded,
    }, { merge: true });
    res.status(succeeded ? 200 : 422).json({
      ok: succeeded === results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  } catch (err) {
    console.error('[quickbooks-link-expenses]', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not link QuickBooks charges' });
  }
}
