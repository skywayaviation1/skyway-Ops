// airport-coords.js — lat/lng coordinates for airports the fleet uses.
//
// This is SEPARATE from airports.js (which is a timezone database) on
// purpose: the timezone DB is comprehensive (1000+ airports) but we only
// need coordinates for airports the fleet actually visits, and bundling
// coordinates for 1000+ airports would inflate the bundle for the TV
// board feature for no gain.
//
// Lookup convention: trip data uses 3- or 4-letter codes. Try the code
// as given, then with K-prefix added/removed (FAA ↔ US ICAO).
//
// If a flight references an airport not in this list, the route line
// just won't draw — better than crashing. The console will log the
// missing code so we can add it.

const COORDS = {
  // Florida
  FXE:  { lat: 26.1973, lng: -80.1707 },
  FLL:  { lat: 26.0726, lng: -80.1527 },
  MIA:  { lat: 25.7959, lng: -80.2870 },
  OPF:  { lat: 25.9070, lng: -80.2784 },
  TMB:  { lat: 25.6479, lng: -80.4327 },
  PBI:  { lat: 26.6832, lng: -80.0956 },
  TPA:  { lat: 27.9755, lng: -82.5332 },
  PIE:  { lat: 27.9106, lng: -82.6874 },
  APF:  { lat: 26.1525, lng: -81.7752 },
  RSW:  { lat: 26.5362, lng: -81.7552 },
  JAX:  { lat: 30.4941, lng: -81.6879 },
  ORL:  { lat: 28.5455, lng: -81.3329 },
  MCO:  { lat: 28.4294, lng: -81.3089 },
  ISM:  { lat: 28.2898, lng: -81.4372 },
  SFB:  { lat: 28.7776, lng: -81.2375 },
  DAB:  { lat: 29.1799, lng: -81.0581 },
  TLH:  { lat: 30.3965, lng: -84.3503 },
  PNS:  { lat: 30.4734, lng: -87.1866 },
  EYW:  { lat: 24.5561, lng: -81.7596 },
  '07FA': { lat: 25.3253, lng: -80.2747 },
  DTS:  { lat: 30.4001, lng: -86.4715 },

  // Southeast US
  ACY:  { lat: 39.4576, lng: -74.5772 },
  ATL:  { lat: 33.6407, lng: -84.4277 },
  PDK:  { lat: 33.8756, lng: -84.3022 },
  RYY:  { lat: 34.0132, lng: -84.5970 },
  CHA:  { lat: 35.0353, lng: -85.2038 },
  BNA:  { lat: 36.1245, lng: -86.6782 },
  MEM:  { lat: 35.0424, lng: -89.9767 },
  CLT:  { lat: 35.2140, lng: -80.9431 },
  ILM:  { lat: 34.2706, lng: -77.9026 },
  CHS:  { lat: 32.8986, lng: -80.0405 },
  HXD:  { lat: 32.2244, lng: -80.6975 },
  SAV:  { lat: 32.1276, lng: -81.2021 },
  AIK:  { lat: 33.6493, lng: -81.6850 },
  ARW:  { lat: 32.4122, lng: -80.6344 },
  GSP:  { lat: 34.8957, lng: -82.2189 },
  AVL:  { lat: 35.4362, lng: -82.5418 },
  LEX:  { lat: 38.0365, lng: -84.6059 },
  SDF:  { lat: 38.1744, lng: -85.7360 },
  BHM:  { lat: 33.5629, lng: -86.7535 },
  HSV:  { lat: 34.6372, lng: -86.7751 },
  TYS:  { lat: 35.8110, lng: -83.9941 },
  MSY:  { lat: 29.9934, lng: -90.2580 },
  SSI:  { lat: 31.1517, lng: -81.3914 },

  // Mid-Atlantic
  TEB:  { lat: 40.8501, lng: -74.0608 },
  MMU:  { lat: 40.7995, lng: -74.4148 },
  CDW:  { lat: 40.8752, lng: -74.2814 },
  JFK:  { lat: 40.6413, lng: -73.7781 },
  LGA:  { lat: 40.7769, lng: -73.8740 },
  EWR:  { lat: 40.6895, lng: -74.1745 },
  HPN:  { lat: 41.0670, lng: -73.7076 },
  ISP:  { lat: 40.7952, lng: -73.1002 },
  FRG:  { lat: 40.7288, lng: -73.4134 },
  IAD:  { lat: 38.9531, lng: -77.4565 },
  DCA:  { lat: 38.8521, lng: -77.0377 },
  GAI:  { lat: 39.1683, lng: -77.1660 },
  HEF:  { lat: 38.7214, lng: -77.5155 },
  BWI:  { lat: 39.1754, lng: -76.6683 },
  RIC:  { lat: 37.5052, lng: -77.3197 },
  ORF:  { lat: 36.8946, lng: -76.2012 },
  PHL:  { lat: 39.8744, lng: -75.2424 },
  PNE:  { lat: 40.0820, lng: -75.0106 },
  ABE:  { lat: 40.6521, lng: -75.4408 },
  RDU:  { lat: 35.8776, lng: -78.7875 },
  TTN:  { lat: 40.2767, lng: -74.8135 },

  // Northeast
  BOS:  { lat: 42.3656, lng: -71.0096 },
  BED:  { lat: 42.4700, lng: -71.2890 },
  ORH:  { lat: 42.2673, lng: -71.8757 },
  PVD:  { lat: 41.7240, lng: -71.4282 },
  ACK:  { lat: 41.2530, lng: -70.0602 },
  MVY:  { lat: 41.3931, lng: -70.6143 },
  HYA:  { lat: 41.6694, lng: -70.2804 },
  PWM:  { lat: 43.6462, lng: -70.3088 },
  BGR:  { lat: 44.8074, lng: -68.8281 },
  BTV:  { lat: 44.4719, lng: -73.1533 },
  ALB:  { lat: 42.7483, lng: -73.8019 },
  SYR:  { lat: 43.1112, lng: -76.1063 },
  BUF:  { lat: 42.9405, lng: -78.7322 },
  ROC:  { lat: 43.1189, lng: -77.6724 },

  // Midwest
  ORD:  { lat: 41.9742, lng: -87.9073 },
  MDW:  { lat: 41.7868, lng: -87.7522 },
  PWK:  { lat: 42.1142, lng: -87.9015 },
  DTW:  { lat: 42.2124, lng: -83.3534 },
  PTK:  { lat: 42.6655, lng: -83.4200 },
  MKE:  { lat: 42.9472, lng: -87.8966 },
  MSP:  { lat: 44.8848, lng: -93.2223 },
  STL:  { lat: 38.7487, lng: -90.3700 },
  MCI:  { lat: 39.2976, lng: -94.7139 },
  CMH:  { lat: 39.9980, lng: -82.8919 },
  CLE:  { lat: 41.4117, lng: -81.8497 },
  IND:  { lat: 39.7173, lng: -86.2944 },
  CVG:  { lat: 39.0488, lng: -84.6678 },

  // West
  DEN:  { lat: 39.8617, lng: -104.6731 },
  APA:  { lat: 39.5701, lng: -104.8487 },
  ASE:  { lat: 39.2232, lng: -106.8687 },
  EGE:  { lat: 39.6426, lng: -106.9176 },
  JAC:  { lat: 43.6073, lng: -110.7378 },
  LAS:  { lat: 36.0801, lng: -115.1522 },
  LAX:  { lat: 33.9416, lng: -118.4085 },
  VNY:  { lat: 34.2098, lng: -118.4901 },
  SNA:  { lat: 33.6757, lng: -117.8682 },
  BUR:  { lat: 34.2007, lng: -118.3587 },
  SBA:  { lat: 34.4262, lng: -119.8415 },
  SFO:  { lat: 37.6213, lng: -122.3790 },
  SJC:  { lat: 37.3639, lng: -121.9289 },
  OAK:  { lat: 37.7213, lng: -122.2207 },
  PDX:  { lat: 45.5887, lng: -122.5975 },
  SEA:  { lat: 47.4502, lng: -122.3088 },
  BFI:  { lat: 47.5300, lng: -122.3019 },
  PHX:  { lat: 33.4373, lng: -112.0078 },
  SDL:  { lat: 33.6229, lng: -111.9106 },
  TUS:  { lat: 32.1161, lng: -110.9410 },
  ABQ:  { lat: 35.0402, lng: -106.6090 },
  SAF:  { lat: 35.6171, lng: -106.0892 },
  SAT:  { lat: 29.5337, lng: -98.4698 },
  AUS:  { lat: 30.1975, lng: -97.6664 },
  HOU:  { lat: 29.6454, lng: -95.2789 },
  IAH:  { lat: 29.9844, lng: -95.3414 },
  DAL:  { lat: 32.8471, lng: -96.8518 },
  DFW:  { lat: 32.8998, lng: -97.0403 },
  ADS:  { lat: 32.9686, lng: -96.8364 },
  TKI:  { lat: 33.1772, lng: -96.5907 },

  // Canada (Eastern)
  CYYZ: { lat: 43.6777, lng: -79.6248 },
  CYTZ: { lat: 43.6275, lng: -79.3961 },
  CYKZ: { lat: 43.8625, lng: -79.3700 },
  CYOW: { lat: 45.3225, lng: -75.6692 },
  CYUL: { lat: 45.4707, lng: -73.7407 },
  CYHU: { lat: 45.5175, lng: -73.4169 },
  CYQB: { lat: 46.7911, lng: -71.3933 },
  CYHZ: { lat: 44.8808, lng: -63.5086 },

  // Caribbean
  MYNN: { lat: 25.0389, lng: -77.4661 },
  MYGF: { lat: 26.5587, lng: -78.6956 },
  MYAM: { lat: 26.5114, lng: -77.0834 },
  MYEH: { lat: 25.4747, lng: -76.6835 },
  MYEM: { lat: 25.2847, lng: -76.3309 },
  TJSJ: { lat: 18.4394, lng: -66.0018 },
  TIST: { lat: 18.3373, lng: -64.9734 },
  TNCM: { lat: 18.0410, lng: -63.1089 },
};

/**
 * Look up airport coordinates. Tries the code as given, then with
 * K-prefix removed (US ICAO → FAA), then with K-prefix added.
 * Returns { lat, lng } or null if unknown.
 */
export function lookupCoords(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().trim();
  if (COORDS[c]) return COORDS[c];
  if (c.length === 4 && c.startsWith('K') && COORDS[c.slice(1)]) return COORDS[c.slice(1)];
  if (c.length === 3 && COORDS['K' + c]) return COORDS['K' + c];
  return null;
}

export default COORDS;
