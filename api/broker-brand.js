// /api/broker-brand.js
//
// Ops/admin endpoint for the broker white-label record.
//
// POST { action, idToken, email, ... }
//   get        → the broker record (empty if none yet)
//   list       → recent broker records
//   save       → display name, accent, powered-by toggle
//   upload     → logo bytes (base64) plus the same fields
//   removeLogo → delete the stored logo; the public page falls back
//
// Sales can share a tracking link but cannot change branding.

import {
  authorizeOps,
  getBrokerBranding,
  listBrokerBranding,
  removeBrokerLogo,
  saveBrokerBranding,
  uploadBrokerLogo,
} from './_broker-brand-store.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }
  }

  const auth = await authorizeOps(req, body);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const action = String(body?.action || '');
  try {
    if (action === 'list') {
      const result = await listBrokerBranding();
      return res.status(200).json({ ok: true, ...result });
    }
    if (action === 'get') {
      const result = await getBrokerBranding(body?.email);
      if (result.error) return res.status(result.error.code).json({ ok: false, error: result.error.error });
      return res.status(200).json({ ok: true, broker: result.broker });
    }
    if (action === 'save') {
      const result = await saveBrokerBranding(body, auth);
      if (result.error) return res.status(result.error.code).json({ ok: false, error: result.error.error });
      return res.status(200).json({ ok: true, broker: result.broker });
    }
    if (action === 'upload') {
      const result = await uploadBrokerLogo(body, auth);
      if (result.error) return res.status(result.error.code).json({ ok: false, error: result.error.error });
      return res.status(200).json({ ok: true, broker: result.broker });
    }
    if (action === 'removeLogo') {
      const result = await removeBrokerLogo(body, auth);
      if (result.error) return res.status(result.error.code).json({ ok: false, error: result.error.error });
      return res.status(200).json({ ok: true, broker: result.broker });
    }
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (e) {
    console.error('[broker-brand]', action, e?.message || e);
    return res.status(500).json({ ok: false, error: 'Could not save broker branding.' });
  }
}
