import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

// describeDirectoryError lives inside App.jsx, which cannot be imported in a
// plain Node test. The mapping is the part that must not regress, so it is
// extracted from source and exercised directly.
const source = await readFile(
  path.join(path.resolve(import.meta.dirname, '..'), 'src/App.jsx'),
  'utf8',
);

function extract(name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} not found in App.jsx`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(`return ${source.slice(source.indexOf('{', start), i + 1)}`)();
      }
    }
  }
  throw new Error(`could not extract ${name}`);
}

const AADSTS_ERRORS = extract('AADSTS_ERRORS');

function describeDirectoryError(text) {
  const match = /AADSTS(\d+)/.exec(String(text || ''));
  if (!match) return null;
  const code = Number(match[1]);
  const known = AADSTS_ERRORS[code];
  if (!known) return { code: `AADSTS${code}`, message: 'Microsoft refused the sign-in request.' };
  return { code: `AADSTS${code}`, ...known };
}

test('the single-tenant /common refusal is identified and given the tenant fix', () => {
  const real = "Firebase: Error getting verification code from microsoft.com response: "
    + "error=invalid_request&error_description=AADSTS50194: Application 'a6e65ee4' "
    + "(Skyway Ops app (login)) is not configured as a multi-tenant application. "
    + "Usage of the /common endpoint is not supported for such applications. "
    + "(auth/invalid-credential).";
  const described = describeDirectoryError(real);
  assert.equal(described.code, 'AADSTS50194');
  assert.match(described.message, /single-tenant/);
  assert.match(described.fix, /VITE_MICROSOFT_TENANT_ID/);
  assert.match(described.fix, /redeploy/);
});

test('other directory refusals map to their own instructions', () => {
  assert.match(describeDirectoryError('AADSTS50011: redirect URI mismatch').fix, /redirect URIs/);
  assert.match(describeDirectoryError('AADSTS7000215: invalid client secret').fix, /secret/);
  assert.match(describeDirectoryError('AADSTS50020: user account from identity provider').message, /does not belong/);
  assert.match(describeDirectoryError('AADSTS90002: Tenant not found').fix, /Directory \(tenant\) ID/);
});

test('an unmapped AADSTS code is still reported rather than swallowed', () => {
  const described = describeDirectoryError('AADSTS999999: something new');
  assert.equal(described.code, 'AADSTS999999');
  assert.match(described.message, /refused/);
});

test('non-directory errors are left to the Firebase code mapping', () => {
  assert.equal(describeDirectoryError('auth/popup-blocked'), null);
  assert.equal(describeDirectoryError(''), null);
  assert.equal(describeDirectoryError(undefined), null);
});
