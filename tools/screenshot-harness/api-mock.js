/* Vite middleware standing in for the /api serverless functions.
 *
 * Only the read endpoints the screenshot flows touch are implemented; anything
 * else answers 501 so a stray call fails fast instead of hanging.
 */

import { harnessAnchor } from './clock.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/* All harness timestamps hang off the shared anchor, not the wall clock, so
 * observation times read as fresh inside the app's pinned clock. */
const now = () => harnessAnchor();

function metar(icao, category, wind, visibility, ceiling, temp, dewpoint, raw) {
  return {
    ok: true,
    icao,
    metar: {
      observedTime: new Date(now() - 12 * MIN).toISOString(),
      rawMetar: raw,
      tempC: temp,
      dewpointC: dewpoint,
      windDir: wind[0],
      windKt: wind[1],
      windGustKt: wind[2] || null,
      visibilitySm: visibility,
      altimeterInHg: 30.02,
      ceilingFt: ceiling,
      flightCategory: category,
      clouds: ceiling
        ? [{ cover: 'BKN', base: ceiling }]
        : [{ cover: 'FEW', base: 25000 }],
    },
    taf: {
      issuedTime: new Date(now() - 90 * MIN).toISOString(),
      validFrom: new Date(now() - 60 * MIN).toISOString(),
      validTo: new Date(now() + 23 * HOUR).toISOString(),
      rawTaf: `TAF ${icao} ${raw.split(' ')[1]} 2412/2518 ${String(wind[0]).padStart(3, '0')}${String(wind[1]).padStart(2, '0')}KT P6SM FEW250`,
      periods: [
        {
          timeFrom: new Date(now() - 60 * MIN).toISOString(),
          timeTo: new Date(now() + 6 * HOUR).toISOString(),
          changeIndicator: null,
          windDir: wind[0], windKt: wind[1], windGustKt: wind[2] || null,
          visibilitySm: visibility, ceilingFt: ceiling,
          flightCategory: category,
          clouds: ceiling ? [{ cover: 'BKN', base: ceiling }] : [{ cover: 'FEW', base: 25000 }],
          weather: null,
        },
        {
          timeFrom: new Date(now() + 6 * HOUR).toISOString(),
          timeTo: new Date(now() + 14 * HOUR).toISOString(),
          changeIndicator: 'TEMPO',
          windDir: wind[0], windKt: wind[1] + 4, windGustKt: wind[1] + 12,
          visibilitySm: 4, ceilingFt: 2500,
          flightCategory: 'MVFR',
          clouds: [{ cover: 'BKN', base: 2500 }],
          weather: ['-RA'],
        },
      ],
    },
    cached: false,
  };
}

const WEATHER = {
  TEB: () => metar('KTEB', 'VFR', [310, 9], 10, null, 24, 12, 'METAR KTEB 241751Z 31009KT 10SM FEW250 24/12 A3002'),
  PBI: () => metar('KPBI', 'MVFR', [120, 12, 19], 6, 2200, 29, 24, 'METAR KPBI 241753Z 12012G19KT 6SM -RA BKN022 29/24 A2998'),
  HPN: () => metar('KHPN', 'VFR', [300, 7], 10, null, 23, 11, 'METAR KHPN 241752Z 30007KT 10SM SKC 23/11 A3003'),
  MVY: () => metar('KMVY', 'IFR', [70, 14], 2, 600, 19, 18, 'METAR KMVY 241753Z 07014KT 2SM BR OVC006 19/18 A2996'),
  DAL: () => metar('KDAL', 'VFR', [170, 11], 10, null, 33, 21, 'METAR KDAL 241753Z 17011KT 10SM FEW045 33/21 A2995'),
  ASE: () => metar('KASE', 'VFR', [290, 8], 10, 12000, 21, 4, 'METAR KASE 241753Z 29008KT 10SM SCT120 21/04 A3011'),
  TPA: () => metar('KTPA', 'VFR', [250, 10, 16], 10, null, 31, 23, 'METAR KTPA 241753Z 25010G16KT 10SM SCT035 31/23 A2999'),
  OPF: () => metar('KOPF', 'VFR', [100, 13], 10, 3500, 30, 23, 'METAR KOPF 241753Z 10013KT 10SM BKN035 30/23 A2997'),
  BOS: () => metar('KBOS', 'MVFR', [60, 16, 24], 5, 1800, 20, 17, 'METAR KBOS 241754Z 06016G24KT 5SM -RA BKN018 20/17 A2994'),
  SDL: () => metar('KSDL', 'VFR', [280, 6], 10, null, 39, 8, 'METAR KSDL 241753Z 28006KT 10SM CLR 39/08 A2988'),
  VNY: () => metar('KVNY', 'VFR', [230, 9], 10, null, 27, 14, 'METAR KVNY 241753Z 23009KT 10SM CLR 27/14 A2992'),
  BNA: () => metar('KBNA', 'VFR', [200, 8], 10, 9000, 28, 19, 'METAR KBNA 241753Z 20008KT 10SM SCT090 28/19 A3001'),
  CHS: () => metar('KCHS', 'VFR', [210, 10], 10, 4500, 30, 24, 'METAR KCHS 241756Z 21010KT 10SM SCT045 30/24 A3000'),
  HOU: () => metar('KHOU', 'VFR', [150, 12], 10, null, 32, 24, 'METAR KHOU 241753Z 15012KT 10SM FEW050 32/24 A2996'),
};

const NOTAMS = {
  PBI: [
    {
      id: 'FDC 4/8812',
      classification: 'FDC',
      type: 'RWY',
      severity: 'high',
      summary: 'RWY 10L/28R CLSD',
      text: 'PBI RWY 10L/28R CLSD FOR MAINTENANCE. USE RWY 10R/28L.',
      effectiveStart: now() - 6 * HOUR,
      effectiveEnd: now() + 30 * HOUR,
      qcode: 'QMRLC',
    },
    {
      id: 'PBI 09/041',
      classification: 'DOM',
      type: 'NAVAID',
      severity: 'medium',
      summary: 'ILS RWY 10R GP U/S',
      text: 'PBI NAV ILS RWY 10R GP U/S.',
      effectiveStart: now() - 20 * HOUR,
      effectiveEnd: now() + 72 * HOUR,
      qcode: 'QICAS',
    },
  ],
  ASE: [
    {
      id: 'ASE 09/007',
      classification: 'DOM',
      type: 'AIRPORT',
      severity: 'high',
      summary: 'ASE SPECIAL QUALIFICATION AIRPORT — DAY VFR DEP ONLY',
      text: 'ASE APCH/DEP PROC SPECIAL QUALIFICATION REQUIRED. DEP RWY 33 DAY VFR ONLY.',
      effectiveStart: now() - 200 * HOUR,
      effectiveEnd: null,
      qcode: 'QFAXX',
    },
  ],
  BOS: [
    {
      id: 'BOS 09/112',
      classification: 'DOM',
      type: 'TWY',
      severity: 'low',
      summary: 'TWY N BTN TWY M AND TWY K CLSD',
      text: 'BOS TWY N BTN TWY M AND TWY K CLSD.',
      effectiveStart: now() - 40 * HOUR,
      effectiveEnd: now() + 200 * HOUR,
      qcode: 'QMXLC',
    },
  ],
};

function windsAloft(icao) {
  return {
    ok: true,
    icao,
    station: icao,
    validTime: new Date(now() + 2 * HOUR).toISOString(),
    levels: [
      { altitude: 6000, windDir: 300, windKt: 18, tempC: 12 },
      { altitude: 9000, windDir: 305, windKt: 24, tempC: 6 },
      { altitude: 12000, windDir: 310, windKt: 31, tempC: -2 },
      { altitude: 18000, windDir: 300, windKt: 42, tempC: -14 },
      { altitude: 24000, windDir: 295, windKt: 55, tempC: -28 },
      { altitude: 30000, windDir: 290, windKt: 68, tempC: -42 },
      { altitude: 34000, windDir: 285, windKt: 74, tempC: -52 },
      { altitude: 39000, windDir: 280, windKt: 66, tempC: -56 },
    ],
  };
}

function strip(icao) {
  const code = String(icao || '').toUpperCase();
  return code.length === 4 && code.startsWith('K') ? code.slice(1) : code;
}

/* The broker-facing tracking page consumes a sanitized trip snapshot: no
 * pricing, no crew contact details, no internal notes. */
function brokerPayload(positions, trackLog) {
  const anchor = now();
  const at = (minutes) => Math.round(anchor + minutes * MIN);
  const position = positions.find((entry) => entry.ident === 'N444AM') || null;

  const brokerWeather = (code) => {
    const source = WEATHER[code]?.();
    if (!source?.metar) return null;
    const period = source.taf?.periods?.[0] || null;
    return {
      icao: source.icao,
      metar: source.metar,
      forecast: period && {
        timeFrom: period.timeFrom,
        timeTo: period.timeTo,
        windDir: period.windDir,
        windKt: period.windKt,
        visibilitySm: period.visibilitySm,
        ceilingFt: period.ceilingFt,
        flightCategory: period.flightCategory,
      },
    };
  };

  return {
    ok: true,
    trip: {
      tripId: 'ji-2211',
      tripCode: 'SKW-2211',
      tail: 'N444AM',
      aircraftType: 'King Air 350',
      legs: [
        {
          legNumber: 1,
          from: 'TEB', to: 'PBI',
          fromFbo: 'Signature TEB', toFbo: 'Atlantic Aviation PBI',
          departure: new Date(at(-78)).toISOString(),
          arrival: new Date(at(62)).toISOString(),
          category: 'REVENUE',
          pic: 'Ken Alvarez',
          sic: 'Sarah Boyd',
          pax: [
            { name: 'R. Ellery', checkedIn: true },
            { name: 'M. Ellery', checkedIn: true },
            { name: 'S. Vaught', checkedIn: true },
            { name: 'A. Renner', checkedIn: true },
            { name: 'D. Okafor', checkedIn: true },
            { name: 'N. Castellanos', checkedIn: true },
          ],
          showPax: true,
          status: {
            crew_onsite: { at: at(-138) },
            aircraft_ready: { at: at(-126) },
            catering_aboard: { at: at(-114) },
            pax_arrived: { at: at(-102) },
            pax_boarded: { at: at(-92) },
            taxi_dep: { at: at(-84) },
            wheels_up: { at: at(-74) },
          },
        },
      ],
      statuses: {},
      completed: false,
      completedAt: null,
    },
    position,
    trail: trackLog.positions.map((point) => ({
      lat: point.latitude,
      lon: point.longitude,
      altitude_ft: point.altitude * 100,
      groundspeed_kt: point.groundspeed,
      time: point.timestamp,
    })),
    trailLive: true,
    weather: { TEB: brokerWeather('TEB'), PBI: brokerWeather('PBI') },
  };
}

/* A fuel-receipt stand-in for the expense detail pane. */
const RECEIPT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560" viewBox="0 0 420 560">
  <rect width="420" height="560" fill="#f6f4ee"/>
  <g font-family="monospace" fill="#26221c">
    <text x="210" y="52" font-size="21" text-anchor="middle" font-weight="bold">ATLANTIC AVIATION</text>
    <text x="210" y="76" font-size="13" text-anchor="middle">PALM BEACH INTL (KPBI)</text>
    <text x="210" y="94" font-size="11" text-anchor="middle">1500 PERIMETER RD · WEST PALM BEACH FL</text>
    <line x1="36" y1="116" x2="384" y2="116" stroke="#26221c" stroke-dasharray="4 4"/>
    <text x="36" y="148" font-size="12">TICKET</text><text x="384" y="148" font-size="12" text-anchor="end">FS-884120</text>
    <text x="36" y="172" font-size="12">AIRCRAFT</text><text x="384" y="172" font-size="12" text-anchor="end">N444AM</text>
    <text x="36" y="196" font-size="12">PRODUCT</text><text x="384" y="196" font-size="12" text-anchor="end">JET A / PRIST</text>
    <text x="36" y="220" font-size="12">GALLONS</text><text x="384" y="220" font-size="12" text-anchor="end">412.6</text>
    <text x="36" y="244" font-size="12">PRICE / GAL</text><text x="384" y="244" font-size="12" text-anchor="end">7.2000</text>
    <line x1="36" y1="268" x2="384" y2="268" stroke="#26221c" stroke-dasharray="4 4"/>
    <text x="36" y="298" font-size="13">SUBTOTAL</text><text x="384" y="298" font-size="13" text-anchor="end">2,971.40</text>
    <text x="36" y="322" font-size="13">TAX</text><text x="384" y="322" font-size="13" text-anchor="end">0.00</text>
    <text x="36" y="356" font-size="17" font-weight="bold">TOTAL</text>
    <text x="384" y="356" font-size="17" text-anchor="end" font-weight="bold">2,971.40</text>
    <line x1="36" y1="378" x2="384" y2="378" stroke="#26221c" stroke-dasharray="4 4"/>
    <text x="36" y="406" font-size="11">CARD  AMEX ****1008</text>
    <text x="36" y="426" font-size="11">AUTH  004871</text>
    <text x="36" y="446" font-size="11">LINE SERVICE  R. MARTINEZ</text>
    <text x="210" y="500" font-size="12" text-anchor="middle">THANK YOU FOR YOUR BUSINESS</text>
    <text x="210" y="522" font-size="10" text-anchor="middle">CUSTOMER COPY</text>
  </g>
</svg>`;

function json(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function harnessApiPlugin({
  buildIcal, buildPositions, buildTrackLog,
}) {
  return {
    name: 'skyway-harness-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost');

        // Stand-in for files that would live in Firebase Storage.
        if (url.pathname.startsWith('/harness-assets/')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/svg+xml');
          res.end(RECEIPT_SVG);
          return;
        }

        if (!url.pathname.startsWith('/api/')) return next();

        const route = url.pathname.slice(5);

        if (route === 'ical') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/calendar');
          res.end(buildIcal());
          return;
        }

        if (route === 'airport-weather') {
          const code = strip(url.searchParams.get('icao'));
          const entry = WEATHER[code];
          json(res, entry ? entry() : { ok: true, icao: code, metar: null, taf: null, parsed: null });
          return;
        }

        if (route === 'faa-notams') {
          const code = strip(url.searchParams.get('icao'));
          json(res, { ok: true, icao: code, notams: NOTAMS[code] || [], cached: false });
          return;
        }

        if (route === 'winds-aloft') {
          json(res, windsAloft(strip(url.searchParams.get('icao'))));
          return;
        }

        if (route === 'flightaware-positions') {
          json(res, { ok: true, positions: buildPositions(), fetchedAt: now() });
          return;
        }

        if (route === 'flightaware-track-log') {
          json(res, buildTrackLog());
          return;
        }

        if (route === 'flightaware-alerts') {
          json(res, { ok: true, alerts: [] });
          return;
        }

        if (route === 'trip-public') {
          json(res, brokerPayload(buildPositions(), buildTrackLog()));
          return;
        }

        // Everything else: explicit, loud, and harmless.
        json(res, { ok: false, error: `harness: ${route} not implemented` }, 501);
      });
    },
  };
}
