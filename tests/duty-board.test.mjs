import assert from 'node:assert/strict';
import test from 'node:test';

import { crewLimitSnapshot, groupLiveCrew } from '../src/duty-board.js';
import { LIMITS } from '../src/duty-limits.js';

const HOUR = 3600_000;

test('live board pairs reciprocal crew and leaves a missing link on its own card', () => {
  const now = Date.parse('2026-10-01T18:00:00Z');
  const crews = groupLiveCrew([
    {
      id: 'matt',
      pilotUid: 'matt',
      pilotName: 'Matt Hale',
      status: 'on',
      dutyOnAt: now - 4 * HOUR,
      crewType: 'two',
      partnerPeriodId: 'daniel',
      tail: 'N444AM',
      role: 'SIC',
    },
    {
      id: 'daniel',
      pilotUid: 'daniel',
      pilotName: 'Daniel Cho',
      status: 'on',
      dutyOnAt: now - 4 * HOUR,
      crewType: 'two',
      partnerPeriodId: 'matt',
      tail: 'N444AM',
      role: 'PIC',
    },
    {
      id: 'solo',
      pilotUid: 'kameron',
      pilotName: 'Kameron Blake',
      status: 'on',
      dutyOnAt: now - HOUR,
      crewType: 'two',
      partnerPeriodId: null,
      tail: 'N651TW',
      role: 'PIC',
    },
  ]);
  assert.equal(crews.length, 2);
  const paired = crews.find((crew) => crew.linked);
  assert.deepEqual(paired.members.map((member) => member.id).sort(), ['daniel', 'matt']);
  const alone = crews.find((crew) => !crew.linked);
  assert.equal(alone.members[0].id, 'solo');
  assert.equal(alone.brokenLink, false);
});

test('nine point three paired hours stay on the 10-hour flight limit', () => {
  const now = Date.parse('2026-10-01T22:00:00Z');
  const snapshot = crewLimitSnapshot({
    dutyOnAt: now - 15 * HOUR,
    crewType: 'two',
    assignmentType: 'regular',
    flightTimeMs: 9.3 * HOUR,
    status: 'on',
  }, now);
  assert.equal(snapshot.flightLimitMs, LIMITS.TWO_PILOT_FLIGHT_MAX_MS);
  assert.equal(snapshot.pairedDesignation, true);
  assert.ok(snapshot.remainingFlightMs > 0);
  assert.ok(snapshot.remainingDutyMs < 0);
});
