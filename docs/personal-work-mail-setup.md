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

This integration is separate from:

1. the Firebase Microsoft SSO app (`docs/microsoft-sso-setup.md`), and
2. the app-only `charters@` shared mailbox (`docs/charter-shared-inbox-setup.md`).

Keeping separate app registrations limits blast radius and allows independent
secret rotation.

## Entra app registration

Create a single-tenant app registration with a **Web** redirect URI:

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
| `MICROSOFT_USER_MAIL_TENANT_ID` | Skyway Entra Directory tenant ID |
| `MICROSOFT_USER_MAIL_CLIENT_ID` | Delegated mailbox app client ID |
| `MICROSOFT_USER_MAIL_CLIENT_SECRET` | Delegated mailbox app secret Value |
| `MICROSOFT_USER_MAIL_REDIRECT_URI` | `https://www.skyway.app/api/user-mail-oauth-callback` |
| `NEXT_PUBLIC_APP_URL` | `https://www.skyway.app` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Firebase Admin service account |

`MICROSOFT_USER_MAIL_TENANT_ID` falls back to
`MICROSOFT_MAIL_TENANT_ID` when omitted, but setting it explicitly makes the
registration boundary clear.

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
