# Personal Microsoft work mailboxes

Every approved Skyway user can connect their own `@flyskyway.com` Microsoft
mailbox under **Profile → My work mailbox**, **Organization settings →
Mailboxes** (admins), **Advanced tools**, or **Comms → My mailbox**. This is
delegated access: the employee explicitly consents, and Skyway can access only
the mailbox represented by that employee's token.

## Employee experience

The Entra and deployment configuration below is completed once by an
administrator, not by each employee. After it is enabled, an employee only
selects **Continue with Microsoft**, signs in with the same company account
used for Skyway, and accepts the mailbox permission prompt. Employees never
enter a tenant ID, client ID, client secret, redirect URI, or mailbox password.

Personal mailbox consent reuses the existing Firebase Microsoft SSO Entra app.
It remains separate from the app-only `charters@` shared mailbox
(`docs/charter-shared-inbox-setup.md`), because the shared mailbox needs
unattended application permissions.

## Entra app registration

Open the existing Skyway Microsoft login app registration:

- Application (client) ID: `6e65ee4c-d6b7-4a1b-9dfe-0056be0946d1`
- Directory (tenant) ID: `aef6138f-7c46-448a-95fe-dda7a700b80f`

Keep its existing Firebase callback and add this additional **Web** redirect
URI:

`https://www.skyway.app/api/user-mail-oauth-callback`

Add Microsoft Graph **delegated** permissions:

- `User.Read`
- `Mail.ReadWrite`
- `Mail.Send`
- `offline_access`
- `openid`, `profile`, `email`

Grant tenant-wide admin consent so users are not individually blocked by the
tenant's user-consent policy. Do not add Graph **application** Mail permissions
to this app.

The app uses the confidential authorization-code flow with PKCE. The browser
is redirected to Microsoft, but the Vercel callback redeems the code with the
client secret and PKCE verifier.

## Vercel environment variables

| Variable | Value |
| --- | --- |
| `MICROSOFT_USER_MAIL_CLIENT_SECRET` | Existing Microsoft login app secret **Value** (required) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Firebase Admin service account |

The production tenant ID, client ID, app origin, and callback are already the
defaults in the server. The corresponding
`MICROSOFT_USER_MAIL_TENANT_ID`, `MICROSOFT_USER_MAIL_CLIENT_ID`,
`NEXT_PUBLIC_APP_URL`, and `MICROSOFT_USER_MAIL_REDIRECT_URI` variables remain
optional overrides for future rotation or a non-production deployment.

Firebase already uses this same secret for Microsoft login, but Firebase does
not expose it to application code. Copy the same secret **Value** into Vercel
as `MICROSOFT_USER_MAIL_CLIENT_SECRET`; do not create a second registration.

## Identity binding

The OAuth start state stores the Firebase UID and expected company email for
ten minutes. On callback Skyway:

1. validates the state and PKCE verifier,
2. exchanges the code server-side,
3. calls Graph `/me`,
4. requires the connected Graph `mail`, UPN, or SMTP proxy address to equal the
   signed-in Firebase profile email, and
5. requires `@flyskyway.com`.

A user cannot connect someone else's mailbox to their Skyway account.

## Token storage and disconnect

Delegated tokens are stored under `user-mailboxes/{firebaseUid}` in the named
`appusers` database. Client Firestore access to this collection and
`user-mail-oauth-state` must be denied; all access goes through authenticated
server APIs.

Refresh tokens rotate and are replaced immediately after refresh. Disconnect
deletes Skyway's stored tokens. Microsoft does not provide a narrow endpoint
to revoke only one refresh token without affecting broader user sessions;
tenant consent remains controlled in Entra.

## Available features

- complete recursive folder tree
- unread counts and folder search
- message reading with remote tracking pixels blocked
- compose, send, reply, reply-all, and forward
- move and create folders
- inbound/outbound attachments within app limits
- per-user email signatures

Personal mail is private to the connected Firebase UID. It is not filed to
trips. Formal charter communication that must become part of a trip record
should use the admin/sales **Shared Inbox**.

Official references:

- [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
- [Microsoft Graph delegated authentication](https://learn.microsoft.com/en-us/graph/auth-v2-user)
- [Graph Mail permissions](https://learn.microsoft.com/en-us/graph/permissions-reference#mail-permissions)
