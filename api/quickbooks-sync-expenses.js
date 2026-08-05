// Direct, idempotent expense sync to QuickBooks Online.
//
// Company-card charges become Purchase entities after statement reconciliation.
// Personal-card charges become Bills payable to the submitting crew member.

import {
  authorizeQboCaller,
  createEntity,
  getDb,
  getValidConnection,
  qboString,
  queryOne,
} from './_quickbooks.js';
import {
  accountForCategory,
} from '../src/expense-export.js';
import {
  buildBillPayload,
  qboDocNumber,
  qboSyncEligibility,
} from '../src/qbo-expense.js';

function refFromMap(map, key) {
  const value = map?.[key];
  if (!value?.id || !value?.name) return null;
  return { Id: String(value.id), Name: value.name };
}

async function resolveAccount(connection, expense) {
  const configured = refFromMap(connection.expenseAccountMap, expense.category);
  if (configured) return configured;

  const name = accountForCategory(expense.category);
  if (!name) throw new Error('Expense account is not mapped');
  const account = await queryOne('Account', `Name = '${qboString(name)}' and Active = true`);
  if (!account) {
    throw new Error(`QuickBooks account "${name}" was not found. Map it in Expenses → QuickBooks.`);
  }
  return account;
}

async function resolveVendor(expense, personal) {
  const displayName = String(
    personal
      ? (expense.authorName || expense.authorEmail || 'Crew reimbursement')
      : (expense.vendor || 'Unknown vendor'),
  ).trim().slice(0, 100);
  let vendor = await queryOne('Vendor', `DisplayName = '${qboString(displayName)}'`);
  if (vendor) return vendor;
  const payload = { DisplayName: displayName };
  if (personal && expense.authorEmail) payload.PrimaryEmailAddr = { Address: expense.authorEmail };
  vendor = await createEntity('vendor', payload);
  if (!vendor?.Id) throw new Error(`QuickBooks could not create vendor "${displayName}"`);
  return vendor;
}

async function findExisting(entityType, expense) {
  return queryOne(entityType, `DocNumber = '${qboString(qboDocNumber(expense))}'`);
}

async function syncOne(connection, expense) {
  const eligibility = qboSyncEligibility(expense);
  if (!eligibility.eligible) {
    if (expense.qbTransactionId) {
      return {
        status: 'already-synced',
        entityType: expense.qbEntityType || eligibility.entityType || '',
        transactionId: expense.qbTransactionId,
      };
    }
    throw new Error(eligibility.reason);
  }

  const existing = await findExisting(eligibility.entityType, expense);
  if (existing?.Id) {
    return {
      status: 'recovered',
      entityType: eligibility.entityType,
      transactionId: String(existing.Id),
    };
  }

  if (eligibility.entityType !== 'Bill') {
    throw new Error('Company-card expenses must link to a posted QBO card charge');
  }
  const [expenseAccount, vendor] = await Promise.all([
    resolveAccount(connection, expense),
    resolveVendor(expense, true),
  ]);
  const entity = await createEntity('bill', buildBillPayload({ expense, expenseAccount, vendor }));
  if (!entity?.Id) throw new Error(`QuickBooks did not return a ${eligibility.entityType} ID`);
  return {
    status: 'synced',
    entityType: eligibility.entityType,
    transactionId: String(entity.Id),
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
    const expenseIds = [...new Set(
      (Array.isArray(req.body?.expenseIds) ? req.body.expenseIds : [])
        .map((id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200))
        .filter(Boolean),
    )].slice(0, 50);
    if (!expenseIds.length) {
      res.status(400).json({ error: 'Select at least one expense to sync' });
      return;
    }
    const connection = await getValidConnection();
    const db = getDb();
    const results = [];

    // Sequential writes are deliberate: QBO has tight per-company rate limits,
    // and this also prevents duplicate vendor/account races.
    for (const id of expenseIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const snap = await db.collection('expenses').doc(id).get();
        if (!snap.exists) throw new Error('Expense not found');
        const expense = { ...snap.data(), id: snap.id };
        // eslint-disable-next-line no-await-in-loop
        const synced = await syncOne(connection, expense);
        if (synced.status !== 'already-synced') {
          const now = Date.now();
          // eslint-disable-next-line no-await-in-loop
          await snap.ref.set({
            status: 'synced',
            syncedAt: now,
            syncedBy: caller.uid,
            syncedByName: caller.name,
            qbTransactionId: synced.transactionId,
            qbEntityType: synced.entityType,
            qbCompanyId: connection.realmId,
            qbSyncHistory: [
              ...(Array.isArray(expense.qbSyncHistory) ? expense.qbSyncHistory.slice(-19) : []),
              {
                at: now,
                by: caller.uid,
                byName: caller.name,
                entityType: synced.entityType,
                transactionId: synced.transactionId,
                mode: synced.status,
              },
            ],
          }, { merge: true });
        }
        results.push({ id, ok: true, ...synced });
      } catch (err) {
        results.push({ id, ok: false, error: err.message || 'Sync failed' });
      }
    }

    const succeeded = results.filter((result) => result.ok).length;
    await db.collection('quickbooks').doc('connection').set({
      lastSyncAt: Date.now(),
      lastSyncBy: caller.uid,
      lastSyncByName: caller.name,
      lastSyncCount: succeeded,
    }, { merge: true });
    res.status(succeeded > 0 ? 200 : 422).json({
      ok: succeeded === results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  } catch (err) {
    console.error('[quickbooks-sync-expenses]', err);
    res.status(err.status || 500).json({ error: err.message || 'QuickBooks sync failed' });
  }
}
