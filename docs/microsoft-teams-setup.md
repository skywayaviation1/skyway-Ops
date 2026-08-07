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
- Attachment links and "Open in Teams" deep links

Skyway posts plain text (escaped to HTML). Rich composition, reactions, calls
and meetings stay in the Teams client, which the deep links open directly.

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
