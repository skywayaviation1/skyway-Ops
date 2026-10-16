import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  mapHasLayout,
  programmaticViewOptions,
  clampedFitPadding,
  settleLeafletFrame,
  syncVendorBasemaps,
  consumeFitKey,
  shouldFollowFleet,
} from '../src/tracking-map.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('mapHasLayout rejects a zero-size Leaflet frame', () => {
  assert.equal(mapHasLayout({ x: 0, y: 640 }), false);
  assert.equal(mapHasLayout({ x: 390, y: 0 }), false);
  assert.equal(mapHasLayout(null), false);
  assert.equal(mapHasLayout({ width: 800, height: 600 }), true);
});

test('programmatic views do not animate', () => {
  assert.deepEqual(programmaticViewOptions(), { animate: false });
});

test('flight chrome insets are clamped so Leaflet cannot compute a NaN zoom', () => {
  const phone = clampedFitPadding(
    { x: 390, y: 500 },
    { top: 188, left: 28, right: 72, bottom: 250 },
  );
  assert.ok(phone.left + phone.right <= 390 - 80);
  assert.ok(phone.top + phone.bottom <= 500 - 80);
  assert.ok(phone.top > 0 && phone.bottom > 0);

  const desktop = clampedFitPadding(
    { x: 1280, y: 400 },
    { top: 210, left: 320, right: 320, bottom: 210 },
  );
  assert.ok(desktop.left + desktop.right <= 1280 - 80);
  assert.ok(desktop.top + desktop.bottom <= 400 - 80);
  assert.ok(desktop.left > 0 && desktop.right > 0);

  const roomy = clampedFitPadding(
    { x: 1440, y: 900 },
    { top: 40, left: 40, right: 40, bottom: 40 },
  );
  assert.deepEqual(roomy, { left: 40, top: 40, right: 40, bottom: 40 });
});

function fakeMap({ size, dragging = false } = {}) {
  const calls = [];
  let current = size;
  const map = {
    dragging: { _dragging: dragging },
    calls,
    stop() { calls.push('stop'); },
    invalidateSize(options) {
      calls.push(['invalidate', options]);
      if (current.x === 0 && current.y === 0) current = { x: 800, y: 600 };
    },
    getSize() { return current; },
    getCenter() { return { lat: 39, lng: -96 }; },
    getZoom() { return 4; },
    setView(center, zoom, options) { calls.push(['setView', zoom, options]); },
  };
  return map;
}

test('settleLeafletFrame redraws once a zero-size map gains layout and syncs vendors', () => {
  const map = fakeMap({ size: { x: 0, y: 0 } });
  const result = settleLeafletFrame(map, { sync() { map.calls.push('sync'); } });
  assert.equal(result.settled, true);
  assert.equal(result.gainedLayout, true);
  assert.ok(map.calls.includes('stop'));
  assert.deepEqual(map.calls.find((entry) => entry[0] === 'setView')[2], { animate: false });
  assert.ok(map.calls.includes('sync'));
});

test('settleLeafletFrame does not move a map that is still 0×0 or being dragged', () => {
  const stuck = fakeMap({ size: { x: 0, y: 0 } });
  stuck.invalidateSize = () => { stuck.calls.push('invalidate'); };
  const stuckResult = settleLeafletFrame(stuck, { sync() { stuck.calls.push('sync'); } });
  assert.equal(stuckResult.settled, false);
  assert.equal(stuck.calls.includes('sync'), false);
  assert.equal(stuck.calls.some((entry) => entry[0] === 'setView'), false);

  const dragging = fakeMap({ size: { x: 800, y: 600 }, dragging: true });
  const dragResult = settleLeafletFrame(dragging, { forceView: true, sync() { dragging.calls.push('sync'); } });
  assert.equal(dragResult.settled, false);
  assert.equal(dragging.calls.includes('stop'), false);
  assert.equal(dragging.calls.includes('sync'), false);
});

test('an already laid-out resize syncs vendors without resetting the view', () => {
  const map = fakeMap({ size: { x: 800, y: 600 } });
  const result = settleLeafletFrame(map, { sync() { map.calls.push('sync'); } });
  assert.equal(result.settled, true);
  assert.equal(result.gainedLayout, false);
  assert.equal(map.calls.includes('stop'), false);
  assert.equal(map.calls.some((entry) => entry[0] === 'setView'), false);
  assert.ok(map.calls.includes('sync'));
});

test('consumeFitKey waits for a real size and then frames once', () => {
  const map = { size: { x: 0, y: 0 }, getSize() { return this.size; } };
  const blocked = consumeFitKey({ map, fitKey: 'N444AM:trail', lastFitKey: null, hasGeometry: true });
  assert.equal(blocked.shouldFit, false);
  assert.equal(blocked.nextFitKey, null);

  map.size = { x: 390, y: 700 };
  const ready = consumeFitKey({ map, fitKey: 'N444AM:trail', lastFitKey: blocked.nextFitKey, hasGeometry: true });
  assert.equal(ready.shouldFit, true);
  assert.equal(ready.nextFitKey, 'N444AM:trail');

  const again = consumeFitKey({ map, fitKey: 'N444AM:trail', lastFitKey: ready.nextFitKey, hasGeometry: true });
  assert.equal(again.shouldFit, false);

  const empty = consumeFitKey({ map, fitKey: 'next', lastFitKey: null, hasGeometry: false });
  assert.equal(empty.shouldFit, false);
  assert.equal(empty.nextFitKey, null);
});

test('fleet follow waits until the map is laid out and the user has not panned', () => {
  assert.equal(shouldFollowFleet({ followFleet: true, userMoved: false, signature: 'N444AM', laidOut: false }), false);
  assert.equal(shouldFollowFleet({ followFleet: true, userMoved: true, signature: 'N444AM', laidOut: true }), false);
  assert.equal(shouldFollowFleet({ followFleet: false, userMoved: false, signature: 'N444AM', laidOut: true }), false);
  assert.equal(shouldFollowFleet({ followFleet: true, userMoved: false, signature: 'N444AM', laidOut: true }), true);
});

test('vendor basemaps are resized and region-synced without waiting for a move', () => {
  const calls = [];
  const map = {
    __swGoogleSync() { calls.push('google-sync'); },
    __swAppleSync() { calls.push('apple-sync'); },
  };
  const mapsEvent = { trigger(target, name) { calls.push([name, target]); } };
  syncVendorBasemaps(map, 'google-map', mapsEvent);
  assert.deepEqual(calls, [['resize', 'google-map'], 'google-sync', 'apple-sync']);
});

test('TrackingMap settles on load instead of animating the first fit', async () => {
  const source = await readFile(path.join(root, 'src/TrackingMap.jsx'), 'utf8');
  assert.match(source, /settleLeafletFrame/);
  assert.match(source, /programmaticViewOptions\(\)/);
  assert.match(source, /clampedFitPadding/);
  assert.match(source, /consumeFitKey/);
  assert.match(source, /shouldFollowFleet/);
  assert.match(source, /syncVendorBasemaps/);
  assert.match(source, /requestAnimationFrame\(\(\) => requestAnimationFrame\(kickApple\)\)/);
  assert.match(source, /google\.maps\.event\.trigger\(googleMap, 'resize'\)/);
  assert.doesNotMatch(source, /animate:\s*true/);
});
