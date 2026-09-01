import crypto from 'node:crypto';
import {
  getDb,
  placeVapiPayload,
  readCallConfig,
} from './_fbo-call.js';
import {
  publicVoiceTaskSummary,
  validateVoiceTaskInput,
  voiceTaskFirstMessage,
  voiceTaskSystemPrompt,
} from '../src/voice-task-call.js';
import {
  CALL_STATUSES,
  SKYWAY_CALLER_ID,
  SKYWAY_CALLER_NAME,
  toE164,
} from '../src/fbo-call.js';

const JOBS = 'voice-task-calls';
const EVENTS = 'voice-task-call-events';

function newVoiceTaskId() {
  return `vtask_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function voiceTaskVapiPayload(job, config = {}) {
  const transfer = toE164(config.opsTransferNumber) || SKYWAY_CALLER_ID;
  const systemPrompt = voiceTaskSystemPrompt(job.task);
  const model = {
    provider: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'system', content: systemPrompt }],
    temperature: 0.2,
    tools: [{
      type: 'transferCall',
      destinations: [{
        type: 'number',
        number: transfer,
        message: 'Please hold while I connect you to Skyway Aviation operations.',
      }],
    }],
  };
  const firstMessage = voiceTaskFirstMessage();
  return {
    customer: { number: job.phoneE164, name: 'Operations contact' },
    assistant: {
      firstMessage,
      firstMessageInterruptionsEnabled: false,
      artifactPlan: { recordingEnabled: true },
      model,
      voice: { provider: 'openai', voiceId: 'alloy' },
      analysisPlan: {
        summaryPrompt: [
          'Report the assigned task, explicitly completed items, open items, corrections,',
          'reference numbers, restrictions, promised actions, and required Skyway follow-up.',
          'Never label an item complete without explicit confirmation.',
        ].join(' '),
        structuredDataSchema: {
          type: 'object',
          properties: {
            taskCompleted: {
              type: 'boolean',
              description: 'True only if the assigned task was explicitly completed or confirmed.',
            },
            outcomeSummary: {
              type: 'string',
              description: 'Concise factual report separating completed and open items.',
            },
            needsFollowUp: {
              type: 'boolean',
              description: 'True if anything is uncertain, refused, changed, or needs human authorization.',
            },
            transferredToOps: {
              type: 'boolean',
              description: 'True only if the live call transferred to Skyway operations.',
            },
            notes: {
              type: 'string',
              description: 'Corrections, reference numbers, restrictions, promises, and open questions.',
            },
          },
        },
      },
    },
    assistantOverrides: {
      firstMessage,
      artifactPlan: { recordingEnabled: true },
      model,
      variableValues: {
        callerName: SKYWAY_CALLER_NAME,
        task: job.task,
      },
    },
    metadata: {
      skywayCallId: job.id,
      skywayJobKind: 'voice_task',
    },
  };
}

export async function loadVoiceTask(id) {
  const snap = await getDb().collection(JOBS).doc(String(id || '')).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function findVoiceTaskByVendorId(vendorCallId) {
  const snap = await getDb().collection(JOBS)
    .where('vendorCallId', '==', vendorCallId)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export async function applyVoiceTaskStatus(job, patch) {
  const next = { ...job, ...patch, updatedAt: Date.now() };
  await getDb().collection(JOBS).doc(job.id).set(next, { merge: true });
  return next;
}

export async function recordVoiceTaskEvent(id, payload) {
  const ref = getDb().collection(EVENTS).doc(id);
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { ...payload, createdAt: Date.now() });
    return true;
  });
}

export async function listVoiceTasks(limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const snap = await getDb().collection(JOBS)
    .orderBy('createdAt', 'desc')
    .limit(safeLimit)
    .get();
  return snap.docs.map((doc) => publicVoiceTaskSummary({ id: doc.id, ...doc.data() }));
}

export async function createVoiceTask({ phone, task, actor, now = Date.now() }) {
  const input = validateVoiceTaskInput({ phone, task });
  if (!input.ok) {
    const error = new Error(input.blockers.join('. '));
    error.status = 400;
    throw error;
  }
  const id = newVoiceTaskId();
  const job = {
    id,
    kind: 'voice_task',
    phoneE164: input.phoneE164,
    phoneDisplay: input.phoneDisplay,
    task: input.task,
    taskHash: crypto.createHash('sha256').update(input.task).digest('hex'),
    status: CALL_STATUSES.dialing,
    dialAt: now,
    dialMode: 'immediate',
    attempts: 1,
    maxAttempts: 1,
    createdAt: now,
    createdByUid: actor.uid,
    createdByName: actor.name,
    callerId: SKYWAY_CALLER_ID,
    callerName: SKYWAY_CALLER_NAME,
    vendor: 'vapi',
    vendorCallId: null,
    transcript: '',
    summary: '',
    outcome: null,
    lastError: '',
    updatedAt: now,
  };
  await getDb().collection(JOBS).doc(id).set(job);
  try {
    const config = await readCallConfig();
    const placed = await placeVapiPayload(voiceTaskVapiPayload(job, config));
    const next = await applyVoiceTaskStatus(job, {
      vendorCallId: placed.id,
      monitorListenUrl: placed.monitor?.listenUrl || '',
      monitorControlUrl: placed.monitor?.controlUrl || '',
      monitorUrlsUpdatedAt: placed.monitor?.listenUrl ? now : null,
      lastError: '',
    });
    return publicVoiceTaskSummary(next);
  } catch (error) {
    await applyVoiceTaskStatus(job, {
      status: CALL_STATUSES.failed,
      endedAt: Date.now(),
      lastError: error.message || 'Vapi rejected the task call',
    });
    throw error;
  }
}

