import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowedCompanyEmail,
  authorizeNativeMicrosoftToken,
} from '../api/mobile-auth-token.js';

test('company email accepts only exact @flyskyway.com addresses', () => {
  assert.equal(allowedCompanyEmail('jake@flyskyway.com'), true);
  assert.equal(allowedCompanyEmail(' Jake@FlySkyway.com '), true);
  assert.equal(allowedCompanyEmail('jake@gmail.com'), false);
  assert.equal(allowedCompanyEmail('@flyskyway.com'), false);
});

test('native token exchange requires a Microsoft company identity', () => {
  assert.equal(authorizeNativeMicrosoftToken({
    uid: 'uid-1',
    email: 'jake@flyskyway.com',
    firebase: { sign_in_provider: 'microsoft.com' },
  }).ok, true);

  assert.equal(authorizeNativeMicrosoftToken({
    uid: 'uid-1',
    email: 'jake@flyskyway.com',
    firebase: { sign_in_provider: 'password' },
  }).ok, false);

  const missingEmail = authorizeNativeMicrosoftToken({
    uid: 'uid-1',
    firebase: { sign_in_provider: 'microsoft.com' },
  });
  assert.equal(missingEmail.ok, false);
  assert.equal(missingEmail.code, 'missing-email');

  assert.equal(authorizeNativeMicrosoftToken({
    uid: 'uid-1',
    email: 'outsider@example.com',
    firebase: { sign_in_provider: 'microsoft.com' },
  }).ok, false);
});
