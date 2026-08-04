// api/quickbooks-disconnect.js
//
// Admin clicks "Disconnect QuickBooks" — this endpoint:
//   1. Verifies caller is admin
//   2. Calls Intuit's revoke endpoint to invalidate the refresh token
//   3. Deletes the Firestore connection doc
//
// After this, the only way to reconnect is the full OAuth flow again.

import { authorizeQboCaller, getDb } from './_quickbooks.js';

const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      res.status(400).json({ error: 'idToken required' });
      return;
    }

    try {
      await authorizeQboCaller(idToken, ['accounting', 'admin']);
    } catch (err) {
      res.status(err.status || 403).json({ error: err.message });
      return;
    }

    // Read the current connection
    const connRef = getDb().collection('quickbooks').doc('connection');
    const connSnap = await connRef.get();
    if (!connSnap.exists) {
      res.status(200).json({ ok: true, message: 'Already disconnected' });
      return;
    }
    const conn = connSnap.data();

    // Revoke with Intuit (best-effort — we still delete locally even if this fails)
    let revokeOk = false;
    let revokeError = null;
    try {
      const clientId = process.env.INTUIT_CLIENT_ID;
      const clientSecret = process.env.INTUIT_CLIENT_SECRET;
      if (clientId && clientSecret && conn.refreshToken) {
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const r = await fetch(REVOKE_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Basic ${basicAuth}`,
          },
          body: JSON.stringify({ token: conn.refreshToken }),
        });
        if (r.ok) {
          revokeOk = true;
        } else {
          const errBody = await r.text().catch(() => '');
          revokeError = `Intuit revoke returned ${r.status}: ${errBody}`;
          console.warn('[qbo-disconnect]', revokeError);
        }
      }
    } catch (err) {
      revokeError = err.message;
      console.warn('[qbo-disconnect] revoke threw:', err);
    }

    // Delete the connection doc regardless
    await connRef.delete();

    res.status(200).json({
      ok: true,
      revokeOk,
      revokeError,
      message: revokeOk
        ? 'Disconnected and tokens revoked at Intuit.'
        : 'Local connection deleted; Intuit revoke may have failed (will expire on its own).',
    });
  } catch (err) {
    console.error('[qbo-disconnect] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
