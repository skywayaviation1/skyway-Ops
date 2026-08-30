/**
 * Ops/admin FBO calling agent.
 *
 * POST { idToken, action, ... }
 *   preview  — resolve verified facts without arming
 *   arm      — ops must arm; never auto-dials from the schedule alone
 *   list     — calls for one trip
 *   cancel
 *   retry
 *   desk     — upcoming armed/scheduled/in-progress/failed jobs
 */

import {
  authorizeFboCaller,
  armCalls,
  cancelJob,
  dialJobNow,
  getListenCredentials,
  listTripCalls,
  loadJob,
  publicVendorStatus,
  readCallConfig,
  resolveFboFacts,
  retryJob,
} from './_fbo-call.js';
import { publicCallSummary } from '../src/fbo-call.js';

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
    const action = String(body.action || 'preview');
    const viewRoles = ['crew', 'pilot', 'sales', 'ops', 'admin'];
    const mutateRoles = ['ops', 'admin'];
    const actor = await authorizeFboCaller(
      body.idToken,
      ['preview', 'list', 'desk'].includes(action) ? viewRoles : mutateRoles,
    );

    if (action === 'preview') {
      const purposes = Array.isArray(body.purposes) ? body.purposes : ['departure', 'arrival'];
      const results = [];
      for (const purpose of purposes) {
        if (purpose !== 'departure' && purpose !== 'arrival') continue;
        results.push({
          purpose,
          ...(await resolveFboFacts(body.trip || {}, body.state || {}, purpose)),
        });
      }
      return res.status(200).json({
        ok: true,
        vendor: publicVendorStatus(),
        config: await readCallConfig(),
        results: results.map((row) => ({
          purpose: row.purpose,
          ok: row.ok,
          blockers: row.blockers || [],
          facts: row.facts,
          hash: row.hash,
        })),
      });
    }

    if (action === 'arm') {
      if (!body.trip?.uid) return res.status(400).json({ error: 'trip.uid is required' });
      const result = await armCalls({
        trip: body.trip,
        state: body.state || {},
        purposes: body.purposes,
        verifiedPurposes: body.verifiedPurposes,
        dialImmediately: body.dialImmediately !== false,
        actor,
      });
      return res.status(200).json({ ok: true, ...result });
    }

    if (action === 'list') {
      if (!body.tripId) return res.status(400).json({ error: 'tripId is required' });
      const jobs = await listTripCalls(body.tripId);
      return res.status(200).json({
        ok: true,
        vendor: publicVendorStatus(),
        calls: jobs.map(publicCallSummary),
      });
    }

    if (action === 'desk') {
      const { getDb } = await import('./_fbo-call.js');
      const snap = await getDb().collection('fbo-call-jobs').limit(120).get();
      const calls = snap.docs
        .map((doc) => publicCallSummary({ id: doc.id, ...doc.data() }))
        .filter((call) => call && call.status !== 'cancelled');
      return res.status(200).json({
        ok: true,
        vendor: publicVendorStatus(),
        config: await readCallConfig(),
        calls,
      });
    }

    if (action === 'cancel') {
      return res.status(200).json({ ok: true, call: await cancelJob(body.callId, actor) });
    }

    if (action === 'retry') {
      return res.status(200).json({ ok: true, call: await retryJob(body.callId, actor) });
    }

    if (action === 'dialNow') {
      return res.status(200).json({
        ok: true,
        result: await dialJobNow(body.callId, { actor, force: true }),
      });
    }

    if (action === 'listen') {
      return res.status(200).json({ ok: true, ...(await getListenCredentials(body.callId)) });
    }

    if (action === 'update') {
      if (!body.trip?.uid) return res.status(400).json({ error: 'trip.uid is required' });
      const { maybeQueueMaterialUpdates } = await import('./_fbo-call.js');
      const created = await maybeQueueMaterialUpdates({
        trip: body.trip,
        state: body.state || {},
        verifiedPurposes: body.verifiedPurposes,
        actor,
      });
      return res.status(200).json({ ok: true, created });
    }

    if (action === 'get') {
      const job = await loadJob(body.callId);
      if (!job) return res.status(404).json({ error: 'Call not found' });
      return res.status(200).json({ ok: true, call: publicCallSummary(job) });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (error) {
    console.error('[fbo-call]', error.message);
    return res.status(error.status || 500).json({
      error: error.message || 'FBO call request failed',
      vendor: publicVendorStatus(),
    });
  }
}
