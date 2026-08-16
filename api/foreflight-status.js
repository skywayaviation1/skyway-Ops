// Public ForeFlight Dispatch connection status (never returns the API key).

import {
  authorizeForeFlightCaller,
  publicForeFlightConfig,
  readConfig,
} from './_foreflight.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    await authorizeForeFlightCaller(req.body?.idToken, ['admin', 'ops', 'pilot']);
    res.status(200).json(publicForeFlightConfig(await readConfig()));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not read ForeFlight status' });
  }
}
