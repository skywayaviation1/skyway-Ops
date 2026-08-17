import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FRAT_CONFIG,
  FRAT_CHECKLIST,
  FRAT_CONFIG_SCHEMA,
  computeFrat,
  fratLevelForScore,
  fratSummary,
  normalizeFratConfig,
  requiredChecklistItems,
} from '../src/frat.js';

/** All checklist items answered the non-adverse way. */
function cleanChecklist() {
  return Object.fromEntries(FRAT_CHECKLIST.map((i) => [i.id, i.invert ? true : false]));
}

const CLEAN_LEG = {
  trip: {
    start: '2030-06-15T15:00:00Z',
    end: '2030-06-15T16:30:00Z',
    info: {
      from: 'KAPF', to: 'KBCT', tail: 'N123AB',
      pic: 'Jane Pilot', sic: 'John Copilot', pax: 2,
      legType: 'REVENUE', category: 'REVENUE',
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
};

test('frat levels map score bands from config', () => {
  assert.equal(fratLevelForScore(0).id, 'low');
  assert.equal(fratLevelForScore(15).id, 'low');
  assert.equal(fratLevelForScore(16).id, 'moderate');
  assert.equal(fratLevelForScore(40).id, 'high');
  assert.equal(fratLevelForScore(80).id, 'severe');

  const strict = normalizeFratConfig({ levels: { low: 5, moderate: 10, high: 20 } });
  assert.equal(fratLevelForScore(6, strict).id, 'moderate');
  assert.equal(fratLevelForScore(21, strict).id, 'severe');
});

test('LIFR weather and AOG produce a severe no-go FRAT', () => {
  const result = computeFrat({
    trip: {
      start: '2030-06-15T23:30:00Z',
      end: '2030-06-16T02:00:00Z',
      info: {
        from: 'APF', to: 'MYNN', tail: 'N123AB',
        pic: '', sic: '', pax: 4, legType: 'REVENUE', category: 'REVENUE',
      },
    },
    originWx: {
      ok: true,
      metar: { flightCategory: 'LIFR', ceilingFt: 200, visibilitySm: 0.5, windGustKt: 38, rawMetar: 'METAR' },
    },
    destWx: { ok: true, metar: { flightCategory: 'IFR', ceilingFt: 800, visibilitySm: 2 } },
    originNotams: {
      significantOnly: [{ severity: 'high' }, { severity: 'medium' }],
    },
    aircraftStatus: { status: 'AOG', reasons: ['Brake failure'], melOpen: 0 },
    squawkSummary: { grounding: 1, openSquawks: 0, melCount: 0 },
    outstanding: [{ code: 'ops-hold', label: 'Ops hold', severity: 'critical' }],
    tripState: { opsDisposition: 'hold', opsDispositionReason: 'Wx' },
    checklist: cleanChecklist(),
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
  const result = computeFrat({ ...CLEAN_LEG, checklist: cleanChecklist() });
  assert.ok(result.score <= 15, `expected low score, got ${result.score}`);
  assert.equal(result.level, 'low');
  assert.equal(result.go, true);
  assert.equal(result.unanswered.length, 0);
  assert.equal(fratSummary(result).score, result.score);
  assert.deepEqual(fratSummary(result).thresholds, DEFAULT_FRAT_CONFIG.levels);
});

test('IMSAFE alcohol yes is a blocker', () => {
  const checklist = { ...cleanChecklist(), alcohol: true };
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

test('config normalization fills gaps, clamps values and orders bands', () => {
  const normalized = normalizeFratConfig({
    levels: { low: 40, moderate: 10, high: 5 },
    weather: { categoryPoints: { IFR: -50 } },
    crew: { missingPicBlocks: 'not-a-boolean' },
    checklist: { alcohol: { points: 5000 } },
    junkKey: true,
  });

  assert.ok(normalized.levels.moderate > normalized.levels.low);
  assert.ok(normalized.levels.high > normalized.levels.moderate);
  assert.equal(normalized.weather.categoryPoints.IFR, 0);
  assert.equal(normalized.weather.categoryPoints.LIFR, DEFAULT_FRAT_CONFIG.weather.categoryPoints.LIFR);
  assert.equal(normalized.crew.missingPicBlocks, true);
  assert.equal(normalized.checklist.alcohol.points, 1000);
  assert.equal('junkKey' in normalized, false);
});

test('weights change the score for identical inputs', () => {
  const input = {
    trip: {
      start: '2030-06-15T15:00:00Z',
      end: '2030-06-15T16:00:00Z',
      info: { from: 'KAPF', to: 'KBCT', tail: 'N1', pic: 'A B', sic: 'C D', legType: 'REVENUE' },
    },
    originWx: { ok: true, metar: { flightCategory: 'IFR', ceilingFt: 900, visibilitySm: 2.5 } },
    destWx: { ok: true, metar: { flightCategory: 'VFR', ceilingFt: 8000, visibilitySm: 10 } },
    aircraftStatus: { status: 'AIRWORTHY', melOpen: 0, reasons: [] },
    squawkSummary: { grounding: 0, openSquawks: 0 },
    pic: { name: 'A B', resolved: true, legality: { status: 'legal' }, currency: { status: 'current' } },
    sic: { name: 'C D', resolved: true, legality: { status: 'legal' }, currency: { status: 'current' } },
    checklist: cleanChecklist(),
  };

  const baseline = computeFrat(input);
  const heavier = computeFrat({
    ...input,
    config: { weather: { categoryPoints: { IFR: 40 }, ceilingMedPoints: 20, visMedPoints: 20 } },
  });
  assert.ok(heavier.score > baseline.score, `${heavier.score} should exceed ${baseline.score}`);

  const disabled = computeFrat({ ...input, config: { weather: { enabled: false } } });
  assert.ok(disabled.score < baseline.score);
  assert.equal(disabled.factors.some((f) => f.category === 'Weather'), false);
});

test('blocker flags are configurable', () => {
  const input = {
    trip: {
      start: '2030-06-15T15:00:00Z',
      info: { from: 'KAPF', to: 'KBCT', tail: 'N1', pic: 'A B', legType: 'REPO' },
    },
    aircraftStatus: { status: 'AOG', reasons: ['test'], melOpen: 0 },
    squawkSummary: { grounding: 0, openSquawks: 0 },
    pic: { name: 'A B', resolved: true },
    checklist: cleanChecklist(),
  };

  assert.ok(computeFrat(input).blockers.some((b) => b.id === 'ac-aog'));
  const lenient = computeFrat({ ...input, config: { aircraft: { aogBlocks: false } } });
  assert.equal(lenient.blockers.some((b) => b.id === 'ac-aog'), false);
  assert.ok(lenient.factors.some((f) => f.id === 'ac-aog'));
});

test('severe band no longer forces no-go when disabled', () => {
  const input = {
    ...CLEAN_LEG,
    // Marginal weather so the leg carries points and the tight bands below
    // actually push it into SEVERE.
    originWx: { ok: true, metar: { flightCategory: 'IFR', ceilingFt: 900, visibilitySm: 2 } },
    checklist: cleanChecklist(),
    config: { levels: { low: 1, moderate: 2, high: 3 } },
  };
  const strict = computeFrat(input);
  assert.equal(strict.level, 'severe');
  assert.equal(strict.go, false);

  const relaxed = computeFrat({
    ...input,
    config: { levels: { low: 1, moderate: 2, high: 3 }, severeIsNoGo: false },
  });
  assert.equal(relaxed.level, 'severe');
  assert.equal(relaxed.go, true);
});

test('checklist items can be disabled or made optional', () => {
  const config = {
    checklist: {
      stress: { enabled: false },
      fatigue: { required: false },
    },
  };
  const required = requiredChecklistItems(config).map((i) => i.id);
  assert.equal(required.includes('stress'), false);
  assert.equal(required.includes('fatigue'), false);
  assert.ok(required.includes('alcohol'));

  const result = computeFrat({
    trip: { start: '2030-06-15T15:00:00Z', info: { from: 'KAPF', to: 'KBCT', tail: 'N1', pic: 'A B', legType: 'REPO' } },
    pic: { name: 'A B', resolved: true },
    config,
    checklist: { ...cleanChecklist(), stress: true },
  });
  assert.equal(result.factors.some((f) => f.id === 'check-stress'), false);
});

test('settings schema only references real config paths', () => {
  const defaults = normalizeFratConfig(null);
  for (const group of FRAT_CONFIG_SCHEMA) {
    assert.ok(defaults[group.group], `unknown group ${group.group}`);
    for (const field of group.fields) {
      const value = field.key.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), defaults[group.group]);
      assert.notEqual(value, undefined, `${group.group}.${field.key} is not in the config`);
      if (field.type === 'boolean') {
        assert.equal(typeof value, 'boolean', `${group.group}.${field.key} should be boolean`);
      } else {
        assert.equal(typeof value, 'number', `${group.group}.${field.key} should be numeric`);
      }
    }
  }
});
