// One source of truth for the managed Skyway fleet. Aircraft can still appear
// on the schedule without being managed fleet; those tails remain attached to
// trips and history but are excluded from fleet counts, tracking and MX lists.

export const DEFAULT_MANAGED_TAILS = Object.freeze([
  'N20UF',
  'N168ZZ',
  'N286N',
  'N444AM',
  'N651TW',
  'N551FP',
  'N85AH',
  'N525CR',
]);

export function normalizeTail(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

export function normalizeFleetTails(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeTail).filter(Boolean))].sort();
}

/**
 * An explicitly saved empty fleet is valid. `fleetConfigured` distinguishes it
 * from an older deployment that has no shared fleet document yet.
 */
export function resolveManagedTails(config) {
  if (config?.fleetConfigured === true) {
    return normalizeFleetTails(config.fleetTails);
  }
  if (Array.isArray(config?.fleetTails) && config.fleetTails.length > 0) {
    return normalizeFleetTails(config.fleetTails);
  }
  return [...DEFAULT_MANAGED_TAILS];
}

export function scheduledTails(trips) {
  return normalizeFleetTails((Array.isArray(trips) ? trips : []).map((trip) => trip?.info?.tail));
}

export function scheduledOnlyTails(trips, managedTails) {
  const managed = new Set(normalizeFleetTails(managedTails));
  return scheduledTails(trips).filter((tail) => !managed.has(tail));
}
