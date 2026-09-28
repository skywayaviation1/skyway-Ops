import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/tenant-context.js';
import { SKYWAY_BRAND } from '../lib/control-plane/skyway-brand.js';

function request({ host, forwarded, method = 'GET' } = {}) {
  const headers = new Map();
  if (host) headers.set('host', host);
  if (forwarded) headers.set('x-forwarded-host', forwarded);
  return {
    method,
    headers: { get: (name) => headers.get(name) || null },
  };
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

test('pinned hosts resolve to Skyway', async () => {
  for (const host of ['www.skyway.app', 'skyway.app', '135ops.app', 'WWW.SKYWAY.APP', 'skyway.app:443']) {
    const response = await handler(request({ host }));
    assert.equal(response.status, 200, host);
    const body = await bodyOf(response);
    assert.equal(body.tenant.slug, 'skyway');
    assert.equal(body.tenant.pinned, true);
    assert.equal(body.tenant.legalName, SKYWAY_BRAND.legalName);
    assert.equal(body.tenant.accentDark, SKYWAY_BRAND.accentDark);
    assert.equal(body.tenant.accentLight, SKYWAY_BRAND.accentLight);
    assert.equal(body.tenant.contactEmail, SKYWAY_BRAND.contactEmail);
    assert.equal(JSON.stringify(body).includes('elite'), false);
  }
});

test('every other host is a 404 and does not fall through to Skyway', async () => {
  for (const host of [
    'acme.skyway.app',
    'example.com',
    'skyway-ops.vercel.app',
    'localhost',
    'www.skyway.app.evil.com',
    '',
  ]) {
    const response = await handler(request({ host: host || undefined }));
    assert.equal(response.status, 404, host || '(none)');
    assert.deepEqual(await bodyOf(response), { error: 'Not found' });
  }
});

test('a forwarded host wins, and other methods are refused', async () => {
  const spoofed = await handler(request({
    host: 'www.skyway.app',
    forwarded: 'acme.skyway.app',
  }));
  assert.equal(spoofed.status, 404);

  const pinned = await handler(request({
    host: 'evil.example',
    forwarded: 'www.skyway.app',
  }));
  assert.equal(pinned.status, 200);

  const head = await handler(request({ host: '135ops.app', method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const posted = await handler(request({ host: 'www.skyway.app', method: 'POST' }));
  assert.equal(posted.status, 405);
});
