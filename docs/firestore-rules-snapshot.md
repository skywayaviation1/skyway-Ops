# Firestore rules snapshot — still needed

Phase 1 does not include a `firestore.rules` file.

The live rules for the named Firestore database `appusers` (Firebase project `skyway-ops-app`) are not in this repository. This environment cannot export them: there is no Firebase console session here, and the rules were never checked in. Do not invent a rules file. A guessed file would look like the real boundary and it is not.

## What to do

1. Open the Firebase console for project `skyway-ops-app`.
2. Go to Firestore, then select the named database `appusers` (not `(default)`).
3. Open the Rules tab and copy the rules that are actually published.
4. Save that text as `firestore.rules` at the root of this repo and commit it.

That file is a snapshot so the current boundary can be reviewed. It is not a deploy.

Do not click Publish in the Firebase console as part of this. Do not add a Firebase deploy step, a `firebase.json` rules target, or a CI job that ships rules. Applying rules to Firebase is a separate, explicit change.

Until that snapshot is committed, the gap in the multi-tenant plan still stands: the server uses the Admin SDK, which ignores rules, and the rules themselves are not reviewable from git.
