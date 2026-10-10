import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIVE_LINK_CACHE_GRACE_MS,
  getLiveLink,
  noteDeviceNetwork,
  noteListenerFailure,
  noteSnapshotMetadata,
  refreshLiveLink,
  resetLiveLinkForTests,
} from '../src/live-link.js';

test.beforeEach(() => {
  resetLiveLinkForTests();
});

test('a cache snapshot stays quiet until the grace window, then shows reconnecting', () => {
  const start = 1_000_000;
  noteSnapshotMetadata({ fromCache: true }, start);
  assert.equal(refreshLiveLink(start + LIVE_LINK_CACHE_GRACE_MS - 1).phase, 'live');
  assert.equal(refreshLiveLink(start + LIVE_LINK_CACHE_GRACE_MS).phase, 'reconnecting');
});

test('a server snapshot clears the reconnecting banner', () => {
  const start = 5_000;
  noteSnapshotMetadata({ fromCache: true }, start);
  assert.equal(refreshLiveLink(start + LIVE_LINK_CACHE_GRACE_MS).phase, 'reconnecting');

  noteSnapshotMetadata({ fromCache: false }, start + LIVE_LINK_CACHE_GRACE_MS + 10);
  assert.equal(getLiveLink().phase, 'live');
});

test('a server snapshot inside the grace window never shows the banner', () => {
  const start = 8_000;
  noteSnapshotMetadata({ fromCache: true }, start);
  noteSnapshotMetadata({ fromCache: false }, start + 200);
  assert.equal(refreshLiveLink(start + LIVE_LINK_CACHE_GRACE_MS + 50).phase, 'live');
});

test('a listener error shows immediately and clears when that listener is released', () => {
  const release = noteListenerFailure();
  assert.equal(getLiveLink().phase, 'reconnecting');
  release();
  assert.equal(getLiveLink().phase, 'live');
  release();
  assert.equal(getLiveLink().phase, 'live');
});

test('device offline wins, and coming back waits for a server snapshot', () => {
  const start = 10_000;
  noteSnapshotMetadata({ fromCache: false }, start);
  assert.equal(getLiveLink().phase, 'live');

  noteDeviceNetwork(false, start + 100);
  assert.equal(getLiveLink().phase, 'offline');

  noteDeviceNetwork(true, start + 200);
  assert.equal(getLiveLink().phase, 'reconnecting');

  noteSnapshotMetadata({ fromCache: false }, start + 300);
  assert.equal(getLiveLink().phase, 'live');
});
