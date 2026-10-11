import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import handler from '../api/fbo-departure-cron.js';

const root = path.resolve(import.meta.dirname, '..');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    setHeader() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('fbo departure cron kill switch', { concurrency: 1 }, () => {
  test('returns before cron work when FBO_AUTO_NOTIFY_DISABLED=1', async () => {
    const previous = process.env.FBO_AUTO_NOTIFY_DISABLED;
    process.env.FBO_AUTO_NOTIFY_DISABLED = '1';
    try {
      const res = mockRes();
      await handler({ method: 'GET', headers: {} }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { ok: true, disabled: true });
    } finally {
      if (previous === undefined) delete process.env.FBO_AUTO_NOTIFY_DISABLED;
      else process.env.FBO_AUTO_NOTIFY_DISABLED = previous;
    }
  });

  test('still requires auth when the kill switch is off', async () => {
    const previous = process.env.FBO_AUTO_NOTIFY_DISABLED;
    delete process.env.FBO_AUTO_NOTIFY_DISABLED;
    try {
      const res = mockRes();
      await handler({ method: 'GET', headers: {} }, res);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { error: 'Unauthorized' });
    } finally {
      if (previous === undefined) delete process.env.FBO_AUTO_NOTIFY_DISABLED;
      else process.env.FBO_AUTO_NOTIFY_DISABLED = previous;
    }
  });
});

test('the departure cron is not scheduled and stays documented', async () => {
  const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const docs = await readFile(path.join(root, 'docs/fbo-notifications.md'), 'utf8');
  assert.equal(vercel.crons.some((entry) => entry.path === '/api/fbo-departure-cron'), false);
  assert.match(docs, /\/api\/fbo-departure-cron/);
  assert.match(docs, /disabled/i);
});
