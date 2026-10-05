import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  accentPalette,
  brokerDocId,
  brokerLogoPath,
  brokerRecordForOps,
  cleanDisplayName,
  contentTypeForFile,
  inspectLogoBytes,
  normalizeAccentColor,
  parseBrokerEmails,
  resolvePublicBranding,
  sanitizeSvg,
  trackingPageMeta,
  validateLogoMeta,
  BROKER_LOGO_LIMIT_LABEL,
  BROKER_LOGO_MAX_BYTES,
} from '../src/broker-brand.js';
import { brand } from '../src/brand.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const LOGO_URL = '/api/broker-logo?token=signed-trip-token';

function record(overrides = {}) {
  return {
    displayName: 'Meridian Charter',
    accentColor: '#1F6B4A',
    logoPath: 'broker-logos/alex@meridiancharter.example/logo.png',
    logoContentType: 'image/png',
    showPoweredBy: false,
    email: 'alex@meridiancharter.example',
    updatedByUid: 'staff-1',
    updatedByName: 'Jordan Ops',
    ...overrides,
  };
}

test('a stored logo resolves to white-label branding and nothing internal', () => {
  const branding = resolvePublicBranding(record(), { logoUrl: LOGO_URL });
  assert.deepEqual(branding, {
    whiteLabel: true,
    displayName: 'Meridian Charter',
    accentColor: '#1F6B4A',
    logoUrl: LOGO_URL,
    logoContentType: 'image/png',
    showPoweredBy: false,
  });
  assert.equal('email' in branding, false);
  assert.equal('logoPath' in branding, false);
  assert.equal('updatedByUid' in branding, false);
  assert.equal('updatedByName' in branding, false);
});

test('no logo falls back instead of hiding the operator brand', () => {
  assert.equal(resolvePublicBranding(null, { logoUrl: LOGO_URL }), null);
  assert.equal(resolvePublicBranding({}, { logoUrl: LOGO_URL }), null);
  assert.equal(resolvePublicBranding(record({ logoPath: '' }), { logoUrl: LOGO_URL }), null);
  assert.equal(resolvePublicBranding(record({ logoPath: 'trip-sheets/secret.pdf' }), { logoUrl: LOGO_URL }), null);
  assert.equal(
    resolvePublicBranding(record({ displayName: 'Meridian Charter', logoPath: undefined }), { logoUrl: LOGO_URL }),
    null,
  );
  assert.equal(resolvePublicBranding(record(), { logoUrl: '' }), null);
});

test('powered-by stays off unless the broker record turns it on', () => {
  assert.equal(resolvePublicBranding(record({ showPoweredBy: undefined }), { logoUrl: LOGO_URL }).showPoweredBy, false);
  assert.equal(resolvePublicBranding(record({ showPoweredBy: 'true' }), { logoUrl: LOGO_URL }).showPoweredBy, false);
  assert.equal(resolvePublicBranding(record({ showPoweredBy: true }), { logoUrl: LOGO_URL }).showPoweredBy, true);
});

test('display name and accent are cleaned, and a bad accent is dropped', () => {
  const branding = resolvePublicBranding(record({
    displayName: `  ${'Meridian '.repeat(20)}  `,
    accentColor: 'green',
  }), { logoUrl: LOGO_URL });
  assert.equal(branding.displayName.length, 80);
  assert.equal(branding.accentColor, null);
  assert.equal(normalizeAccentColor('1f6b4a'), '#1F6B4A');
  assert.equal(normalizeAccentColor('#1F6B4'), null);
  assert.equal(cleanDisplayName('   '), null);
});

test('page meta names the broker when white-labeled and the operator otherwise', () => {
  const operator = brand('skyway');
  const branded = trackingPageMeta({
    branding: resolvePublicBranding(record(), { logoUrl: LOGO_URL }),
    operator,
    origin: 'https://ops.example',
  });
  assert.equal(branded.whiteLabel, true);
  assert.equal(branded.title, 'Meridian Charter · Flight tracking');
  assert.match(branded.description, /Meridian Charter/);
  assert.equal(branded.image, `https://ops.example${LOGO_URL}`);
  assert.equal(branded.themeColor, '#1F6B4A');
  assert.equal(branded.showPoweredBy, false);
  assert.doesNotMatch(branded.title, /Skyway/);
  assert.doesNotMatch(branded.description, /Skyway/);

  const fallback = trackingPageMeta({ branding: null, operator, origin: 'https://ops.example' });
  assert.equal(fallback.whiteLabel, false);
  assert.match(fallback.title, /Skyway Aviation/);
  assert.equal(fallback.image, null);
  assert.equal(fallback.showPoweredBy, false);
});

test('broker identity is the normalized email, and logo paths stay under that record', () => {
  assert.equal(brokerDocId('  Alex@MeridianCharter.example '), 'alex@meridiancharter.example');
  assert.equal(brokerDocId('not an email'), null);
  assert.equal(brokerDocId(''), null);
  assert.deepEqual(
    parseBrokerEmails('Alex@MeridianCharter.example, alex@meridiancharter.example ops@other.test'),
    ['alex@meridiancharter.example', 'ops@other.test'],
  );
  assert.equal(
    brokerLogoPath('alex@meridiancharter.example', 'png'),
    'broker-logos/alex@meridiancharter.example/logo.png',
  );
});

test('logo uploads accept png, jpeg, and svg within the size cap', () => {
  assert.equal(validateLogoMeta({ contentType: 'image/png', byteLength: 1200 }).ok, true);
  assert.equal(validateLogoMeta({ contentType: 'image/jpeg', byteLength: 1200 }).ext, 'jpg');
  assert.equal(validateLogoMeta({ contentType: 'image/jpg', byteLength: 1200 }).contentType, 'image/jpeg');
  assert.equal(validateLogoMeta({ contentType: 'image/svg+xml', byteLength: 800 }).ext, 'svg');
  assert.equal(validateLogoMeta({ contentType: 'application/pdf', byteLength: 800 }).ok, false);
  assert.equal(validateLogoMeta({ contentType: 'image/gif', byteLength: 800 }).ok, false);
  assert.equal(validateLogoMeta({ contentType: 'image/png', byteLength: 0 }).ok, false);
  assert.match(
    validateLogoMeta({ contentType: 'image/png', byteLength: BROKER_LOGO_MAX_BYTES + 1 }).error,
    /1\.5 MB/,
  );
  assert.equal(contentTypeForFile({ type: '', name: 'mark.SVG' }), 'image/svg+xml');
  assert.equal(contentTypeForFile({ type: 'image/png', name: 'mark.png' }), 'image/png');
});

test('logo bytes must match the declared type, and svg scripts are rejected', () => {
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);
  assert.equal(inspectLogoBytes(png, 'image/png').ok, true);
  assert.equal(inspectLogoBytes(Buffer.from('not a png'), 'image/png').ok, false);
  assert.equal(inspectLogoBytes(png, 'image/jpeg').ok, false);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
  const ok = inspectLogoBytes(svg, 'image/svg+xml');
  assert.equal(ok.ok, true);
  assert.match(ok.svg, /<svg/);

  const scripted = sanitizeSvg('<svg><script>alert(1)</script><rect /></svg>');
  assert.equal(scripted.ok, false);
  const handler = sanitizeSvg('<svg onload="alert(1)"><rect /></svg>');
  assert.equal(handler.ok, false);

  const sized = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 64"><rect width="10" height="10"/></svg>');
  assert.equal(sized.ok, true);
  assert.match(sized.svg, /width="280"/);
  assert.match(sized.svg, /height="64"/);
  const already = sanitizeSvg('<svg width="12" height="12" viewBox="0 0 12 12"><rect /></svg>');
  assert.equal((already.svg.match(/width=/g) || []).length, 1);
});

function contrastAgainst(hex, surface) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (color) => 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
  const a = lum(rgb);
  const b = lum(surface);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('accent palette keeps the chosen hue and picks a readable contrast', () => {
  const dark = accentPalette('#1F6B4A');
  assert.equal(dark.base, '#1F6B4A');
  assert.equal(dark.contrast, '#FFFFFF');
  assert.match(dark.soft, /^rgba\(31, 107, 74,/);
  assert.equal(dark.onLight, '#1F6B4A');
  assert.ok(contrastAgainst(dark.onDark, [30, 33, 38]) >= 4.5);
  assert.ok(contrastAgainst(dark.onLight, [255, 255, 255]) >= 4.5);
  const light = accentPalette('#F4E7C5');
  assert.equal(light.contrast, '#0A0B0D');
  assert.ok(contrastAgainst(light.onLight, [255, 255, 255]) >= 4.5);
  assert.equal(accentPalette('nope'), null);
});

test('ops records omit the storage path', () => {
  const view = brokerRecordForOps('Alex@MeridianCharter.example', record());
  assert.equal(view.email, 'alex@meridiancharter.example');
  assert.equal(view.hasLogo, true);
  assert.equal('logoPath' in view, false);
  assert.equal('updatedByUid' in view, false);
});

test('the public page and the trip API both consume the branding resolver', () => {
  const page = read('src/TripTrack.jsx');
  const api = read('api/trip-public.js');
  const plate = read('src/track-brand.css');
  const logoRoute = read('api/broker-logo.js');
  const panel = read('src/BrokerBrandPanel.jsx');
  assert.match(page, /branding\?\.whiteLabel/);
  assert.match(page, /showPoweredBy/);
  assert.match(page, /trackingPageMeta/);
  assert.match(page, /track-accent-text/);
  assert.match(page, /track-accent-dot/);
  assert.match(api, /publicBrandingForTrip/);
  assert.doesNotMatch(page, /CHARTERS@FLYSKYWAY/);
  assert.match(plate, /height:\s*44px/);
  assert.match(plate, /max-width:\s*180px/);
  assert.doesNotMatch(plate, /\.track-logo-plate img \{[^}]*max-width:\s*100%/);
  assert.doesNotMatch(logoRoute, /Content-Security-Policy'.*sandbox/);
  assert.match(logoRoute, /nosniff/);
  assert.equal(BROKER_LOGO_LIMIT_LABEL, '1.5 MB');
  assert.match(panel, /BROKER_LOGO_LIMIT_LABEL/);
  assert.doesNotMatch(panel, /1\.4 MB/);
});
