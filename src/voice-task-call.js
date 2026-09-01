import {
  CALL_STATUSES,
  SKYWAY_CALLER_ID,
  SKYWAY_CALLER_NAME,
  toE164,
} from './fbo-call.js';

const clean = (value) => String(value ?? '').trim();

export function validateVoiceTaskInput({ phone, task } = {}) {
  const phoneE164 = toE164(phone);
  const taskText = clean(task).replace(/\s+/g, ' ');
  const blockers = [];
  if (!phoneE164) blockers.push('Enter a valid destination phone number');
  if (!taskText) blockers.push('Describe the task for the voice agent');
  if (taskText.length > 3000) blockers.push('Task instructions must be 3,000 characters or fewer');
  return {
    ok: blockers.length === 0,
    blockers,
    phoneE164,
    phoneDisplay: clean(phone),
    task: taskText,
  };
}

export function publicVoiceTaskSummary(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: job.id,
    status: job.status || CALL_STATUSES.dialing,
    phone: job.phoneDisplay || job.phoneE164 || '',
    task: job.task || '',
    createdAt: job.createdAt || null,
    createdByName: job.createdByName || '',
    startedAt: job.startedAt || null,
    endedAt: job.endedAt || null,
    endedReason: job.endedReason || '',
    summary: job.summary || '',
    transcript: job.transcript || '',
    outcome: job.outcome || null,
    parentCallId: job.parentCallId || null,
    transcriptStatus: job.transcriptStatus || (job.transcript ? 'complete' : 'pending'),
    recordingStatus: job.recordingStatus || (job.recordingAvailable ? 'ready' : 'pending'),
    artifactBackfillAttempts: job.artifactBackfillAttempts || 0,
    lastError: job.lastError || '',
    callerId: job.callerId || SKYWAY_CALLER_ID,
    callerName: job.callerName || SKYWAY_CALLER_NAME,
    listenAvailable: ['dialing', 'in_progress'].includes(job.status) && Boolean(job.vendorCallId),
    recordingAvailable: Boolean(
      job.recordingAvailable
      || (job.vendorCallId && ['completed', 'failed', 'needs_followup'].includes(job.status)),
    ),
  };
}

export function formatVoiceTaskLog(job) {
  const outcome = job?.outcome || {};
  return [
    'Skyway Aviation — AI voice task call log',
    `Call ID: ${job?.id || 'unknown'}`,
    `Created: ${job?.createdAt ? new Date(job.createdAt).toISOString() : 'unknown'}${job?.createdByName ? ` by ${job.createdByName}` : ''}`,
    `Destination: ${job?.phone || 'unknown'}`,
    `Status: ${String(job?.status || 'unknown').replace(/_/g, ' ')}`,
    '',
    '--- ASSIGNED TASK ---',
    job?.task || '(none)',
    '',
    '--- TASK OUTCOME ---',
    `Completed: ${outcome.taskCompleted === true ? 'yes' : (outcome.taskCompleted === false ? 'no' : 'not reported')}`,
    `Needs follow-up: ${outcome.needsFollowUp === true ? 'yes' : (outcome.needsFollowUp === false ? 'no' : 'not reported')}`,
    `Transferred to operations: ${outcome.transferredToOps === true ? 'yes' : 'no'}`,
    `Outcome: ${outcome.outcomeSummary || job?.summary || '(none)'}`,
    `Notes: ${outcome.notes || '(none)'}`,
    '',
    '--- CALL TRANSCRIPT ---',
    job?.transcript || '(none)',
    '',
  ].join('\n');
}

