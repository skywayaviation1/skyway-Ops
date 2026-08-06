// Completes delegated OAuth and binds the Microsoft mailbox to the Firebase UID
// that initiated the connection.

import {
  userMailConfig,
  userMailboxRef,
} from './_user-mail.js';
import { mailDb } from './_charter-mail.js';

function appRedirect(success, message = '') {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.skyway.app';
  const params = new URLSearchParams({
    userMail: success ? 'connected' : 'error',
    msg: message,
    section: 'mailbox',
  });
  return `${appUrl}/?${params.toString()}#mailbox`;
}

function normalizedAddresses(user) {
  return [
    user?.mail,
    user?.userPrincipalName,
    ...(Array.isArray(user?.proxyAddresses) ? user.proxyAddresses : []),
  ].map((value) => String(value || '').replace(/^smtp:/i, '').trim().toLowerCase()).filter(Boolean);
}

export default async function handler(req, res) {
  let stateRef = null;
  try {
    const { code, state, error, error_description: description } = req.query;
    if (error) {
      res.redirect(302, appRedirect(false, description || error));
      return;
    }
    if (!code || !state) {
      res.redirect(302, appRedirect(false, 'Missing authorization code or state'));
      return;
    }
    stateRef = mailDb().collection('user-mail-oauth-state').doc(String(state));
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists || stateSnap.data().expiresAt < Date.now()) {
      if (stateSnap.exists) await stateRef.delete().catch(() => {});
      res.redirect(302, appRedirect(false, 'Mailbox connection expired — try again'));
      return;
    }
    const saved = stateSnap.data();
    const config = userMailConfig();
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
          code_verifier: saved.codeVerifier,
          scope: 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send',
        }).toString(),
      },
    );
    const token = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !token.access_token || !token.refresh_token) {
      console.error('[user-mail-oauth-callback] token failure', tokenResponse.status, token);
      res.redirect(302, appRedirect(false, `Microsoft token exchange failed (${token.error || tokenResponse.status})`));
      return;
    }
    const meResponse = await fetch(
      'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,proxyAddresses',
      { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } },
    );
    const me = await meResponse.json().catch(() => ({}));
    if (!meResponse.ok || !me.id) {
      res.redirect(302, appRedirect(false, 'Microsoft could not verify this mailbox'));
      return;
    }
    const expectedEmail = String(saved.expectedEmail || '').toLowerCase();
    const addresses = normalizedAddresses(me);
    if (!expectedEmail.endsWith('@flyskyway.com') || !addresses.includes(expectedEmail)) {
      res.redirect(302, appRedirect(false, `Connect the same Skyway mailbox as your signed-in account (${expectedEmail})`));
      return;
    }
    const now = Date.now();
    await userMailboxRef(saved.uid).set({
      graphUserId: me.id,
      displayName: me.displayName || expectedEmail,
      mail: me.mail || expectedEmail,
      userPrincipalName: me.userPrincipalName || expectedEmail,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: now + (Number(token.expires_in) || 3600) * 1000,
      scopes: String(token.scope || '').split(/\s+/).filter(Boolean),
      connectedAt: now,
      lastRefreshedAt: now,
    });
    await stateRef.delete();
    res.redirect(302, appRedirect(true, me.mail || me.userPrincipalName || expectedEmail));
  } catch (err) {
    console.error('[user-mail-oauth-callback]', err);
    if (stateRef) await stateRef.delete().catch(() => {});
    res.redirect(302, appRedirect(false, err.message || 'Mailbox connection failed'));
  }
}
