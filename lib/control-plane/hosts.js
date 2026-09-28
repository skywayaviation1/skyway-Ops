import { PINNED_SKYWAY_HOSTS, skywayPublicTenant } from './skyway-brand.js';

const PINNED = new Set(PINNED_SKYWAY_HOSTS);

/**
 * Hostname the edge route should trust.
 * Vercel sets both Host and X-Forwarded-Host to the public hostname.
 */
export function requestHostname(request) {
  const header = request?.headers?.get?.('x-forwarded-host')
    || request?.headers?.get?.('host')
    || '';
  return normalizeHostname(header);
}

export function normalizeHostname(value) {
  const first = String(value || '').split(',')[0].trim().toLowerCase();
  if (!first) return '';
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    return end === -1 ? '' : first.slice(1, end);
  }
  return first.replace(/:\d+$/, '');
}

/**
 * Pinned hosts are Skyway even when Postgres is down or unset.
 * Every other host is unknown. Do not fall through to Skyway.
 */
export function resolvePinnedTenant(hostname) {
  if (!PINNED.has(hostname)) return null;
  return skywayPublicTenant();
}
