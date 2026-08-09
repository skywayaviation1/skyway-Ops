import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  messagePreview,
  normalizeChat,
  normalizeDriveItem,
  normalizeTeamsMessage,
  outgoingMessageBody,
  safeGraphId,
} from '../api/_teams.js';
import {
  DELEGATED_SCOPES,
  grantedScopeNames,
  hasTeamsScopes,
} from '../api/_user-mail.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('delegated consent covers mail and Teams in one authorization', () => {
  for (const scope of [
    'Mail.ReadWrite', 'Mail.Send', 'offline_access',
    'Team.ReadBasic.All', 'Channel.ReadBasic.All',
    'ChannelMessage.Read.All', 'ChannelMessage.Send', 'Chat.ReadWrite',
    'Files.ReadWrite.All',
  ]) {
    assert.ok(DELEGATED_SCOPES.includes(scope), `missing scope ${scope}`);
  }
});

test('Teams readiness is detected from granted scopes', () => {
  const mailOnly = { scopes: ['https://graph.microsoft.com/Mail.ReadWrite'] };
  const withTeams = {
    scopes: [
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Team.ReadBasic.All',
      'https://graph.microsoft.com/Chat.ReadWrite',
      'https://graph.microsoft.com/Files.ReadWrite.All',
    ],
  };
  assert.equal(hasTeamsScopes(mailOnly), false);
  assert.equal(hasTeamsScopes(withTeams), true);
  assert.deepEqual(grantedScopeNames(mailOnly), ['Mail.ReadWrite']);
});

test('token refresh only asks for scopes the connection already holds', async () => {
  const helper = await source('api/_user-mail.js');
  assert.match(helper, /function refreshScope/);
  assert.match(helper, /scope: refreshScope\(connection\)/);
});

test('chat titles fall back to the other participants', () => {
  const chat = normalizeChat({
    id: '19:abc',
    chatType: 'oneOnOne',
    members: [
      { userId: 'self-id', displayName: 'Me' },
      { userId: 'other-id', displayName: 'Jake Skyway' },
    ],
  }, ['self-id']);
  assert.equal(chat.name, 'Jake Skyway');
  const named = normalizeChat({ id: '19:x', topic: 'Dispatch', members: [] }, []);
  assert.equal(named.name, 'Dispatch');
});

test('Teams messages normalize sender, body and attachments', () => {
  const message = normalizeTeamsMessage({
    id: '1',
    createdDateTime: '2026-08-07T12:00:00Z',
    from: { user: { id: 'u1', displayName: 'Ops' } },
    body: { contentType: 'html', content: '<p>Wheels up <b>1400</b></p>' },
    attachments: [{ id: 'a1', name: 'brief.pdf', contentUrl: 'https://example.com/brief.pdf' }],
  });
  assert.equal(message.from.name, 'Ops');
  assert.equal(message.preview, 'Wheels up 1400');
  assert.equal(message.attachments[0].name, 'brief.pdf');
});

test('channel files normalize for browsing and Microsoft 365 editing', () => {
  const file = normalizeDriveItem({
    id: 'f1',
    name: 'Trip brief.docx',
    size: 1234,
    file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    webUrl: 'https://tenant.sharepoint.com/brief.docx',
    parentReference: { driveId: 'drive-1' },
    lastModifiedBy: { user: { displayName: 'Dispatch' } },
  });
  assert.equal(file.driveId, 'drive-1');
  assert.equal(file.isFolder, false);
  assert.match(file.webUrl, /sharepoint/);
  const folder = normalizeDriveItem({ id: 'd1', name: 'Briefs', folder: { childCount: 3 } });
  assert.equal(folder.isFolder, true);
  assert.equal(folder.childCount, 3);
});

test('message preview strips markup and entities', () => {
  assert.equal(messagePreview('<div>A &amp; B</div>'), 'A & B');
});

test('outgoing messages are escaped and require text', () => {
  const body = outgoingMessageBody('Hi <script>alert(1)</script>\nline two');
  assert.equal(body.contentType, 'html');
  assert.ok(!body.content.includes('<script>'));
  assert.ok(body.content.includes('&lt;script&gt;'));
  assert.ok(body.content.includes('<br>'));
  assert.throws(() => outgoingMessageBody('   '), /Message text is required/);
});

test('graph ids are validated', () => {
  assert.equal(safeGraphId('19:abc@thread.tacv2'), '19:abc@thread.tacv2');
  assert.throws(() => safeGraphId(''), /Invalid ID/);
  assert.throws(() => safeGraphId('bad\nid'), /Invalid ID/);
});

test('Teams Graph calls are restricted to Teams resources', async () => {
  const helper = await source('api/_teams.js');
  assert.match(helper, /'\/v1\.0\/me\/joinedTeams'/);
  assert.match(helper, /'\/v1\.0\/teams\/'/);
  assert.match(helper, /'\/v1\.0\/chats\/'/);
  assert.match(helper, /'\/v1\.0\/drives\/'/);
  assert.match(helper, /allowPrefixes: TEAMS_PREFIXES/);
  const mail = await source('api/_user-mail.js');
  assert.match(mail, /validateGraphUrl\(pathOrUrl, connection, allowPrefixes = \[\]\)/);
});

test('Teams API requires consent and exposes conversation actions', async () => {
  const handler = await source('api/teams.js');
  assert.match(handler, /requireTeamsConsent\(connection\)/);
  for (const action of [
    'overview', 'channels', 'channelMessages', 'chatMessages',
    'channelFiles', 'driveChildren', 'sendChannelMessage',
    'sendChannelReply', 'sendChatMessage',
  ]) {
    assert.match(handler, new RegExp(`action === '${action}'`));
  }
});

test('Teams has its own navigation tab for every role', async () => {
  const app = await source('src/App.jsx');
  assert.match(
    app,
    /id: 'teams'.*roles: \['crew', 'sales', 'ops', 'maint', 'accounting', 'admin'\]/,
  );
  assert.match(app, /id: 'teams'.*label: 'Teams'.*children: \['teams'\]/);
  assert.match(app, /section === 'teams'/);
  assert.match(app, /TeamsHubLazy/);
});

test('Teams tab guides connection and Teams consent separately', async () => {
  const hub = await source('src/TeamsHub.jsx');
  assert.match(hub, /Connect Microsoft to use Teams/);
  assert.match(hub, /Approve Teams access/);
  assert.match(hub, /Open in Teams/);
  assert.match(hub, /Posts/);
  assert.match(hub, /Files/);
  assert.match(hub, /Open \/ edit/);
  assert.match(hub, /DOMPurify\.sanitize/);
  assert.doesNotMatch(hub, /MICROSOFT_USER_MAIL_CLIENT_SECRET/);
});
