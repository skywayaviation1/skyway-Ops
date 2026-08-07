import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DELEGATED_SCOPES } from '../api/_user-mail.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('personal mailbox OAuth uses confidential auth code flow with PKCE', async () => {
  const start = await source('api/user-mail-oauth-start.js');
  const callback = await source('api/user-mail-oauth-callback.js');
  assert.match(start, /code_challenge_method: 'S256'/);
  assert.match(start, /codeVerifier/);
  // Authorization and redemption share one scope list so consent cannot drift.
  assert.match(start, /const SCOPES = DELEGATED_SCOPES/);
  assert.match(callback, /scope: DELEGATED_SCOPES/);
  for (const scope of ['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send']) {
    assert.ok(DELEGATED_SCOPES.includes(scope), `missing scope ${scope}`);
  }
  assert.match(callback, /grant_type: 'authorization_code'/);
  assert.match(callback, /client_secret: config\.clientSecret/);
  assert.match(callback, /code_verifier: saved\.codeVerifier/);
});

test('connected mailbox must equal the signed-in company email', async () => {
  const callback = await source('api/user-mail-oauth-callback.js');
  assert.match(callback, /expectedEmail\.endsWith\('@flyskyway\.com'\)/);
  assert.match(callback, /addresses\.includes\(expectedEmail\)/);
  assert.match(callback, /Connect the same Skyway mailbox as your signed-in account/);
});

test('personal mailbox accepts every approved active company role', async () => {
  const helper = await source('api/_user-mail.js');
  assert.match(helper, /profile\.active === false \|\| profile\.approved !== true/);
  assert.match(helper, /email\.endsWith\('@flyskyway\.com'\)/);
  assert.doesNotMatch(helper, /roles\.includes/);
});

test('delegated tokens rotate server-side and never enter client source', async () => {
  const helper = await source('api/_user-mail.js');
  const client = [
    await source('src/UserMailbox.jsx'),
    await source('src/firebase-user-mail.js'),
    await source('src/CharterInbox.jsx'),
  ].join('\n');
  assert.match(helper, /refreshToken: data\.refresh_token \|\| connection\.refreshToken/);
  assert.match(helper, /grant_type: 'refresh_token'/);
  assert.doesNotMatch(client, /MICROSOFT_USER_MAIL_CLIENT_SECRET/);
  assert.doesNotMatch(client, /refreshToken|accessToken/);
});

test('personal Graph access is scoped to the delegated user and has no trip filing', async () => {
  const helper = await source('api/_user-mail.js');
  const route = await source('api/user-mail.js');
  assert.match(helper, /'\/v1\.0\/me'/);
  assert.match(route, /'\/me\/sendMail'/);
  assert.doesNotMatch(route, /fileTrip|tripMessages|charter-mail-links|charter-mail-conversations/);
});

test('navigation gives all roles personal mail but preserves shared-mail restriction', async () => {
  const app = await source('src/App.jsx');
  assert.match(
    app,
    /id: 'mailbox'.*roles: \['crew', 'sales', 'ops', 'maint', 'accounting', 'admin'\]/,
  );
  assert.match(app, /id: 'inbox'.*roles: \['sales', 'admin'\]/);
  assert.match(app, /id: 'email'.*label: 'Email'.*children: \['mailbox', 'inbox'\]/);
  assert.match(app, /id: 'comms'.*children: \['comms'\]/);
  assert.doesNotMatch(app, /children: \['comms', 'mailbox', 'inbox'\]/);
});

test('settings and profile expose mailbox connection controls', async () => {
  const panel = await source('src/MailboxSettingsPanel.jsx');
  const app = await source('src/App.jsx');
  const settings = await source('src/AdminSettings.jsx');
  assert.match(panel, /Continue with Microsoft/);
  assert.match(panel, /there is nothing you need to enter/);
  assert.match(panel, /Shared charter inbox/);
  assert.match(panel, /MICROSOFT_MAIL_/);
  assert.match(app, /MailboxSettingsPanelLazy/);
  assert.match(app, /placement="profile"/);
  assert.match(app, /placement="advanced"/);
  assert.match(settings, /MailboxSettingsPanel/);
  assert.match(settings, /placement="settings"/);
});

test('personal status reports whether server mail integration is configured', async () => {
  const helper = await source('api/_user-mail.js');
  assert.match(helper, /export function isUserMailConfigured/);
  assert.match(helper, /configured,/);
  assert.match(helper, /setupHint/);
});

test('personal mail reuses the existing Microsoft login registration', async () => {
  const helper = await source('api/_user-mail.js');
  const docs = await source('docs/personal-work-mail-setup.md');
  assert.match(helper, /SKYWAY_SSO_CLIENT_ID = '6e65ee4c-d6b7-4a1b-9dfe-0056be0946d1'/);
  assert.match(helper, /SKYWAY_TENANT_ID = 'aef6138f-7c46-448a-95fe-dda7a700b80f'/);
  assert.match(helper, /MICROSOFT_SSO_CLIENT_SECRET/);
  assert.match(helper, /api\/user-mail-oauth-callback/);
  assert.match(helper, /\.trim\(\)\.replace/);
  assert.match(docs, /do not create a second registration/i);
});

test('invalid_client token failures explain the secret Value mistake', async () => {
  const callback = await source('api/user-mail-oauth-callback.js');
  assert.match(callback, /token\.error === 'invalid_client'/);
  assert.match(callback, /copy the Value \(not Secret ID\)/);
  assert.match(callback, /MICROSOFT_USER_MAIL_CLIENT_SECRET/);
});

test('OAuth state expires and callback consumes it', async () => {
  const start = await source('api/user-mail-oauth-start.js');
  const callback = await source('api/user-mail-oauth-callback.js');
  assert.match(start, /expiresAt: Date\.now\(\) \+ 10 \* 60 \* 1000/);
  assert.match(callback, /stateSnap\.data\(\)\.expiresAt < Date\.now\(\)/);
  assert.match(callback, /await stateRef\.delete\(\)/);
});
