// Departure reminders. The Vercel cron schedule is removed so this route
// does not run on its own. When FBO_AUTO_NOTIFY_DISABLED=1 it returns
// immediately and does not read or write Firestore or send mail.
// A manual invocation still requires `Authorization: Bearer ${CRON_SECRET}`.
// A missing secret is a denial, matching cleanup-pax-ids and shift-handoff-cleanup.

import { cronAuthorized } from '../src/fbo-notify.js';
import { jsonError, runFboCron } from './_fbo-server.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export { cronAuthorized };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.FBO_AUTO_NOTIFY_DISABLED === '1') {
    return res.status(200).json({ ok: true, disabled: true });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'GET or POST only' });
  }
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const summary = await runFboCron();
    return res.status(200).json({ ok: true, ...summary });
  } catch (error) {
    return jsonError(res, error);
  }
}
