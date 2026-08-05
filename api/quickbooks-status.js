// Returns public QuickBooks connection metadata. Tokens remain server-only.

import {
  authorizeQboCaller,
  publicConnection,
  readConnection,
} from './_quickbooks.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    await authorizeQboCaller(req.body?.idToken, ['accounting', 'admin']);
    res.status(200).json(publicConnection(await readConnection()));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not read QuickBooks status' });
  }
}
