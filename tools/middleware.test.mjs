/* Verifies the host routing in middleware.js: the marketing domain must be
 * rewritten to the marketing homepage, and every other host — above all the
 * operations app — must pass through untouched.
 *
 * Usage: node tools/middleware.test.mjs
 */

import assert from 'node:assert/strict';
import middleware, { config } from '../middleware.js';

const call = (host, url = 'https://example.test/') =>
  middleware(new Request(url, { headers: { host } }));

const rewriteTarget = (response) =>
  response.headers.get('x-middleware-rewrite') || null;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

console.log('middleware host routing');

check('marketing apex is rewritten to the marketing homepage', () => {
  const target = rewriteTarget(call('135ops.app', 'https://135ops.app/'));
  assert.ok(target, 'expected a rewrite');
  assert.equal(new URL(target).pathname, '/marketing/index.html');
});

check('marketing www is rewritten too', () => {
  const target = rewriteTarget(call('www.135ops.app', 'https://www.135ops.app/'));
  assert.ok(target, 'expected a rewrite');
  assert.equal(new URL(target).pathname, '/marketing/index.html');
});

check('host matching ignores case and port', () => {
  const target = rewriteTarget(call('135OPS.APP:443', 'https://135ops.app/'));
  assert.ok(target, 'expected a rewrite');
  assert.equal(new URL(target).pathname, '/marketing/index.html');
});

check('the operations app host passes through', () => {
  assert.equal(rewriteTarget(call('app.flyskyway.com')), null);
});

check('vercel preview hosts pass through', () => {
  assert.equal(rewriteTarget(call('skyway-ops.vercel.app')), null);
});

check('a lookalike host is not matched', () => {
  assert.equal(rewriteTarget(call('135ops.app.evil.test')), null);
});

check('a missing host header passes through', () => {
  assert.equal(rewriteTarget(middleware(new Request('https://example.test/'))), null);
});

check('the matcher is scoped to the root document only', () => {
  assert.deepEqual(config.matcher, ['/', '/index.html']);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
