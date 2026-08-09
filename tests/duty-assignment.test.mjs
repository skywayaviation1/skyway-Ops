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
    { id: 'a', info: { tail: 'N1', from: 'KAPF' }, start: '2026-08-07T13:00:00Z', end: '2026-08-07T18:00:00Z' },
    { id: 'b', info: { tail: 'N2' }, start: '2026-08-08T13:00:00Z', end: '2026-08-08T18:00:00Z' },
  ];
  assert.equal(findAssignedTrip(trips, onAt).id, 'a');
  assert.equal(assignedTailFor(trips, onAt), 'N1');
});

test('falls back to the next trip starting within the 14h period', () => {
  const onAt = Date.parse('2026-08-07T12:00:00Z');
  const trips = [
    { id: 'soon', info: { tail: 'N9' }, start: '2026-08-07T15:00:00Z', end: '2026-08-07T20:00:00Z' },
    { id: 'tomorrow', info: { tail: 'N8' }, start: '2026-08-09T09:00:00Z' },
  ];
  assert.equal(findAssignedTrip(trips, onAt).id, 'soon');
});

test('ignores trips beyond the duty window or without a tail', () => {
  const onAt = Date.parse('2026-08-07T12:00:00Z');
  const trips = [
    { id: 'notail', info: {}, start: '2026-08-07T13:00:00Z' },
    { id: 'far', info: { tail: 'N7' }, start: new Date(onAt + 30 * HOUR).toISOString() },
  ];
  assert.equal(findAssignedTrip(trips, onAt), null);
  assert.equal(assignedTailFor(trips, onAt), null);
});

test('duty start form auto-assigns and always records the tail', async () => {
  const duty = await readFile(path.join(root, 'src/DutyV2.jsx'), 'utf8');
  assert.match(duty, /assignedTailFor|findAssignedTrip/);
  assert.match(duty, /tail: \(tail\.trim\(\) \|\| assignedTail/);
  assert.match(duty, /auto-assigned/);
});
