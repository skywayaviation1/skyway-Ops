# Super admin, navigation access, and audit

## Owner

`jake@flyskyway.com` is the permanent super owner. Override or add owner
addresses with server-only `SUPER_OWNER_EMAILS`.

- Jake always receives the Super admin navigation item.
- Only Jake can grant or revoke `users/{uid}.superAdmin`.
- Other super admins can publish navigation grouping and role visibility.
- Only Jake can query the all-user audit trail.

## Navigation policy

The first load uses the role arrays and groups shipped in `NAV_SECTIONS` and
`NAV_GROUPS`, so access is unchanged until a super admin publishes a policy.
The published policy lives in `app-config/navigation`.

Super admins can:

- move each tab to another top-level navigation group;
- change its label;
- enable or disable visibility for crew, sales, ops, maintenance, accounting,
  and admin users.

Unknown or newly shipped items fall back to code defaults. The Super admin item
cannot be removed by a published policy.

## Audit trail

`AppAuditTracker` records authenticated button actions and form submissions
from every app section without collecting input values. Events are written by
`POST /api/audit-events` to `audit-events`.

Each event contains:

- timestamp and app section;
- actor UID, name, email, role, and super-admin status;
- action type and a short control/task label;
- optional target type and ID.

The audit query API calls `authorizeJake`, so even another super admin cannot
read the all-user audit. Firestore rules should deny client reads and writes to
`audit-events`; all access should stay behind the server API.

