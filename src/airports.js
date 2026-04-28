// Airport timezone database.
// Maps IATA airport codes to IANA timezone identifiers.
// Covers: continental US, Canada, Mexico, Caribbean, Central America, South America.
// 
// For airports not in this list, the app falls back to UTC (Zulu) time.
// To add airports: append to this map. IANA timezone names from
// https://en.wikipedia.org/wiki/List_of_tz_database_time_zones

const AIRPORT_TIMEZONES = {
  // ===== CONTINENTAL US — Eastern Time =====
  ATL: 'America/New_York',  // Atlanta
  BDL: 'America/New_York',  // Hartford
  BOS: 'America/New_York',  // Boston
  BWI: 'America/New_York',  // Baltimore
  BUF: 'America/New_York',  // Buffalo
  CAE: 'America/New_York',  // Columbia SC
  CHA: 'America/New_York',  // Chattanooga
  CHS: 'America/New_York',  // Charleston
  CLE: 'America/New_York',  // Cleveland
  CLT: 'America/New_York',  // Charlotte
  CMH: 'America/New_York',  // Columbus
  CVG: 'America/New_York',  // Cincinnati
  DAB: 'America/New_York',  // Daytona Beach
  DAY: 'America/New_York',  // Dayton
  DCA: 'America/New_York',  // Washington Reagan
  DTW: 'America/New_York',  // Detroit
  EWR: 'America/New_York',  // Newark
  FLL: 'America/New_York',  // Fort Lauderdale
  FXE: 'America/New_York',  // Fort Lauderdale Executive
  FAY: 'America/New_York',  // Fayetteville
  GSO: 'America/New_York',  // Greensboro
  HEF: 'America/New_York',  // Manassas
  HHH: 'America/New_York',  // Hilton Head
  HPN: 'America/New_York',  // Westchester
  HVN: 'America/New_York',  // Tweed New Haven
  IAD: 'America/New_York',  // Dulles
  IAG: 'America/New_York',  // Niagara Falls
  ILM: 'America/New_York',  // Wilmington NC
  IND: 'America/New_York',  // Indianapolis
  ISP: 'America/New_York',  // Long Island
  JAX: 'America/New_York',  // Jacksonville
  JFK: 'America/New_York',  // JFK
  LEX: 'America/New_York',  // Lexington
  LGA: 'America/New_York',  // LaGuardia
  MCO: 'America/New_York',  // Orlando
  MMU: 'America/New_York',  // Morristown
  MIA: 'America/New_York',  // Miami
  MLB: 'America/New_York',  // Melbourne
  MYR: 'America/New_York',  // Myrtle Beach
  ORF: 'America/New_York',  // Norfolk
  OPF: 'America/New_York',  // Opa-Locka
  PBI: 'America/New_York',  // Palm Beach
  PHL: 'America/New_York',  // Philadelphia
  PIT: 'America/New_York',  // Pittsburgh
  PNS: 'America/New_York',  // Pensacola
  PWM: 'America/New_York',  // Portland ME
  PVD: 'America/New_York',  // Providence
  PVU: 'America/New_York',  // Provo
  PWK: 'America/Chicago',   // Chicago Executive
  RDU: 'America/New_York',  // Raleigh-Durham
  RIC: 'America/New_York',  // Richmond
  ROC: 'America/New_York',  // Rochester
  RSW: 'America/New_York',  // Fort Myers
  SAV: 'America/New_York',  // Savannah
  SDF: 'America/New_York',  // Louisville
  SFB: 'America/New_York',  // Sanford
  SRQ: 'America/New_York',  // Sarasota
  STP: 'America/Chicago',   // St. Paul
  SUA: 'America/New_York',  // Stuart
  SYR: 'America/New_York',  // Syracuse
  TLH: 'America/New_York',  // Tallahassee
  TPA: 'America/New_York',  // Tampa
  TEB: 'America/New_York',  // Teterboro
  TYS: 'America/New_York',  // Knoxville
  VRB: 'America/New_York',  // Vero Beach
  // Florida small fields
  APF: 'America/New_York',  // Naples
  BCT: 'America/New_York',  // Boca Raton
  GFL: 'America/New_York',  // Glens Falls
  HWO: 'America/New_York',  // North Perry / Hollywood
  LAL: 'America/New_York',  // Lakeland
  MQS: 'America/New_York',  // Coatesville (PA, mistakenly EDT — actually PA which is ET)
  ORL: 'America/New_York',  // Orlando Executive
  PMP: 'America/New_York',  // Pompano Beach
  SUA_alt: 'America/New_York', // Stuart (also)
  TIX: 'America/New_York',  // Titusville
  ZPH: 'America/New_York',  // Zephyrhills

  // ===== CONTINENTAL US — Central Time =====
  ABI: 'America/Chicago',   // Abilene
  ATW: 'America/Chicago',   // Appleton
  AUS: 'America/Chicago',   // Austin
  BHM: 'America/Chicago',   // Birmingham
  BNA: 'America/Chicago',   // Nashville
  CID: 'America/Chicago',   // Cedar Rapids
  CKB: 'America/New_York',  // Clarksburg WV (ET)
  COS: 'America/Denver',    // Colorado Springs (MT)
  DAL: 'America/Chicago',   // Dallas Love
  DFW: 'America/Chicago',   // Dallas-Fort Worth
  DSM: 'America/Chicago',   // Des Moines
  ELP: 'America/Denver',    // El Paso (MT)
  FSD: 'America/Chicago',   // Sioux Falls
  FWA: 'America/New_York',  // Fort Wayne (IN — ET)
  GPT: 'America/Chicago',   // Gulfport
  HOU: 'America/Chicago',   // Houston Hobby
  IAH: 'America/Chicago',   // Houston Intercontinental
  ICT: 'America/Chicago',   // Wichita
  JAN: 'America/Chicago',   // Jackson MS
  LIT: 'America/Chicago',   // Little Rock
  MCI: 'America/Chicago',   // Kansas City
  MDW: 'America/Chicago',   // Chicago Midway
  MEM: 'America/Chicago',   // Memphis
  MKE: 'America/Chicago',   // Milwaukee
  MOB: 'America/Chicago',   // Mobile
  MSP: 'America/Chicago',   // Minneapolis
  MSY: 'America/Chicago',   // New Orleans
  OKC: 'America/Chicago',   // Oklahoma City
  OMA: 'America/Chicago',   // Omaha
  ORD: 'America/Chicago',   // Chicago O'Hare
  SAT: 'America/Chicago',   // San Antonio
  SDL: 'America/Phoenix',   // Scottsdale (AZ)
  SHV: 'America/Chicago',   // Shreveport
  SPI: 'America/Chicago',   // Springfield IL
  STL: 'America/Chicago',   // St. Louis
  TUL: 'America/Chicago',   // Tulsa
  TYR: 'America/Chicago',   // Tyler
  VPS: 'America/Chicago',   // Destin / Eglin

  // ===== CONTINENTAL US — Mountain Time =====
  ABQ: 'America/Denver',    // Albuquerque
  APA: 'America/Denver',    // Centennial
  ASE: 'America/Denver',    // Aspen
  BIL: 'America/Denver',    // Billings
  BJC: 'America/Denver',    // Rocky Mtn Metro
  BZN: 'America/Denver',    // Bozeman
  COD: 'America/Denver',    // Cody
  DEN: 'America/Denver',    // Denver
  EGE: 'America/Denver',    // Eagle/Vail
  HDN: 'America/Denver',    // Hayden/Steamboat
  IDA: 'America/Boise',     // Idaho Falls
  JAC: 'America/Denver',    // Jackson Hole
  MSO: 'America/Denver',    // Missoula
  RAP: 'America/Denver',    // Rapid City
  SLC: 'America/Denver',    // Salt Lake City
  TEX: 'America/Denver',    // Telluride
  TWF: 'America/Boise',     // Twin Falls

  // ===== CONTINENTAL US — Arizona (no DST) =====
  IFP: 'America/Phoenix',   // Bullhead City
  PHX: 'America/Phoenix',   // Phoenix
  PRC: 'America/Phoenix',   // Prescott
  TUS: 'America/Phoenix',   // Tucson

  // ===== CONTINENTAL US — Pacific Time =====
  BFL: 'America/Los_Angeles',  // Bakersfield
  BOI: 'America/Boise',        // Boise (MT but uses Mountain)
  BUR: 'America/Los_Angeles',  // Burbank
  CCR: 'America/Los_Angeles',  // Concord
  CRQ: 'America/Los_Angeles',  // Carlsbad
  EUG: 'America/Los_Angeles',  // Eugene
  FAT: 'America/Los_Angeles',  // Fresno
  GEG: 'America/Los_Angeles',  // Spokane
  HHR: 'America/Los_Angeles',  // Hawthorne
  LAS: 'America/Los_Angeles',  // Las Vegas
  LAX: 'America/Los_Angeles',  // Los Angeles
  LGB: 'America/Los_Angeles',  // Long Beach
  MFR: 'America/Los_Angeles',  // Medford
  OAK: 'America/Los_Angeles',  // Oakland
  ONT: 'America/Los_Angeles',  // Ontario
  PAE: 'America/Los_Angeles',  // Everett
  PDX: 'America/Los_Angeles',  // Portland OR
  PSP: 'America/Los_Angeles',  // Palm Springs
  RDD: 'America/Los_Angeles',  // Redding
  RNO: 'America/Los_Angeles',  // Reno
  SAN: 'America/Los_Angeles',  // San Diego
  SBA: 'America/Los_Angeles',  // Santa Barbara
  SEA: 'America/Los_Angeles',  // Seattle
  SFO: 'America/Los_Angeles',  // SF
  SJC: 'America/Los_Angeles',  // San Jose
  SMF: 'America/Los_Angeles',  // Sacramento
  SMO: 'America/Los_Angeles',  // Santa Monica
  SNA: 'America/Los_Angeles',  // John Wayne / Orange County
  TRK: 'America/Los_Angeles',  // Truckee
  VNY: 'America/Los_Angeles',  // Van Nuys

  // ===== ALASKA =====
  ANC: 'America/Anchorage',
  FAI: 'America/Anchorage',
  JNU: 'America/Juneau',

  // ===== HAWAII =====
  HNL: 'Pacific/Honolulu',
  KOA: 'Pacific/Honolulu',
  LIH: 'Pacific/Honolulu',
  OGG: 'Pacific/Honolulu',
  ITO: 'Pacific/Honolulu',

  // ===== CANADA =====
  YHZ: 'America/Halifax',     // Halifax
  YYZ: 'America/Toronto',     // Toronto Pearson
  YTZ: 'America/Toronto',     // Toronto Billy Bishop
  YYJ: 'America/Vancouver',   // Victoria
  YOW: 'America/Toronto',     // Ottawa
  YUL: 'America/Toronto',     // Montreal
  YQB: 'America/Toronto',     // Quebec City
  YQM: 'America/Halifax',     // Moncton
  YQR: 'America/Regina',      // Regina (no DST)
  YQT: 'America/Toronto',     // Thunder Bay
  YQX: 'America/St_Johns',    // Gander
  YVR: 'America/Vancouver',   // Vancouver
  YWG: 'America/Winnipeg',    // Winnipeg
  YXE: 'America/Regina',      // Saskatoon
  YYC: 'America/Edmonton',    // Calgary
  YEG: 'America/Edmonton',    // Edmonton
  YYJ_alt: 'America/Vancouver',
  YHM: 'America/Toronto',     // Hamilton

  // ===== MEXICO =====
  MEX: 'America/Mexico_City', // Mexico City
  CUN: 'America/Cancun',      // Cancun (no DST)
  GDL: 'America/Mexico_City', // Guadalajara
  MTY: 'America/Monterrey',   // Monterrey
  TIJ: 'America/Tijuana',     // Tijuana
  PVR: 'America/Mexico_City', // Puerto Vallarta
  SJD: 'America/Mazatlan',    // Cabo San Lucas
  CZM: 'America/Cancun',      // Cozumel
  CUL: 'America/Mazatlan',    // Culiacan
  HMO: 'America/Hermosillo',  // Hermosillo
  LAP: 'America/Mazatlan',    // La Paz
  MID: 'America/Merida',      // Merida
  MZT: 'America/Mazatlan',    // Mazatlan
  OAX: 'America/Mexico_City', // Oaxaca
  PXM: 'America/Mexico_City', // Puerto Escondido
  TLC: 'America/Mexico_City', // Toluca
  ZIH: 'America/Mexico_City', // Ixtapa
  ZLO: 'America/Mexico_City', // Manzanillo

  // ===== CARIBBEAN =====
  AUA: 'America/Aruba',          // Aruba
  BGI: 'America/Barbados',       // Barbados
  CUR: 'America/Curacao',        // Curacao
  GCM: 'America/Cayman',         // Grand Cayman
  HAV: 'America/Havana',         // Havana
  KIN: 'America/Jamaica',        // Kingston JM
  MBJ: 'America/Jamaica',        // Montego Bay
  NAS: 'America/Nassau',         // Nassau
  POP: 'America/Santo_Domingo',  // Puerto Plata DR
  POS: 'America/Port_of_Spain',  // Trinidad
  PUJ: 'America/Santo_Domingo',  // Punta Cana
  SDQ: 'America/Santo_Domingo',  // Santo Domingo
  SJU: 'America/Puerto_Rico',    // San Juan
  STI: 'America/Santo_Domingo',  // Santiago DR
  STT: 'America/Puerto_Rico',    // St. Thomas
  STX: 'America/Puerto_Rico',    // St. Croix
  ANU: 'America/Antigua',        // Antigua
  BDA: 'Atlantic/Bermuda',       // Bermuda
  EIS: 'America/Tortola',        // Tortola
  FDF: 'America/Martinique',     // Martinique
  PTP: 'America/Guadeloupe',     // Guadeloupe
  SXM: 'America/Lower_Princes',  // St. Maarten
  SBH: 'America/St_Barthelemy',  // St. Barths
  TNCM_alt: 'America/Lower_Princes',
  GND: 'America/Grenada',        // Grenada
  SLU: 'America/St_Lucia',       // St. Lucia
  SVD: 'America/St_Vincent',     // St. Vincent
  EYW: 'America/New_York',       // Key West
  // Bahamas
  ELH: 'America/Nassau',         // North Eleuthera
  GHB: 'America/Nassau',         // Governors Harbour
  GGT: 'America/Nassau',         // George Town Exumas
  MHH: 'America/Nassau',         // Marsh Harbour
  TBI: 'America/Nassau',         // The Bight Cat Island
  TCB: 'America/Nassau',         // Treasure Cay
  ZNZ_alt: 'America/Nassau',     // (placeholder)

  // ===== CENTRAL AMERICA =====
  BZE: 'America/Belize',         // Belize City
  GUA: 'America/Guatemala',      // Guatemala City
  SAL: 'America/El_Salvador',    // San Salvador
  TGU: 'America/Tegucigalpa',    // Tegucigalpa
  SAP: 'America/Tegucigalpa',    // San Pedro Sula
  RTB: 'America/Tegucigalpa',    // Roatan
  MGA: 'America/Managua',        // Managua
  SJO: 'America/Costa_Rica',     // San Jose CR
  LIR: 'America/Costa_Rica',     // Liberia CR
  PTY: 'America/Panama',         // Panama City
  DAV: 'America/Panama',         // David, Panama

  // ===== SOUTH AMERICA =====
  // Colombia
  BOG: 'America/Bogota',
  MDE: 'America/Bogota',         // Medellin
  CTG: 'America/Bogota',         // Cartagena
  CLO: 'America/Bogota',         // Cali
  // Venezuela
  CCS: 'America/Caracas',
  VLN: 'America/Caracas',
  // Ecuador
  UIO: 'America/Guayaquil',      // Quito
  GYE: 'America/Guayaquil',
  // Peru
  LIM: 'America/Lima',
  CUZ: 'America/Lima',           // Cusco
  // Bolivia
  LPB: 'America/La_Paz',         // La Paz
  VVI: 'America/La_Paz',         // Santa Cruz
  // Chile
  SCL: 'America/Santiago',
  // Argentina
  EZE: 'America/Argentina/Buenos_Aires',  // Buenos Aires Ezeiza
  AEP: 'America/Argentina/Buenos_Aires',  // Buenos Aires Aeroparque
  COR: 'America/Argentina/Cordoba',       // Cordoba
  MDZ: 'America/Argentina/Mendoza',       // Mendoza
  USH: 'America/Argentina/Ushuaia',       // Ushuaia
  // Uruguay
  MVD: 'America/Montevideo',
  // Paraguay
  ASU: 'America/Asuncion',
  // Brazil
  GRU: 'America/Sao_Paulo',      // Sao Paulo Guarulhos
  CGH: 'America/Sao_Paulo',      // Sao Paulo Congonhas
  GIG: 'America/Sao_Paulo',      // Rio Galeao
  SDU: 'America/Sao_Paulo',      // Rio Santos Dumont
  BSB: 'America/Sao_Paulo',      // Brasilia
  REC: 'America/Recife',         // Recife
  SSA: 'America/Bahia',          // Salvador
  FOR: 'America/Fortaleza',      // Fortaleza
  CWB: 'America/Sao_Paulo',      // Curitiba
  POA: 'America/Sao_Paulo',      // Porto Alegre
  MAO: 'America/Manaus',         // Manaus
  CNF: 'America/Sao_Paulo',      // Belo Horizonte
  // Suriname / Guyana / French Guiana
  PBM: 'America/Paramaribo',     // Paramaribo
  GEO: 'America/Guyana',         // Georgetown GY
  CAY: 'America/Cayenne',        // Cayenne
};

/**
 * Get the IANA timezone for an airport code.
 * Returns null if the airport is not in the database.
 */
export function getAirportTimezone(iataCode) {
  if (!iataCode || typeof iataCode !== 'string') return null;
  return AIRPORT_TIMEZONES[iataCode.trim().toUpperCase()] || null;
}

/**
 * Format a Date in a specific airport's local time.
 * Returns object: { time: "10:21 AM", tz: "EDT" } or { time: "1021Z", tz: "UTC" } if airport unknown.
 */
export function formatLocalTime(date, iataCode) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return { time: '—', tz: '' };
  }
  const tz = getAirportTimezone(iataCode);
  if (!tz) {
    // Fall back to Zulu
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    return { time: `${hh}${mm}Z`, tz: 'UTC' };
  }
  try {
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
    // Get TZ abbreviation (EDT, PST, etc)
    const tzAbbr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value || '';
    return { time, tz: tzAbbr };
  } catch (err) {
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    return { time: `${hh}${mm}Z`, tz: 'UTC' };
  }
}

/**
 * Format a Date as date in airport's local time.
 * Returns "27 APR 2026" in the airport's TZ.
 */
export function formatLocalDate(date, iataCode) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return '';
  const tz = getAirportTimezone(iataCode) || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).formatToParts(date);
    const d = parts.find(p => p.type === 'day')?.value || '';
    const m = (parts.find(p => p.type === 'month')?.value || '').toUpperCase();
    const y = parts.find(p => p.type === 'year')?.value || '';
    return `${d} ${m} ${y}`;
  } catch (err) {
    return '';
  }
}
