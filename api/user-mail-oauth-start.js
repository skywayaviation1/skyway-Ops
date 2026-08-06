// Begins delegated OAuth for an approved employee's own Microsoft mailbox.

import crypto from 'crypto';
import {
  authorizeApprovedUser,
  userMailConfig,
} from './_user-mail.js';
import { mailDb } from './_charter-mail.js';

const SCOPES = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const caller = await authorizeApprovedUser(req.body?.idToken);
    const config = userMailConfig();
    const state = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    await mailDb().collection('user-mail-oauth-state').doc(state).set({
      uid: caller.uid,
      expectedEmail: caller.email,
      codeVerifier,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      response_mode: 'query',
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      login_hint: caller.email,
      domain_hint: 'flyskyway.com',
      prompt: 'select_account',
    });
    res.status(200).json({
      authUrl: `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/authorize?${params.toString()}`,
    });
  } catch (err) {
    console.error('[user-mail-oauth-start]', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not start mailbox connection' });
  }
}
