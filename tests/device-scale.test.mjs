import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the website viewport covers the safe area and does not lock zoom', async () => {
  const html = await read('../index.html');
  assert.match(html, /name="viewport"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /width=device-width/);
  assert.match(html, /initial-scale=1/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(html, /maximum-scale\s*=\s*1(?:\.0)?/);
});

test('shell height uses dynamic viewport units and inputs stay at 16px', async () => {
  const css = await read('../src/index.css');
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /\.h-screen\s*\{\s*height:\s*100dvh/);
  assert.match(css, /\.min-h-screen\s*\{\s*min-height:\s*100dvh/);
  assert.match(css, /max-height:\s*90dvh/);
  assert.match(css, /font-size:\s*16px\s*!important/);
  assert.match(css, /env\(safe-area-inset-top,\s*0px\)/);
  assert.match(css, /env\(safe-area-inset-bottom,\s*0px\)/);
  assert.match(css, /env\(safe-area-inset-left,\s*0px\)/);
  assert.match(css, /env\(safe-area-inset-right,\s*0px\)/);
  assert.match(css, /\.sw-map-controls/);
  assert.match(css, /\.w-screen\s*\{\s*width:\s*100%/);
});

test('iPhone landscape, iPad split view, and edge-to-edge safe areas are configured', async () => {
  const plist = await read('../ios/App/App/Info.plist');
  assert.match(plist, /<key>UIRequiresFullScreen<\/key>\s*<false\/>/);
  assert.match(plist, /<key>UISupportedInterfaceOrientations<\/key>[\s\S]*UIInterfaceOrientationLandscapeLeft[\s\S]*UIInterfaceOrientationLandscapeRight/);
  assert.match(plist, /<key>UISupportedInterfaceOrientations~ipad<\/key>[\s\S]*UIInterfaceOrientationPortraitUpsideDown[\s\S]*UIInterfaceOrientationLandscapeRight/);

  const project = await read('../ios/App/App.xcodeproj/project.pbxproj');
  assert.match(project, /TARGETED_DEVICE_FAMILY = "1,2"/);

  const capacitor = JSON.parse(await read('../capacitor.config.json'));
  assert.equal(capacitor.ios.contentInset, 'never');
  assert.equal(capacitor.ios.preferredContentMode, 'desktop');
});

test('headers, bottom nav, and the map opt into the safe-area utilities', async () => {
  const app = await read('../src/App.jsx');
  assert.match(app, /sw-safe-top/);
  assert.match(app, /sw-safe-bottom/);
  assert.match(app, /overflow-hidden/);
  const map = await read('../src/TrackingMap.jsx');
  assert.match(map, /sw-map-controls/);
  assert.match(map, /sw-map-legend/);
  assert.match(map, /sw-safe-inset/);
});
