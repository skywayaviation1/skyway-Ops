/**
 * Ops/admin one-off AI voice tasks.
 *
 * POST { idToken, action: 'create' | 'list' | 'get', phone?, task?, callId? }
 */

import { authorizeFboCaller, publicVendorStatus } from './_fbo-call.js';
import {
  createVoiceTask,
  clearVoiceTaskHistory,
  deleteVoiceTask,
  getVoiceTaskListenCredentials,
  getVoiceTaskRecordingCredentials,
  listVoiceTasks,
  loadVoiceTask,
  refreshVoiceTaskArtifacts,
  retryVoiceTask,
} from './_voice-task-call.js';
import { publicVoiceTaskSummary } from '../src/voice-task-call.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

function bodyOf(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try {
    body = bodyOf(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    const actor = await authorizeFboCaller(body.idToken, ['ops', 'admin']);
    const action = String(body.action || 'list');
    if (action === 'create') {
      const call = await createVoiceTask({
        phone: body.phone,
        task: body.task,
        actor,
      });
      return res.status(200).json({ ok: true, call, vendor: publicVendorStatus() });
    }
    if (action === 'list') {
      return res.status(200).json({
        ok: true,
        calls: await listVoiceTasks(body.limit),
        vendor: publicVendorStatus(),
      });
    }
    if (action === 'get') {
      const call = await loadVoiceTask(body.callId);
      if (!call) return res.status(404).json({ error: 'Voice task call not found' });
      return res.status(200).json({ ok: true, call: publicVoiceTaskSummary(call) });
    }
    if (action === 'refreshArtifacts') {
      return res.status(200).json({
        ok: true,
        call: await refreshVoiceTaskArtifacts(body.callId),
      });
    }
    if (action === 'listen') {
      return res.status(200).json({
        ok: true,
        ...(await getVoiceTaskListenCredentials(body.callId)),
      });
    }
    if (action === 'recording') {
      return res.status(200).json({
        ok: true,
        ...(await getVoiceTaskRecordingCredentials(body.callId)),
      });
    }
    if (action === 'retry') {
      return res.status(200).json({
        ok: true,
        call: await retryVoiceTask(body.callId, actor),
      });
    }
    if (action === 'delete') {
      return res.status(200).json({
        ok: true,
        deleted: await deleteVoiceTask(body.callId),
      });
    }
    if (action === 'clearHistory') {
      return res.status(200).json({
        ok: true,
        ...(await clearVoiceTaskHistory()),
      });
    }
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (error) {
    console.error('[voice-task-call]', error.message);
    return res.status(error.status || 500).json({
      error: error.message || 'Voice task call failed',
      vendor: publicVendorStatus(),
    });
  }
}

