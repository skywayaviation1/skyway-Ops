// /api/_airports-data.js
//
// Hardcoded coordinates for common US airports used in charter operations.
// Source: OurAirports public dataset (cc-by) cross-checked against FAA AIS.
//
// This exists because relying on FlightAware's /airports/{code} endpoint for
// coordinates has produced wrong data for some IDs (e.g. KINT returning
// Oklahoma coords). For airports in this table, we use these values directly
// and skip the API call. For airports NOT in this table, we still fall back
// to FlightAware.
//
// Format: ICAO code → { latitude, longitude, city, name }
// All coords are decimal degrees, signed (W = negative longitude).

export const AIRPORTS = {
  // === Major Skyway operating airports ===
  'KTPA': { latitude: 27.97548, longitude: -82.53325, city: 'Tampa',          name: 'Tampa International' },
  'KOPF': { latitude: 25.90730, longitude: -80.27940, city: 'Miami',          name: 'Opa-Locka Executive' },
  'KFLL': { latitude: 26.07258, longitude: -80.15275, city: 'Fort Lauderdale',name: 'Fort Lauderdale-Hollywood Intl' },
  'KAPF': { latitude: 26.15259, longitude: -81.77520, city: 'Naples',         name: 'Naples Municipal' },
  'KMIA': { latitude: 25.79325, longitude: -80.29056, city: 'Miami',          name: 'Miami International' },
  'KPBI': { latitude: 26.68316, longitude: -80.09559, city: 'West Palm Beach',name: 'Palm Beach International' },
  'KMCO': { latitude: 28.42939, longitude: -81.30899, city: 'Orlando',        name: 'Orlando International' },
  'KSFB': { latitude: 28.77762, longitude: -81.23748, city: 'Orlando',        name: 'Orlando Sanford International' },

  // === East Coast, frequently used ===
  'KINT': { latitude: 36.13370, longitude: -80.22200, city: 'Winston-Salem',  name: 'Smith Reynolds' },
  'KGON': { latitude: 41.33009, longitude: -72.04518, city: 'Groton',         name: 'Groton-New London' },
  'KTEB': { latitude: 40.85007, longitude: -74.06083, city: 'Teterboro',      name: 'Teterboro' },
  'KMMU': { latitude: 40.79935, longitude: -74.41487, city: 'Morristown',     name: 'Morristown Municipal' },
  'KHPN': { latitude: 41.06695, longitude: -73.70758, city: 'White Plains',   name: 'Westchester County' },
  'KJFK': { latitude: 40.63975, longitude: -73.77893, city: 'New York',       name: 'John F Kennedy International' },
  'KLGA': { latitude: 40.77724, longitude: -73.87261, city: 'New York',       name: 'LaGuardia' },
  'KEWR': { latitude: 40.69250, longitude: -74.16867, city: 'Newark',         name: 'Newark Liberty International' },
  'KBOS': { latitude: 42.36430, longitude: -71.00518, city: 'Boston',         name: 'Logan International' },
  'KBED': { latitude: 42.46999, longitude: -71.28903, city: 'Bedford',        name: 'Laurence G Hanscom Field' },
  'KIAD': { latitude: 38.94453, longitude: -77.45581, city: 'Washington',     name: 'Dulles International' },
  'KDCA': { latitude: 38.85208, longitude: -77.03772, city: 'Washington',     name: 'Reagan National' },
  'KCLT': { latitude: 35.21401, longitude: -80.94313, city: 'Charlotte',      name: 'Charlotte/Douglas International' },
  'KCHS': { latitude: 32.89864, longitude: -80.04050, city: 'Charleston',     name: 'Charleston International' },
  'KJAX': { latitude: 30.49414, longitude: -81.68786, city: 'Jacksonville',   name: 'Jacksonville International' },
  'KSAV': { latitude: 32.12758, longitude: -81.20214, city: 'Savannah',       name: 'Savannah/Hilton Head' },
  'KATL': { latitude: 33.63672, longitude: -84.42807, city: 'Atlanta',        name: 'Hartsfield-Jackson Atlanta International' },
  'KPDK': { latitude: 33.87560, longitude: -84.30201, city: 'Atlanta',        name: 'Dekalb-Peachtree' },
  'KFXE': { latitude: 26.19725, longitude: -80.17072, city: 'Fort Lauderdale',name: 'Fort Lauderdale Executive' },

  // === Texas ===
  'KDAL': { latitude: 32.84711, longitude: -96.85177, city: 'Dallas',         name: 'Dallas Love Field' },
  'KDFW': { latitude: 32.89683, longitude: -97.03800, city: 'Dallas',         name: 'Dallas/Fort Worth International' },
  'KAUS': { latitude: 30.19453, longitude: -97.66987, city: 'Austin',         name: 'Austin-Bergstrom International' },
  'KHOU': { latitude: 29.64539, longitude: -95.27890, city: 'Houston',        name: 'William P Hobby' },
  'KIAH': { latitude: 29.98442, longitude: -95.34144, city: 'Houston',        name: 'George Bush Intercontinental' },
  'KSAT': { latitude: 29.53369, longitude: -98.46978, city: 'San Antonio',    name: 'San Antonio International' },

  // === Mountain West / Ski destinations ===
  'KASE': { latitude: 39.22316, longitude: -106.86880, city: 'Aspen',         name: 'Aspen-Pitkin County' },
  'KEGE': { latitude: 39.64255, longitude: -106.91760, city: 'Eagle',         name: 'Eagle County Regional' },
  'KJAC': { latitude: 43.60733, longitude: -110.73786, city: 'Jackson',       name: 'Jackson Hole' },
  'KBJC': { latitude: 39.90878, longitude: -105.11722, city: 'Denver',        name: 'Rocky Mountain Metropolitan' },
  'KAPA': { latitude: 39.57014, longitude: -104.84897, city: 'Denver',        name: 'Centennial' },
  'KDEN': { latitude: 39.85841, longitude: -104.66700, city: 'Denver',        name: 'Denver International' },
  'KSLC': { latitude: 40.78839, longitude: -111.97777, city: 'Salt Lake City',name: 'Salt Lake City International' },

  // === West Coast ===
  'KLAX': { latitude: 33.94254, longitude: -118.40807, city: 'Los Angeles',   name: 'Los Angeles International' },
  'KVNY': { latitude: 34.20987, longitude: -118.48970, city: 'Van Nuys',      name: 'Van Nuys' },
  'KBUR': { latitude: 34.20070, longitude: -118.35850, city: 'Burbank',       name: 'Hollywood Burbank' },
  'KSNA': { latitude: 33.67566, longitude: -117.86824, city: 'Santa Ana',     name: 'John Wayne Orange County' },
  'KSFO': { latitude: 37.61901, longitude: -122.37484, city: 'San Francisco', name: 'San Francisco International' },
  'KSJC': { latitude: 37.36186, longitude: -121.92903, city: 'San Jose',      name: 'Norman Y Mineta San Jose International' },
  'KOAK': { latitude: 37.72129, longitude: -122.22074, city: 'Oakland',       name: 'Oakland International' },
  'KLAS': { latitude: 36.08036, longitude: -115.15233, city: 'Las Vegas',     name: 'Harry Reid International' },
  'KHND': { latitude: 35.97268, longitude: -115.13414, city: 'Las Vegas',     name: 'Henderson Executive' },
  'KSDL': { latitude: 33.62290, longitude: -111.91056, city: 'Scottsdale',    name: 'Scottsdale' },
  'KPHX': { latitude: 33.43417, longitude: -112.00806, city: 'Phoenix',       name: 'Phoenix Sky Harbor International' },
  'KSAN': { latitude: 32.73356, longitude: -117.18966, city: 'San Diego',     name: 'San Diego International' },

  // === Midwest ===
  'KORD': { latitude: 41.97861, longitude: -87.90472, city: 'Chicago',        name: 'O\'Hare International' },
  'KMDW': { latitude: 41.78598, longitude: -87.75242, city: 'Chicago',        name: 'Chicago Midway International' },
  'KPWK': { latitude: 42.11421, longitude: -87.90147, city: 'Chicago',        name: 'Chicago Executive' },
  'KSTL': { latitude: 38.74872, longitude: -90.37000, city: 'St Louis',       name: 'St Louis Lambert International' },
  'KMSP': { latitude: 44.88195, longitude: -93.22177, city: 'Minneapolis',    name: 'Minneapolis-St Paul International' },
  'KDTW': { latitude: 42.21241, longitude: -83.35339, city: 'Detroit',        name: 'Detroit Metropolitan Wayne County' },
  'KCLE': { latitude: 41.41089, longitude: -81.84979, city: 'Cleveland',      name: 'Cleveland-Hopkins International' },
  'KCMH': { latitude: 39.99799, longitude: -82.89189, city: 'Columbus',       name: 'John Glenn Columbus International' },
  'KCVG': { latitude: 39.04880, longitude: -84.66773, city: 'Cincinnati',     name: 'Cincinnati/Northern Kentucky International' },
  'KIND': { latitude: 39.71732, longitude: -86.29438, city: 'Indianapolis',   name: 'Indianapolis International' },
  'KMCI': { latitude: 39.29760, longitude: -94.71390, city: 'Kansas City',    name: 'Kansas City International' },
  'KOKC': { latitude: 35.39309, longitude: -97.60074, city: 'Oklahoma City',  name: 'Will Rogers World' },

  // === Bahamas / Caribbean (Skyway international ops) ===
  'MYNN': { latitude: 25.03888, longitude: -77.46625, city: 'Nassau',         name: 'Lynden Pindling International' },
  'MYAM': { latitude: 26.51188, longitude: -77.08359, city: 'Marsh Harbour',  name: 'Marsh Harbour International' },
  'MYEH': { latitude: 25.69472, longitude: -76.68389, city: 'Eleuthera',      name: 'North Eleuthera' },
  'MYEM': { latitude: 25.47428, longitude: -76.83572, city: 'Eleuthera',      name: 'Governor\'s Harbour' },
  'MYGF': { latitude: 26.55858, longitude: -78.69556, city: 'Freeport',       name: 'Grand Bahama International' },
  'MUHA': { latitude: 22.98919, longitude: -82.40889, city: 'Havana',         name: 'Jose Marti International' },
  'MWCR': { latitude: 19.30142, longitude: -81.35775, city: 'Grand Cayman',   name: 'Owen Roberts International' },

  // === Mountain / popular GA destinations ===
  'KTRK': { latitude: 39.32000, longitude: -120.13970, city: 'Truckee',       name: 'Truckee Tahoe' },
  'KMTH': { latitude: 24.72611, longitude: -81.05139, city: 'Marathon',       name: 'The Florida Keys Marathon International' },
  'KEYW': { latitude: 24.55611, longitude: -81.75953, city: 'Key West',       name: 'Key West International' },
  'KPVU': { latitude: 40.21889, longitude: -111.72333, city: 'Provo',         name: 'Provo Municipal' },
  'KBJI': { latitude: 47.50939, longitude: -94.93433, city: 'Bemidji',        name: 'Bemidji Regional' },
  'KMSO': { latitude: 46.91631, longitude: -114.09056, city: 'Missoula',      name: 'Missoula Montana' },
};

/**
 * Look up an airport's coordinates. Accepts either ICAO (e.g. "KINT") or
 * 3-letter code (e.g. "INT" — will try "K" + code as well).
 * Returns { latitude, longitude } | null.
 */
export function lookupAirport(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().trim();
  if (AIRPORTS[c]) return AIRPORTS[c];
  // Try K-prefix variant (US airports)
  if (c.length === 3 && /^[A-Z]{3}$/.test(c) && AIRPORTS['K' + c]) {
    return AIRPORTS['K' + c];
  }
  return null;
}
