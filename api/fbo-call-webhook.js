/**
 * Vapi → Skyway FBO call webhook.
 *
 * Stores transcript, structured summary, and terminal status on the job.
 * HMAC of the raw body with VAPI_WEBHOOK_SECRET.
 */

import crypto from 'node:crypto';
import {
  applyVendorStatus,
  loadJob,
  notifyOps,
  recordEvent,
} from './_fbo-call.js';
import {
  applyVoiceTaskStatus,
  findVoiceTaskByVendorId,
  loadVoiceTask,
  recordVoiceTaskEvent,
} from './_voice-task-call.js';
import { CALL_STATUSES, vapiEnvValue } from '../src/fbo-call.js';
import {
  extractVapiAnalysis,
  extractVapiRecording,
  extractVapiTranscript,
  mergeTranscript,
  transcriptEventSegment,
} from '../src/vapi-call-artifacts.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
  api: { bodyParser: false },
};

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function validVapiSignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeSecretEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validVapiRequest(body, headers = {}, secret = '') {
  const signature = headers['x-vapi-signature']
    || headers['x-vapi-signature-256']
    || headers['x-signature'];
  if (validVapiSignature(body, signature, secret)) return true;
  const authorization = String(headers.authorization || '');
  const bearer = authorization.replace(/^Bearer\s+/i, '');
  const token = headers['x-vapi-secret'] || bearer;
  return Boolean(token && secret && safeSecretEqual(token, secret));
}

function jobIdFrom(payload) {
  return payload?.call?.metadata?.skywayCallId
    || payload?.message?.call?.metadata?.skywayCallId
    || payload?.metadata?.skywayCallId
    || '';
}

function vendorIdFrom(payload) {
  return payload?.call?.id || payload?.message?.call?.id || payload?.id || '';
}

export function jobKindFrom(payload) {
  return payload?.call?.metadata?.skywayJobKind
    || payload?.message?.call?.metadata?.skywayJobKind
    || payload?.metadata?.skywayJobKind
    || 'fbo_call';
}

export function summarizeWebhook(payload) {
  const message = payload?.message || payload;
  const type = message.type || payload.type || '';
  const status = String(message.status || message.call?.status || '').toLowerCase();
  const analysis = extractVapiAnalysis(payload);
  const structured = analysis.structuredData || analysis.structured || null;
  const ended = type === 'end-of-call-report' || status === 'ended';
  const failed = ended && /no-answer|busy|failed|error/i.test(String(message.endedReason || message.ended_reason || ''));
  const transferred = Boolean(structured?.transferredToOps) || /transfer/i.test(type);
  const segment = transcriptEventSegment(payload);
  const isTranscriptEvent = /^transcript(?:\[|$)/i.test(String(type));
  let nextStatus = null;
  if (status === 'ringing' || status === 'queued') nextStatus = CALL_STATUSES.dialing;
  if (status === 'in-progress' || status === 'in_progress') nextStatus = CALL_STATUSES.in_progress;
  if (ended) {
    if (failed) nextStatus = CALL_STATUSES.failed;
    else if (structured?.needsFollowUp) nextStatus = CALL_STATUSES.needs_followup;
    else nextStatus = CALL_STATUSES.completed;
  }
  return {
    type,
    status,
    nextStatus,
    ended,
    failed,
    transferred,
    transcript: isTranscriptEvent ? segment : extractVapiTranscript(payload),
    transcriptSegment: segment,
    summary: analysis.summary || message.summary || '',
    confirmations: structured,
    endedReason: message.endedReason || message.ended_reason || '',
    vendorCallId: vendorIdFrom(payload),
    skywayCallId: jobIdFrom(payload),
    recordingAvailable: Boolean(extractVapiRecording(payload)),
    monitorListenUrl: message.call?.monitor?.listenUrl || payload.call?.monitor?.listenUrl || '',
    monitorControlUrl: message.call?.monitor?.controlUrl || payload.call?.monitor?.controlUrl || '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const raw = await rawBody(req);
  const secret = vapiEnvValue(process.env, 'webhookSecret');
  if (!secret) {
    return res.status(503).json({ error: 'VAPI_WEBHOOK_SECRET is not configured' });
  }
  if (!validVapiRequest(raw, req.headers, secret)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventKey = String(
    payload.message?.timestamp
    || payload.call?.id
    || payload.message?.call?.id
    || Date.now(),
  ) + ':' + String(payload.message?.type || payload.type || 'event')
    + ':' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

  const jobKind = jobKindFrom(payload);
  const record = jobKind === 'voice_task' ? recordVoiceTaskEvent : recordEvent;
  const first = await record(eventKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200), {
    type: payload.message?.type || payload.type,
    vendorCallId: vendorIdFrom(payload),
    jobKind,
  });
  if (!first) return res.status(200).json({ ok: true, duplicate: true });

  const parsed = summarizeWebhook(payload);
  let job = parsed.skywayCallId
    ? await (jobKind === 'voice_task' ? loadVoiceTask : loadJob)(parsed.skywayCallId)
    : null;
  if (!job && parsed.vendorCallId && jobKind === 'voice_task') {
    job = await findVoiceTaskByVendorId(parsed.vendorCallId);
  } else if (!job && parsed.vendorCallId) {
    const { getDb } = await import('./_fbo-call.js');
    const snap = await getDb().collection('fbo-call-jobs')
      .where('vendorCallId', '==', parsed.vendorCallId)
      .limit(1)
      .get();
    if (!snap.empty) job = { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  if (!job) return res.status(200).json({ ok: true, ignored: 'unknown_call' });

  const patch = {
    vendorCallId: parsed.vendorCallId || job.vendorCallId,
  };
  if (parsed.nextStatus) patch.status = parsed.nextStatus;
  const incomingTranscript = parsed.transcriptSegment || parsed.transcript;
  if (incomingTranscript) {
    patch.transcript = mergeTranscript(job.transcript, incomingTranscript);
    patch.transcriptStatus = parsed.ended ? 'complete' : 'partial';
    patch.transcriptUpdatedAt = Date.now();
  } else if (parsed.ended && !job.transcript) {
    patch.transcriptStatus = 'pending';
    patch.artifactBackfillAt = Date.now() + 30_000;
  }
  if (parsed.summary) patch.summary = parsed.summary;
  if (parsed.confirmations) {
    if (jobKind === 'voice_task') patch.outcome = parsed.confirmations;
    else patch.confirmations = parsed.confirmations;
  }
  if (parsed.recordingAvailable) {
    patch.recordingAvailable = true;
    patch.recordingStatus = 'ready';
  } else if (parsed.ended && !job.recordingAvailable) {
    patch.recordingStatus = 'pending';
  }
  if (parsed.monitorListenUrl) {
    patch.monitorListenUrl = parsed.monitorListenUrl;
    patch.monitorControlUrl = parsed.monitorControlUrl;
    patch.monitorUrlsUpdatedAt = Date.now();
  }
  if (parsed.ended) {
    patch.endedAt = Date.now();
    patch.endedReason = parsed.endedReason;
  }
  if (parsed.nextStatus === CALL_STATUSES.in_progress) patch.startedAt = job.startedAt || Date.now();
  if (jobKind === 'voice_task') await applyVoiceTaskStatus(job, patch);
  else await applyVendorStatus(job, patch);

  if (parsed.ended) {
    const subjectStatus = parsed.failed ? 'failed' : (parsed.nextStatus === CALL_STATUSES.needs_followup ? 'needs follow-up' : 'completed');
    if (jobKind === 'voice_task') {
      await notifyOps({
        source: 'voice-task-call-complete',
        subject: `AI voice task ${subjectStatus} — ${job.phoneDisplay || job.phoneE164}`,
        text: [
          `Task: ${job.task}`,
          `Status: ${subjectStatus}`,
          parsed.summary || 'No summary returned.',
          parsed.endedReason ? `Vendor reason: ${parsed.endedReason}` : '',
          'Open Skyway Ops → FBO calls → One-off voice tasks for the transcript and text log.',
        ].filter(Boolean).join('\n'),
      });
    } else {
      await notifyOps({
        tripId: job.tripId,
        source: 'fbo-call-complete',
        subject: `FBO call ${subjectStatus} — ${job.fboName || ''} ${job.airport || ''}`,
        text: [
          `${job.purpose} call to ${job.fboName} at ${job.airport} ${subjectStatus}.`,
          parsed.summary || 'No summary returned.',
          parsed.endedReason ? `Vendor reason: ${parsed.endedReason}` : '',
          'Open Skyway Ops → FBO calls for the transcript.',
        ].filter(Boolean).join('\n'),
      });
    }
  }

  return res.status(200).json({ ok: true, callId: job.id, status: patch.status || job.status });
}
