import {
  authorizeAppUser,
  authorizeJake,
  getDb,
  writeAudit,
} from './_super-admin.js';

export const config = { runtime: 'nodejs' };

function bodyOf(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = bodyOf(req);
    if (body.action === 'ingest') {
      const actor = await authorizeAppUser(body.idToken);
      const event = await writeAudit(actor, body.event || {}, 'client');
      return res.status(200).json({ ok: true, id: event.id });
    }
    if (body.action === 'query') {
      await authorizeJake(body.idToken);
      const limit = Math.min(500, Math.max(1, Number(body.limit) || 200));
      const snap = await getDb().collection('audit-events')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();
      const events = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      return res.status(200).json({ ok: true, events });
    }
    return res.status(400).json({ error: 'Unknown audit action' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Audit request failed' });
  }
}

