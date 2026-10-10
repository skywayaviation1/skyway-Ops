# App Store review sign-in

Apple reviewers cannot use Microsoft Entra. Skyway Ops keeps a single hidden
email/password account, `appreview@flyskyway.com`, that lands in a separate
Firestore database named `appreview`. That database holds fictional trips,
crew, passengers, duty, and a tracking link. It is not the company database.

The password is never stored in this repository.

## How a reviewer opens the form

The login screen is unchanged for company users: one **Continue with Microsoft**
button. At the very bottom of that screen there is a small text link,
**Reviewer sign-in**. Tapping it shows an email and password form. The same
control is in the Capacitor iOS build because the form uses the Firebase
JavaScript SDK inside the WebView, and the native Firebase Authentication
plugin is configured with the password provider as well.

## Credentials

The account email is `appreview@flyskyway.com`.

The password lives only in App Store Connect, under the version's
**Sign-in required** fields, and in the terminal output of the create script
the one time it generates a password. To create the account or rotate the
password:

```bash
export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
# Optional. At least 12 characters. Omit it to generate one and print it once.
export REVIEWER_ACCOUNT_PASSWORD='choose-a-long-password'
npm run reviewer:create
```

`npm run reviewer:create` runs `scripts/create-reviewer-account.mjs`. It
creates or updates that one Auth user, sets the custom claim `appReviewer:
true`, and loads the sandbox. When `REVIEWER_ACCOUNT_PASSWORD` is omitted, the
generated password is printed to stdout and is not written to a file.

Reset the fictional operating day without rotating the password:

```bash
export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
npm run reviewer:reset
```

That runs `scripts/seed-reviewer-demo.mjs`. It deletes and rewrites documents
only in the `appreview` database.

## Firebase console steps

1. Authentication → Sign-in method → keep **Email/Password** enabled next to
   Microsoft. Existing password accounts, including `developer@flyskyway.com`,
   stay as they are. The reviewer form itself submits only
   `appreview@flyskyway.com`.
2. Create the named Firestore database `appreview` in `skyway-ops-app`, in
   the same region as `appusers`.
3. Deploy `firebase/appreview.rules` to that database only:

   ```bash
   npx firebase-tools deploy --only firestore --project skyway-ops-app
   ```

   `firebase.json` points Firestore deploy at `appreview` and leaves the
   `appusers` rules untouched.
4. Production `appusers` and Storage rules are already updated separately.
   `isSignedIn()` admits every other signed-in account and excludes only the
   reviewer identity: the `appReviewer` custom claim, or the email
   `appreview@flyskyway.com`.
5. Run `npm run reviewer:create` with the service account. Copy the password
   from the terminal into App Store Connect. Do not commit it.

## What the sandbox can and cannot do

The reviewer reads and writes only the `appreview` database. Firestore rules
on that database allow the one password account with the `appReviewer` claim
and the email `appreview@flyskyway.com`, and deny every other identity.
Production `appusers` and Storage rules exclude that same reviewer identity
from `isSignedIn()`.

The client drops company API calls while the sandbox flag is set. Every
`verifyIdToken` check in `api/` rejects a token when `appReviewer` is true or
the email is `appreview@flyskyway.com`. Other sessions, including existing
password accounts, keep the checks they already had. Email, push, Stream
Chat, QuickBooks, FlightAware, broker, and maintenance side effects do not
run for the reviewer. Stream Chat is not connected.
Mailbox previews stay empty. Share-with-broker and ETA email buttons are not
shown. A **Demo tracking** link opens `/trip-track?token=demo-sandbox`, which
renders a fixed fictional flight and does not read company trips.

The banner switches between the operations board and the crew home. Crew home
includes duty for the sandbox account. Manifests, schedule, and tracking use
the seeded demo tails `N551SK` and `N882SK`. N551SK is airborne from PBI to
TEB with a static track. N882SK is parked at TEB. The sandbox does not call
FlightAware, so those positions never wait on a live poll.

Settings on this account explains that Skyway provisions accounts and that
this demo sign-in cannot delete a company account.

## Review notes to paste into App Store Connect

```
Sign-in is required. Company employees use Microsoft, which is not available
to App Review. A sandbox account is provided instead.

On the login screen, scroll to the bottom and tap "Reviewer sign-in".
Sign in with the email and password in the Sign-in required fields
(appreview@flyskyway.com).

This account is a demo. It cannot see Skyway trips, crew, passengers,
billing, or messages, and it cannot send email, SMS, or charges. The
operations board, crew home, duty, manifests, trip details, and the demo
tracking link are populated with fictional data.

Account deletion is not available in the app. Skyway Ops accounts are
provisioned by the employer (Microsoft for employees, this sandbox
account for App Review). The app does not let a user create an account.
Skyway deletes an employee account when that person leaves the company.
This follows App Store guideline 5.1.1(v) for employer-provisioned accounts.
```
