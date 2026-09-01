import crypto from 'node:crypto';
import {
  getDb,
  placeVapiPayload,
  readCallConfig,
} from './_fbo-call.js';
import {
  publicVoiceTaskSummary,
  validateVoiceTaskInput,
} from '../src/voice-task-call.js';
import {
  CALL_STATUSES,
  SKYWAY_CALLER_ID,
  SKYWAY_CALLER_NAME,
  isFinishedCallStatus,
  toE164,
  vapiEnvValue,
} from '../src/fbo-call.js';
import {
  extractVapiAnalysis,
  extractVapiRecording,
  extractVapiTranscript,
  mergeTranscript,
} from '../src/vapi-call-artifacts.js';

const JOBS = 'voice-task-calls';
const EVENTS = 'voice-task-call-events';

function newVoiceTaskId() {
  return `vtask_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function voiceTaskVapiPayload(job, config = {}, env = process.env) {
  const transfer = toE164(config.opsTransferNumber) || SKYWAY_CALLER_ID;
  const payload = {
    customer: { number: job.phoneE164, name: 'Operations contact' },
    assistantOverrides: { variableValues: {
      callerName: SKYWAY_CALLER_NAME,
      task: job.task,
      ops_transfer_number: transfer,
    } },
    metadata: {
      skywayCallId: job.id,
      skywayJobKind: 'voice_task',
    },
  };
  const taskAssistant = String(env.VAPI_VOICE_TASK_ASSISTANT_ID || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
  const assistantId = taskAssistant || vapiEnvValue(env, 'assistantId');
  if (assistantId) payload.assistantId = assistantId;
  return payload;
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
  const jobs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const dueForRecovery = jobs
    .filter((job) => (
      job.vendorCallId
      && (
        (['dialing', 'in_progress'].includes(job.status)
          && Number(job.vendorSyncAt || 0) <= Date.now())
        || (isFinishedCallStatus(job.status)
          && !job.transcript
          && Number(job.artifactBackfillAt || 0) <= Date.now()
          && (job.artifactBackfillAttempts || 0) < 5)
      )
    ))
    .slice(0, 3);
  for (const job of dueForRecovery) {
    try {
      const recovered = await refreshVoiceTaskArtifacts(job.id);
      const index = jobs.findIndex((candidate) => candidate.id === job.id);
      if (index >= 0) jobs[index] = { ...jobs[index], ...recovered };
    } catch {
      await applyVoiceTaskStatus(job, {
        artifactBackfillAttempts: (job.artifactBackfillAttempts || 0) + 1,
        artifactBackfillAt: Date.now() + 60_000,
      }).catch(() => {});
      // The manual Refresh transcript action remains available; list should
      // still succeed when Vapi artifacts are temporarily unavailable.
    }
  }
  return jobs.map(publicVoiceTaskSummary);
}

export async function createVoiceTask({
  phone,
  task,
  actor,
  parentCallId = '',
  now = Date.now(),
}) {
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
    parentCallId: parentCallId || null,
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
    transcriptStatus: 'pending',
    recordingStatus: 'pending',
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
      vendorSyncAt: now + 5_000,
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

export async function refreshVoiceTaskArtifacts(id, env = process.env) {
  const job = await loadVoiceTask(id);
  if (!job) {
    const error = new Error('Voice task call not found');
    error.status = 404;
    throw error;
  }
  if (!job.vendorCallId) {
    const error = new Error('Vapi call ID is not available yet');
    error.status = 409;
    throw error;
  }
  const apiKey = vapiEnvValue(env, 'apiKey');
  if (!apiKey) {
    const error = new Error('VAPI_API_KEY is missing on this deployment');
    error.status = 503;
    throw error;
  }
  const response = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(job.vendorCallId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Vapi artifact lookup failed (${response.status})`);
    error.status = 502;
    throw error;
  }
  const transcript = extractVapiTranscript(data);
  const analysis = extractVapiAnalysis(data);
  const outcome = analysis.structuredData || analysis.structured || job.outcome || null;
  const summary = analysis.summary || data.summary || job.summary || '';
  const recordingReady = Boolean(extractVapiRecording(data));
  const vendorStatus = String(data.status || '').toLowerCase();
  const ended = vendorStatus === 'ended';
  const endedReason = data.endedReason || data.ended_reason || job.endedReason || '';
  const failed = ended && /no-answer|busy|failed|error/i.test(String(endedReason));
  const status = ended
    ? (failed ? CALL_STATUSES.failed : (outcome?.needsFollowUp ? CALL_STATUSES.needs_followup : CALL_STATUSES.completed))
    : (vendorStatus === 'in-progress' || vendorStatus === 'in_progress'
      ? CALL_STATUSES.in_progress
      : job.status);
  const next = await applyVoiceTaskStatus(job, {
    status,
    startedAt: status === CALL_STATUSES.in_progress ? (job.startedAt || Date.now()) : job.startedAt,
    endedAt: ended ? (job.endedAt || Date.now()) : job.endedAt,
    endedReason,
    transcript: mergeTranscript(job.transcript, transcript),
    transcriptStatus: transcript ? 'complete' : (job.transcript ? 'complete' : 'pending'),
    transcriptUpdatedAt: transcript ? Date.now() : (job.transcriptUpdatedAt || null),
    summary,
    outcome,
    recordingAvailable: recordingReady || job.recordingAvailable === true,
    recordingStatus: recordingReady ? 'ready' : (job.recordingStatus || 'pending'),
    artifactBackfillAttempts: (job.artifactBackfillAttempts || 0) + 1,
    artifactBackfillAt: transcript ? null : Date.now() + 60_000,
    vendorSyncAt: ended ? null : Date.now() + 8_000,
  });
  return publicVoiceTaskSummary(next);
}

export async function getVoiceTaskListenCredentials(id, env = process.env) {
  let job = await loadVoiceTask(id);
  if (!job) {
    const error = new Error('Voice task call not found');
    error.status = 404;
    throw error;
  }
  if (!['dialing', 'in_progress'].includes(job.status) || !job.vendorCallId) {
    const error = new Error('Live listening is available only while the call is active');
    error.status = 409;
    throw error;
  }
  if (!job.monitorListenUrl) {
    const response = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(job.vendorCallId)}`, {
      headers: { Authorization: `Bearer ${vapiEnvValue(env, 'apiKey')}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.monitor?.listenUrl) {
      const error = new Error(data.message || 'Vapi did not provide a live listen stream');
      error.status = 409;
      throw error;
    }
    job = await applyVoiceTaskStatus(job, {
      monitorListenUrl: data.monitor.listenUrl,
      monitorControlUrl: data.monitor.controlUrl || '',
    });
  }
  return { callId: job.id, listenUrl: job.monitorListenUrl };
}

export async function getVoiceTaskRecordingCredentials(id, env = process.env) {
  const job = await loadVoiceTask(id);
  if (!job) {
    const error = new Error('Voice task call not found');
    error.status = 404;
    throw error;
  }
  if (!job.vendorCallId || !isFinishedCallStatus(job.status)) {
    const error = new Error('The call recording is available after the call ends');
    error.status = 409;
    throw error;
  }
  const response = await fetch(
    `https://api.vapi.ai/call/${encodeURIComponent(job.vendorCallId)}/mono-recording`,
    {
      headers: { Authorization: `Bearer ${vapiEnvValue(env, 'apiKey')}` },
      redirect: 'manual',
    },
  );
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) {
    return { callId: job.id, recordingUrl: location };
  }
  const data = await response.json().catch(() => ({}));
  const recordingUrl = data.url || data.recordingUrl || data.monoUrl || '';
  if (!response.ok || !recordingUrl) {
    const error = new Error(data.message || data.error || 'Vapi recording is not ready');
    error.status = response.status === 404 ? 409 : 502;
    throw error;
  }
  return { callId: job.id, recordingUrl };
}

export async function retryVoiceTask(id, actor) {
  const original = await loadVoiceTask(id);
  if (!original) {
    const error = new Error('Voice task call not found');
    error.status = 404;
    throw error;
  }
  if (!isFinishedCallStatus(original.status)) {
    const error = new Error('Only finished voice task calls can be retried');
    error.status = 409;
    throw error;
  }
  return createVoiceTask({
    phone: original.phoneE164,
    task: original.task,
    actor,
    parentCallId: original.id,
  });
}

async function deleteRefs(refs) {
  for (let index = 0; index < refs.length; index += 400) {
    const batch = getDb().batch();
    refs.slice(index, index + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

export async function deleteVoiceTask(id) {
  const job = await loadVoiceTask(id);
  if (!job) {
    const error = new Error('Voice task call not found');
    error.status = 404;
    throw error;
  }
  if (!isFinishedCallStatus(job.status)) {
    const error = new Error('Only finished voice task calls can be deleted');
    error.status = 409;
    throw error;
  }
  const eventSnap = await getDb().collection(EVENTS).where('callId', '==', id).get();
  await deleteRefs([
    getDb().collection(JOBS).doc(id),
    ...eventSnap.docs.map((doc) => doc.ref),
  ]);
  return { id, deletedAt: Date.now() };
}

export async function clearVoiceTaskHistory() {
  const jobsSnap = await getDb().collection(JOBS).get();
  const jobs = jobsSnap.docs.map((doc) => ({ ref: doc.ref, ...doc.data() }));
  const finished = jobs.filter((job) => isFinishedCallStatus(job.status));
  const finishedIds = new Set(finished.map((job) => job.id));
  const eventSnap = await getDb().collection(EVENTS).get();
  const noActiveCalls = finished.length === jobs.length;
  const eventRefs = eventSnap.docs
    .filter((doc) => noActiveCalls || finishedIds.has(doc.data()?.callId))
    .map((doc) => doc.ref);
  await deleteRefs([...finished.map((job) => job.ref), ...eventRefs]);
  return { deleted: finished.length };
}

