// Airport → state / country for the trade-show counters.
//
// Explicit charter airports win. Everything else falls back to an ICAO
// prefix, then to a bounding box. Boxes are a display aid for the booth
// totals, not a survey: a field sitting on a state line can land in the
// neighbor when it is not in the explicit table.

const PLACES = {
  OPF: ['United States', 'FL'],
  FXE: ['United States', 'FL'],
  FLL: ['United States', 'FL'],
  MIA: ['United States', 'FL'],
  PBI: ['United States', 'FL'],
  DJT: ['United States', 'FL'],
  APF: ['United States', 'FL'],
  TPA: ['United States', 'FL'],
  PIE: ['United States', 'FL'],
  MCO: ['United States', 'FL'],
  SFB: ['United States', 'FL'],
  EYW: ['United States', 'FL'],
  JAX: ['United States', 'FL'],
  PNS: ['United States', 'FL'],
  TLH: ['United States', 'FL'],
  DAB: ['United States', 'FL'],
  RSW: ['United States', 'FL'],
  TEB: ['United States', 'NJ'],
  MMU: ['United States', 'NJ'],
  EWR: ['United States', 'NJ'],
  CDW: ['United States', 'NJ'],
  HPN: ['United States', 'NY'],
  JFK: ['United States', 'NY'],
  LGA: ['United States', 'NY'],
  BUF: ['United States', 'NY'],
  ALB: ['United States', 'NY'],
  BOS: ['United States', 'MA'],
  ACK: ['United States', 'MA'],
  HYA: ['United States', 'MA'],
  BED: ['United States', 'MA'],
  MVY: ['United States', 'MA'],
  BDL: ['United States', 'CT'],
  PVD: ['United States', 'RI'],
  PWM: ['United States', 'ME'],
  BGR: ['United States', 'ME'],
  BTV: ['United States', 'VT'],
  MHT: ['United States', 'NH'],
  DCA: ['United States', 'VA'],
  IAD: ['United States', 'VA'],
  ORF: ['United States', 'VA'],
  RIC: ['United States', 'VA'],
  BWI: ['United States', 'MD'],
  PHL: ['United States', 'PA'],
  PIT: ['United States', 'PA'],
  CLT: ['United States', 'NC'],
  RDU: ['United States', 'NC'],
  ILM: ['United States', 'NC'],
  CHS: ['United States', 'SC'],
  ATL: ['United States', 'GA'],
  PDK: ['United States', 'GA'],
  SAV: ['United States', 'GA'],
  BNA: ['United States', 'TN'],
  TYS: ['United States', 'TN'],
  MEM: ['United States', 'TN'],
  MSY: ['United States', 'LA'],
  AUS: ['United States', 'TX'],
  DAL: ['United States', 'TX'],
  DFW: ['United States', 'TX'],
  HOU: ['United States', 'TX'],
  IAH: ['United States', 'TX'],
  SAT: ['United States', 'TX'],
  ELP: ['United States', 'TX'],
  ASE: ['United States', 'CO'],
  EGE: ['United States', 'CO'],
  DEN: ['United States', 'CO'],
  APA: ['United States', 'CO'],
  BJC: ['United States', 'CO'],
  JAC: ['United States', 'WY'],
  LAS: ['United States', 'NV'],
  HND: ['United States', 'NV'],
  PHX: ['United States', 'AZ'],
  SDL: ['United States', 'AZ'],
  TUS: ['United States', 'AZ'],
  LAX: ['United States', 'CA'],
  VNY: ['United States', 'CA'],
  BUR: ['United States', 'CA'],
  SNA: ['United States', 'CA'],
  SAN: ['United States', 'CA'],
  SFO: ['United States', 'CA'],
  SJC: ['United States', 'CA'],
  OAK: ['United States', 'CA'],
  TRK: ['United States', 'CA'],
  SEA: ['United States', 'WA'],
  GEG: ['United States', 'WA'],
  PDX: ['United States', 'OR'],
  ORD: ['United States', 'IL'],
  MDW: ['United States', 'IL'],
  PWK: ['United States', 'IL'],
  DTW: ['United States', 'MI'],
  MSP: ['United States', 'MN'],
  STL: ['United States', 'MO'],
  MCI: ['United States', 'MO'],
  CVG: ['United States', 'KY'],
  SDF: ['United States', 'KY'],
  CLE: ['United States', 'OH'],
  CMH: ['United States', 'OH'],
  IND: ['United States', 'IN'],
  OKC: ['United States', 'OK'],
  TUL: ['United States', 'OK'],
  ABQ: ['United States', 'NM'],
  SLC: ['United States', 'UT'],
  PVU: ['United States', 'UT'],
  BOI: ['United States', 'ID'],
  BIL: ['United States', 'MT'],
  MSO: ['United States', 'MT'],
  BZN: ['United States', 'MT'],
  BHM: ['United States', 'AL'],
  INT: ['United States', 'NC'],
  HNL: ['United States', 'HI'],
  OGG: ['United States', 'HI'],
  ANC: ['United States', 'AK'],
  NAS: ['Bahamas', null],
  MYNN: ['Bahamas', null],
  MYAM: ['Bahamas', null],
  MYEH: ['Bahamas', null],
  MYEM: ['Bahamas', null],
  MYGF: ['Bahamas', null],
  CUN: ['Mexico', null],
  MMUN: ['Mexico', null],
  SJD: ['Mexico', null],
  MEX: ['Mexico', null],
  MMMX: ['Mexico', null],
  GDL: ['Mexico', null],
  HAV: ['Cuba', null],
  MUHA: ['Cuba', null],
  GCM: ['Cayman Islands', null],
  MWCR: ['Cayman Islands', null],
  MBJ: ['Jamaica', null],
  MKJS: ['Jamaica', null],
  SJU: ['Puerto Rico', null],
  TJSJ: ['Puerto Rico', null],
  STT: ['U.S. Virgin Islands', null],
  YYZ: ['Canada', null],
  CYYZ: ['Canada', null],
  YUL: ['Canada', null],
  CYUL: ['Canada', null],
  YVR: ['Canada', null],
  CYVR: ['Canada', null],
  YOW: ['Canada', null],
  YYC: ['Canada', null],
};

const PREFIX_COUNTRY = [
  ['MY', 'Bahamas'],
  ['MM', 'Mexico'],
  ['MK', 'Jamaica'],
  ['MW', 'Cayman Islands'],
  ['MU', 'Cuba'],
  ['MD', 'Dominican Republic'],
  ['TJ', 'Puerto Rico'],
  ['TI', 'U.S. Virgin Islands'],
  ['MG', 'Guatemala'],
  ['MH', 'Honduras'],
  ['MR', 'Costa Rica'],
  ['MP', 'Panama'],
  ['CY', 'Canada'],
  ['CZ', 'Canada'],
  ['EG', 'United Kingdom'],
  ['EI', 'Ireland'],
  ['LF', 'France'],
  ['LS', 'Switzerland'],
  ['LE', 'Spain'],
  ['LP', 'Portugal'],
  ['LI', 'Italy'],
  ['EH', 'Netherlands'],
  ['EB', 'Belgium'],
  ['BI', 'Iceland'],
  ['ED', 'Germany'],
  ['EK', 'Denmark'],
  ['EN', 'Norway'],
  ['EF', 'Finland'],
  ['ES', 'Sweden'],
  ['LO', 'Austria'],
  ['LK', 'Czechia'],
  ['EP', 'Poland'],
  ['OE', 'United Arab Emirates'],
  ['OM', 'Oman'],
  ['OT', 'Qatar'],
];

const STATE_BOXES = [
  ['DC', 38.791, 38.996, -77.12, -76.909],
  ['RI', 41.15, 42.02, -71.91, -71.12],
  ['DE', 38.45, 39.84, -75.79, -75.05],
  ['CT', 40.98, 42.05, -73.73, -71.79],
  ['NJ', 38.93, 41.36, -75.56, -73.89],
  ['MD', 37.91, 39.72, -79.49, -75.05],
  ['MA', 41.24, 42.89, -73.51, -69.93],
  ['NH', 42.7, 45.31, -72.56, -70.61],
  ['VT', 42.73, 45.02, -73.44, -71.47],
  ['HI', 18.91, 22.24, -160.25, -154.81],
  ['FL', 24.4, 29.2, -83.3, -80.0],
  ['FL', 29.55, 31.05, -87.64, -84.05],
  ['GA', 30.36, 35.0, -85.61, -80.84],
  ['SC', 32.03, 35.22, -83.35, -78.54],
  ['NC', 33.84, 36.59, -84.32, -75.46],
  ['VA', 36.54, 39.47, -83.68, -75.24],
  ['WV', 37.2, 40.64, -82.65, -77.72],
  ['PA', 39.72, 42.27, -80.52, -74.69],
  ['NY', 40.5, 45.02, -79.76, -71.86],
  ['ME', 43.06, 47.46, -71.08, -66.95],
  ['OH', 38.4, 41.98, -84.82, -80.52],
  ['MI', 41.7, 45.3, -87.0, -82.4],
  ['MI', 45.1, 47.5, -90.42, -83.4],
  ['IN', 37.77, 41.76, -88.1, -84.79],
  ['KY', 36.5, 39.15, -89.57, -81.96],
  ['TN', 34.98, 36.68, -90.31, -81.65],
  ['AL', 30.19, 35.01, -88.47, -84.89],
  ['MS', 30.17, 35.0, -91.66, -88.1],
  ['LA', 28.93, 33.02, -94.04, -88.82],
  ['AR', 33.0, 36.5, -94.62, -89.64],
  ['MO', 36.0, 40.61, -95.77, -89.1],
  ['IA', 40.38, 43.5, -96.64, -90.14],
  ['IL', 36.97, 42.51, -91.51, -87.5],
  ['WI', 42.49, 47.08, -92.89, -86.8],
  ['MN', 43.5, 49.38, -97.24, -89.49],
  ['TX', 25.84, 36.5, -106.65, -93.51],
  ['OK', 33.62, 37.0, -103.0, -94.43],
  ['KS', 36.99, 40.0, -102.05, -94.59],
  ['NE', 40.0, 43.0, -104.05, -95.31],
  ['SD', 42.48, 45.95, -104.06, -96.44],
  ['ND', 45.94, 49.0, -104.05, -96.55],
  ['NM', 31.33, 37.0, -109.05, -103.0],
  ['CO', 36.99, 41.0, -109.06, -102.04],
  ['WY', 40.99, 45.01, -111.06, -104.05],
  ['MT', 44.36, 49.0, -116.05, -104.04],
  ['ID', 41.99, 49.0, -117.24, -111.04],
  ['UT', 37.0, 42.0, -114.05, -109.04],
  ['AZ', 31.33, 37.0, -114.82, -109.05],
  ['NV', 35.0, 42.0, -120.01, -114.04],
  ['CA', 32.53, 42.01, -124.41, -114.13],
  ['OR', 41.99, 46.29, -124.57, -116.46],
  ['WA', 45.54, 49.0, -124.73, -116.92],
  ['AK', 51.2, 71.4, -179.2, -129.9],
];

const CITIES = {
  OPF: 'Opa-locka',
  FXE: 'Fort Lauderdale',
  FLL: 'Fort Lauderdale',
  MIA: 'Miami',
  PBI: 'Palm Beach',
  DJT: 'Palm Beach',
  APF: 'Naples',
  TPA: 'Tampa',
  MCO: 'Orlando',
  EYW: 'Key West',
  JAX: 'Jacksonville',
  PNS: 'Pensacola',
  TLH: 'Tallahassee',
  TEB: 'Teterboro',
  HPN: 'White Plains',
  EWR: 'Newark',
  JFK: 'New York',
  BOS: 'Boston',
  ACK: 'Nantucket',
  DCA: 'Washington',
  IAD: 'Dulles',
  BWI: 'Baltimore',
  CLT: 'Charlotte',
  ATL: 'Atlanta',
  CHS: 'Charleston',
  BNA: 'Nashville',
  MSY: 'New Orleans',
  AUS: 'Austin',
  DAL: 'Dallas',
  HOU: 'Houston',
  ASE: 'Aspen',
  EGE: 'Vail',
  DEN: 'Denver',
  LAS: 'Las Vegas',
  PHX: 'Phoenix',
  LAX: 'Los Angeles',
  VNY: 'Van Nuys',
  SAN: 'San Diego',
  SFO: 'San Francisco',
  SEA: 'Seattle',
  ORD: 'Chicago',
  DTW: 'Detroit',
  MSP: 'Minneapolis',
  NAS: 'Nassau',
  CUN: 'Cancún',
  YYZ: 'Toronto',
  MBJ: 'Montego Bay',
  SJU: 'San Juan',
};

function explicit(code) {
  const hit = PLACES[code];
  if (!hit) return null;
  return { country: hit[0], state: hit[1] };
}

/** Friendly city for the booth ticker. Unknown fields stay as the airport code. */
export function airportCity(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CITIES[c]
    || (c.length === 4 && c.startsWith('K') ? CITIES[c.slice(1)] : null)
    || null;
}

function countryFromPrefix(code) {
  if (!code || code.length < 4) return null;
  if (code.startsWith('K') || code.startsWith('PA') || code.startsWith('PH')) return 'United States';
  for (const [prefix, country] of PREFIX_COUNTRY) {
    if (code.startsWith(prefix)) return country;
  }
  return null;
}

export function stateFromPoint(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  let bestD = Infinity;
  for (const [code, minLat, maxLat, minLng, maxLng] of STATE_BOXES) {
    if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
    const dLat = lat - (minLat + maxLat) / 2;
    const dLng = lng - (minLng + maxLng) / 2;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) {
      bestD = d;
      best = code;
    }
  }
  return best;
}

function countryFromPoint(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat >= 20.9 && lat <= 27.4 && lng >= -79.4 && lng <= -72.7) return 'Bahamas';
  if (lat >= 14.5 && lat <= 32.7 && lng >= -117.1 && lng <= -86.6) return 'Mexico';
  if (lat >= 17.8 && lat <= 18.6 && lng >= -67.3 && lng <= -65.2) return 'Puerto Rico';
  if (lat >= 41.6 && lat <= 83 && lng >= -141 && lng <= -52.6) return 'Canada';
  return null;
}

export function placeForAirport(code, lat, lng) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const named = explicit(c)
    || (c.length === 4 && c.startsWith('K') ? explicit(c.slice(1)) : null)
    || (c.length === 3 ? explicit(`K${c}`) : null);
  const city = airportCity(c);
  if (named) return { ...named, city };
  const prefixed = countryFromPrefix(c);
  if (prefixed && prefixed !== 'United States') return { country: prefixed, state: null, city };
  const state = stateFromPoint(lat, lng);
  if (prefixed === 'United States' || state) {
    return { country: 'United States', state, city };
  }
  return { country: countryFromPoint(lat, lng), state: null, city };
}
