// Disconnects only Skyway's stored delegated mailbox tokens. Microsoft does
// not expose narrow revocation of one refresh token without broader effects.

import {
  authorizeApprovedUser,
  userMailboxRef,
} from './_user-mail.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const caller = await authorizeApprovedUser(req.body?.idToken);
    await userMailboxRef(caller.uid).delete();
    res.status(200).json({
      ok: true,
      message: 'Work mailbox disconnected from Skyway. Microsoft consent remains managed by your company administrator.',
    });
  } catch (err) {
    console.error('[user-mail-disconnect]', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not disconnect mailbox' });
  }
}
