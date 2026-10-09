import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  APP_REVIEWER_EMAIL,
  classifyAuthToken,
  isActivatedReviewerSession,
  passwordSignInAllowed,
  reviewerSessionBlock,
} from '../src/reviewer-account.js';
import { buildReviewerDemo, DEMO_TAILS } from '../src/reviewer-demo-data.js';
import { demoFlightDetail, demoPositionsMap, demoTrackPoints, demoTrackingResponse, isDemoTrackingToken } from '../src/reviewer-demo-track.js';
import {
  isCompanyApiRequest,
  isDemoTrackingRequest,
} from '../src/reviewer-sandbox.js';

const root = path.resolve(import.meta.dirname, '..');

test('password sign-in allows only the reviewer address', () => {
  assert.equal(passwordSignInAllowed(APP_REVIEWER_EMAIL), true);
  assert.equal(passwordSignInAllowed(' AppReview@FlySkyway.com '), true);
  assert.equal(passwordSignInAllowed('pilot@flyskyway.com'), false);
  assert.equal(passwordSignInAllowed('appreview@gmail.com'), false);
  assert.equal(passwordSignInAllowed(''), false);
});

test('company tokens pass and every password token is blocked', () => {
  assert.equal(classifyAuthToken({
    email: 'pilot@flyskyway.com',
    firebase: { sign_in_provider: 'microsoft.com' },
  }).block, false);

  const otherPassword = classifyAuthToken({
    email: 'pilot@flyskyway.com',
    firebase: { sign_in_provider: 'password' },
  });
  assert.equal(otherPassword.block, true);
  assert.equal(otherPassword.code, 'password-provider-blocked');

  const reviewer = classifyAuthToken({
    email: APP_REVIEWER_EMAIL,
    appReviewer: true,
    firebase: { sign_in_provider: 'password' },
  });
  assert.equal(reviewer.block, true);
  assert.equal(reviewer.reviewer, true);
  assert.equal(reviewer.code, 'app-reviewer-sandbox');

  assert.throws(
    () => reviewerSessionBlock({
      email: 'pilot@flyskyway.com',
      firebase: { sign_in_provider: 'password' },
    }),
    /not available/,
  );

  const microsoft = { email: 'pilot@flyskyway.com', firebase: { sign_in_provider: 'microsoft.com' } };
  assert.equal(reviewerSessionBlock(microsoft), microsoft);
});

test('activation requires the claim, the email, and the password provider', () => {
  assert.equal(isActivatedReviewerSession({
    email: APP_REVIEWER_EMAIL,
    claims: { appReviewer: true, email: APP_REVIEWER_EMAIL },
    signInProvider: 'password',
  }), true);
  assert.equal(isActivatedReviewerSession({
    email: APP_REVIEWER_EMAIL,
    claims: { email: APP_REVIEWER_EMAIL },
    signInProvider: 'password',
  }), false);
  assert.equal(isActivatedReviewerSession({
    email: 'pilot@flyskyway.com',
    claims: { appReviewer: true },
    signInProvider: 'password',
  }), false);
  assert.equal(isActivatedReviewerSession({
    email: APP_REVIEWER_EMAIL,
    claims: { appReviewer: true },
    signInProvider: 'microsoft.com',
  }), false);
});

test('demo data stays fictional and covers the main screens', () => {
  const now = Date.parse('2026-10-09T15:00:00Z');
  const demo = buildReviewerDemo(now, 'reviewer-uid');
  assert.equal(demo.reviewerProfile.email, APP_REVIEWER_EMAIL);
  assert.equal(demo.reviewerProfile.role, 'ops');
  assert.equal(demo.reviewerProfile.appReviewer, true);
  assert.ok(demo.trips.length >= 4);
  assert.ok(demo.trips.some((t) => new Date(t.end).getTime() < now));
  assert.ok(demo.trips.some((t) => new Date(t.start).getTime() > now));
  assert.ok(demo.trips.some((t) => t.uid === 'demo-active' && new Date(t.start).getTime() < now && new Date(t.end).getTime() > now));
  for (const trip of demo.trips) {
    assert.ok(DEMO_TAILS.includes(trip.info.tail));
    assert.equal(trip.info.demoTrackingUrl, '/trip-track?token=demo-sandbox');
    assert.doesNotMatch(trip.info.broker || '', /flyskyway\.com/);
  }
  assert.equal(demo.duty.filter((d) => d.pilotUid === 'reviewer-uid').length, 2);
  assert.ok(demo.duty.some((d) => d.status === 'on'));
  assert.equal(demo.manifests.length, 1);
  assert.ok(demo.manifests[0].legs[0].passengers.length >= 2);
  assert.deepEqual(demo.fleet.managedTails, [...DEMO_TAILS]);
  const airborne = demo.positions.find((p) => p.id === 'N551SK');
  const parked = demo.positions.find((p) => p.id === 'N882SK');
  assert.equal(airborne.airborne, true);
  assert.equal(parked.airborne, false);
  assert.ok(Number.isFinite(parked.groundedLat));
  const map = demoPositionsMap(now);
  assert.equal(map.N551SK.airborne, true);
  assert.equal(map.N882SK.airborne, false);
  assert.ok(demoTrackPoints('N551SK', now).length >= 2);
  assert.equal(demoTrackPoints('N882SK', now).length, 0);
  assert.equal(demoFlightDetail('N551SK', now).destination.code, 'KTEB');
  assert.ok(demoFlightDetail('N882SK', now).actualOn);
});

test('demo tracking token never looks like a company trip token', () => {
  assert.equal(isDemoTrackingToken('demo-sandbox'), true);
  assert.equal(isDemoTrackingToken('real-hmac'), false);
  const payload = demoTrackingResponse();
  assert.equal(payload.ok, true);
  assert.equal(payload.trip.tail, 'N551SK');
  assert.equal(payload.trip.legs[0].showPax, false);
  assert.equal(payload.position.airborne, true);
});

test('sandbox network gate blocks company APIs and allows the demo track', () => {
  assert.equal(isCompanyApiRequest('/api/send-email'), true);
  assert.equal(isCompanyApiRequest('https://www.skyway.app/api/send-push'), true);
  assert.equal(isCompanyApiRequest('/schedule'), false);
  assert.equal(isDemoTrackingRequest('/api/trip-public?token=demo-sandbox'), true);
  assert.equal(isDemoTrackingRequest('/api/trip-public?token=other'), false);
  assert.equal(isDemoTrackingRequest('/api/send-email'), false);
});

test('every verifyIdToken call is wrapped and the client blocks the company feed', async () => {
  const apiDir = path.join(root, 'api');
  const files = (await readdir(apiDir)).filter((name) => name.endsWith('.js'));
  for (const name of files) {
    const source = await readFile(path.join(apiDir, name), 'utf8');
    for (const line of source.split('\n')) {
      if (!line.includes('.verifyIdToken(') || line.trim().startsWith('//')) continue;
      assert.match(line, /reviewerSessionBlock\(/, `${name} leaves a token check unwrapped: ${line.trim()}`);
    }
  }

  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(app, /Reviewer sign-in/);
  assert.match(app, /readReviewerDatabaseFlag\(\)/);
  const auth = await readFile(path.join(root, 'src/firebase-auth.js'), 'utf8');
  assert.match(auth, /signInAsAppReviewer/);
  assert.match(auth, /auth\/password-not-allowed/);
  const rules = await readFile(path.join(root, 'firebase/appreview.rules'), 'utf8');
  assert.match(rules, /appreview@flyskyway\.com/);
  assert.match(rules, /sign_in_provider == 'password'/);
});
