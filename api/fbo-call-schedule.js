/**
 * Places armed FBO calls when their dial window opens.
 *
 * Vercel Cron every 15 minutes (see vercel.json). Ops must arm each trip;
 * this job never invents new calls from the calendar.
 */

import {
  dialJobNow,
  dueJobs,
  publicVendorStatus,
  readCallConfig,
} from './_fbo-call.js';
import { vendorConfigured } from '../src/fbo-call.js';

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
      try {
        results.push(await dialJobNow(job.id, { now, force: false }));
      } catch (error) {
        results.push({ id: job.id, ok: false, error: error.message });
      }
    }

    return res.status(200).json({ ok: true, now, attempted: results.length, results });
  } catch (error) {
    console.error('[fbo-call-schedule]', error);
    return res.status(500).json({ error: error.message || 'Scheduler failed' });
  }
}
