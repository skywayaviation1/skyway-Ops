// Browser-only switches for the App Review sandbox.
// No Firebase imports here, so firebase.js can read the flag at startup.

import { DEMO_TRACKING_TOKEN } from './reviewer-account.js';

export const REVIEWER_DB_STORAGE_KEY = 'skyway_reviewer_db';

export function readReviewerDatabaseFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(REVIEWER_DB_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeReviewerDatabaseFlag(on) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (on) localStorage.setItem(REVIEWER_DB_STORAGE_KEY, '1');
    else localStorage.removeItem(REVIEWER_DB_STORAGE_KEY);
  } catch { /* private mode */ }
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

export function isDemoTrackingRequest(input) {
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const url = new URL(raw, typeof location !== 'undefined' ? location.origin : 'https://www.skyway.app');
    if (!url.pathname.endsWith('/api/trip-public')) return false;
    return url.searchParams.get('token') === DEMO_TRACKING_TOKEN;
  } catch {
    return false;
  }
}

export function isCompanyApiRequest(input) {
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const url = new URL(raw, typeof location !== 'undefined' ? location.origin : 'https://www.skyway.app');
    return url.pathname === '/api' || url.pathname.startsWith('/api/');
  } catch {
    return raw.startsWith('/api/') || raw.includes('/api/');
  }
}

/**
 * Drop every company API call while the sandbox is active. The demo tracking
 * page is the one exception: it serves a fixed fictional payload and never
 * reads the company database.
 */
export function installReviewerNetworkGate() {
  if (typeof window === 'undefined' || window.__skywayReviewerGate) return;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (readReviewerDatabaseFlag() && isCompanyApiRequest(input) && !isDemoTrackingRequest(input)) {
      const body = JSON.stringify({
        ok: false,
        suppressed: true,
        error: 'Suppressed in the App Review sandbox',
      });
      return Promise.resolve(new Response(body, {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return original(input, init);
  };
  window.__skywayReviewerGate = true;
}
