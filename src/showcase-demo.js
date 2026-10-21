// Realistic public-shaped legs for the booth preview and screenshots.
// No customer, crew, price, or trip fields live here. Coordinates are the
// same airports the replay page draws from stored legs.

import {
  publicShowcaseBody,
  selectShowcaseLegs,
  zonedStartOfYearMs,
} from './showcase-replay.js';

const AIRPORTS = {
  OPF: [25.907, -80.2784],
  FXE: [26.1973, -80.1707],
  FLL: [26.0726, -80.1527],
  MIA: [25.7959, -80.287],
  PBI: [26.6832, -80.0956],
  APF: [26.1525, -81.7753],
  TPA: [27.9755, -82.5332],
  MCO: [28.4294, -81.3089],
  EYW: [24.5561, -81.7596],
  JAX: [30.4941, -81.6879],
  TEB: [40.8501, -74.0608],
  HPN: [41.067, -73.7076],
  EWR: [40.6895, -74.1745],
  BOS: [42.3656, -71.0096],
  ACK: [41.253, -70.0602],
  DCA: [38.8512, -77.0402],
  IAD: [38.9531, -77.4565],
  BWI: [39.1754, -76.6683],
  CLT: [35.214, -80.9431],
  ATL: [33.6407, -84.4277],
  CHS: [32.8986, -80.0405],
  BNA: [36.1245, -86.6782],
  MSY: [29.9934, -90.258],
  AUS: [30.1945, -97.6699],
  DAL: [32.8471, -96.8518],
  HOU: [29.6454, -95.2789],
  ASE: [39.2232, -106.8688],
  EGE: [39.6426, -106.9177],
  DEN: [39.8561, -104.6737],
  LAS: [36.084, -115.1537],
  PHX: [33.4343, -112.0116],
  LAX: [33.9416, -118.4085],
  VNY: [34.2098, -118.4897],
  SAN: [32.7338, -117.1933],
  SFO: [37.6213, -122.379],
  SEA: [47.4502, -122.3088],
  ORD: [41.9742, -87.9073],
  DTW: [42.2124, -83.3534],
  MSP: [44.882, -93.2218],
  NAS: [25.039, -77.4662],
  CUN: [21.0365, -86.8771],
  YYZ: [43.6777, -79.6248],
  MBJ: [18.5037, -77.9134],
  SJU: [18.4394, -66.0018],
};

const ROUTES = [
  ['OPF', 'TEB'], ['TEB', 'PBI'], ['OPF', 'ASE'], ['ASE', 'VNY'], ['VNY', 'LAS'],
  ['LAS', 'DAL'], ['DAL', 'OPF'], ['FXE', 'BOS'], ['BOS', 'ACK'], ['ACK', 'HPN'],
  ['HPN', 'PBI'], ['MIA', 'NAS'], ['NAS', 'OPF'], ['TPA', 'CUN'], ['CUN', 'TPA'],
  ['ORD', 'TEB'], ['TEB', 'ORD'], ['SFO', 'LAS'], ['SEA', 'DEN'], ['DEN', 'AUS'],
  ['AUS', 'MSY'], ['MSY', 'ATL'], ['ATL', 'DCA'], ['DCA', 'BOS'], ['BNA', 'OPF'],
  ['LAX', 'TEB'], ['TEB', 'LAX'], ['BOS', 'SFO'], ['SFO', 'SEA'], ['YYZ', 'TEB'],
  ['TEB', 'YYZ'], ['MBJ', 'FXE'], ['SJU', 'MIA'], ['MCO', 'EWR'], ['EWR', 'CLT'],
  ['CLT', 'CHS'], ['CHS', 'EYW'], ['EYW', 'OPF'], ['MSP', 'ORD'], ['DTW', 'BNA'],
  ['PHX', 'SAN'], ['SAN', 'ASE'], ['EGE', 'DAL'], ['HOU', 'JAX'], ['JAX', 'IAD'],
  ['IAD', 'BWI'], ['BWI', 'OPF'], ['APF', 'TEB'], ['FLL', 'ATL'], ['PBI', 'ASE'],
];

const TAILS = ['N551SK', 'N882SK', 'N100SK', 'N200SK', 'N300SK', 'N400SK'];

function lookup(code) {
  const hit = AIRPORTS[code];
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}

/** Public payload covering the calendar year, built through the same projector as stored legs. */
export function demoShowcasePayload(now = Date.now()) {
  const yearStart = zonedStartOfYearMs(now);
  const raw = [];
  let n = 0;
  for (let day = 2; day <= 285; day += 2) {
    for (let slot = 0; slot < 3; slot += 1) {
      const [from, to] = ROUTES[n % ROUTES.length];
      const departure = yearStart + day * 86_400_000 + (13 + slot * 3) * 3_600_000;
      const hours = 1.7 + ((n + slot) % 5) * 0.75;
      const arrival = departure + hours * 3_600_000;
      if (arrival >= now) continue;
      raw.push({
        tail: TAILS[n % TAILS.length],
        from,
        to,
        departure: new Date(departure).toISOString(),
        arrival: new Date(arrival).toISOString(),
        category: n % 17 === 0 ? 'REPO' : 'REVENUE',
        isFlight: true,
        cancelled: false,
      });
      n += 1;
    }
  }
  return publicShowcaseBody(selectShowcaseLegs(raw, { now, lookupCoords: lookup }), now);
}
