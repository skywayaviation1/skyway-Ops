/**
 * ForeFlight Dispatch + Mobile helpers.
 *
 * ForeFlight does not expose an embeddable in-app product API. What it does
 * offer — and what this module targets — is:
 *   1. ForeFlight Dispatch REST API (public-api.foreflight.com)
 *   2. Mobile / web deep links into an existing Dispatch flight
 *   3. Webhooks that push filing / OOOI / plan changes back to us
 *
 * Schema reference: https://public-api.foreflight.com/swagger/v1/swagger.json
 */

/** Normalize an airport code to the ICAO-ish form ForeFlight accepts. */
export function normalizeIcao(code) {
  if (!code) return '';
  const c = String(code).toUpperCase().trim();
  if (/^[A-Z0-9]{4}$/.test(c)) return c;
  if (/^[A-Z]{3}$/.test(c)) return `K${c}`;
  return c;
}

/**
 * Deep-link into ForeFlight Mobile Maps with route + performance prefilled.
 * Spec: foreflight.com/support/app-urls
 */
export function buildForeFlightMapsUrl({
  from, to, cruiseKts, burnGph, cruiseFt, tail, etdIso,
}) {
  const fromIcao = normalizeIcao(from);
  const toIcao = normalizeIcao(to);
  if (!fromIcao || !toIcao) return null;
  const parts = [fromIcao, toIcao];
  if (cruiseKts) parts.push(`${cruiseKts}kts`);
  if (burnGph) parts.push(`${burnGph}gph`);
  if (cruiseFt) parts.push(`${cruiseFt}ft`);
  if (tail) parts.push(String(tail).toUpperCase());
  if (etdIso) {
    try {
      const d = new Date(etdIso);
      if (d.getTime() > Date.now()) {
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mi = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        parts.push(`${yyyy}${mm}${dd}T${hh}:${mi}:${ss}Z`);
      }
    } catch {
      /* skip ETD */
    }
  }
  return `foreflightmobile://maps/search?q=${parts.join('+')}`;
}

/** Open a known Dispatch flight inside ForeFlight Mobile. */
export function buildForeFlightFlightViewUrl(flightId) {
  if (!flightId) return null;
  return `foreflightmobile://flights/view?id=${encodeURIComponent(flightId)}`;
}

/**
 * Open the flight editor in Dispatch web.
 * Org UUID comes from GET /public/api/apiKeyInfo → organisationUUID.
 */
export function buildDispatchEditUrl(organisationUUID, flightId) {
  if (!organisationUUID || !flightId) return null;
  return `https://dispatch.foreflight.com/flight/${organisationUUID}_${flightId}/edit`;
}

/** Convert feet to a Dispatch altitude object (prefers FL when divisible by 100). */
export function altitudeFromFeet(cruiseFt) {
  const ft = Number(cruiseFt) || 0;
  if (!ft) return null;
  if (ft >= 18000 && ft % 100 === 0) {
    return { altitude: Math.round(ft / 100), unit: 'FL' };
  }
  return { altitude: Math.round(ft), unit: 'FT' };
}

function toIsoZulu(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Map an ops trip (+ optional plan overrides) onto a Dispatch
 * DTOCreateOrUpdateFlightRequest.flight body.
 *
 * Crew emails should already be resolved by the caller (PIC/SIC free-text
 * names from the schedule are not enough for ForeFlight's crewId field).
 */
export function tripToDispatchFlight(trip, {
  cruiseFt,
  routeNotes,
  alternate,
  callsign,
  flightRule = 'IFR',
  atcTypeOfFlight = 'G',
  crew = [],
  dispatcherNotes,
  tags,
} = {}) {
  const from = normalizeIcao(trip?.info?.from || trip?.from || '');
  const to = normalizeIcao(trip?.info?.to || trip?.to || '');
  const tail = String(trip?.info?.tail || trip?.tail || '').toUpperCase().trim();
  const etd = toIsoZulu(trip?.start || trip?.etd || trip?.info?.etd);
  if (!from || !to || !tail || !etd) {
    const missing = [
      !from && 'departure',
      !to && 'destination',
      !tail && 'aircraftRegistration',
      !etd && 'scheduledTimeOfDeparture',
    ].filter(Boolean);
    throw new Error(`Missing required ForeFlight fields: ${missing.join(', ')}`);
  }

  const pax = Number(trip?.info?.pax ?? trip?.pax ?? 0) || 0;
  const hasPic = Boolean(trip?.info?.pic);
  const hasSic = Boolean(trip?.info?.sic);
  const people = pax + (hasPic ? 1 : 0) + (hasSic ? 1 : 0);

  const flight = {
    departure: from,
    destination: to,
    scheduledTimeOfDeparture: etd,
    aircraftRegistration: tail,
    flightRule,
    atcTypeOfFlight,
    tripId: String(trip?.uid || trip?.tripId || '').slice(0, 64) || null,
    tags: Array.isArray(tags) && tags.length
      ? tags
      : [trip?.info?.legType, trip?.uid].filter(Boolean).map(String),
  };

  if (callsign) flight.callsign = String(callsign).slice(0, 7).toUpperCase();

  const altitude = altitudeFromFeet(cruiseFt);
  const route = (routeNotes || '').trim() || 'DCT';
  flight.routeToDestination = altitude
    ? { route, altitude }
    : { route };

  const alt = normalizeIcao(alternate);
  if (alt) flight.alternate = alt;

  if (people > 0) {
    flight.load = { people };
  }

  if (Array.isArray(crew) && crew.length) {
    flight.crew = crew
      .filter((c) => c?.crewId && c?.position)
      .map((c) => ({
        position: c.position,
        crewId: String(c.crewId).trim(),
        ...(c.weight != null ? { weight: c.weight } : {}),
      }));
  }

  const notes = (dispatcherNotes || '').trim();
  if (notes) flight.dispatcherNotes = notes.slice(0, 5000);

  return flight;
}

/** Public (secret-free) view of a stored ForeFlight connection. */
export function publicForeFlightConfig(config) {
  if (!config) {
    return {
      connected: false,
      enabled: false,
      webhookRegistered: false,
    };
  }
  return {
    connected: Boolean(config.apiKey),
    enabled: config.enabled !== false && Boolean(config.apiKey),
    hasApiKey: Boolean(config.apiKey),
    vendorId: config.vendorId || null,
    organisationUUID: config.organisationUUID || null,
    organisationName: config.organisationName || null,
    webhookUrl: config.webhookUrl || null,
    webhookRegistered: Boolean(config.webhookUrl),
    hasWebhookSecret: Boolean(config.webhookSecret),
    updatedAt: config.updatedAt || null,
    updatedByName: config.updatedByName || null,
    lastTestAt: config.lastTestAt || null,
    lastTestOk: config.lastTestOk ?? null,
    lastWebhookAt: config.lastWebhookAt || null,
  };
}

/** Capabilities we expose through the action proxy — mirrors Dispatch OpenAPI. */
export const FOREFLIGHT_ACTIONS = [
  'test',
  'getFlight',
  'listFlights',
  'listModified',
  'createFlight',
  'updateFlight',
  'deleteFlight',
  'releaseFlight',
  'updateOooi',
  'getPerformance',
  'calculatePerformance',
  'getAircraft',
  'getCrew',
  'getContacts',
  'getSavedRoutes',
  'uploadSchedule',
  'getApiKeyInfo',
  'registerWebhook',
  'webhookSample',
];
