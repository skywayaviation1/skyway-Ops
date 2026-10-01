import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCrewDayPairings,
  classifyFlightTiming,
  crewNamesMatch,
  dutyClockState,
  finalizeScheduleCategory,
  legsVisibleToCrew,
  localDayKey,
  partnerOnCrewDay,
  selectFocusTrip,
  showTimeMs,
  splitScheduleTypeSuffix,
} from '../src/crew-day.js';

const HOUR = 3600_000;

function leg(id, opts) {
  return {
    uid: id,
    id,
    start: opts.start,
    end: opts.end,
    info: {
      tail: opts.tail || 'N444AM',
      from: opts.from,
      to: opts.to,
      pic: opts.pic || '',
      sic: opts.sic || '',
      category: opts.category || 'REVENUE',
      isFlight: opts.isFlight !== false,
      pax: opts.pax ?? 2,
      customer: opts.customer || 'Charter',
      tripType: opts.tripType || 'Charter',
      rawSummary: opts.rawSummary || '',
    },
  };
}

test('a no-route crew assignment is a hold, not a flight', () => {
  const split = splitScheduleTypeSuffix('Crew 525CR - Crew assignment');
  assert.equal(split.customer, 'Crew 525CR');
  assert.equal(split.tripType, 'Crew assignment');
  const cat = finalizeScheduleCategory({
    tripType: split.tripType,
    customer: split.customer,
    summary: '[N525CR] Crew 525CR - Crew assignment',
    from: '----',
    to: '----',
    pax: 0,
    description: 'PIC: David Chen\nSIC: Timothy Woods\nPax: 0',
  });
  assert.equal(cat.category, 'HOLD');
  assert.equal(cat.isFlight, false);
  assert.equal(cat.isOps, false);
});

test('a chartered leg with a route stays revenue', () => {
  const cat = finalizeScheduleCategory({
    tripType: 'Charter',
    customer: 'Acme',
    summary: '[N444AM] Acme (IAD - HYA) - Charter',
    from: 'IAD',
    to: 'HYA',
    pax: 4,
  });
  assert.equal(cat.category, 'REVENUE');
  assert.equal(cat.isFlight, true);
  assert.equal(cat.legType, 'REVENUE');
});

test('same airport and a repositioning placeholder are holds', () => {
  const same = finalizeScheduleCategory({
    tripType: 'Charter',
    from: 'KTPA',
    to: 'TPA',
    pax: 2,
    summary: '[N1] Hold (KTPA - TPA) - Charter',
  });
  assert.equal(same.category, 'HOLD');
  assert.equal(same.isFlight, false);

  const repo = finalizeScheduleCategory({
    tripType: 'Positioning',
    from: 'TEB',
    to: 'PBI',
    pax: 0,
    summary: 'Needs repositioning to PBI',
    description: 'Needs repositioning',
  });
  assert.equal(repo.category, 'HOLD');
});

test('multi-leg day with a tail change is one pairing for both pilots', () => {
  const trips = [
    leg('a', {
      start: '2026-10-01T14:00:00Z',
      end: '2026-10-01T16:00:00Z',
      from: 'IAD',
      to: 'HYA',
      tail: 'N444AM',
      pic: 'DAVID C CHEN',
      sic: 'Timothy Woods',
    }),
    leg('b', {
      start: '2026-10-01T18:00:00Z',
      end: '2026-10-01T20:00:00Z',
      from: 'HYA',
      to: 'TEB',
      tail: 'N525CR',
      pic: 'David Chen',
      sic: 'TIMOTHY J WOODS',
    }),
    leg('stale', {
      start: '2026-09-29T04:00:00Z',
      end: '2026-10-02T20:00:00Z',
      from: '----',
      to: '----',
      tail: 'N525CR',
      category: 'REPO',
      isFlight: true,
      customer: 'Crew 525CR',
      tripType: 'Crew assignment',
      rawSummary: '[N525CR] Crew 525CR - Crew assignment',
      pic: 'David Chen',
      sic: 'Timothy Woods',
    }),
  ];
  const pairings = buildCrewDayPairings(trips, { timeZone: 'America/Chicago' });
  assert.equal(pairings.length, 1);
  assert.deepEqual(pairings[0].legIds.sort(), ['a', 'b']);
  assert.deepEqual(pairings[0].tails.sort(), ['N444AM', 'N525CR']);
  assert.equal(crewNamesMatch(pairings[0].picName, 'David Chen'), true);

  const david = legsVisibleToCrew(trips, 'David Chen', 'America/Chicago').map((t) => t.uid);
  const timothy = legsVisibleToCrew(trips, 'TIMOTHY WOODS', 'America/Chicago').map((t) => t.uid);
  assert.deepEqual(david.sort(), ['a', 'b']);
  assert.deepEqual(timothy.sort(), ['a', 'b']);
});

test('local midnight in the crew timezone splits the pairing', () => {
  // 2026-10-02T04:30:00Z is 23:30 CDT on Oct 1. 06:30Z is 01:30 CDT on Oct 2.
  const trips = [
    leg('late', {
      start: '2026-10-02T04:30:00Z',
      end: '2026-10-02T05:30:00Z',
      from: 'MDW',
      to: 'IND',
      pic: 'David Chen',
      sic: 'Timothy Woods',
    }),
    leg('early', {
      start: '2026-10-02T06:30:00Z',
      end: '2026-10-02T08:00:00Z',
      from: 'IND',
      to: 'TEB',
      pic: 'David Chen',
      sic: 'Timothy Woods',
    }),
  ];
  assert.equal(localDayKey('2026-10-02T04:30:00Z', 'America/Chicago'), '2026-10-01');
  assert.equal(localDayKey('2026-10-02T06:30:00Z', 'America/Chicago'), '2026-10-02');
  const pairings = buildCrewDayPairings(trips, { timeZone: 'America/Chicago' });
  assert.equal(pairings.length, 2);
  assert.deepEqual(pairings.map((p) => p.day).sort(), ['2026-10-01', '2026-10-02']);
});

test('a blank-SIC leg attaches only when the named pilot has one partner that day', () => {
  const shared = leg('shared', {
    start: '2026-10-01T15:00:00Z',
    end: '2026-10-01T17:00:00Z',
    from: 'IAD',
    to: 'HYA',
    pic: 'David Chen',
    sic: 'Timothy Woods',
  });
  const blank = leg('blank', {
    start: '2026-10-01T19:00:00Z',
    end: '2026-10-01T21:00:00Z',
    from: 'HYA',
    to: 'TEB',
    pic: 'David Chen',
    sic: '',
  });
  const one = buildCrewDayPairings([shared, blank], { timeZone: 'America/Chicago' });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].legIds.sort(), ['blank', 'shared']);
  const timothy = legsVisibleToCrew([shared, blank], 'Timothy Woods', 'America/Chicago').map((t) => t.uid);
  assert.deepEqual(timothy.sort(), ['blank', 'shared']);

  const other = leg('other', {
    start: '2026-10-01T12:00:00Z',
    end: '2026-10-01T13:00:00Z',
    from: 'PBI',
    to: 'OPF',
    pic: 'David Chen',
    sic: 'Alex Rivera',
  });
  const two = buildCrewDayPairings([shared, other, blank], { timeZone: 'America/Chicago' });
  const blankGroup = two.find((p) => p.legIds.includes('blank'));
  assert.equal(blankGroup, undefined);
  assert.equal(partnerOnCrewDay([shared, other, blank], 'David Chen', Date.parse('2026-10-01T16:00:00Z'), 'America/Chicago'), null);
});

test('selectFocusTrip ignores a stale crew-assignment window and keeps the real leg', () => {
  const now = Date.parse('2026-10-01T18:41:00Z');
  const assignment = leg('assign', {
    start: new Date(now - (2 * 24 + 14) * HOUR).toISOString(),
    end: new Date(now + 24 * HOUR).toISOString(),
    from: '----',
    to: '----',
    tail: 'N525CR',
    category: 'REPO',
    isFlight: true,
    pax: 0,
    customer: 'Crew 525CR',
    tripType: '',
    rawSummary: '[N525CR] Crew 525CR - Crew assignment',
    pic: 'David Chen',
    sic: 'Timothy Woods',
  });
  const flying = leg('fly', {
    start: new Date(now - 30 * 60_000).toISOString(),
    end: new Date(now + 90 * 60_000).toISOString(),
    from: 'IAD',
    to: 'HYA',
    pic: 'David Chen',
    sic: 'Timothy Woods',
  });
  assert.equal(classifyFlightTiming(assignment, now), 'stale');
  const focus = selectFocusTrip([assignment, flying], now);
  assert.equal(focus.trip.uid, 'fly');
  assert.equal(focus.timing.isActive, true);
  assert.equal(showTimeMs(assignment), null);
  assert.equal(showTimeMs(flying), Date.parse(flying.start) - 90 * 60_000);
});

test('the duty clock follows duty-on, not an earlier trip departure', () => {
  const now = Date.parse('2026-10-01T18:41:00Z');
  const dutyOnAt = Date.parse('2026-10-01T13:10:00Z');
  const clock = dutyClockState({ dutyOnAt, tripStart: now - 2 * 24 * HOUR }, now);
  assert.equal(clock.dutyOnAt, dutyOnAt);
  assert.equal(clock.elapsedMs, now - dutyOnAt);
  assert.equal(clock.releaseAt, dutyOnAt + 14 * HOUR);
  assert.equal(clock.remainingMs, 14 * HOUR - (now - dutyOnAt));
  assert.equal(dutyClockState({ dutyOnAt: null }, now), null);
});

test('partnerOnCrewDay names the complementary seat for that local day', () => {
  const trips = [
    leg('a', {
      start: '2026-10-01T15:00:00Z',
      end: '2026-10-01T17:00:00Z',
      from: 'IAD',
      to: 'HYA',
      tail: 'N444AM',
      pic: 'Maxwell Hagberg',
      sic: 'Timothy Woods',
    }),
    leg('b', {
      start: '2026-10-01T20:00:00Z',
      end: '2026-10-01T22:00:00Z',
      from: 'HYA',
      to: 'TEB',
      tail: 'N525CR',
      pic: 'Maxwell Hagberg',
      sic: 'Timothy Woods',
    }),
  ];
  const at = Date.parse('2026-10-01T16:00:00Z');
  const forPic = partnerOnCrewDay(trips, 'Maxwell Hagberg', at, 'America/Chicago');
  assert.equal(forPic.myRole, 'PIC');
  assert.equal(forPic.role, 'SIC');
  assert.equal(forPic.name, 'Timothy Woods');
  assert.deepEqual(forPic.pairing.legIds.sort(), ['a', 'b']);
  const forSic = partnerOnCrewDay(trips, 'Timothy Woods', at, 'America/Chicago');
  assert.equal(forSic.myRole, 'SIC');
  assert.equal(forSic.name, 'Maxwell Hagberg');
});
