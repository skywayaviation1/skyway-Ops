import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { postJson } from '../src/api-json.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('an HTML error page becomes an actionable deployment message', async () => {
  const restore = stubFetch(async () => new Response(
    '<!doctype html><title>404</title>',
    { status: 404, headers: { 'Content-Type': 'text/html' } },
  ));
  try {
    await assert.rejects(
      postJson('/api/voice-task-call', { action: 'list' }),
      /not available on this deployment \(HTTP 404\)\. Deploy the latest build/,
    );
  } finally {
    restore();
  }
});

test('a non-JSON server fault names the route and status', async () => {
  const restore = stubFetch(async () => new Response('gateway blew up', { status: 502 }));
  try {
    await assert.rejects(
      postJson('/api/voice-task-call', { action: 'list' }),
      /returned 502 without JSON/,
    );
  } finally {
    restore();
  }
});

test('a JSON error keeps the server message and success returns data', async () => {
  const restoreError = stubFetch(async () => new Response(
    JSON.stringify({ error: 'Set VAPI_ASSISTANT_ID in Vercel, then redeploy.' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  ));
  try {
    await assert.rejects(
      postJson('/api/voice-task-call', { action: 'create' }),
      /Set VAPI_ASSISTANT_ID in Vercel/,
    );
  } finally {
    restoreError();
  }

  const restoreOk = stubFetch(async () => new Response(
    JSON.stringify({ ok: true, calls: [{ id: 'vtask_1' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  try {
    const data = await postJson('/api/voice-task-call', { action: 'list' });
    assert.equal(data.calls[0].id, 'vtask_1');
  } finally {
    restoreOk();
  }
});

test('an unreachable route reports a connection problem, not a parser error', async () => {
  const restore = stubFetch(async () => { throw new TypeError('Failed to fetch'); });
  try {
    await assert.rejects(
      postJson('/api/voice-task-call', { action: 'list' }),
      /Could not reach \/api\/voice-task-call/,
    );
  } finally {
    restore();
  }
});

test('voicebot components read replies through the shared JSON helper', async () => {
  for (const file of [
    'src/VoiceTaskCalls.jsx',
    'src/VoiceTaskRecording.jsx',
    'src/FboCallListener.jsx',
  ]) {
    const text = await source(file);
    assert.match(text, /postJson/, `${file} should use postJson`);
    assert.doesNotMatch(text, /await response\.json\(\)/, `${file} should not parse raw replies`);
  }
  const ui = await source('src/VoiceTaskCalls.jsx');
  assert.match(ui, /Missing on this deployment/);
});
