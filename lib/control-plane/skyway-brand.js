/**
 * Public Skyway brand copied from src/brand.js.
 *
 * The pinned-host edge route returns this object. It does not read Postgres,
 * so a database outage cannot attach www.skyway.app to another company or
 * blank the payload. Phase 1 does not let the UI theme from this route.
 */

export const SKYWAY_SLUG = 'skyway';

export const PINNED_SKYWAY_HOSTS = Object.freeze([
  'www.skyway.app',
  'skyway.app',
  '135ops.app',
]);

export const SKYWAY_BRAND = Object.freeze({
  slug: SKYWAY_SLUG,
  name: 'Skyway Aviation',
  shortName: 'Skyway',
  legalName: 'Skyway Aviation Services',
  appName: 'Skyway Ops',
  tagline: 'Private Jet & Helicopter Charter Services',
  domain: 'flyskyway.com',
  contactEmail: 'charters@flyskyway.com',
  contactPhone: '727-605-5000',
  logoUrl: '/skyway-logo',
  logoDarkUrl: '/skyway-logo-reverse',
  logoMarkUrl: '/skyway-logo-nav',
  logoMarkDarkUrl: '/skyway-logo-nav-reverse',
  accentDark: '#3FA9CC',
  accentLight: '#12708C',
  accent: Object.freeze({
    dark: Object.freeze({
      base: '#3FA9CC',
      soft: 'rgba(63, 169, 204, 0.12)',
      border: 'rgba(63, 169, 204, 0.40)',
      contrast: '#06171E',
    }),
    light: Object.freeze({
      base: '#12708C',
      soft: 'rgba(18, 112, 140, 0.09)',
      border: 'rgba(18, 112, 140, 0.32)',
      contrast: '#FFFFFF',
    }),
  }),
  emailFrom: 'Skyway Ops <noreply@send.flyskyway.com>',
});

export function skywayPublicTenant() {
  return {
    slug: SKYWAY_BRAND.slug,
    name: SKYWAY_BRAND.name,
    shortName: SKYWAY_BRAND.shortName,
    legalName: SKYWAY_BRAND.legalName,
    appName: SKYWAY_BRAND.appName,
    tagline: SKYWAY_BRAND.tagline,
    logoUrl: SKYWAY_BRAND.logoUrl,
    logoDarkUrl: SKYWAY_BRAND.logoDarkUrl,
    logoMarkUrl: SKYWAY_BRAND.logoMarkUrl,
    logoMarkDarkUrl: SKYWAY_BRAND.logoMarkDarkUrl,
    accentDark: SKYWAY_BRAND.accentDark,
    accentLight: SKYWAY_BRAND.accentLight,
    accent: {
      dark: { ...SKYWAY_BRAND.accent.dark },
      light: { ...SKYWAY_BRAND.accent.light },
    },
    contactEmail: SKYWAY_BRAND.contactEmail,
    contactPhone: SKYWAY_BRAND.contactPhone,
    emailFrom: SKYWAY_BRAND.emailFrom,
    pinned: true,
  };
}
