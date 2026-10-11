/**
 * Merge aviowiki FBO/airport records with iFlightPlanner fuel prices.
 * aviowiki owns the provider list, contacts, services, and payment methods.
 * iFlightPlanner owns US dollars per gallon and the price timestamp.
 * An aviowiki price is shown only when iFlightPlanner has no price for that fuel.
 */

const compact = (value) => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

export function sameAirport(a, b) {
  const left = compact(a);
  const right = compact(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length === 3 && right === `K${left}`) return true;
  if (right.length === 3 && left === `K${right}`) return true;
  return false;
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function namesMatch(a, b) {
  const left = normName(a);
  const right = normName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 5 && right.length >= 5 && (left.includes(right) || right.includes(left))) return true;
  return false;
}

function fromIFlight(fuel) {
  const price = Number(fuel.price);
  return {
    fuelType: fuel.fuelType,
    service: fuel.service || 'Retail',
    price,
    pricePerGal: Number.isFinite(price) ? price : null,
    unit: 'USG',
    currency: 'USD',
    selfService: fuel.service === 'Self service' ? true : (fuel.service === 'Full service' ? false : null),
    nonUsd: false,
    converted: false,
    updatedAt: fuel.updatedAt || null,
    source: 'iFlightPlanner',
    fallback: false,
  };
}

export function mergeFuelPrices(aviowikiPrices = [], iflightPrices = []) {
  const primary = (iflightPrices || []).filter((fuel) => Number.isFinite(Number(fuel.price))).map(fromIFlight);
  const covered = new Set(primary.map((fuel) => fuel.fuelType));
  const fallback = (aviowikiPrices || [])
    .filter((fuel) => fuel && !covered.has(fuel.fuelType) && Number.isFinite(Number(fuel.price)))
    .map((fuel) => ({ ...fuel, source: 'aviowiki', fallback: true, updatedAt: null }));
  return [...primary, ...fallback];
}

function findIflightMatch(fbo, iflightFbos, used) {
  let best = null;
  let bestScore = 0;
  for (const candidate of iflightFbos) {
    if (used.has(candidate)) continue;
    if (!namesMatch(fbo.name, candidate.name)) continue;
    const exact = normName(fbo.name) === normName(candidate.name);
    const score = (exact ? 10 : 1) + (candidate.fuelPrices?.length || 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function mergeFboLists(aviowikiFbos = [], iflightFbos = []) {
  const used = new Set();
  const merged = (aviowikiFbos || []).map((fbo) => {
    const match = findIflightMatch(fbo, iflightFbos || [], used);
    if (match) used.add(match);
    return {
      ...fbo,
      phone: fbo.phone || match?.phone || match?.tollFree || '',
      email: fbo.email || match?.email || '',
      website: fbo.website || match?.website || '',
      address: fbo.address || [match?.address, match?.city, match?.state].filter(Boolean).join(', '),
      vhf: fbo.vhf || match?.frequency || '',
      fuelBrand: match?.fuelBrand || '',
      fuelPrices: mergeFuelPrices(fbo.fuelPrices, match?.fuelPrices),
      source: 'aviowiki',
    };
  });
  for (const fbo of iflightFbos || []) {
    if (used.has(fbo)) continue;
    merged.push({
      aid: null,
      name: fbo.name || 'Fuel service',
      phone: fbo.phone || fbo.tollFree || '',
      email: fbo.email || '',
      website: fbo.website || '',
      vhf: fbo.frequency || '',
      address: [fbo.address, fbo.city, fbo.state].filter(Boolean).join(', '),
      city: fbo.city || '',
      state: fbo.state || '',
      paymentMethods: [],
      services: [],
      featured: false,
      verified: false,
      featuredOrder: null,
      fbo: true,
      category: 'FUEL',
      serviceLevel: null,
      fuelBrand: fbo.fuelBrand || '',
      fuelPrices: mergeFuelPrices([], fbo.fuelPrices),
      source: 'iFlightPlanner',
    });
  }
  return merged;
}

export function lowestUsdPrices(fbos) {
  const lowest = {};
  for (const fbo of fbos || []) {
    for (const fuel of fbo.fuelPrices || []) {
      if (fuel.nonUsd) continue;
      const price = Number(fuel.pricePerGal ?? fuel.price);
      if (!Number.isFinite(price)) continue;
      if (fuel.source === 'aviowiki' && fuel.currency && fuel.currency !== 'USD') continue;
      const current = lowest[fuel.fuelType];
      if (!current || price < current.price) {
        lowest[fuel.fuelType] = {
          fuelType: fuel.fuelType,
          price,
          service: fuel.service,
          fboName: fbo.name,
          source: fuel.source,
        };
      }
    }
  }
  return lowest;
}

export function mergeAirportView({
  requested,
  aviowikiAirport = null,
  aviowikiFbos = null,
  iflight = null,
}) {
  const code = compact(requested);
  const iflightAirport = (iflight?.airports || []).find((airport) => (
    sameAirport(airport.airport, code) || sameAirport(airport.airport, aviowikiAirport?.airport?.icao)
  )) || null;
  const awFboAirport = (aviowikiFbos?.airports || []).find((airport) => (
    sameAirport(airport.airport, code)
    || sameAirport(airport.requested, code)
    || sameAirport(airport.airport, aviowikiAirport?.airport?.icao)
  )) || null;
  const airport = aviowikiAirport?.airport || null;
  const fbos = mergeFboLists(awFboAirport?.fbos || [], iflightAirport?.fbos || []);
  const configured = aviowikiAirport?.configured !== false && aviowikiFbos?.configured !== false;
  const source = aviowikiAirport?.source
    || (awFboAirport?.fbos?.length ? 'aviowiki' : null)
    || (iflightAirport ? 'iFlightPlanner' : null);
  return {
    airport: airport?.icao || awFboAirport?.airport || iflightAirport?.airport || code,
    airportName: airport?.name || awFboAirport?.airportName || iflightAirport?.airportName || '',
    servedCity: airport?.servedCity || '',
    elevationFt: airport?.elevationFt ?? null,
    timezone: airport?.timezone || null,
    latitude: airport?.latitude ?? null,
    longitude: airport?.longitude ?? null,
    source,
    configured,
    stale: Boolean(aviowikiAirport?.stale || awFboAirport?.stale),
    runways: aviowikiAirport?.runways || [],
    availability: aviowikiAirport?.source === 'aviowiki' ? (aviowikiAirport.availability || null) : null,
    notes: aviowikiAirport?.source === 'aviowiki' ? (aviowikiAirport.notes || []) : [],
    fbos,
    lowestByFuel: lowestUsdPrices(fbos),
    warning: [aviowikiAirport?.warning, awFboAirport?.error, aviowikiAirport?.error].filter(Boolean).join(' '),
  };
}
