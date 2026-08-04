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

export function normalizeAircraftMeta(value) {
  const source = value && typeof value === 'object' ? value : {};
  const clean = (field, max = 80) => String(source[field] || '').trim().slice(0, max);
  return {
    displayName: clean('displayName'),
    icaoType: clean('icaoType', 8).toUpperCase(),
    serialNumber: clean('serialNumber', 40),
    homeBase: clean('homeBase', 8).toUpperCase(),
  };
}

export function normalizeAircraftByTail(value, managedTails = null) {
  const source = value && typeof value === 'object' ? value : {};
  const allowed = Array.isArray(managedTails) ? new Set(normalizeFleetTails(managedTails)) : null;
  const result = {};
  for (const [rawTail, rawMeta] of Object.entries(source)) {
    const tail = normalizeTail(rawTail);
    if (!tail || (allowed && !allowed.has(tail))) continue;
    result[tail] = normalizeAircraftMeta(rawMeta);
  }
  return result;
}

/**
 * There is intentionally no guessed tail-to-model fallback. Until an
 * administrator enters verified metadata, fleet surfaces show "Type not set".
 */
export function resolveAircraftMeta(tail, config) {
  const normalized = normalizeTail(tail);
  return normalizeAircraftMeta(config?.aircraftByTail?.[normalized]);
}
