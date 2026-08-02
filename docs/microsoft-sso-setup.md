# Microsoft company sign-in setup

The application code only accepts Microsoft identities whose verified email
ends exactly in `@flyskyway.com`. New identities receive a `crew` profile with
`approved: false`; an existing Skyway administrator must approve access.

Complete these deployment settings before releasing this change:

1. In Microsoft Entra ID, create a **single-tenant** web application.
2. Add the Firebase OAuth callback URL shown by Firebase Authentication.
3. In Firebase Authentication → Sign-in method, enable Microsoft with the
   Entra application ID and client secret.
4. Disable Email/Password sign-in after confirming existing users can use
   their matching Microsoft company accounts.
5. Set `VITE_MICROSOFT_TENANT_ID` in Vercel to the Entra Directory (tenant) ID.
6. Confirm `FIREBASE_SERVICE_ACCOUNT_JSON` is available to
   `/api/auth-profile-bootstrap`.
7. Update the deployed Firestore rules for the named `appusers` database:
   - deny client creation of `/users/{uid}` profiles;
   - prevent users from changing their own `role`, `approved`, `active`,
     `email`, or `authProvider`;
   - require approved/active profiles for operational collections.

The React domain check improves UX, but it is not the security boundary.
The bootstrap endpoint verifies the signed Firebase token and provider before
creating a least-privilege profile. Disabling password auth and enforcing
Firestore rules closes direct-client paths that do not pass through React.

## Existing users

Microsoft must return the same email address already stored in
`users/{uid}.email`. If Firebase reports
`auth/account-exists-with-different-credential`, link or migrate that user in
Firebase Authentication rather than creating a duplicate operational profile.
