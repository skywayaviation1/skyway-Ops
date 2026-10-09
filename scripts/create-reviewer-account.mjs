// Create or rotate the single App Review Firebase Auth user.
//
// Required for a real project:
//   FIREBASE_SERVICE_ACCOUNT_JSON   service account for skyway-ops-app
//
// Optional:
//   REVIEWER_ACCOUNT_PASSWORD       at least 12 characters. When omitted, a
//                                   password is generated and printed once
//                                   to this process's stdout. It is not written
//                                   to a file.
//
//   node scripts/create-reviewer-account.mjs
//
// The Email/Password provider must be enabled in Firebase Authentication
// before the account can sign in. This script also refreshes the sandbox
// documents in the named `appreview` database.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';
import { APP_REVIEWER_EMAIL, APP_REVIEWER_CLAIM } from '../src/reviewer-account.js';
import { initReviewerAdmin } from './lib/reviewer-admin.mjs';

const MIN_PASSWORD = 12;

function resolvePassword() {
  const fromEnv = String(process.env.REVIEWER_ACCOUNT_PASSWORD || '');
  if (!fromEnv) {
    return { password: crypto.randomBytes(18).toString('base64url'), generated: true };
  }
  if (fromEnv.length < MIN_PASSWORD) {
    throw new Error(`REVIEWER_ACCOUNT_PASSWORD must be at least ${MIN_PASSWORD} characters`);
  }
  return { password: fromEnv, generated: false };
}

function seedAfterCreate() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-reviewer-demo.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sandbox seed exited ${code}`));
    });
  });
}

async function main() {
  const { password, generated } = resolvePassword();
  const app = initReviewerAdmin();
  const auth = admin.auth(app);

  let user;
  let action = 'updated';
  try {
    user = await auth.getUserByEmail(APP_REVIEWER_EMAIL);
    await auth.updateUser(user.uid, {
      password,
      emailVerified: true,
      disabled: false,
      displayName: 'App Review',
    });
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') throw err;
    action = 'created';
    user = await auth.createUser({
      email: APP_REVIEWER_EMAIL,
      password,
      emailVerified: true,
      displayName: 'App Review',
    });
  }

  await auth.setCustomUserClaims(user.uid, { [APP_REVIEWER_CLAIM]: true });

  console.log(`[reviewer-account] ${action} ${APP_REVIEWER_EMAIL} (${user.uid})`);
  console.log('[reviewer-account] custom claim appReviewer=true');
  if (generated) {
    console.log('[reviewer-account] password generated for this run. Copy it into App Store Connect. It is not stored in the repo.');
    console.log(password);
  } else {
    console.log('[reviewer-account] password taken from REVIEWER_ACCOUNT_PASSWORD and was not printed.');
  }

  await seedAfterCreate();
}

main().catch((err) => {
  console.error('[reviewer-account]', err?.message || err);
  process.exit(1);
});
