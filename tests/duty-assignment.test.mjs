import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assignedTailFor, findAssignedTrip, tripTail } from '../src/duty-assignment.js';

const root = path.resolve(import.meta.dirname, '..');
const HOUR = 3600 * 1000;

test('tripTail normalizes and uppercases', () => {
  assert.equal(tripTail({ info: { tail: 'n444am' } }), 'N444AM');
  assert.equal(tripTail({ tail: ' N12 ' }), 'N12');
  assert.equal(tripTail({ info: {} }), null);
});

test('picks the trip in progress at duty-on', () => {
  const onAt = Date.parse('2026-08-07T14:00:00Z');
  const trips = [
    { id: 'a', info: { tail: 'N1', from: 'KAPF', to: 'KTEB', isFlight: true }, start: '2026-08-07T13:00:00Z', end: '2026-08-07T18:00:00Z' },
    { id: 'b', info: { tail: 'N2', from: 'KTEB', to: 'KMIA', isFlight: true }, start: '2026-08-08T13:00:00Z', end: '2026-08-08T18:00:00Z' },
  ];
  assert.equal(findAssignedTrip(trips, onAt).id, 'a');
  assert.equal(assignedTailFor(trips, onAt), 'N1');
});

test('falls back to the next trip starting within the 14h period', () => {
  const onAt = Date.parse('2026-08-07T12:00:00Z');
  const trips = [
    { id: 'soon', info: { tail: 'N9', from: 'KTEB', to: 'KPBI', isFlight: true }, start: '2026-08-07T15:00:00Z', end: '2026-08-07T20:00:00Z' },
    { id: 'tomorrow', info: { tail: 'N8', from: 'KPBI', to: 'KOPF', isFlight: true }, start: '2026-08-09T09:00:00Z' },
  ];
  assert.equal(findAssignedTrip(trips, onAt).id, 'soon');
});

test('ignores trips beyond the duty window or without a tail', () => {
  const onAt = Date.parse('2026-08-07T12:00:00Z');
  const trips = [
    { id: 'notail', info: { from: 'KTEB', to: 'KMIA' }, start: '2026-08-07T13:00:00Z' },
    { id: 'far', info: { tail: 'N7', from: 'KTEB', to: 'KMIA', isFlight: true }, start: new Date(onAt + 30 * HOUR).toISOString() },
  ];
  assert.equal(findAssignedTrip(trips, onAt), null);
  assert.equal(assignedTailFor(trips, onAt), null);
});

test('a covering crew-assignment block does not beat the real flight', () => {
  const onAt = Date.parse('2026-10-01T18:00:00Z');
  const trips = [
    {
      id: 'assign',
      uid: 'assign',
      info: {
        tail: 'N525CR',
        from: '----',
        to: '----',
        customer: 'Crew 525CR',
        tripType: 'Crew assignment',
        category: 'REPO',
        isFlight: true,
        rawSummary: '[N525CR] Crew 525CR - Crew assignment',
      },
      start: '2026-09-29T04:00:00Z',
      end: '2026-10-02T20:00:00Z',
    },
    {
      id: 'leg',
      uid: 'leg',
      info: { tail: 'N444AM', from: 'IAD', to: 'HYA', category: 'REVENUE', isFlight: true },
      start: '2026-10-01T16:00:00Z',
      end: '2026-10-01T19:00:00Z',
    },
  ];
  assert.equal(findAssignedTrip(trips, onAt).id, 'leg');
  assert.equal(assignedTailFor(trips, onAt), 'N444AM');
});

test('duty start form auto-assigns and always records the tail', async () => {
  const duty = await readFile(path.join(root, 'src/DutyV2.jsx'), 'utf8');
  assert.match(duty, /assignedTailFor|findAssignedTrip/);
  assert.match(duty, /tail: \(tail\.trim\(\) \|\| assignedTail/);
  assert.match(duty, /auto-assigned/);
});
