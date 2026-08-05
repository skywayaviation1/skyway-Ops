import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function source(file) {
  return readFile(path.join(root, file), 'utf8');
}

test('QuickBooks server uses the named appusers database', async () => {
  const helper = await source('api/_quickbooks.js');
  assert.match(helper, /getFirestore\(getAdminApp\(\), 'appusers'\)/);
  for (const file of [
    'api/quickbooks-oauth-start.js',
    'api/quickbooks-oauth-callback.js',
    'api/quickbooks-disconnect.js',
  ]) {
    const text = await source(file);
    assert.doesNotMatch(text, /admin\.firestore\(\)/, file);
  }
});

test('accounting and admin can connect and disconnect QuickBooks', async () => {
  const start = await source('api/quickbooks-oauth-start.js');
  const disconnect = await source('api/quickbooks-disconnect.js');
  assert.match(start, /\['accounting', 'admin'\]/);
  assert.match(disconnect, /\['accounting', 'admin'\]/);
});

test('personal Bill sync is server-side and idempotent', async () => {
  const sync = await source('api/quickbooks-sync-expenses.js');
  assert.match(sync, /findExisting\(eligibility\.entityType, expense\)/);
  assert.match(sync, /Company-card expenses must link to a posted QBO card charge/);
  assert.doesNotMatch(sync, /createEntity\('purchase'/);
  assert.match(sync, /qbTransactionId:/);
  assert.match(sync, /qbEntityType:/);
  assert.match(sync, /qbCompanyId:/);
  assert.match(sync, /qbSyncHistory:/);
});

test('company-card receipts link to verified existing QBO Purchases', async () => {
  const link = await source('api/quickbooks-link-expenses.js');
  assert.match(link, /qboRequest\(`\/purchase\/\$\{purchaseId\}/);
  assert.match(link, /where\('qbTransactionId', '==', purchaseId\)/);
  assert.match(link, /qboLinkPatch/);
  assert.doesNotMatch(link, /createEntity\('purchase'/);
});

test('accounting dashboard loads QBO reports, cards and posted purchases', async () => {
  const accounting = await source('api/quickbooks-accounting-data.js');
  assert.match(accounting, /reports\/ProfitAndLoss/);
  assert.match(accounting, /reports\/BalanceSheet/);
  assert.match(accounting, /select \* from Purchase/);
  assert.match(accounting, /account\.type === 'Credit Card'/);
});

test('token refresh persists rotated access and refresh tokens', async () => {
  const helper = await source('api/_quickbooks.js');
  assert.match(helper, /grant_type: 'refresh_token'/);
  assert.match(helper, /refreshToken: data\.refresh_token \|\| connection\.refreshToken/);
  assert.match(helper, /lastRefreshedAt:/);
  assert.doesNotMatch(await source('api/quickbooks-status.js'), /accessToken|refreshToken/);
});
