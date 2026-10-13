// Broker tracking links follow the live JetInsight schedule.
// The link stores a selection rule. Times, routes, tails, and which legs
// exist are read from the feed on every request.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { eventsToScheduleLegs } from '../src/ical-parse.js';
import { brand } from '../src/brand.js';
import { signTripToken, verifyTripToken } from '../api/_trip-token.js';
import { clearScheduleMemory, loadLiveSchedule } from '../api/_schedule-cache.js';
import {
  CANCEL_GRACE_MS,
  assembleLiveItinerary,
  deriveShareRule,
  evaluateLinkAccess,
  lastLegLandedAt,
  linkPatchFromRequest,
  overlayLiveLegData,
  activeTail,
  reconcileSchedule,
  trackingSubjectMeta,
  trackingUrl,
  TRIP_CHANGED_REASON,
} from '../src/trip-itinerary.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

process.env.TRIP_LINK_SECRET = process.env.TRIP_LINK_SECRET || 'test-secret-value-123456';

const HOUR = 60 * 60 * 1000;

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function ics(events) {
  let out = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//TEST//EN\r\n';
  for (const event of events) {
    out += 'BEGIN:VEVENT\r\n';
    out += `UID:${event.uid}\r\n`;
    out += `DTSTART:${stamp(event.start)}\r\n`;
    out += `DTEND:${stamp(event.end)}\r\n`;
    out += `SUMMARY:[${event.tail}] ${event.customer} (${event.from} - ${event.to}) - ${event.type || 'Charter'}\r\n`;
    out += `DESCRIPTION:Pax: ${event.pax ?? 2}\\nPIC: Ada Pilot\\nSIC: Bo Copilot\\nTrip ID: ${event.tripCode}\\n\r\n`;
    out += 'END:VEVENT\r\n';
  }
  return `${out}END:VCALENDAR\r\n`;
}

function legsFrom(events, now) {
  return eventsToScheduleLegs(ics(events), now);
}

const NOW = Date.parse('2026-10-13T12:00:00Z');

function baseEvents(overrides = {}) {
  return [
    {
      uid: 'leg-out',
      tail: 'N525CR',
      customer: 'Platinum Air',
      from: 'TPA',
      to: 'MIA',
      tripCode: 'WEQVQD',
      start: NOW + 3 * HOUR,
      end: NOW + 4 * HOUR,
      ...overrides,
    },
  ];
}

function rule(extra = {}) {
  return {
    anchorUid: 'leg-out',
    tripCode: 'WEQVQD',
    broker: 'Platinum Air',
    tail: 'N525CR',
    windowMs: 48 * HOUR,
    anchorStart: new Date(NOW + 3 * HOUR).toISOString(),
    pinnedLegUids: ['leg-out'],
    excludedLegUids: [],
    showPax: true,
    showPaxByLeg: { 'leg-out': true },
    theme: 'premium',
    brokerEmail: 'broker@platinumair.example',
    ...extra,
  };
}

test('a time change on the feed shows up on the next read', () => {
  const before = legsFrom(baseEvents(), NOW);
  const after = legsFrom(baseEvents({ start: NOW + 5 * HOUR, end: NOW + 6 * HOUR }), NOW);
  const stale = assembleLiveItinerary(before, rule(), NOW);
  const live = assembleLiveItinerary(after, rule(), NOW);
  assert.equal(stale.legs[0].departure, new Date(NOW + 3 * HOUR).toISOString());
  assert.equal(live.legs[0].departure, new Date(NOW + 5 * HOUR).toISOString());
  assert.notEqual(live.legs[0].departure, stale.legs[0].departure);
});

test('a route change replaces the airports stored at share time', () => {
  const live = assembleLiveItinerary(
    legsFrom(baseEvents({ from: 'BCT', to: 'OPF' }), NOW),
    rule(),
    NOW,
  );
  assert.equal(live.legs.length, 1);
  assert.equal(live.legs[0].from, 'BCT');
  assert.equal(live.legs[0].to, 'OPF');
});

test('an unselected leg after the live leg is not added', () => {
  const events = [
    ...baseEvents(),
    {
      uid: 'leg-back',
      tail: 'N525CR',
      customer: 'Platinum Air',
      from: 'MIA',
      to: 'TPA',
      tripCode: 'WEQVQD',
      start: NOW + 6 * HOUR,
      end: NOW + 7 * HOUR,
    },
    {
      uid: 'leg-next-tail',
      tail: 'N525CR',
      customer: 'Platinum Air',
      from: 'TPA',
      to: 'TEB',
      tripCode: 'P3LHXA',
      start: NOW + 9 * HOUR,
      end: NOW + 11 * HOUR,
    },
  ];
  const live = assembleLiveItinerary(legsFrom(events, NOW), rule(), NOW);
  assert.deepEqual(live.legs.map((leg) => leg.tripId), ['leg-out']);
  assert.equal(live.legs.some((leg) => leg.tripId === 'leg-back'), false);
  assert.equal(live.legs.some((leg) => leg.tripId === 'leg-next-tail'), false);

  const checked = assembleLiveItinerary(
    legsFrom(events, NOW),
    rule({ pinnedLegUids: ['leg-out', 'leg-back'] }),
    NOW,
  );
  assert.deepEqual(checked.legs.map((leg) => leg.tripId), ['leg-out', 'leg-back']);
  assert.equal(checked.legs.some((leg) => leg.tripId === 'leg-next-tail'), false);
});

test('include entire trip adds every leg of that trip id, including a new one on another tail', () => {
  const events = [
    {
      uid: 'leg-later',
      tail: 'N444AM',
      customer: 'Platinum Air',
      from: 'TEB',
      to: 'PBI',
      tripCode: 'WEQVQD',
      start: NOW + 10 * HOUR,
      end: NOW + 13 * HOUR,
    },
    ...baseEvents(),
    {
      uid: 'leg-other-tail',
      tail: 'N20UF',
      customer: 'Someone Else',
      from: 'MIA',
      to: 'OPF',
      tripCode: 'WEQVQD',
      start: NOW + 6 * HOUR,
      end: NOW + 7 * HOUR,
    },
    {
      uid: 'leg-other-trip',
      tail: 'N525CR',
      customer: 'Platinum Air',
      from: 'MIA',
      to: 'TPA',
      tripCode: 'P3LHXA',
      start: NOW + 8 * HOUR,
      end: NOW + 9 * HOUR,
    },
    {
      uid: 'leg-trip-number',
      tail: 'N999XX',
      customer: 'Platinum Air',
      from: 'SRQ',
      to: 'BCT',
      tripCode: '104281',
      start: NOW + 4 * HOUR,
      end: NOW + 5 * HOUR,
    },
  ];
  const live = assembleLiveItinerary(
    legsFrom(events, NOW),
    rule({ includeEntireTrip: true, pinnedLegUids: ['leg-out'] }),
    NOW,
  );
  assert.deepEqual(live.legs.map((leg) => leg.tripId), ['leg-out', 'leg-other-tail', 'leg-later']);
  assert.deepEqual(live.legs.map((leg) => leg.legNumber), [1, 2, 3]);
  assert.deepEqual(live.legs.map((leg) => leg.tail), ['N525CR', 'N20UF', 'N444AM']);
  assert.equal(live.legs.every((leg) => leg.tripCode === 'WEQVQD'), true);
  assert.equal(live.legs.some((leg) => leg.tripId === 'leg-other-trip'), false);
  assert.equal(live.legs.some((leg) => leg.tripId === 'leg-trip-number'), false);
});

test('a numeric trip number does not turn on entire-trip matching', () => {
  const events = [
    {
      uid: 'leg-num-a',
      tail: 'N525CR',
      customer: 'Platinum Air',
      from: 'TPA',
      to: 'MIA',
      tripCode: '104281',
      start: NOW + 3 * HOUR,
      end: NOW + 4 * HOUR,
    },
    {
      uid: 'leg-num-b',
      tail: 'N20UF',
      customer: 'Platinum Air',
      from: 'MIA',
      to: 'TEB',
      tripCode: '104281',
      start: NOW + 6 * HOUR,
      end: NOW + 8 * HOUR,
    },
  ];
  const live = assembleLiveItinerary(
    legsFrom(events, NOW),
    rule({
      anchorUid: 'leg-num-a',
      tripCode: '104281',
      includeEntireTrip: true,
      pinnedLegUids: ['leg-num-a'],
    }),
    NOW,
  );
  assert.deepEqual(live.legs.map((leg) => leg.tripId), ['leg-num-a']);
});

test('a removed leg stays visible as cancelled during the grace period, then drops', () => {
  const previous = legsFrom(baseEvents(), NOW);
  const remaining = legsFrom([
    {
      uid: 'leg-back',
      tail: 'N525CR',
      customer: 'Platinum Air',
      from: 'MIA',
      to: 'TPA',
      tripCode: 'WEQVQD',
      start: NOW + 6 * HOUR,
      end: NOW + 7 * HOUR,
    },
  ], NOW);
  const during = reconcileSchedule(previous, remaining, NOW);
  const shown = assembleLiveItinerary(during, rule(), NOW);
  const cancelled = shown.legs.find((leg) => leg.tripId === 'leg-out');
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.from, 'TPA');
  assert.equal(shown.tripChanged, false);
  assert.equal(shown.legs.some((leg) => leg.tripId === 'leg-back'), false);

  const later = NOW + CANCEL_GRACE_MS + 60 * 1000;
  const expired = reconcileSchedule(during, remaining, later);
  assert.equal(expired.some((leg) => leg.uid === 'leg-out'), false);
  const afterGrace = assembleLiveItinerary(expired, rule({ anchorUid: 'leg-back', pinnedLegUids: ['leg-back'] }), later);
  assert.equal(afterGrace.legs.some((leg) => leg.cancelled), false);
});

test('a tail swap follows the aircraft now assigned to the leg', () => {
  const swapped = legsFrom(baseEvents({ tail: 'N444AM' }), NOW);
  const live = assembleLiveItinerary(swapped, rule(), NOW);
  assert.equal(live.legs[0].tail, 'N444AM');
  const overlaid = overlayLiveLegData(live.legs, {
    'leg-out': { statuses: { wheels_up: { at: NOW } }, hasCatering: true, fromFbo: 'Signature' },
  });
  assert.equal(activeTail(overlaid), 'N444AM');
  assert.equal(overlaid[0].fromFbo, 'Signature');
  assert.equal(overlaid[0].hasCatering, true);
});

test('a cancelled anchor stays on the link and does not pull in an unselected leg', () => {
  const previous = legsFrom(baseEvents(), NOW);
  const survivor = legsFrom([
    {
      uid: 'leg-back',
      tail: 'N525CR',
      customer: 'Platinum Air',
      from: 'MIA',
      to: 'TPA',
      tripCode: 'WEQVQD',
      start: NOW + 6 * HOUR,
      end: NOW + 7 * HOUR,
    },
  ], NOW);
  const schedule = reconcileSchedule(previous, survivor, NOW);
  const pinnedOnly = assembleLiveItinerary(schedule, rule(), NOW);
  assert.equal(pinnedOnly.tripChanged, false);
  assert.equal(pinnedOnly.promotedFrom, null);
  assert.deepEqual(pinnedOnly.legs.map((leg) => leg.tripId), ['leg-out']);
  assert.equal(pinnedOnly.legs[0].cancelled, true);

  const entire = assembleLiveItinerary(schedule, rule({ includeEntireTrip: true }), NOW);
  assert.equal(entire.tripChanged, false);
  assert.equal(entire.promotedFrom, 'leg-out');
  assert.equal(entire.anchorUid, 'leg-back');
  assert.equal(entire.legs.find((leg) => leg.tripId === 'leg-out').cancelled, true);
  assert.equal(entire.legs.find((leg) => leg.tripId === 'leg-back').cancelled, false);

  const onlyAnchor = reconcileSchedule(previous, [], NOW);
  const stillVisible = assembleLiveItinerary(onlyAnchor, rule(), NOW);
  assert.equal(stillVisible.tripChanged, false);
  assert.equal(stillVisible.legs[0].cancelled, true);

  const later = NOW + CANCEL_GRACE_MS + 60 * 1000;
  const gone = reconcileSchedule(onlyAnchor, [], later);
  const dropped = assembleLiveItinerary(gone, rule(), later);
  assert.equal(dropped.tripChanged, false);
  assert.deepEqual(dropped.legs, []);

  const expiredInPlace = assembleLiveItinerary(
    [{ ...onlyAnchor.find((leg) => leg.uid === 'leg-out'), cancelled: true, cancelledAt: later - CANCEL_GRACE_MS - 1000 }],
    rule(),
    later,
  );
  assert.equal(expiredInPlace.tripChanged, true);
  assert.equal(expiredInPlace.reason, TRIP_CHANGED_REASON);
});

test('rotate and revoke invalidate the previous token without changing its shape', () => {
  const issued = linkPatchFromRequest({
    existing: {},
    tripId: 'leg-out',
    rotate: false,
    shareSelection: rule(),
    now: 1_000,
  });
  assert.equal(issued.patch.publicTripData, undefined);
  assert.equal(issued.patch.shareRule.anchorUid, 'leg-out');
  assert.equal(issued.patch.shareRule.pinnedLegUids.includes('leg-out'), true);
  const token = signTripToken('leg-out', issued.issuedAt);
  assert.equal(token.split('.').length, 3);
  assert.match(trackingUrl('https://skyway-ops.vercel.app', token), /\/trip-track\.html\?token=/);

  const rotated = linkPatchFromRequest({
    existing: { linkTokenIssuedAt: issued.issuedAt, shareRule: issued.patch.shareRule },
    tripId: 'leg-out',
    rotate: true,
    shareSelection: rule(),
    now: 2_000,
  });
  const still = verifyTripToken(token);
  const denied = evaluateLinkAccess(
    { linkTokenIssuedAt: rotated.issuedAt, linkRevoked: false },
    still,
    2_000,
    null,
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'link rotated');

  const fresh = signTripToken('leg-out', rotated.issuedAt);
  const allowed = evaluateLinkAccess(
    { linkTokenIssuedAt: rotated.issuedAt, linkRevoked: false },
    verifyTripToken(fresh),
    2_000,
    null,
  );
  assert.equal(allowed.ok, true);

  const revoked = evaluateLinkAccess(
    { linkTokenIssuedAt: rotated.issuedAt, linkRevoked: true },
    verifyTripToken(fresh),
    3_000,
    null,
  );
  assert.equal(revoked.reason, 'link revoked');
});

test('the broker page takes its name from the tenant brand', () => {
  const page = read('src/TripTrack.jsx');
  assert.match(page, /brand\(\)\.legalName/);
  assert.match(page, /brand\(\)\.contactEmail/);
  assert.match(page, /brand\(\)\.contactPhone/);
  assert.match(page, /Trip changed — contact your broker/);
  assert.equal(page.includes('CHARTERS@FLYSKYWAY'), false);
  assert.equal(page.includes('727-605-5000'), false);
  assert.notEqual(brand('elite').legalName, brand('skyway').legalName);
  assert.equal(brand('elite').legalName, 'Elite Jets');
  assert.equal(brand('elite').contactEmail, 'charters@elitejets.com');
  assert.notEqual(brand('elite').contactPhone, brand('skyway').contactPhone);
});

test('an old snapshot is only a fallback, and email does not read it', () => {
  const legacy = {
    tripCode: 'WEQVQD',
    publicTripData: {
      tail: 'N525CR',
      legs: [
        { tripId: 'leg-out', from: 'TPA', to: 'MIA', departure: new Date(NOW).toISOString(), showPax: true },
      ],
    },
  };
  const derived = deriveShareRule(legacy, 'leg-out');
  assert.equal(derived.backfill, true);
  assert.deepEqual(derived.rule.pinnedLegUids, ['leg-out']);
  assert.equal(derived.rule.includeEntireTrip, false);
  assert.equal(derived.rule.tail, 'N525CR');

  const withNeighbor = legsFrom([
    ...baseEvents({ from: 'SRQ', to: 'TEB' }),
    {
      uid: 'leg-unselected',
      tail: 'N525CR',
      customer: 'Platinum Air',
      from: 'TEB',
      to: 'PBI',
      tripCode: 'WEQVQD',
      start: NOW + 8 * HOUR,
      end: NOW + 10 * HOUR,
    },
  ], NOW);
  const live = assembleLiveItinerary(withNeighbor, derived.rule, NOW);
  assert.deepEqual(live.legs.map((leg) => leg.tripId), ['leg-out']);
  assert.equal(live.legs[0].from, 'SRQ');
  assert.equal(live.legs[0].to, 'TEB');

  const missed = assembleLiveItinerary([], derived.rule, NOW);
  assert.equal(missed.tripChanged, false);
  assert.equal(missed.legs.length, 0);

  const subject = trackingSubjectMeta({
    publicTripData: { tail: 'NOLD' },
    shareRule: { tail: 'N525CR', tripCode: 'WEQVQD' },
  });
  assert.equal(subject.tail, 'N525CR');
  assert.equal(subject.tripCode, 'WEQVQD');
  const noRule = trackingSubjectMeta({ publicTripData: { tail: 'NOLD' }, tail: null });
  assert.equal(noRule.tail, null);

  const share = read('api/trip-share.js');
  assert.equal(share.includes('publicTripData'), false);
  assert.match(share, /shareSelection/);
  assert.match(read('api/trip-public.js'), /assembleLiveItinerary/);
  assert.match(read('src/App.jsx'), /shareSelection/);
  assert.equal(/function buildPublicTripData/.test(read('src/App.jsx')), false);
});

test('link expiry follows the live last leg, not an earlier landing', () => {
  const legs = [
    { cancelled: false, status: { landed: { at: NOW - 30 * HOUR } }, tail: 'N525CR' },
    { cancelled: false, status: { wheels_up: { at: NOW - HOUR } }, tail: 'N525CR' },
  ];
  assert.equal(lastLegLandedAt(legs), null);
  const finished = [
    { cancelled: false, status: { landed: { at: NOW - 30 * HOUR } } },
    { cancelled: false, status: { landed: { at: NOW - 25 * HOUR } } },
  ];
  const access = evaluateLinkAccess(
    { linkRevoked: false, linkTokenIssuedAt: 1 },
    { issuedAt: 1 },
    NOW,
    lastLegLandedAt(finished),
  );
  assert.equal(access.reason, 'link expired after trip completion');
});

test('the schedule cache serves a fresh feed and keeps a short copy', async () => {
  clearScheduleMemory();
  const docs = new Map();
  const db = {
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          return {
            async get() {
              if (!docs.has(key)) return { exists: false, data: () => undefined };
              return { exists: true, data: () => docs.get(key) };
            },
            async set(value, opts) {
              const prev = docs.get(key) || {};
              docs.set(key, opts?.merge ? { ...prev, ...value } : value);
            },
          };
        },
        limit() { return this; },
        async get() { return { docs: [] }; },
      };
    },
  };
  let fetches = 0;
  const feed = ics(baseEvents());
  const fetchImpl = async () => {
    fetches += 1;
    return { ok: true, text: async () => feed };
  };
  const url = 'https://portal.jetinsight.com/schedule/test.ics';
  const first = await loadLiveSchedule({ db, fetchImpl, now: NOW, feedUrl: url, force: true });
  assert.equal(fetches, 1);
  assert.equal(first.legs[0].from, 'TPA');
  assert.equal(first.legs[0].tail, 'N525CR');
  assert.ok(docs.has('schedule-cache/jetinsight'));
  assert.ok([...docs.keys()].some((key) => key.startsWith('legs/')));

  const second = await loadLiveSchedule({ db, fetchImpl, now: NOW + 30 * 1000, feedUrl: url });
  assert.equal(fetches, 1);
  assert.equal(second.source, 'memory');

  clearScheduleMemory();
  const third = await loadLiveSchedule({ db, fetchImpl, now: NOW + 60 * 1000, feedUrl: url });
  assert.equal(fetches, 1);
  assert.equal(third.source, 'firestore');
  assert.equal(third.legs[0].to, 'MIA');
});

test('client itinerary fields are not part of the stored link', () => {
  const patch = linkPatchFromRequest({
    existing: { linkTokenIssuedAt: 50, linkRevoked: false, publicTripData: { tail: 'NSTALE', legs: [{ from: 'AAA' }] } },
    tripId: 'leg-out',
    rotate: false,
    shareSelection: {
      ...rule(),
      legs: [{ from: 'ZZZ', to: 'YYY', departure: '1999-01-01T00:00:00Z' }],
      publicTripData: { tail: 'NFAKE' },
    },
    now: 80,
  });
  assert.equal(patch.reused, true);
  assert.equal(patch.patch.publicTripData, undefined);
  assert.equal(patch.patch.shareRule.tail, 'N525CR');
  assert.equal(patch.patch.shareRule.legs, undefined);
  assert.equal(patch.patch.shareRule.brokerEmail, 'broker@platinumair.example');
  assert.equal(patch.patch.shareRule.theme, 'premium');
  assert.equal(patch.patch.shareRule.includeEntireTrip, false);
});

test('toggling include entire trip updates the stored rule and keeps the token', () => {
  const issued = linkPatchFromRequest({
    existing: {},
    tripId: 'leg-out',
    rotate: false,
    shareSelection: rule({ includeEntireTrip: false }),
    now: 1_000,
  });
  const token = signTripToken('leg-out', issued.issuedAt);
  const toggled = linkPatchFromRequest({
    existing: { linkTokenIssuedAt: issued.issuedAt, linkRevoked: false, shareRule: issued.patch.shareRule },
    tripId: 'leg-out',
    rotate: false,
    shareSelection: rule({ includeEntireTrip: true }),
    now: 9_000,
  });
  assert.equal(toggled.reused, true);
  assert.equal(toggled.issuedAt, issued.issuedAt);
  assert.equal(toggled.patch.linkTokenIssuedAt, undefined);
  assert.equal(toggled.patch.shareRule.includeEntireTrip, true);
  assert.equal(verifyTripToken(token).ok, true);
  const access = evaluateLinkAccess(
    { linkTokenIssuedAt: issued.issuedAt, linkRevoked: false },
    verifyTripToken(token),
    9_000,
    null,
  );
  assert.equal(access.ok, true);

  const twoLegs = {
    publicTripData: {
      tail: 'N525CR',
      legs: [
        { tripId: 'leg-out', showPax: true },
        { tripId: 'leg-back', showPax: false },
      ],
    },
  };
  const fromSnapshot = deriveShareRule(twoLegs, 'leg-out');
  assert.deepEqual(fromSnapshot.rule.pinnedLegUids, ['leg-out', 'leg-back']);
  assert.equal(fromSnapshot.rule.includeEntireTrip, false);

  const dialog = read('src/App.jsx');
  assert.match(dialog, /INCLUDE ENTIRE TRIP/);
  assert.match(dialog, /includeEntireTrip/);
  assert.match(read('src/TripTrack.jsx'), /leg\.tail/);
});
