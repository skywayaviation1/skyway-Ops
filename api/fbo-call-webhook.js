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
import { CALL_STATUSES, vapiEnvValue } from '../src/fbo-call.js';

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

function jobIdFrom(payload) {
  return payload?.call?.metadata?.skywayCallId
    || payload?.message?.call?.metadata?.skywayCallId
    || payload?.metadata?.skywayCallId
    || '';
}

function vendorIdFrom(payload) {
  return payload?.call?.id || payload?.message?.call?.id || payload?.id || '';
}

function transcriptFrom(payload) {
  const report = payload?.message || payload;
  if (typeof report.transcript === 'string' && report.transcript.trim()) return report.transcript.trim();
  const stereo = report.artifact?.transcript;
  if (typeof stereo === 'string') return stereo;
  const messages = report.artifact?.messages || report.messages;
  if (Array.isArray(messages)) {
    return messages
      .filter((row) => row?.role && row?.message)
      .map((row) => `${row.role}: ${row.message}`)
      .join('\n');
  }
  return '';
}

function recordingFrom(payload) {
  const report = payload?.message || payload;
  const artifact = report.artifact || report.call?.artifact || payload?.call?.artifact || {};
  const recording = artifact.recording || {};
  return recording.monoUrl
    || recording.stereoUrl
    || artifact.recordingUrl
    || artifact.stereoRecordingUrl
    || '';
}

export function summarizeWebhook(payload) {
  const message = payload?.message || payload;
  const type = message.type || payload.type || '';
  const status = String(message.status || message.call?.status || '').toLowerCase();
  const analysis = message.analysis || message.artifact?.analysis || {};
  const structured = analysis.structuredData || analysis.structured || null;
  const ended = type === 'end-of-call-report' || status === 'ended';
  const failed = ended && /no-answer|busy|failed|error/i.test(String(message.endedReason || message.ended_reason || ''));
  const transferred = Boolean(structured?.transferredToOps) || /transfer/i.test(type);
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
    transcript: transcriptFrom(payload),
    summary: analysis.summary || message.summary || '',
    confirmations: structured,
    endedReason: message.endedReason || message.ended_reason || '',
    vendorCallId: vendorIdFrom(payload),
    skywayCallId: jobIdFrom(payload),
    recordingAvailable: Boolean(recordingFrom(payload)),
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
  const signature = req.headers['x-vapi-signature'] || req.headers['x-vapi-signature-256'];
  if (!secret) {
    return res.status(503).json({ error: 'VAPI_WEBHOOK_SECRET is not configured' });
  }
  if (!validVapiSignature(raw, signature, secret)) {
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
  ) + ':' + String(payload.message?.type || payload.type || 'event');

  const first = await recordEvent(eventKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200), {
    type: payload.message?.type || payload.type,
    vendorCallId: vendorIdFrom(payload),
  });
  if (!first) return res.status(200).json({ ok: true, duplicate: true });

  const parsed = summarizeWebhook(payload);
  let job = parsed.skywayCallId ? await loadJob(parsed.skywayCallId) : null;
  if (!job && parsed.vendorCallId) {
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
  if (parsed.transcript) patch.transcript = parsed.transcript;
  if (parsed.summary) patch.summary = parsed.summary;
  if (parsed.confirmations) patch.confirmations = parsed.confirmations;
  if (parsed.recordingAvailable) patch.recordingAvailable = true;
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
  await applyVendorStatus(job, patch);

  if (parsed.ended) {
    const subjectStatus = parsed.failed ? 'failed' : (parsed.nextStatus === CALL_STATUSES.needs_followup ? 'needs follow-up' : 'completed');
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

  return res.status(200).json({ ok: true, callId: job.id, status: patch.status || job.status });
}
