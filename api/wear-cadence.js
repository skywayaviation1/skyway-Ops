import { authorizeAppUser } from './_super-admin.js';
import { recordWearLanding, resetWearCadence } from './_wear-cadence.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const actor = await authorizeAppUser(body.idToken);
    if (body.action === 'landing') {
      const result = await recordWearLanding({
        tripUid: body.tripUid,
        tail: body.tail,
        landedAtMs: body.landedAtMs,
        pic: body.pic,
        sic: body.sic,
        source: `manual:${actor.uid}`,
      });
      return res.status(200).json({ ok: true, ...result });
    }
    if (body.action === 'session-complete') {
      const result = await resetWearCadence({
        tail: body.tail,
        sessionId: body.sessionId,
        completedAtMs: body.completedAtMs,
      });
      return res.status(200).json({ ok: true, ...result });
    }
    return res.status(400).json({ error: 'Unknown wear cadence action' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Wear cadence failed' });
  }
}

