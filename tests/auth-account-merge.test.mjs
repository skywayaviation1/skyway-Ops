import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCompanyEmail,
  microsoftIdentityFromGraph,
  normalizeEmail,
  planProviderMerge,
} from '../src/auth-account-merge.js';

test('company email accepts only exact @flyskyway.com addresses', () => {
  assert.equal(isCompanyEmail('jake@flyskyway.com'), true);
  assert.equal(isCompanyEmail(' Jake@FlySkyway.com '), true);
  assert.equal(isCompanyEmail('jake@gmail.com'), false);
  assert.equal(isCompanyEmail('@flyskyway.com'), false);
  assert.equal(isCompanyEmail('jake@notflyskyway.com'), false);
  assert.equal(normalizeEmail(' Jake@FlySkyway.com '), 'jake@flyskyway.com');
});

test('Graph identity prefers mail, falls back to UPN', () => {
  assert.deepEqual(
    microsoftIdentityFromGraph({
      id: 'oid-1',
      mail: 'jake@flyskyway.com',
      userPrincipalName: 'jake@flyskyway.onmicrosoft.com',
      displayName: 'Jake',
    }),
    { oid: 'oid-1', email: 'jake@flyskyway.com', displayName: 'Jake' },
  );
  assert.equal(
    microsoftIdentityFromGraph({
      id: 'oid-2',
      userPrincipalName: 'zack.taylor@flyskyway.com',
    }).email,
    'zack.taylor@flyskyway.com',
  );
  assert.equal(
    microsoftIdentityFromGraph({
      id: 'oid-3',
      mail: 'personal@gmail.com',
      userPrincipalName: 'personal@gmail.com',
    }),
    null,
  );
  assert.equal(microsoftIdentityFromGraph({ mail: 'jake@flyskyway.com' }), null);
});

test('password account is linked to Microsoft and password is dropped', () => {
  const plan = planProviderMerge(
    {
      uid: 'uid-legacy',
      email: 'jake@flyskyway.com',
      providerData: [{ providerId: 'password', uid: 'jake@flyskyway.com' }],
    },
    { oid: 'ms-oid', email: 'jake@flyskyway.com', displayName: 'Jake' },
  );
  assert.equal(plan.action, 'link');
  assert.equal(plan.uid, 'uid-legacy');
  assert.deepEqual(plan.link, {
    providerId: 'microsoft.com',
    uid: 'ms-oid',
    email: 'jake@flyskyway.com',
    displayName: 'Jake',
  });
  assert.deepEqual(plan.unlink, ['password']);
});

test('already-linked Microsoft account is a no-op for the link itself', () => {
  const plan = planProviderMerge(
    {
      uid: 'uid-1',
      email: 'jake@flyskyway.com',
      providerData: [
        { providerId: 'microsoft.com', uid: 'ms-oid' },
        { providerId: 'password', uid: 'jake@flyskyway.com' },
      ],
    },
    { oid: 'ms-oid', email: 'jake@flyskyway.com', displayName: 'Jake' },
  );
  assert.equal(plan.action, 'already-linked');
  assert.deepEqual(plan.unlink, ['password']);
});

test('a different Microsoft subject on the same email is refused', () => {
  const plan = planProviderMerge(
    {
      uid: 'uid-1',
      email: 'jake@flyskyway.com',
      providerData: [{ providerId: 'microsoft.com', uid: 'other-oid' }],
    },
    { oid: 'ms-oid', email: 'jake@flyskyway.com', displayName: 'Jake' },
  );
  assert.equal(plan.action, 'reject');
  assert.equal(plan.reason, 'microsoft-oid-conflict');
});

test('email mismatch between Auth user and Microsoft identity is refused', () => {
  const plan = planProviderMerge(
    {
      uid: 'uid-1',
      email: 'other@flyskyway.com',
      providerData: [{ providerId: 'password', uid: 'other@flyskyway.com' }],
    },
    { oid: 'ms-oid', email: 'jake@flyskyway.com', displayName: 'Jake' },
  );
  assert.equal(plan.action, 'reject');
  assert.equal(plan.reason, 'email-mismatch');
});
