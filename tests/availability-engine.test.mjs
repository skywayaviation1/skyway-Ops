import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  AVAILABILITY_RULES,
  aircraftProfile,
  estimateLeg,
  evaluateCrewFit,
  formatDuration,
  parseRouting,
  planLiveLegAssignments,
  priceAvailabilityOption,
  rankTailAvailability,
} from '../src/availability-engine.js';

const at = (iso) => new Date(iso).getTime();
const date = (ms) => new Date(ms);
const MIN = 60_000;
const HR = 60 * MIN;
const root = path.resolve(import.meta.dirname, '..');

function trip({
  id,
  tail,
  from,
  to,
  start,
  end,
  pic = '',
  sic = '',
  category = 'REVENUE',
  legType = category === 'REVENUE' ? 'REVENUE' : 'REPO',
  pax = category === 'REVENUE' ? 1 : 0,
}) {
  return {
    uid: id,
    start: date(start),
    end: date(end),
    info: {
      tail,
      from,
      to,
      pic,
      sic,
      category,
      legType,
      pax,
      isFlight: true,
      isOps: true,
    },
  };
}

const fleet = (overrides = {}) => [{
  tail: 'NTEST',
  icaoType: 'C25B',
  homeBase: 'APF',
  ...overrides,
}];

test('routing parser accepts aviation-style separators', () => {
  assert.deepEqual(parseRouting('apf-teb → ack, bos'), ['APF', 'TEB', 'ACK', 'BOS']);
  assert.deepEqual(parseRouting(' APF  APF / TEB '), ['APF', 'TEB']);
});

test('aircraft performance changes the estimated flight time', () => {
  const cj = estimateLeg('APF', 'TEB', 'C25B');
  const helicopter = estimateLeg('APF', 'TEB', 'AS50');
  assert.equal(cj.ok, true);
  assert.equal(helicopter.ok, true);
  assert.ok(cj.distanceNm > 800);
  assert.ok(cj.flightMinutes < helicopter.flightMinutes);
  assert.equal(aircraftProfile('C25B').label, 'Citation CJ3');
  assert.equal(aircraftProfile('').assumed, true);
});

test('an idle tail at the requested origin fits with no delay', () => {
  const requested = at('2026-09-01T14:00:00Z');
  const [result] = rankTailAvailability({
    fleet: fleet(),
    allTrips: [],
    route: ['APF', 'TEB'],
    requestedStartMs: requested,
    crew: [],
    dutyPeriods: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'fits');
  assert.equal(result.delayMinutes, 0);
  assert.equal(result.movements.some((movement) => movement.kind === 'reposition-in'), false);
  assert.equal(result.crewFit.status, 'not-checked');
});

test('45-minute ground turn delays a request after the previous leg', () => {
  const requested = at('2026-09-01T14:00:00Z');
  const allTrips = [trip({
    id: 'prior',
    tail: 'NTEST',
    from: 'TEB',
    to: 'APF',
    start: requested - 2 * HR,
    end: requested - 30 * MIN,
  })];
  const [result] = rankTailAvailability({
    fleet: fleet(),
    allTrips,
    route: ['APF', 'MCO'],
    requestedStartMs: requested,
  });
  assert.equal(result.ok, true);
  assert.equal(result.delayMinutes, 15);
  assert.equal(result.startMs, requested + 15 * MIN);
});

test('required repositioning is included before and after the request', () => {
  const requested = at('2026-09-01T14:00:00Z');
  const previous = trip({
    id: 'prior',
    tail: 'NTEST',
    from: 'APF',
    to: 'TEB',
    start: requested - 6 * HR,
    end: requested - 4 * HR,
  });
  const next = trip({
    id: 'next',
    tail: 'NTEST',
    from: 'APF',
    to: 'MCO',
    start: requested + 14 * HR,
    end: requested + 15 * HR,
  });
  const [result] = rankTailAvailability({
    fleet: fleet(),
    allTrips: [previous, next],
    route: ['APF', 'TEB'],
    requestedStartMs: requested,
  });
  assert.equal(result.ok, true);
  assert.ok(result.movements.some((movement) => movement.kind === 'reposition-in'));
  assert.ok(result.movements.some((movement) => movement.kind === 'reposition-out'));
  assert.ok(result.repositionDistanceNm > 1_000);
  assert.ok(result.repositionMinutes > 0);
});

test('a reposition that would need to depart in the past creates a delay', () => {
  const planningNow = at('2026-09-01T13:00:00Z');
  const requested = at('2026-09-01T14:00:00Z');
  const [result] = rankTailAvailability({
    fleet: fleet({ homeBase: 'TEB' }),
    allTrips: [],
    route: ['APF', 'MCO'],
    requestedStartMs: requested,
    planningNowMs: planningNow,
  });
  assert.equal(result.ok, true);
  assert.ok(result.delayMinutes > 0);
  const repo = result.movements.find((movement) => movement.kind === 'reposition-in');
  assert.ok(repo.startMs >= planningNow, 'reposition must not begin before planning now');
});

test('multi-leg request includes a 45-minute turn between routing legs', () => {
  const requested = at('2026-09-01T14:00:00Z');
  const [result] = rankTailAvailability({
    fleet: fleet(),
    allTrips: [],
    route: ['APF', 'MCO', 'APF'],
    requestedStartMs: requested,
  });
  const requests = result.movements.filter((movement) => movement.kind === 'request');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].startMs - requests[0].endMs, 45 * MIN);
});

test('engine advances to a later schedule gap and reports required delay', () => {
  const requested = at('2026-09-01T14:00:00Z');
  const blocking = trip({
    id: 'blocking',
    tail: 'NTEST',
    from: 'APF',
    to: 'TEB',
    start: requested + 30 * MIN,
    end: requested + 3 * HR,
  });
  const [result] = rankTailAvailability({
    fleet: fleet(),
    allTrips: [blocking],
    route: ['APF', 'TEB'],
    requestedStartMs: requested,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'delayed');
  assert.ok(result.delayMinutes > 3 * 60, `delay was only ${result.delayMinutes}m`);
});

test('a matching live request consumes the scheduled reposition and uses the following leg', () => {
  const requested = at('2026-09-04T13:45:00Z');
  const prior = trip({
    id: 'dab-mynn',
    tail: 'NTEST',
    from: 'DAB',
    to: 'MYNN',
    start: requested - 4 * HR,
    end: requested - 2 * HR,
  });
  const scheduledRepo = trip({
    id: 'mynn-hpn-repo',
    tail: 'NTEST',
    from: 'MYNN',
    to: 'HPN',
    start: requested + 22 * HR,
    end: requested + 25 * HR,
    category: 'REPO',
  });
  const followingLive = trip({
    id: 'hpn-grb-live',
    tail: 'NTEST',
    from: 'HPN',
    to: 'GRB',
    start: requested + 28 * HR,
    end: requested + 30 * HR,
  });
  const [result] = rankTailAvailability({
    fleet: fleet(),
    allTrips: [prior, scheduledRepo, followingLive],
    route: ['MYNN', 'HPN'],
    requestedStartMs: requested,
    planningNowMs: requested - 3 * HR,
  });

  assert.equal(result.ok, true);
  assert.equal(result.startMs, requested);
  assert.deepEqual(result.consumedPositioning.map((leg) => leg.id), ['mynn-hpn-repo']);
  assert.equal(result.next.id, 'hpn-grb-live');
  assert.equal(result.next.from, 'HPN');
  // The old bug sent the airplane HPN → MYNN just to operate a repo the new
  // live request had already fulfilled.
  assert.equal(result.movements.some((movement) => (
    movement.kind === 'reposition-out'
    && movement.from === 'HPN'
    && movement.to === 'MYNN'
  )), false);
});

test('a revenue leg over the same route is not consumed', () => {
  const requested = at('2026-09-04T13:45:00Z');
  const scheduledRevenue = trip({
    id: 'mynn-hpn-revenue',
    tail: 'NTEST',
    from: 'MYNN',
    to: 'HPN',
    start: requested + 5 * HR,
    end: requested + 8 * HR,
    category: 'REVENUE',
  });
  const [result] = rankTailAvailability({
    fleet: fleet({ homeBase: 'MYNN' }),
    allTrips: [scheduledRevenue],
    route: ['MYNN', 'HPN'],
    requestedStartMs: requested,
    planningNowMs: requested - HR,
  });
  assert.equal(result.ok, true);
  assert.equal(result.consumedPositioning.length, 0);
  // It cannot replace live revenue; if the first gap is too small, it must
  // move to a later gap and report a delay.
  assert.ok(result.delayMinutes > 0);
});

test('45-minute pre-duty and 30-minute post-duty are included', () => {
  const start = at('2026-09-01T14:00:00Z');
  const movement = {
    id: 'request',
    kind: 'request',
    startMs: start,
    endMs: start + 2 * HR,
    flightMinutes: 90,
  };
  const fit = evaluateCrewFit({
    crew: [{ uid: 'p1', name: 'Jane Pilot' }],
    allTrips: [],
    movements: [movement],
    dutyPeriods: [],
  });
  assert.equal(fit.legal, true);
  assert.equal(fit.members[0].dutyStartMs, start - 45 * MIN);
  assert.equal(fit.members[0].dutyEndMs, start + 2 * HR + 30 * MIN);
  assert.equal(fit.members[0].dutyMinutes, 195);
});

test('less than 10 hours rest joins duty periods; 15-minute delay restores rest', () => {
  const requested = at('2026-09-02T14:00:00Z');
  // Prior duty: flight ends 11h before request. With 30m post-duty and 45m
  // pre-duty, rest before the requested start is 9h45. A 15m delay gives 10h.
  const prior = trip({
    id: 'crew-prior',
    tail: 'NOTHER',
    from: 'APF',
    to: 'MCO',
    start: requested - 12 * HR,
    end: requested - 11 * HR,
    pic: 'Jane Pilot',
  });
  const [result] = rankTailAvailability({
    fleet: fleet(),
    allTrips: [prior],
    route: ['APF', 'MCO'],
    requestedStartMs: requested,
    crew: [{ uid: 'p1', name: 'Jane Pilot', role: 'PIC' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.delayMinutes, 15);
  assert.equal(result.crewFit.status, 'legal');
  assert.ok(result.crewFit.members[0].restMinutes >= 600);
});

test('14-hour continuous duty blocks the proposed assignment', () => {
  const start = at('2026-09-01T14:00:00Z');
  const movement = {
    id: 'request',
    kind: 'request',
    startMs: start,
    endMs: start + 3 * HR,
    flightMinutes: 150,
  };
  const existing = trip({
    id: 'long-day',
    tail: 'NOTHER',
    from: 'APF',
    to: 'MCO',
    start: start - 11 * HR,
    end: start - 10 * HR,
    pic: 'Jane Pilot',
  });
  const fit = evaluateCrewFit({
    crew: [{ uid: 'p1', name: 'Jane Pilot' }],
    allTrips: [existing],
    movements: [movement],
    dutyPeriods: [],
  });
  assert.equal(fit.legal, false);
  assert.ok(fit.members[0].dutyMinutes > AVAILABILITY_RULES.maxDutyMinutes);
  assert.match(fit.reasons.join(' '), /continuous duty exceeds/);
});

test('rolling 10 flight hours in 24 uses interval overlap, not whole-period placement', () => {
  const start = at('2026-09-02T14:00:00Z');
  const movement = {
    id: 'request',
    kind: 'request',
    startMs: start,
    endMs: start + 2 * HR,
    flightMinutes: 120,
  };
  const fit = evaluateCrewFit({
    crew: [{ uid: 'p1', name: 'Jane Pilot' }],
    allTrips: [],
    movements: [movement],
    dutyPeriods: [{
      id: 'actual',
      pilotUid: 'p1',
      pilotName: 'Jane Pilot',
      dutyOnAt: start - 20 * HR,
      dutyOffAt: start - 10.5 * HR,
      flightTimeMs: 9.5 * HR,
      status: 'off',
      confirmStatus: 'self-attested',
    }],
  });
  assert.equal(fit.legal, false);
  assert.ok(fit.members[0].maxRollingFlightMinutes > 600);
  assert.match(fit.reasons.join(' '), /rolling 24h exceeds/);
});

test('outside-operator flying counts toward flight, duty, and rest limits', () => {
  const start = at('2026-09-02T14:00:00Z');
  const movement = {
    id: 'request',
    kind: 'request',
    startMs: start,
    endMs: start + 2 * HR,
    flightMinutes: 120,
  };
  const fit = evaluateCrewFit({
    crew: [{ uid: 'p1', name: 'Jane Pilot' }],
    allTrips: [],
    movements: [movement],
    dutyPeriods: [],
    outsideFlying: [{
      id: 'outside',
      pilotUid: 'p1',
      pilotName: 'Jane Pilot',
      startAt: start - 20 * HR,
      endAt: start - 10.5 * HR,
      flightTimeMs: 9.5 * HR,
      source: 'Other operator',
    }],
  });
  assert.equal(fit.legal, false);
  assert.ok(fit.members[0].maxRollingFlightMinutes > 600);
  assert.match(fit.reasons.join(' '), /rolling 24h exceeds/);
});

test('tails are ranked by delay, then repositioning', () => {
  const requested = at('2026-09-01T14:00:00Z');
  const results = rankTailAvailability({
    fleet: [
      { tail: 'NDELAY', icaoType: 'C25B', homeBase: 'TEB' },
      { tail: 'NFIT', icaoType: 'C25B', homeBase: 'APF' },
    ],
    allTrips: [],
    route: ['APF', 'MCO'],
    requestedStartMs: requested,
  });
  assert.equal(results[0].tail, 'NFIT');
  assert.equal(results[0].delayMinutes, 0);
  assert.ok(results[1].repositionMinutes > 0);
  assert.equal(formatDuration(615), '10h 15m');
});

test('Availability is a role-gated lazy Flights tab fed by the live schedule', async () => {
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(app, /AvailabilityLazy = lazy\(\(\) => import\('\.\/AvailabilityPlanner\.jsx'\)\)/);
  assert.match(app, /\{ id: 'availability', label: 'Availability'[\s\S]*?roles: \['ops', 'admin'\]/);
  assert.match(app, /children: \['schedule', 'availability', 'ops'/);
  assert.match(app, /section === 'availability'/);
  assert.match(app, /<AvailabilityLazy[\s\S]*?allTrips=\{allTrips\}[\s\S]*?config=\{config\}[\s\S]*?users=\{users\}/);
  const component = await readFile(path.join(root, 'src/AvailabilityPlanner.jsx'), 'utf8');
  assert.match(component, /subscribeOutsideReportForAllPilots\(3, setOutsideFlying\)/);
  assert.match(component, /outsideFlying,/);
});

test('round trip keeps the aircraft at the outstation and sees trips in between', () => {
  const outbound = at('2026-09-01T14:00:00Z');
  const returning = at('2026-09-03T18:00:00Z');
  const inBetweenOut = trip({
    id: 'teb-bos',
    tail: 'NTEST',
    from: 'TEB',
    to: 'BOS',
    start: outbound + 24 * HR,
    end: outbound + 25 * HR,
  });
  const inBetweenBack = trip({
    id: 'bos-teb',
    tail: 'NTEST',
    from: 'BOS',
    to: 'TEB',
    start: outbound + 29 * HR,
    end: outbound + 30 * HR,
  });
  const plan = planLiveLegAssignments({
    legs: [
      { id: 'out', from: 'APF', to: 'TEB', requestedStartMs: outbound },
      { id: 'back', from: 'TEB', to: 'APF', requestedStartMs: returning },
    ],
    fleet: fleet({ costPerBlockHour: 2000, sellPerBlockHour: 5000 }),
    allTrips: [inBetweenOut, inBetweenBack],
    assignments: { out: 'NTEST', back: 'NTEST' },
    planningNowMs: outbound - 2 * HR,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.legs.length, 2);
  assert.equal(plan.legs[0].selected.next.id, 'teb-bos');
  assert.equal(plan.legs[1].selected.previous.id, 'bos-teb');
  assert.equal(plan.legs[0].selected.movements.some((m) => (
    m.kind === 'reposition-out' && m.from === 'TEB' && m.to === 'APF'
  )), false);
  assert.equal(plan.legs[1].selected.movements.some((m) => m.kind === 'reposition-in'), false);
});

test('each live leg ranks multiple tails and allows a different selected tail', () => {
  const start = at('2026-09-01T14:00:00Z');
  const plan = planLiveLegAssignments({
    legs: [
      { id: 'one', from: 'APF', to: 'MCO', requestedStartMs: start },
      { id: 'two', from: 'MCO', to: 'TEB', requestedStartMs: start + 6 * HR },
    ],
    fleet: [
      { tail: 'N1', icaoType: 'C25B', homeBase: 'APF', costPerBlockHour: 1800, sellPerBlockHour: 4500 },
      { tail: 'N2', icaoType: 'C25B', homeBase: 'MCO', costPerBlockHour: 2000, sellPerBlockHour: 4800 },
    ],
    allTrips: [],
    assignments: { one: 'N1', two: 'N2' },
    planningNowMs: start - 3 * HR,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.legs[0].options.length, 2);
  assert.equal(plan.legs[1].options.length, 2);
  assert.equal(plan.legs[0].selected.tail, 'N1');
  assert.equal(plan.legs[1].selected.tail, 'N2');
});

test('multiple aircraft types can be checked together', () => {
  const start = at('2026-09-01T14:00:00Z');
  const base = {
    legs: [{ id: 'one', from: 'APF', to: 'TEB', requestedStartMs: start }],
    fleet: [
      { tail: 'NCJ', icaoType: 'C25B', typeFilterId: 'C25B', homeBase: 'APF' },
      { tail: 'NLJ', icaoType: 'LJ60', typeFilterId: 'LJ60', homeBase: 'APF' },
      { tail: 'NSF', icaoType: 'SF50', typeFilterId: 'SF50', homeBase: 'APF' },
    ],
    allTrips: [],
    planningNowMs: start - HR,
  };
  const twoTypes = planLiveLegAssignments({
    ...base,
    selectedTypeIds: ['C25B', 'LJ60'],
  });
  assert.deepEqual(
    twoTypes.legs[0].options.map((option) => option.tail).sort(),
    ['NCJ', 'NLJ'],
  );
  const oneType = planLiveLegAssignments({
    ...base,
    selectedTypeIds: ['SF50'],
  });
  assert.deepEqual(oneType.legs[0].options.map((option) => option.tail), ['NSF']);
});

test('pricing costs all movement block but sells only live block', () => {
  const start = at('2026-09-01T14:00:00Z');
  const [option] = rankTailAvailability({
    fleet: fleet({ homeBase: 'TEB' }),
    allTrips: [],
    route: ['APF', 'MCO'],
    requestedStartMs: start,
    planningNowMs: start - 6 * HR,
  });
  const pricing = priceAvailabilityOption(option, {
    costPerBlockHour: 2000,
    sellPerBlockHour: 5000,
  });
  assert.ok(pricing.repositionBlockMinutes > 0);
  assert.equal(pricing.totalBlockMinutes, pricing.billableBlockMinutes + pricing.repositionBlockMinutes);
  assert.equal(pricing.cost, Math.round(2000 * pricing.totalBlockMinutes / 60 * 100) / 100);
  assert.equal(pricing.sell, Math.round(5000 * pricing.billableBlockMinutes / 60 * 100) / 100);
  assert.equal(pricing.margin, Math.round((pricing.sell - pricing.cost) * 100) / 100);
});

test('whole-trip price totals selected aircraft per leg and flags missing rates', () => {
  const start = at('2026-09-01T14:00:00Z');
  const plan = planLiveLegAssignments({
    legs: [
      { id: 'out', from: 'APF', to: 'MCO', requestedStartMs: start },
      { id: 'back', from: 'MCO', to: 'APF', requestedStartMs: start + 8 * HR },
    ],
    fleet: [
      { tail: 'N1', icaoType: 'C25B', homeBase: 'APF', costPerBlockHour: 2000, sellPerBlockHour: 5000 },
      { tail: 'N2', icaoType: 'C25B', homeBase: 'MCO', costPerBlockHour: 2500, sellPerBlockHour: 5500 },
    ],
    allTrips: [],
    assignments: { out: 'N1', back: 'N2' },
    planningNowMs: start - HR,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.totals.missingRates.length, 0);
  const sumCost = plan.legs.reduce((sum, leg) => sum + leg.selected.pricing.cost, 0);
  const sumSell = plan.legs.reduce((sum, leg) => sum + leg.selected.pricing.sell, 0);
  assert.equal(plan.totals.cost, Math.round(sumCost * 100) / 100);
  assert.equal(plan.totals.sell, Math.round(sumSell * 100) / 100);

  const missing = planLiveLegAssignments({
    legs: [{ id: 'one', from: 'APF', to: 'MCO', requestedStartMs: start }],
    fleet: [{ tail: 'N3', icaoType: 'C25B', homeBase: 'APF' }],
    allTrips: [],
    planningNowMs: start - HR,
  });
  assert.equal(missing.totals.cost, null);
  assert.deepEqual(missing.totals.missingRates.sort(), ['N3 operating cost', 'N3 sell rate']);
});

test('an unfit selected leg never produces a misleading zero-dollar total', () => {
  const start = at('2026-09-01T14:00:00Z');
  const plan = planLiveLegAssignments({
    legs: [{ id: 'one', from: 'UNKNOWN1', to: 'UNKNOWN2', requestedStartMs: start }],
    fleet: [{
      tail: 'N1',
      icaoType: 'C25B',
      homeBase: 'APF',
      costPerBlockHour: 2000,
      sellPerBlockHour: 5000,
    }],
    allTrips: [],
    planningNowMs: start - HR,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.totals.cost, null);
  assert.equal(plan.totals.sell, null);
  assert.equal(plan.totals.margin, null);
});

