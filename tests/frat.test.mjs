import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FRAT_CHECKLIST,
  computeFrat,
  fratLevelForScore,
  fratSummary,
} from '../src/frat.js';

test('frat levels map score bands', () => {
  assert.equal(fratLevelForScore(0).id, 'low');
  assert.equal(fratLevelForScore(15).id, 'low');
  assert.equal(fratLevelForScore(16).id, 'moderate');
  assert.equal(fratLevelForScore(40).id, 'high');
  assert.equal(fratLevelForScore(80).id, 'severe');
});

test('LIFR weather and AOG produce a severe no-go FRAT', () => {
  const result = computeFrat({
    trip: {
      start: '2030-06-15T23:30:00Z',
      end: '2030-06-16T02:00:00Z',
      info: {
        from: 'APF',
        to: 'MYNN',
        tail: 'N123AB',
        pic: '',
        sic: '',
        pax: 4,
        legType: 'REVENUE',
        category: 'REVENUE',
      },
    },
    originWx: {
      ok: true,
      metar: { flightCategory: 'LIFR', ceilingFt: 200, visibilitySm: 0.5, windGustKt: 38, rawMetar: 'METAR' },
    },
    destWx: {
      ok: true,
      metar: { flightCategory: 'IFR', ceilingFt: 800, visibilitySm: 2 },
    },
    originNotams: {
      significantOnly: [
        { severity: 'high', summary: 'RWY CLSD' },
        { severity: 'medium', summary: 'TWY WIP' },
      ],
    },
    aircraftStatus: { status: 'AOG', reasons: ['Brake failure'], melOpen: 0 },
    squawkSummary: { grounding: 1, openSquawks: 0, melCount: 0 },
    outstanding: [{ code: 'ops-hold', label: 'Ops hold', severity: 'critical' }],
    tripState: { opsDisposition: 'hold', opsDispositionReason: 'Wx' },
    checklist: Object.fromEntries(FRAT_CHECKLIST.map((i) => [i.id, i.invert ? true : false])),
  });

  assert.ok(result.score >= 50, `expected severe score, got ${result.score}`);
  assert.equal(result.level, 'severe');
  assert.equal(result.go, false);
  assert.ok(result.blockers.some((b) => b.id === 'ac-aog'));
  assert.ok(result.blockers.some((b) => b.id === 'crew-missing-PIC'));
  assert.ok(result.factors.some((f) => f.id === 'ops-intl'));
  assert.ok(result.factors.some((f) => f.id === 'ops-circadian'));
});

test('clean VFR revenue leg with complete checklist is low and go', () => {
  const checklist = {};
  for (const item of FRAT_CHECKLIST) {
    checklist[item.id] = item.invert ? true : false;
  }
  const result = computeFrat({
    trip: {
      start: '2030-06-15T15:00:00Z',
      end: '2030-06-15T16:30:00Z',
      info: {
        from: 'KAPF',
        to: 'KBCT',
        tail: 'N123AB',
        pic: 'Jane Pilot',
        sic: 'John Copilot',
        pax: 2,
        legType: 'REVENUE',
        category: 'REVENUE',
      },
    },
    originWx: { ok: true, metar: { flightCategory: 'VFR', ceilingFt: 5000, visibilitySm: 10, windKt: 8 } },
    destWx: { ok: true, metar: { flightCategory: 'VFR', ceilingFt: 4000, visibilitySm: 10, windKt: 6 } },
    originNotams: { significantOnly: [] },
    destNotams: { significantOnly: [] },
    aircraftStatus: { status: 'AIRWORTHY', reasons: [], melOpen: 0 },
    squawkSummary: { grounding: 0, openSquawks: 0, melCount: 0 },
    outstanding: [],
    pic: { name: 'Jane Pilot', resolved: true, legality: { status: 'legal' }, currency: { status: 'current', expiredCount: 0, warningCount: 0 } },
    sic: { name: 'John Copilot', resolved: true, legality: { status: 'legal' }, currency: { status: 'current', expiredCount: 0, warningCount: 0 } },
    checklist,
  });

  assert.ok(result.score <= 15, `expected low score, got ${result.score}`);
  assert.equal(result.level, 'low');
  assert.equal(result.go, true);
  assert.equal(result.unanswered.length, 0);
  assert.equal(fratSummary(result).score, result.score);
});

test('IMSAFE alcohol yes is a blocker', () => {
  const checklist = Object.fromEntries(FRAT_CHECKLIST.map((i) => [i.id, i.invert ? true : false]));
  checklist.alcohol = true;
  const result = computeFrat({
    trip: {
      start: '2030-06-15T15:00:00Z',
      info: { from: 'KAPF', to: 'KBCT', tail: 'N1', pic: 'A B', legType: 'REPO', category: 'REPO' },
    },
    pic: { name: 'A B', resolved: true },
    checklist,
  });
  assert.ok(result.blockers.some((b) => b.id === 'check-alcohol'));
  assert.equal(result.go, false);
});

test('unanswered required checklist items prevent go', () => {
  const result = computeFrat({
    trip: {
      start: '2030-06-15T15:00:00Z',
      info: { from: 'KAPF', to: 'KBCT', tail: 'N1', pic: 'A B', legType: 'REPO' },
    },
    pic: { name: 'A B', resolved: true },
    checklist: {},
  });
  assert.ok(result.unanswered.length >= 5);
  assert.equal(result.go, false);
});
