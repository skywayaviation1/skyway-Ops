/**
 * Places armed FBO calls when their dial window opens.
 *
 * Vercel Cron every 15 minutes (see vercel.json). Ops must arm each trip;
 * this job never invents new calls from the calendar.
 */

import {
  applyVendorStatus,
  dueJobs,
  loadJob,
  notifyOps,
  placeVapiCall,
  publicVendorStatus,
  readCallConfig,
} from './_fbo-call.js';
import { CALL_STATUSES, DEFAULT_MAX_ATTEMPTS, nextRetryAt, vendorConfigured } from '../src/fbo-call.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

function authorized(req) {
  const cron = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  if (cron && auth === `Bearer ${cron}`) return true;
  const internal = req.headers['x-internal-secret'];
  return Boolean(internal && internal === process.env.INTERNAL_API_SECRET);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'GET or POST' });
  }
  if (!authorized(req) && process.env.VERCEL !== '1') {
    // Local/dev: allow. Production cron sends CRON_SECRET; Vercel production
    // cron requests are accepted when VERCEL=1 even without the header so a
    // missing CRON_SECRET cannot silently disable FBO calling.
  } else if (process.env.VERCEL === '1' && process.env.CRON_SECRET && !authorized(req)) {
    const ua = String(req.headers['user-agent'] || '');
    if (!/vercel-cron/i.test(ua) && !authorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const now = Date.now();
  const results = [];
  try {
    if (!vendorConfigured(process.env)) {
      return res.status(200).json({
        ok: true,
        skipped: 'vapi_not_configured',
        vendor: publicVendorStatus(),
      });
    }
    const settings = await readCallConfig();
    if (settings.enabled === false) {
      return res.status(200).json({ ok: true, skipped: 'disabled', vendor: publicVendorStatus() });
    }

    const jobs = await dueJobs(now);
    for (const job of jobs.slice(0, 8)) {
      const fresh = await loadJob(job.id);
      if (!fresh) continue;
      if (['dialing', 'in_progress', 'completed', 'cancelled'].includes(fresh.status)) continue;
      const attempts = (fresh.attempts || 0) + 1;
      try {
        await applyVendorStatus(fresh, {
          status: CALL_STATUSES.dialing,
          attempts,
          lastAttemptAt: now,
        });
        const placed = await placeVapiCall({ ...fresh, attempts }, settings);
        await applyVendorStatus(fresh, {
          status: CALL_STATUSES.dialing,
          attempts,
          vendorCallId: placed.id,
          lastAttemptAt: now,
          lastError: '',
        });
        results.push({ id: fresh.id, ok: true, vendorCallId: placed.id });
      } catch (error) {
        const max = fresh.maxAttempts || DEFAULT_MAX_ATTEMPTS;
        const failed = attempts >= max;
        await applyVendorStatus(fresh, {
          status: failed ? CALL_STATUSES.failed : 'retry',
          attempts,
          lastError: error.message,
          dialAt: failed ? fresh.dialAt : nextRetryAt(now, settings.retryMinutes),
        });
        if (failed) {
          await notifyOps({
            tripId: fresh.tripId,
            source: 'fbo-call-failed',
            subject: `FBO call failed — ${fresh.fboName || ''} ${fresh.airport || ''}`,
            text: [
              `Skyway could not complete the ${fresh.purpose} FBO call.`,
              `${fresh.fboName} ${fresh.airport} ${fresh.phoneE164}`,
              `Error: ${error.message}`,
              'Ops should call the FBO directly.',
            ].join('\n'),
          });
        }
        results.push({ id: fresh.id, ok: false, error: error.message, failed });
      }
    }

    return res.status(200).json({ ok: true, now, attempted: results.length, results });
  } catch (error) {
    console.error('[fbo-call-schedule]', error);
    return res.status(500).json({ error: error.message || 'Scheduler failed' });
  }
}
