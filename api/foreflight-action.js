// Authenticated proxy for ForeFlight Dispatch actions. The API key never leaves
// the server. Admins and ops can call; pilots may only read status of a flight
// already linked to a trip they can see (enforced loosely — getFlight only).

import {
  authorizeForeFlightCaller,
  publicForeFlightConfig,
  readConfig,
  runForeFlightAction,
  writeConfig,
} from './_foreflight.js';

const PILOT_ACTIONS = new Set([
  'getFlight',
  'getPerformance',
  'getIcao',
  'listFiles',
]);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const { idToken, action, ...params } = req.body || {};
    if (!action) {
      res.status(400).json({ error: 'action is required' });
      return;
    }

    const caller = await authorizeForeFlightCaller(idToken, ['admin', 'ops', 'pilot']);
    if (caller.role === 'pilot' && !PILOT_ACTIONS.has(action)) {
      res.status(403).json({ error: 'Pilots can only read linked ForeFlight flight data' });
      return;
    }

    const config = await readConfig();
    if (!config?.apiKey) {
      res.status(400).json({ error: 'ForeFlight Dispatch is not connected', ...publicForeFlightConfig(config) });
      return;
    }

    const result = await runForeFlightAction(config, action, params);

    if (action === 'test' || action === 'getApiKeyInfo') {
      const info = action === 'test' ? result.info : result;
      await writeConfig({
        organisationUUID: info?.organisationUUID || config.organisationUUID || null,
        organisationName: info?.organisationName || config.organisationName || null,
        storageAccountUUID: info?.storageAccountUUID || config.storageAccountUUID || null,
        lastTestAt: Date.now(),
        lastTestOk: true,
      });
    }

    if (action === 'registerWebhook' && result?.url) {
      await writeConfig({
        webhookUrl: result.url,
        ...(params.secret ? { webhookSecret: params.secret } : {}),
      });
    }

    res.status(200).json({ ok: true, action, result });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'ForeFlight action failed',
      foreflight: err.foreflight || null,
      rateLimit: err.rateLimit || null,
    });
  }
}
