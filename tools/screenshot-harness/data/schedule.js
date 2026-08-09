/* Demo schedule.
 *
 * Emits a JetInsight-shaped iCal feed plus the matching trip-state documents,
 * so the app's own parser and status pipeline produce the schedule rather than
 * the harness hand-feeding screens. Everything is anchored to "now" so the
 * board always has one aircraft airborne, one in preflight, and one on deck.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const STEPS_REVENUE = [
  'crew_onsite', 'aircraft_ready', 'catering_aboard',
  'pax_arrived', 'pax_boarded', 'taxi_dep', 'wheels_up', 'landed',
];
const STEPS_REPO = ['crew_onsite', 'aircraft_ready', 'taxi_dep', 'wheels_up', 'landed'];

/* Flights, ordered as they appear on the schedule. `through` names the last
 * completed status step; offsets are minutes relative to now. */
const FLIGHTS = [
  {
    uid: 'ji-2211',
    tail: 'N444AM',
    customer: 'Meridian Jet Partners',
    from: 'TEB', to: 'PBI',
    type: 'Charter',
    pax: 6,
    pic: 'Ken Alvarez', sic: 'Sarah Boyd',
    depMin: -78, arrMin: 62,
    through: 'wheels_up',
    broker: 'dispatch@meridianjetpartners.com',
    fromFbo: 'Signature TEB', toFbo: 'Atlantic Aviation PBI',
    notes: 'Catering from Cafe Ludwig · 2 wheelchairs curbside · Sprinter to Palm Beach Gardens',
    airborne: { lat: 33.11, lon: -77.42, heading: 191, altitude: 41000, groundspeed: 438, progress: 58 },
  },
  {
    uid: 'ji-2212',
    tail: 'N525CR',
    customer: 'Ardsley Capital',
    from: 'HPN', to: 'MVY',
    type: 'Owner',
    pax: 4,
    pic: 'Devin Cross', sic: 'Rachel Nakamura',
    depMin: 96, arrMin: 168,
    through: 'aircraft_ready',
    broker: 'flightdept@ardsleycapital.com',
    fromFbo: 'Ross Aviation HPN', toFbo: 'MVY Airport Services',
    notes: 'Owner leg · dog on board · newspapers WSJ + FT',
  },
  {
    uid: 'ji-2213',
    tail: 'N168ZZ',
    customer: 'Air Charter Service - Dallas',
    from: 'DAL', to: 'ASE',
    type: 'Charter',
    pax: 7,
    pic: 'Anthony Pruitt', sic: 'Grace Lindstrom',
    depMin: -352, arrMin: -168,
    through: 'landed',
    broker: 'dallas@aircharterservice.com',
    fromFbo: 'Business Jet Center DAL', toFbo: 'Atlantic Aviation ASE',
    notes: 'ASE special qualification captain required · ski equipment ×7',
    groundedAt: 'ASE',
  },
  {
    uid: 'ji-2214',
    tail: 'N444AM',
    customer: 'Meridian Jet Partners',
    from: 'PBI', to: 'TPA',
    type: 'Positioning',
    pax: 0,
    pic: 'Ken Alvarez', sic: 'Sarah Boyd',
    depMin: 156, arrMin: 224,
    through: null,
    fromFbo: 'Atlantic Aviation PBI', toFbo: 'Sheltair TPA',
  },
  {
    uid: 'ji-2215',
    tail: 'N286N',
    customer: 'Skyway Aviation',
    from: 'OPF', to: 'TPA',
    type: 'Positioning',
    pax: 0,
    pic: 'Miles Turner', sic: 'Owen Wexler',
    depMin: 268, arrMin: 336,
    through: null,
    fromFbo: 'Fontainebleau OPF', toFbo: 'Sheltair TPA',
  },
  {
    uid: 'ji-2216',
    tail: 'N651TW',
    customer: 'Bayview Partners',
    from: 'BOS', to: 'TEB',
    type: 'Charter',
    pax: 3,
    pic: 'Owen Wexler', sic: '',
    depMin: 404, arrMin: 476,
    through: null,
    // Left deliberately incomplete so the dispatch console shows real flags.
    missingSheet: true,
    missingBroker: true,
  },
  {
    uid: 'ji-2217',
    tail: 'N20UF',
    customer: 'Scheduled inspection - Elliott Aviation',
    from: 'SDL', to: 'SDL',
    type: 'Maintenance',
    pax: 0,
    depMin: -120, arrMin: 600,
  },
  {
    uid: 'ji-2218',
    tail: 'N85AH',
    customer: 'Recurrent - CAE Dallas',
    from: 'TPA', to: 'TPA',
    type: 'Training',
    pax: 0,
    pic: 'Grace Lindstrom',
    depMin: 60, arrMin: 540,
  },

  // Tomorrow
  {
    uid: 'ji-2231',
    tail: 'N525CR',
    customer: 'Ardsley Capital',
    from: 'MVY', to: 'HPN',
    type: 'Owner',
    pax: 4,
    pic: 'Devin Cross', sic: 'Rachel Nakamura',
    dep: [1, 9, 15], block: 72,
    broker: 'flightdept@ardsleycapital.com',
  },
  {
    uid: 'ji-2232',
    tail: 'N444AM',
    customer: 'Crestline Air',
    from: 'TPA', to: 'VNY',
    type: 'Charter',
    pax: 5,
    pic: 'Sarah Boyd', sic: 'Devin Cross',
    dep: [1, 11, 40], block: 320,
    broker: 'trips@crestlineair.com',
  },
  {
    uid: 'ji-2233',
    tail: 'N168ZZ',
    customer: 'Air Charter Service - Dallas',
    from: 'ASE', to: 'DAL',
    type: 'Charter',
    pax: 7,
    pic: 'Anthony Pruitt', sic: 'Grace Lindstrom',
    dep: [1, 15, 5], block: 135,
    broker: 'dallas@aircharterservice.com',
  },

  // Later this week
  {
    uid: 'ji-2241',
    tail: 'N551FP',
    customer: 'Halyard Group',
    from: 'PBI', to: 'BNA',
    type: 'Charter',
    pax: 6,
    pic: 'Miles Turner', sic: 'Owen Wexler',
    dep: [2, 8, 30], block: 118,
    broker: 'ops@halyardgroup.com',
  },
  {
    uid: 'ji-2242',
    tail: 'N444AM',
    customer: 'Crestline Air',
    from: 'VNY', to: 'SDL',
    type: 'Charter',
    pax: 5,
    pic: 'Sarah Boyd', sic: 'Devin Cross',
    dep: [2, 13, 45], block: 100,
    broker: 'trips@crestlineair.com',
  },
  {
    uid: 'ji-2243',
    tail: 'N286N',
    customer: 'Wickham Family Office',
    from: 'TPA', to: 'CHS',
    type: 'Charter',
    pax: 2,
    pic: 'Ken Alvarez', sic: 'Rachel Nakamura',
    dep: [3, 9, 50], block: 95,
    broker: 'travel@wickhamfo.com',
  },
  {
    uid: 'ji-2244',
    tail: 'N651TW',
    customer: 'Bayview Partners',
    from: 'TEB', to: 'BOS',
    type: 'Charter',
    pax: 3,
    pic: 'Owen Wexler', sic: 'Anthony Pruitt',
    dep: [4, 12, 20], block: 70,
    broker: 'ops@bayviewpartners.com',
  },

  // Completed — feeds the archive and the trailing-week metrics
  {
    uid: 'ji-2201',
    tail: 'N444AM',
    customer: 'Meridian Jet Partners',
    from: 'TPA', to: 'TEB',
    type: 'Charter',
    pax: 6,
    pic: 'Ken Alvarez', sic: 'Sarah Boyd',
    dep: [-1, 7, 40], block: 150,
    through: 'landed',
    completed: true,
    broker: 'dispatch@meridianjetpartners.com',
  },
  {
    uid: 'ji-2202',
    tail: 'N525CR',
    customer: 'Ardsley Capital',
    from: 'OPF', to: 'HPN',
    type: 'Owner',
    pax: 4,
    pic: 'Devin Cross', sic: 'Rachel Nakamura',
    dep: [-1, 12, 10], block: 160,
    through: 'landed',
    completed: true,
    broker: 'flightdept@ardsleycapital.com',
  },
  {
    uid: 'ji-2203',
    tail: 'N168ZZ',
    customer: 'Air Charter Service - Dallas',
    from: 'HOU', to: 'DAL',
    type: 'Positioning',
    pax: 0,
    pic: 'Anthony Pruitt', sic: 'Grace Lindstrom',
    dep: [-2, 16, 20], block: 60,
    through: 'landed',
    completed: true,
  },
  {
    uid: 'ji-2204',
    tail: 'N551FP',
    customer: 'Halyard Group',
    from: 'BNA', to: 'PBI',
    type: 'Charter',
    pax: 6,
    pic: 'Miles Turner', sic: 'Owen Wexler',
    dep: [-3, 10, 5], block: 120,
    through: 'landed',
    completed: true,
    broker: 'ops@halyardgroup.com',
  },
];

/* The anchor is 14:22 local, so offsets for flights on other days are written
 * as wall-clock times and converted here. */
const ANCHOR_MINUTES = 14 * 60 + 22;

function normalize(flight) {
  if (flight.depMin != null) return flight;
  const [dayOffset, hour, minute] = flight.dep;
  const depMin = dayOffset * 1440 + (hour * 60 + minute) - ANCHOR_MINUTES;
  return { ...flight, depMin, arrMin: depMin + flight.block };
}

function icalStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function description(flight) {
  const lines = [];
  if (flight.pax != null) lines.push(`PAX: ${flight.pax}`);
  if (flight.pic) lines.push(`PIC: ${flight.pic}`);
  if (flight.sic) lines.push(`SIC: ${flight.sic}`);
  if (flight.notes) lines.push(flight.notes);
  return lines.join('\\n');
}

export function buildDemoICal(now = Date.now()) {
  let out = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//JetInsight//Schedule//EN\r\n';
  for (const flight of FLIGHTS.map(normalize)) {
    const dep = new Date(now + flight.depMin * MIN);
    const arr = new Date(now + flight.arrMin * MIN);
    out += 'BEGIN:VEVENT\r\n';
    out += `UID:${flight.uid}\r\n`;
    out += `DTSTART:${icalStamp(dep)}\r\n`;
    out += `DTEND:${icalStamp(arr)}\r\n`;
    out += `SUMMARY:[${flight.tail}] ${flight.customer} (${flight.from} - ${flight.to}) - ${flight.type}\r\n`;
    out += `DESCRIPTION:${description(flight)}\r\n`;
    out += `LOCATION:${flight.from}\r\n`;
    out += 'URL:https://portal.jetinsight.com/trips/demo\r\n';
    out += 'END:VEVENT\r\n';
  }
  out += 'END:VCALENDAR\r\n';
  return out;
}

/* Trip-state documents: statuses, broker wiring, FBOs and parsed pax. */
export function buildTripStates(now = Date.now(), usersByName = {}) {
  const docs = [];
  for (const flight of FLIGHTS.map(normalize)) {
    if (flight.type === 'Maintenance' || flight.type === 'Training') continue;

    const isRevenue = flight.type === 'Charter' ? flight.pax > 0 : flight.type === 'Owner';
    const steps = isRevenue ? STEPS_REVENUE : STEPS_REPO;
    const cutoff = flight.through ? steps.indexOf(flight.through) : -1;
    const dep = now + flight.depMin * MIN;
    const arr = now + flight.arrMin * MIN;

    // Pre-departure steps are spread over the hour before wheels-up; the last
    // two hang off the leg itself.
    const preDeparture = steps.indexOf('taxi_dep');
    const statuses = {};
    for (let i = 0; i <= cutoff; i += 1) {
      const step = steps[i];
      let at;
      if (step === 'landed') at = arr;
      else if (step === 'wheels_up') at = dep + 4 * MIN;
      else if (step === 'taxi_dep') at = dep - 6 * MIN;
      else at = dep - (60 - i * (48 / preDeparture)) * MIN;
      statuses[step] = {
        timestamp: Math.round(at),
        author: flight.pic || 'Ops',
        coords: step === 'crew_onsite' ? { lat: 26.6832, lon: -80.0956, accuracy: 12 } : null,
        notified: !!flight.broker,
      };
    }

    const pic = usersByName[flight.pic || ''];
    docs.push({
      id: flight.uid,
      data: {
        statuses,
        passengers: [],
        preloadedPax: buildPax(flight),
        brokerEmail: flight.missingBroker ? '' : (flight.broker || ''),
        autoNotify: !!flight.broker,
        completed: !!flight.completed,
        completedAt: flight.completed ? arr + 20 * MIN : null,
        archived: false,
        archivedAt: null,
        hasCatering: isRevenue,
        paxOverride: null,
        tripSheetUrl: flight.missingSheet ? null : '/harness-assets/trip-sheet.pdf',
        tripSheetFilename: flight.missingSheet ? null : `crew-itinerary-${flight.uid}.pdf`,
        tripSheetUploadedAt: flight.missingSheet ? null : dep - 20 * HOUR,
        tripSheetUploadedBy: 'Marco Ruiz',
        dispatcherUids: flight.missingSheet ? [] : ['demo-ops-marco'],
        fromFbo: flight.fromFbo || null,
        toFbo: flight.toFbo || null,
        tripSheetNotes: flight.notes
          ? { crew: `PIC ${flight.pic}${flight.sic ? ` · SIC ${flight.sic}` : ''}`, pax: flight.notes, customer: flight.customer, specialItems: null }
          : null,
        tripMeta: {
          tail: flight.tail,
          from: flight.from,
          to: flight.to,
          start: dep,
          legType: isRevenue ? 'REVENUE' : 'REPO',
        },
        updatedAt: now - 4 * MIN,
        picUid: pic?.uid || null,
      },
    });
  }
  return docs;
}

const PAX_POOL = [
  ['Robert', 'Ellery'], ['Margaret', 'Ellery'], ['Simon', 'Vaught'],
  ['Alicia', 'Renner'], ['David', 'Okafor'], ['Nina', 'Castellanos'],
  ['Peter', 'Hollins'],
];

function buildPax(flight) {
  if (!flight.pax || flight.missingSheet) return [];
  return PAX_POOL.slice(0, flight.pax).map(([firstName, lastName], index) => ({
    id: `${flight.uid}-pax-${index}`,
    firstName,
    lastName,
    dob: `19${60 + index * 3}-0${(index % 9) + 1}-1${index % 9}`,
    weight: 160 + index * 9,
    gender: index % 2 === 0 ? 'M' : 'F',
    primary: index === 0,
    scannedPaxId: null,
    vetted: true,
  }));
}

/* FlightAware-shaped positions for the live tracking screens. */
export function buildPositions(now = Date.now()) {
  const positions = [];
  const airborne = FLIGHTS.map(normalize).find((flight) => flight.airborne);
  for (const aircraft of ['N444AM', 'N525CR', 'N286N', 'N20UF', 'N651TW', 'N551FP', 'N85AH', 'N168ZZ']) {
    if (airborne && aircraft === airborne.tail) {
      positions.push({
        ident: aircraft,
        airborne: true,
        faFlightId: `demo-${aircraft}`,
        latitude: airborne.airborne.lat,
        longitude: airborne.airborne.lon,
        heading: airborne.airborne.heading,
        altitude: airborne.airborne.altitude,
        groundspeed: airborne.airborne.groundspeed,
        origin: 'KTEB',
        originLat: 40.8501,
        originLon: -74.0608,
        destination: 'KPBI',
        destinationLat: 26.6832,
        destinationLon: -80.0956,
        destinationCity: 'West Palm Beach',
        actualOff: new Date(now + (airborne.depMin + 4) * MIN).toISOString(),
        estimatedOn: new Date(now + airborne.arrMin * MIN).toISOString(),
        progressPercent: airborne.airborne.progress,
        track: buildTrack(),
      });
      continue;
    }
    const parked = PARKED[aircraft];
    positions.push({
      ident: aircraft,
      airborne: false,
      groundedAt: parked.icao,
      groundedLat: parked.lat,
      groundedLon: parked.lon,
      groundedCity: parked.city,
      groundedSince: new Date(now - parked.sinceHours * HOUR).toISOString(),
      lastOrigin: parked.fromIcao || null,
      lastOriginLat: parked.fromLat ?? null,
      lastOriginLon: parked.fromLon ?? null,
    });
  }
  return positions;
}

const PARKED = {
  N525CR: { icao: 'KHPN', lat: 41.0670, lon: -73.7076, city: 'White Plains', sinceHours: 14, fromIcao: 'KOPF', fromLat: 25.9079, fromLon: -80.2784 },
  N286N: { icao: 'KOPF', lat: 25.9079, lon: -80.2784, city: 'Opa-locka', sinceHours: 31 },
  N20UF: { icao: 'KSDL', lat: 33.6229, lon: -111.9105, city: 'Scottsdale', sinceHours: 78 },
  N651TW: { icao: 'KBOS', lat: 42.3643, lon: -71.0052, city: 'Boston', sinceHours: 20 },
  N551FP: { icao: 'KPBI', lat: 26.6832, lon: -80.0956, city: 'West Palm Beach', sinceHours: 41 },
  N85AH: { icao: 'KTPA', lat: 27.9755, lon: -82.5332, city: 'Tampa', sinceHours: 9 },
  N168ZZ: { icao: 'KASE', lat: 39.2232, lon: -106.8687, city: 'Aspen', sinceHours: 3, fromIcao: 'KDAL', fromLat: 32.8471, fromLon: -96.8518 },
};

/* Great-circle-ish trail from KTEB toward KPBI, with a climb profile. */
function buildTrack() {
  const start = [-74.0608, 40.8501];
  const here = [-77.42, 33.11];
  const points = [];
  const legs = 26;
  for (let i = 0; i <= legs; i += 1) {
    const ratio = i / legs;
    const lon = start[0] + (here[0] - start[0]) * ratio + Math.sin(ratio * Math.PI) * 0.5;
    const lat = start[1] + (here[1] - start[1]) * ratio;
    const altitude = Math.round(Math.min(41000, 1500 + ratio * 96000) / 100) * 100;
    points.push([lon, lat, altitude]);
  }
  return points;
}

export function trackLogPayload(now = Date.now()) {
  const track = buildTrack();
  return {
    ok: true,
    ident: 'N444AM',
    positions: track.map(([lon, lat, altitude], index) => ({
      timestamp: new Date(now - (track.length - index) * 3 * MIN).toISOString(),
      latitude: lat,
      longitude: lon,
      altitude: altitude / 100,
      groundspeed: Math.min(440, 160 + index * 14),
    })),
  };
}

export { FLIGHTS, MIN, HOUR, DAY };
