// Provider logo helpers for the WALLET section.
//
// Strategy: Logo.dev API for everything. Logo.dev wants a domain
// (e.g. "aa.com") and returns a logo image. We maintain a mapping
// from our internal type/name strings -> domains, so callers can
// pass either a card type ("avfuel") or a free-text name ("American
// Airlines") and we resolve to a domain.
//
// The Logo.dev publishable key is safe to expose client-side per their
// docs (analogous to a Stripe publishable key). It still lives in an
// env var so it can be rotated without a code change.
//
// Free tier: ~5,000 requests/month. Logos are CDN-cached on Logo.dev's
// side, plus we add localStorage caching to avoid re-resolving the same
// names across sessions.

const LOGO_DEV_TOKEN = import.meta.env.VITE_LOGO_DEV_TOKEN || '';

// Internal card-type -> primary domain
// Update when you add new card providers
const FUEL_CARD_DOMAINS = {
  'multi-service': 'multiservice.com',
  'avfuel': 'avfuel.com',
  'colt': 'coltinternational.com',
  'phillips66': 'phillips66.com',
  'epic': 'epicaviation.com',
  'shell': 'shell.com',
  'fbo': null, // generic — no specific brand
  'other': null,
};

// US airlines + major international — name-keyed
// Keys are lowercased; lookup compares lowercased input
const AIRLINE_DOMAINS = {
  'american airlines': 'aa.com',
  'american': 'aa.com',
  'aa': 'aa.com',
  'delta': 'delta.com',
  'delta air lines': 'delta.com',
  'dl': 'delta.com',
  'united': 'united.com',
  'united airlines': 'united.com',
  'ua': 'united.com',
  'southwest': 'southwest.com',
  'southwest airlines': 'southwest.com',
  'wn': 'southwest.com',
  'jetblue': 'jetblue.com',
  'jetblue airways': 'jetblue.com',
  'b6': 'jetblue.com',
  'alaska': 'alaskaair.com',
  'alaska airlines': 'alaskaair.com',
  'as': 'alaskaair.com',
  'spirit': 'spirit.com',
  'spirit airlines': 'spirit.com',
  'nk': 'spirit.com',
  'frontier': 'flyfrontier.com',
  'frontier airlines': 'flyfrontier.com',
  'f9': 'flyfrontier.com',
  'hawaiian': 'hawaiianairlines.com',
  'hawaiian airlines': 'hawaiianairlines.com',
  'ha': 'hawaiianairlines.com',
  'allegiant': 'allegiantair.com',
  'g4': 'allegiantair.com',
  'breeze': 'flybreeze.com',
  'mx': 'flybreeze.com',
  // International common ones
  'air canada': 'aircanada.com',
  'ac': 'aircanada.com',
  'british airways': 'britishairways.com',
  'ba': 'britishairways.com',
  'lufthansa': 'lufthansa.com',
  'lh': 'lufthansa.com',
  'air france': 'airfrance.com',
  'af': 'airfrance.com',
  'klm': 'klm.com',
  'kl': 'klm.com',
  'emirates': 'emirates.com',
  'ek': 'emirates.com',
  'qatar airways': 'qatarairways.com',
  'qr': 'qatarairways.com',
};

// Hotel brands — name keywords -> domain
// We do substring matching here because hotel names are messy
// ("Hilton Garden Inn Tampa Riverview" should match "hilton")
const HOTEL_BRAND_KEYWORDS = [
  // Marriott family
  { keywords: ['marriott'], domain: 'marriott.com' },
  { keywords: ['ritz-carlton', 'ritz carlton'], domain: 'ritzcarlton.com' },
  { keywords: ['st. regis', 'st regis'], domain: 'marriott.com' },
  { keywords: ['westin'], domain: 'marriott.com' },
  { keywords: ['sheraton'], domain: 'marriott.com' },
  { keywords: ['w hotel', 'w hotels'], domain: 'marriott.com' },
  { keywords: ['courtyard'], domain: 'marriott.com' },
  { keywords: ['residence inn'], domain: 'marriott.com' },
  { keywords: ['fairfield'], domain: 'marriott.com' },
  { keywords: ['springhill suites'], domain: 'marriott.com' },
  { keywords: ['ac hotels'], domain: 'marriott.com' },
  { keywords: ['aloft'], domain: 'marriott.com' },
  { keywords: ['moxy'], domain: 'marriott.com' },
  { keywords: ['element'], domain: 'marriott.com' },
  // Hilton family
  { keywords: ['hilton'], domain: 'hilton.com' },
  { keywords: ['waldorf astoria'], domain: 'hilton.com' },
  { keywords: ['conrad'], domain: 'hilton.com' },
  { keywords: ['embassy suites'], domain: 'hilton.com' },
  { keywords: ['doubletree'], domain: 'hilton.com' },
  { keywords: ['hampton inn', 'hampton'], domain: 'hilton.com' },
  { keywords: ['homewood suites'], domain: 'hilton.com' },
  { keywords: ['home2 suites', 'home2'], domain: 'hilton.com' },
  { keywords: ['tru by hilton'], domain: 'hilton.com' },
  { keywords: ['canopy'], domain: 'hilton.com' },
  // IHG
  { keywords: ['intercontinental'], domain: 'ihg.com' },
  { keywords: ['holiday inn'], domain: 'ihg.com' },
  { keywords: ['crowne plaza'], domain: 'ihg.com' },
  { keywords: ['kimpton'], domain: 'ihg.com' },
  { keywords: ['indigo'], domain: 'ihg.com' },
  { keywords: ['staybridge'], domain: 'ihg.com' },
  { keywords: ['candlewood'], domain: 'ihg.com' },
  // Hyatt
  { keywords: ['hyatt'], domain: 'hyatt.com' },
  { keywords: ['andaz'], domain: 'hyatt.com' },
  { keywords: ['grand hyatt'], domain: 'hyatt.com' },
  { keywords: ['park hyatt'], domain: 'hyatt.com' },
  // Wyndham
  { keywords: ['wyndham'], domain: 'wyndhamhotels.com' },
  { keywords: ['ramada'], domain: 'wyndhamhotels.com' },
  { keywords: ['days inn'], domain: 'wyndhamhotels.com' },
  { keywords: ['super 8'], domain: 'wyndhamhotels.com' },
  { keywords: ['la quinta'], domain: 'wyndhamhotels.com' },
  { keywords: ['microtel'], domain: 'wyndhamhotels.com' },
  { keywords: ['howard johnson'], domain: 'wyndhamhotels.com' },
  // Choice Hotels
  { keywords: ['comfort inn', 'comfort suites'], domain: 'choicehotels.com' },
  { keywords: ['quality inn'], domain: 'choicehotels.com' },
  { keywords: ['sleep inn'], domain: 'choicehotels.com' },
  { keywords: ['mainstay'], domain: 'choicehotels.com' },
  { keywords: ['cambria'], domain: 'choicehotels.com' },
  // Best Western
  { keywords: ['best western'], domain: 'bestwestern.com' },
  // Independent / boutique chains
  { keywords: ['four seasons'], domain: 'fourseasons.com' },
  { keywords: ['mandarin oriental'], domain: 'mandarinoriental.com' },
  { keywords: ['shangri-la', 'shangri la'], domain: 'shangri-la.com' },
  { keywords: ['peninsula'], domain: 'peninsula.com' },
  { keywords: ['fairmont'], domain: 'fairmont.com' },
  { keywords: ['sofitel'], domain: 'sofitel.com' },
  { keywords: ['accor'], domain: 'accor.com' },
];

/**
 * Resolve a fuel card type -> domain.
 */
export function fuelCardDomain(type) {
  return FUEL_CARD_DOMAINS[String(type || '').toLowerCase()] || null;
}

/**
 * Resolve an airline name or code -> domain.
 */
export function airlineDomain(nameOrCode) {
  if (!nameOrCode) return null;
  const key = String(nameOrCode).toLowerCase().trim();
  // Exact match
  if (AIRLINE_DOMAINS[key]) return AIRLINE_DOMAINS[key];
  // Try substring match against the name keys (handles "American Airlines Inc.")
  for (const [k, v] of Object.entries(AIRLINE_DOMAINS)) {
    if (k.length >= 4 && key.includes(k)) return v;
  }
  return null;
}

/**
 * Resolve a hotel name or brand -> domain.
 * Uses keyword substring match because hotel names are unpredictable.
 */
export function hotelDomain(nameOrBrand) {
  if (!nameOrBrand) return null;
  const lower = String(nameOrBrand).toLowerCase();
  for (const entry of HOTEL_BRAND_KEYWORDS) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) return entry.domain;
    }
  }
  return null;
}

/**
 * Build a Logo.dev URL for a given domain.
 * Returns null if no domain or no token configured.
 *
 * Options:
 *   size:    pixel dimensions (default 128)
 *   theme:   'light' | 'dark' (defaults to light backgrounds)
 *   format:  'png' | 'jpg' | 'webp' (default png for transparency)
 *   retina:  true for 2x source resolution
 */
export function logoUrl(domain, opts = {}) {
  if (!domain) return null;
  if (!LOGO_DEV_TOKEN) return null;
  const size = opts.size || 128;
  const theme = opts.theme || 'light';
  const format = opts.format || 'png';
  const retina = opts.retina !== false;
  const params = new URLSearchParams({
    token: LOGO_DEV_TOKEN,
    size: String(size),
    format,
    theme,
  });
  if (retina) params.set('retina', 'true');
  return `https://img.logo.dev/${domain}?${params.toString()}`;
}

// === CREDIT CARD BIN DETECTION ============================
//
// Pure client-side. Looks at the first few digits of the card number.
// Returns a domain so we can use the same Logo.dev pipeline.

const CARD_BRAND_BINS = [
  { name: 'Visa', domain: 'visa.com', regex: /^4/ },
  { name: 'Mastercard', domain: 'mastercard.com', regex: /^(5[1-5]|2[2-7])/ },
  { name: 'American Express', domain: 'americanexpress.com', regex: /^3[47]/ },
  { name: 'Discover', domain: 'discover.com', regex: /^(6011|65|64[4-9]|622[126-9]|6229[01])/ },
  { name: 'Diners Club', domain: 'dinersclub.com', regex: /^(36|30[0-5]|309|38|39)/ },
  { name: 'JCB', domain: 'global.jcb', regex: /^35(2[89]|[3-8])/ },
  { name: 'UnionPay', domain: 'unionpayintl.com', regex: /^62/ },
];

/**
 * Detect credit card brand from card number.
 * Returns { name, domain } or null.
 */
export function detectCardBrand(cardNumber) {
  if (!cardNumber) return null;
  const clean = String(cardNumber).replace(/\D/g, '');
  if (clean.length < 2) return null;
  for (const bin of CARD_BRAND_BINS) {
    if (bin.regex.test(clean)) {
      return { name: bin.name, domain: bin.domain };
    }
  }
  return null;
}

// === LOCALSTORAGE CACHING =================================
//
// Caches the resolved domain (not the image — Logo.dev handles that).
// Keyed by lowercased input string. 30-day TTL.

const CACHE_KEY = 'skyway-logo-domain-cache-v1';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore quota errors
  }
}

export function cachedAirlineDomain(nameOrCode) {
  if (!nameOrCode) return null;
  const key = `airline:${String(nameOrCode).toLowerCase().trim()}`;
  const cache = readCache();
  const entry = cache[key];
  if (entry && Date.now() - entry.t < CACHE_TTL_MS) return entry.d || null;
  const domain = airlineDomain(nameOrCode);
  cache[key] = { d: domain, t: Date.now() };
  writeCache(cache);
  return domain;
}

export function cachedHotelDomain(nameOrBrand) {
  if (!nameOrBrand) return null;
  const key = `hotel:${String(nameOrBrand).toLowerCase().trim()}`;
  const cache = readCache();
  const entry = cache[key];
  if (entry && Date.now() - entry.t < CACHE_TTL_MS) return entry.d || null;
  const domain = hotelDomain(nameOrBrand);
  cache[key] = { d: domain, t: Date.now() };
  writeCache(cache);
  return domain;
}

export const LOGO_DEV_CONFIGURED = !!LOGO_DEV_TOKEN;
