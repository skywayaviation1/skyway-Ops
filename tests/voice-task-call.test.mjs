import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { voiceTaskVapiPayload } from '../api/_voice-task-call.js';
import { jobKindFrom, validVapiRequest } from '../api/fbo-call-webhook.js';
import {
  formatVoiceTaskLog,
  publicVoiceTaskSummary,
  validateVoiceTaskInput,
} from '../src/voice-task-call.js';
import {
  extractVapiRecording,
  extractVapiTranscript,
  mergeTranscript,
  normalizeTranscriberKeywords,
  transcriptEventSegment,
} from '../src/vapi-call-artifacts.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('one-off voice task requires a valid number and scoped task', () => {
  assert.equal(validateVoiceTaskInput({ phone: 'bad', task: '' }).ok, false);
  const input = validateVoiceTaskInput({
    phone: '(305) 555-0142',
    task: '  Confirm two crew rooms and collect the confirmation number.  ',
  });
  assert.equal(input.ok, true);
  assert.equal(input.phoneE164, '+13055550142');
  assert.equal(input.task, 'Confirm two crew rooms and collect the confirmation number.');
});

test('voice task calls use the Vapi assistant and still deliver the task', () => {
  const job = {
    id: 'vtask_1',
    phoneE164: '+13055550142',
    task: 'Confirm two crew rooms and collect the confirmation number.',
  };
  const payload = voiceTaskVapiPayload(job, { opsTransferNumber: '+18138595943' }, {
    VAPI_VOICE_TASK_ASSISTANT_ID: 'asst_task',
    VAPI_WEBHOOK_SECRET: 'webhook-secret',
  });

  // Vapi owns the prompt, first message, and voice.
  assert.equal(payload.assistantId, 'asst_task');
  assert.equal('assistant' in payload, false);
  assert.equal('model' in payload.assistantOverrides, false);
  assert.equal('voice' in payload.assistantOverrides, false);
  assert.equal('firstMessage' in payload.assistantOverrides, false);
  assert.equal(payload.assistantOverrides.transcriber.model, 'nova-2-phonecall');

  // Skyway supplies the task, isolation metadata, and delivery.
  assert.equal(payload.customer.number, '+13055550142');
  assert.equal(payload.assistantOverrides.variableValues.task, job.task);
  assert.equal(payload.assistantOverrides.variableValues.ops_transfer_number, '+18138595943');
  assert.equal(payload.metadata.skywayCallId, 'vtask_1');
  assert.equal(payload.metadata.skywayJobKind, 'voice_task');
  assert.equal('tripId' in payload.metadata, false);
  assert.equal(payload.assistantOverrides.artifactPlan.recordingEnabled, true);
  assert.equal(payload.assistantOverrides.artifactPlan.transcriptPlan.enabled, true);
  assert.match(payload.assistantOverrides.server.url, /fbo-call-webhook/);
  assert.equal(payload.assistantOverrides.server.headers['X-Vapi-Secret'], 'webhook-secret');
  assert.equal(payload.assistantOverrides.serverMessages.includes('transcript'), true);
  assert.equal(payload.assistantOverrides.monitorPlan.listenEnabled, true);
});

test('a voice task falls back to the main assistant and fails when none is set', () => {
  const shared = voiceTaskVapiPayload(
    { id: 'vtask_2', phoneE164: '+13055550142', task: 'Confirm rooms.' },
    {},
    { VAPI_ASSISTANT_ID: 'asst_main', VAPI_WEBHOOK_SECRET: 'hook' },
  );
  assert.equal(shared.assistantId, 'asst_main');
  assert.throws(
    () => voiceTaskVapiPayload(
      { id: 'vtask_3', phoneE164: '+13055550142', task: 'Confirm rooms.' },
      {},
      { VAPI_WEBHOOK_SECRET: 'hook' },
    ),
    /VAPI_VOICE_TASK_ASSISTANT_ID or VAPI_ASSISTANT_ID/,
  );
});

test('Deepgram keywords stay in the word or word:boost format Vapi requires', () => {
  assert.deepEqual(
    normalizeTranscriberKeywords(['Skyway Aviation:2', 'FBO', 'tail number', '  ', 'FBO']),
    ['Skyway:2', 'Aviation:2', 'FBO', 'tail', 'number'],
  );
  const payload = voiceTaskVapiPayload(
    { id: 'vtask_1', phoneE164: '+13055550142', task: 'Confirm rooms.' },
    {},
    { VAPI_ASSISTANT_ID: 'asst_1', VAPI_WEBHOOK_SECRET: 'webhook-secret' },
  );
  const valid = /^[A-Za-z0-9']+(?::\d+)?$/;
  for (const keyword of payload.assistantOverrides.transcriber.keywords) {
    assert.match(keyword, valid, `invalid Deepgram keyword: ${keyword}`);
  }
});

test('Vapi artifacts parse all current transcript and recording shapes', () => {
  const payload = {
    message: {
      type: 'end-of-call-report',
      call: {
        artifact: {
          messagesOpenAIFormatted: [
            { role: 'assistant', content: 'How can I help?' },
            { role: 'user', content: [{ type: 'text', text: 'Confirm SKY-4821.' }] },
          ],
          recording: { monoUrl: 'https://private.example/call.wav' },
        },
      },
    },
  };
  assert.match(extractVapiTranscript(payload), /assistant: How can I help/);
  assert.match(extractVapiTranscript(payload), /contact: Confirm SKY-4821/);
  assert.equal(extractVapiRecording(payload), 'https://private.example/call.wav');
  assert.equal(transcriptEventSegment({
    message: {
      type: 'transcript',
      transcriptType: 'final',
      role: 'user',
      transcript: 'The rooms are confirmed.',
    },
  }), 'contact: The rooms are confirmed.');
  assert.equal(transcriptEventSegment({
    message: { type: 'transcript', transcriptType: 'partial', transcript: 'The rooms' },
  }), '');
  assert.equal(
    mergeTranscript('assistant: Hello', 'contact: Confirmed'),
    'assistant: Hello\ncontact: Confirmed',
  );
});

test('Vapi webhook accepts HMAC, bearer, and legacy secret authentication', () => {
  const body = Buffer.from('{"message":{"type":"status-update"}}');
  assert.equal(validVapiRequest(body, { 'x-vapi-secret': 'secret' }, 'secret'), true);
  assert.equal(validVapiRequest(body, { authorization: 'Bearer secret' }, 'secret'), true);
  assert.equal(validVapiRequest(body, { 'x-vapi-secret': 'wrong' }, 'secret'), false);
});

test('voice task summary hides vendor and monitor credentials', () => {
  const summary = publicVoiceTaskSummary({
    id: 'vtask_1',
    status: 'in_progress',
    task: 'Confirm rooms',
    phoneE164: '+13055550142',
    vendorCallId: 'vapi-secret-id',
    monitorListenUrl: 'wss://private.example/listen',
    monitorControlUrl: 'wss://private.example/control',
  });
  assert.equal(summary.listenAvailable, true);
  assert.equal('vendorCallId' in summary, false);
  assert.equal('monitorListenUrl' in summary, false);
  assert.equal('monitorControlUrl' in summary, false);
});

test('downloadable text log includes task, outcome, notes, and transcript', () => {
  const text = formatVoiceTaskLog({
    id: 'vtask_1',
    status: 'completed',
    phone: '+1 (305) 555-0142',
    task: 'Confirm crew rooms.',
    summary: 'Rooms confirmed.',
    transcript: 'contact: Confirmation SKY-4821.',
    outcome: {
      taskCompleted: true,
      needsFollowUp: false,
      outcomeSummary: 'Two rooms confirmed.',
      notes: 'Cancellation deadline 1800 local.',
    },
  });
  assert.match(text, /--- ASSIGNED TASK ---\nConfirm crew rooms/);
  assert.match(text, /Completed: yes/);
  assert.match(text, /Two rooms confirmed/);
  assert.match(text, /Confirmation SKY-4821/);
});

test('webhook discriminator routes voice tasks without breaking old FBO calls', () => {
  assert.equal(jobKindFrom({
    message: { call: { metadata: { skywayJobKind: 'voice_task' } } },
  }), 'voice_task');
  assert.equal(jobKindFrom({
    message: { call: { metadata: { skywayCallId: 'fbo_old' } } },
  }), 'fbo_call');
});

test('voice task routes and UI remain server-authenticated and trip-isolated', async () => {
  const api = await source('api/voice-task-call.js');
  const helper = await source('api/_voice-task-call.js');
  const ui = await source('src/VoiceTaskCalls.jsx');
  const recordingUi = await source('src/VoiceTaskRecording.jsx');
  const app = await source('src/App.jsx');
  assert.match(api, /authorizeFboCaller\(body\.idToken, \['ops', 'admin'\]\)/);
  assert.match(helper, /voice-task-calls/);
  assert.doesNotMatch(helper, /fbo-call-jobs/);
  assert.doesNotMatch(helper, /trip-state/);
  assert.match(helper, /export async function retryVoiceTask/);
  assert.match(helper, /parentCallId: original\.id/);
  assert.match(helper, /export async function deleteVoiceTask/);
  assert.match(helper, /Only finished voice task calls can be deleted/);
  assert.match(helper, /refreshVoiceTaskArtifacts/);
  assert.match(ui, /Download \.txt/);
  assert.match(ui, /AI Voicebot control center/);
  assert.match(ui, /Refresh transcript/);
  assert.match(recordingUi, /Play recording/);
  assert.match(ui, /act\('retry'/);
  assert.match(ui, /act\('delete'/);
  assert.match(api, /action === 'refreshArtifacts'/);
  assert.match(api, /action === 'recording'/);
  assert.match(api, /action === 'delete'/);
  assert.match(ui, /\/api\/voice-task-call/);
  assert.doesNotMatch(ui, /VAPI_API_KEY/);
  assert.match(app, /AI voice calls/);
});


