import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTripMeta } from '../api/send-push.js';

test('the caller decides which aircraft a notification names', () => {
  // Reported bug: crew flying N444AM received notifications titled N286N
  // because a stale trips/{id} document outranked the leg the user acted on.
  const stale = { info: { tail: 'N286N', from: 'TVC', to: 'IAD', pic: 'Someone Else' } };
  const meta = resolveTripMeta(stale, {
    tripTail: 'N444AM',
    tripFrom: 'IAD',
    tripTo: 'HYA',
    tripPicName: 'Maxwell Hagberg',
  });
  assert.equal(meta.tail, 'N444AM');
  assert.equal(meta.label, 'N444AM · IAD→HYA');
  assert.equal(meta.picName, 'Maxwell Hagberg');
  assert.equal(meta.staleTail, true);
});

test('a stale trip doc cannot misroute recipients either', () => {
  const stale = { info: { pic: 'Wrong Pilot', sic: 'Wrong SIC' } };
  const meta = resolveTripMeta(stale, { tripPicName: 'Real PIC', tripSicName: 'Real SIC' });
  assert.equal(meta.picName, 'Real PIC');
  assert.equal(meta.sicName, 'Real SIC');
});

test('the trip doc still fills gaps the caller leaves empty', () => {
  const doc = { info: { tail: 'N444AM', from: 'KTEB', to: 'KPBI', pic: 'Doc PIC' } };
  const meta = resolveTripMeta(doc, { tripTail: '', tripFrom: '', tripTo: '' });
  assert.equal(meta.tail, 'N444AM');
  assert.equal(meta.label, 'N444AM · KTEB→KPBI');
  assert.equal(meta.picName, 'Doc PIC');
  assert.equal(meta.staleTail, false, 'filling a gap is not a disagreement');
});

test('iCal trips with no Firestore doc use the caller payload', () => {
  const meta = resolveTripMeta(null, { tripTail: 'N286N', tripFrom: 'TVC', tripTo: 'IAD' });
  assert.equal(meta.label, 'N286N · TVC→IAD');
  assert.equal(meta.staleTail, false);
});

test('a partial route never renders a half arrow', () => {
  assert.equal(resolveTripMeta(null, { tripTail: 'N444AM', tripFrom: 'IAD' }).label, 'N444AM');
  assert.equal(resolveTripMeta(null, {}).label, '');
});

test('whitespace and casing differences are not treated as a different aircraft', () => {
  const meta = resolveTripMeta({ info: { tail: 'n444am' } }, { tripTail: ' N444AM ' });
  assert.equal(meta.tail, 'N444AM');
  assert.equal(meta.staleTail, false);
});
