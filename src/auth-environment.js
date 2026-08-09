// Browser/environment decisions for Microsoft authentication.
// Kept free of Firebase imports so these rules can be tested directly.

/**
 * Which Microsoft directory to authenticate against.
 *
 * Firebase defaults to the multi-tenant `/common` endpoint, which a
 * single-tenant Entra app registration refuses outright with AADSTS50194. Since
 * Skyway only ever admits one directory, defaulting to the company domain is
 * both correct and removes a required deployment variable — Microsoft accepts a
 * verified domain name wherever it accepts a tenant GUID.
 *
 * An explicit GUID still wins, for tenants whose sign-in domain differs from
 * their mail domain.
 */
export function resolveMicrosoftTenant(configuredTenant, companyDomain) {
  const explicit = String(configuredTenant || '').trim();
  if (explicit) return explicit;
  const domain = String(companyDomain || '').trim();
  return domain || 'common';
}

export function isStandaloneApp(win = globalThis.window, nav = globalThis.navigator) {
  if (!win || !nav) return false;
  return nav.standalone === true
    || win.matchMedia?.('(display-mode: standalone)')?.matches === true;
}

export function isIosDevice(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = nav.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
}

export function isSameOriginAuthDomain(authDomain, location = globalThis.location) {
  if (!authDomain || !location?.hostname) return false;
  return String(authDomain).toLowerCase() === String(location.hostname).toLowerCase();
}

/**
 * Firebase redirect is preferred everywhere when the auth helper is
 * same-origin. In an installed iOS PWA with a cross-origin helper, WebKit can
 * lose redirect state to storage partitioning; a user-gesture popup keeps the
 * result connected to the PWA and is the safer compatibility fallback.
 */
export function microsoftAuthMethod({
  authDomain,
  win = globalThis.window,
  nav = globalThis.navigator,
  location = globalThis.location,
} = {}) {
  const crossOrigin = !isSameOriginAuthDomain(authDomain, location);
  return crossOrigin && isIosDevice(nav) && isStandaloneApp(win, nav)
    ? 'popup'
    : 'redirect';
}

