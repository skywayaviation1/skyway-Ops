# Microsoft Teams integration

The **Teams** tab gives every approved employee their own Microsoft Teams
channels and chats inside Skyway: read conversations, post messages, and jump
to the Teams client for anything richer.

Access is **delegated** — Skyway acts as the signed-in employee and can only
reach teams, channels and chats that person can already open in Teams. No
application-wide Teams permission is used, so Skyway can never read a
conversation the employee cannot.

## One Microsoft connection

Teams reuses the same delegated connection as personal work mail, on the same
Entra app registration as Microsoft sign-in (see
`docs/personal-work-mail-setup.md`). Employees connect Microsoft once and get
both mail and Teams.

## Entra app registration

On the existing Skyway login app registration, add these Microsoft Graph
**delegated** permissions alongside the mail permissions:

| Permission | Purpose |
| --- | --- |
| `Team.ReadBasic.All` | List the teams the employee belongs to |
| `Channel.ReadBasic.All` | List channels in those teams |
| `ChannelMessage.Read.All` | Read channel conversations |
| `ChannelMessage.Send` | Post a channel message as the employee |
| `Chat.ReadWrite` | List chats, read them, and send chat messages |
| `Files.ReadWrite.All` | Browse channel files and open them in Microsoft 365 for editing |

Grant tenant-wide admin consent. `ChannelMessage.Read.All` and
`Team.ReadBasic.All` require an administrator; users cannot consent themselves.

No new environment variables are needed. The client ID, tenant, redirect URI
and `MICROSOFT_USER_MAIL_CLIENT_SECRET` already in place for mail are reused.

## Employees must reconnect once

Consent is recorded per connection. Anyone who connected Microsoft before Teams
shipped has a mail-only token, so the Teams tab shows **Approve Teams access**
with a reconnect button. Reconnecting keeps the mailbox connected and adds
Teams.

Token refresh only requests scopes a connection already holds, so mail keeps
working for employees who have not reconnected yet.

## What the tab supports

- Joined teams and their channels
- Recent one-to-one and group chats
- Channel and chat message history, newest last
- Posting messages as the signed-in employee
- Threaded channel replies
- Teams-style Chat / Teams rail and channel Posts / Files tabs
- Channel file browsing, folders, attachment links and "Open in Teams" deep links
- Office files open in the employee's authenticated Microsoft 365 editor

Skyway posts plain text (escaped to HTML). Microsoft does not expose every
native Teams feature through Graph, and Teams/Office web editors deny
third-party iframe embedding. Calls, meetings, reactions and full-fidelity
Office editing therefore open through authenticated Microsoft deep links.
This preserves the real Teams/Office editor, coauthoring, version history and
compliance controls instead of pretending a custom editor is equivalent.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Approve Teams access" | Connection predates Teams scopes — reconnect once |
| "Connect Microsoft to use Teams" | Employee has never connected Microsoft |
| "Microsoft is not configured yet" | `MICROSOFT_USER_MAIL_CLIENT_SECRET` missing on the deployment |
| Empty team list | The account belongs to no teams, or admin consent is missing |

Official references:

- [Graph list joinedTeams](https://learn.microsoft.com/en-us/graph/api/user-list-joinedteams)
- [Graph list channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages)
- [Graph send chatMessage](https://learn.microsoft.com/en-us/graph/api/chatmessage-post)
- [Teams Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference#microsoft-teams-permissions)
