# Charter shared inbox — Microsoft 365 setup

The **Shared Inbox** page gives approved `admin` and `sales` users an
Outlook-style workspace for `charters@flyskyway.com`: folders, search,
read/unread state, compose, reply/reply-all/forward, attachments, move, and
trip filing.

The mailbox remains in Microsoft 365. Skyway accesses it server-side through
Microsoft Graph; mailbox tokens and the client secret are never sent to a
browser.

## Separate mailbox app registration

Use a dedicated Entra application for mailbox automation. Do not add Mail
permissions to the Firebase login provider: employee sign-in and application
mailbox access have different privilege boundaries.

Required application capabilities:

- `Application Mail.ReadWrite`
- `Application Mail.Send`

Grant access only to `charters@flyskyway.com`. For new deployments, prefer
[Exchange Online Application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
over the legacy Application Access Policy mechanism.

Example Exchange Online PowerShell outline:

```powershell
New-ServicePrincipal -AppId <application-client-id> -ObjectId <enterprise-app-object-id>
New-ManagementScope -Name "Skyway Charter Mailbox" `
  -RecipientRestrictionFilter "EmailAddresses -eq 'charters@flyskyway.com'"
New-ManagementRoleAssignment -App <enterprise-app-object-id> `
  -Role "Application Mail.ReadWrite" -CustomResourceScope "Skyway Charter Mailbox"
New-ManagementRoleAssignment -App <enterprise-app-object-id> `
  -Role "Application Mail.Send" -CustomResourceScope "Skyway Charter Mailbox"
Test-ServicePrincipalAuthorization -Identity <enterprise-app-object-id> `
  -Resource charters@flyskyway.com
```

Use the **Enterprise application Object ID**, not the App Registration Object
ID. Entra-wide Mail application grants and Exchange RBAC grants are additive;
remove unscoped Entra Mail grants after the scoped RBAC assignment is working.

## Vercel environment variables

| Variable | Value |
| --- | --- |
| `MICROSOFT_MAIL_TENANT_ID` | Skyway Entra Directory (tenant) ID |
| `MICROSOFT_MAIL_CLIENT_ID` | Dedicated mailbox app Application (client) ID |
| `MICROSOFT_MAIL_CLIENT_SECRET` | Dedicated mailbox app secret Value |
| `CHARTER_MAILBOX_UPN` | `charters@flyskyway.com` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Existing Firebase Admin service account |

Set them for Production and redeploy. The Graph client uses the client-
credentials flow with `https://graph.microsoft.com/.default`.

## Trip filing

Filing an email writes a small audit record to:

- `charter-mail-links/{message-hash}`
- `charter-mail-conversations/{conversation-hash}`

The email body and attachments remain in Microsoft 365. Conversation filing
means later replies in the same Graph conversation also appear in the trip's
**Comms → Email** tab, preventing follow-up communication from becoming
detached from the trip.

Firestore access to both collections must be denied to normal clients; the
mail APIs use Firebase Admin after verifying an active admin or sales profile.

## Attachments and signatures

- New-message attachments use Graph inline file attachments and are limited in
  this UI to 2 MB each / 3 MB total.
- Inbound downloads are proxied through an authenticated API and capped at
  20 MB.
- Admin/sales users save a plain-text shared-inbox signature under My Profile.
  It is escaped and added server-side to new messages and replies.
- Remote images in received HTML are blocked in the reading pane to prevent
  tracking pixels. “Open in Outlook” displays the original when needed.

## Operational notes

- Graph folder listing is recursive and includes hidden folders.
- Message list pages use immutable Graph IDs and Graph-provided next links.
- Moving a message can change its Graph ID; Skyway migrates the trip filing.
- Search is scoped to the selected folder and subject/sender/body indexing in
  Microsoft 365.
- Application RBAC changes can take time to propagate. Use
  `Test-ServicePrincipalAuthorization` before troubleshooting the app.

Official references:

- [Microsoft identity client credentials](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow)
- [Graph mail folders](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders)
- [Graph list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages)
- [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail)
- [Graph Outlook immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)
