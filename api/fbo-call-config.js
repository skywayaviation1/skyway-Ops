/**
 * Admin-only FBO calling agent settings.
 * API keys stay in the deployment environment — never in Firestore.
 *
 * POST { idToken, action: 'status' | 'save', ... }
 */

import {
  authorizeFboCaller,
  defaultConfig,
  publicVendorStatus,
  readCallConfig,
  writeCallConfig,
} from './_fbo-call.js';
import { toE164 } from '../src/fbo-call.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    const actor = await authorizeFboCaller(body.idToken, ['admin']);
    if (body.action === 'save') {
      const defaults = defaultConfig();
      const saved = await writeCallConfig({
        enabled: body.enabled !== false,
        depLeadMinutes: Math.min(12 * 60, Math.max(15, Number(body.depLeadMinutes) || defaults.depLeadMinutes)),
        arrLeadMinutes: Math.min(12 * 60, Math.max(15, Number(body.arrLeadMinutes) || defaults.arrLeadMinutes)),
        retryMinutes: Math.min(60, Math.max(5, Number(body.retryMinutes) || defaults.retryMinutes)),
        maxAttempts: Math.min(5, Math.max(1, Number(body.maxAttempts) || defaults.maxAttempts)),
        opsTransferNumber: toE164(body.opsTransferNumber) || defaults.opsTransferNumber,
      }, actor);
      return res.status(200).json({ ok: true, ...saved });
    }
    return res.status(200).json({ ok: true, ...(await readCallConfig()), vendor: publicVendorStatus() });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Settings failed' });
  }
}
