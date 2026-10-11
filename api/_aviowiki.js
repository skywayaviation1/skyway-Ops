/**
 * Server-only aviowiki client.
 *
 *   AVIOWIKI_API_TOKEN   paid API token (Authorization: Bearer). Never log it.
 *   AVIOWIKI_BASE_URL    optional, default https://api.aviowiki.com
 *   AVIOWIKI_WEBHOOK_SECRET  subscription HMAC secret; not required to read data
 *
 * Firestore collection `aviowiki-cache`:
 *   airport identity / runways / hours / notes  30 days
 *   handling & fuel providers                   24 hours
 *   fuel products                               6 hours
 *
 * Warm instances also keep an in-memory copy, coalesce identical in-flight
 * loads, and serve the last cached payload when aviowiki errors.
 */

import crypto from 'node:crypto';
import { parseCsv } from './_iflightplanner.js';

export const CACHE_COLLECTION = 'aviowiki-cache';
export const DEFAULT_BASE_URL = 'https://api.aviowiki.com';
export const REQUEST_TIMEOUT_MS = 12_000;
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
export const MEMORY_REVALIDATE_MS = 60_000;
export const OURAIRPORTS_RUNWAYS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';

export const CACHE_TTL_MS = {
  airport: 30 * 24 * 60 * 60 * 1000,
  providers: 24 * 60 * 60 * 1000,
  fuel: 6 * 60 * 60 * 1000,
};

const LITERS_PER_US_GALLON = 3.785411784;
const LITERS_PER_IMP_GALLON = 4.54609;
const METERS_TO_FEET = 3.280839895;

const FUEL_TYPE_LABELS = {
  JET_A: 'Jet A',
  JET_A1: 'Jet A-1',
  JET_B: 'Jet B',
  TS1: 'TS-1',
  AVGAS_100_130: '100/130',
  AVGAS_100LL: '100LL',
  AVGAS_91_96UL: '91/96UL',
  JP5: 'JP-5',
  JP8: 'JP-8',
  MO_GAS: 'MOGAS',
  DIESEL: 'Diesel',
};

const clean = (value) => String(value ?? '').replace(/\u00a0/g, ' ').trim();

function redact(message, extraSecret = '') {
  let text = clean(message).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  for (const secret of [process.env.AVIOWIKI_API_TOKEN, process.env.AVIOWIKI_WEBHOOK_SECRET, extraSecret]) {
    const value = clean(secret);
    if (value.length >= 8) text = text.split(value).join('[redacted]');
  }
  return text.slice(0, 300);
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(clean(value).replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrNull(value) {
  const numeric = finiteOrNull(value);
  if (numeric == null || numeric < 0) return null;
  return numeric;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.content)) return payload.content;
  return [];
}

function firestoreSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

export function cacheDocId(prefix, id) {
  const safe = clean(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
  return `${prefix}_${safe || 'unknown'}`;
}

export function icaoCandidates(value) {
  const code = clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 3 || code.length > 7) return [];
  const list = [code];
  if (/^[A-Z]{3}$/.test(code)) list.push(`K${code}`);
  return list;
}

export function aviowikiConfigured(env = process.env) {
  return Boolean(clean(env.AVIOWIKI_API_TOKEN));
}

export function publicAviowikiStatus(env = process.env) {
  return {
    configured: aviowikiConfigured(env),
    source: 'aviowiki',
  };
}

export function pricePerUsGallon(price, unit) {
  const amount = numberOrNull(price);
  if (amount == null) return null;
  const normalized = clean(unit).toUpperCase();
  if (!normalized || normalized === 'USG' || normalized === 'GAL' || normalized === 'GALLON') {
    return normalized ? round4(amount) : null;
  }
  if (normalized === 'LTR' || normalized === 'L' || normalized === 'LITRE' || normalized === 'LITER') {
    return round4(amount * LITERS_PER_US_GALLON);
  }
  if (normalized === 'IMP' || normalized === 'IG') {
    return round4(amount * (LITERS_PER_US_GALLON / LITERS_PER_IMP_GALLON));
  }
  return null;
}

export function fuelTypeLabel(type) {
  const key = clean(type).toUpperCase();
  if (!key) return 'Fuel';
  return FUEL_TYPE_LABELS[key] || key.replace(/_/g, ' ');
}

export function humanizeCode(value) {
  return clean(value)
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bGpu\b/g, 'GPU')
    .replace(/\bTks\b/g, 'TKS')
    .replace(/\bAfis\b/g, 'AFIS')
    .replace(/(\d)([a-z])\b/g, (_match, digit, letter) => `${digit}${letter.toUpperCase()}`);
}

export function serviceLabel(selfService) {
  if (selfService === true) return 'Self service';
  if (selfService === false) return 'Full service';
  return 'Retail';
}

function formatVhf(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return numeric.toFixed(3);
}

function metersToFeet(value) {
  const numeric = numberOrNull(value);
  if (numeric == null) return null;
  return Math.round(numeric * METERS_TO_FEET);
}

function addressOf(provider) {
  return [provider.streetName, provider.locality, provider.municipality, provider.postalCode]
    .map(clean)
    .filter(Boolean)
    .join(', ');
}

export function isRelevantProvider(provider) {
  const category = clean(provider?.category).toUpperCase();
  return category === 'HANDLING' || category === 'FUEL';
}

export function isFbo(provider) {
  return clean(provider?.handlingProvider?.serviceLevel).toUpperCase() === 'FBO';
}

export function featuredRank(order) {
  if (order === -1 || order === '-1') return -1;
  if (order == null || order === '') return Number.POSITIVE_INFINITY;
  const numeric = Number(order);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

export function compareFeatured(a, b) {
  const delta = featuredRank(a.featuredOrder) - featuredRank(b.featuredOrder);
  if (delta) return delta;
  return clean(a.name).localeCompare(clean(b.name));
}

export function normalizeFuelProduct(product) {
  const price = numberOrNull(product?.price);
  if (price == null) return null;
  const currency = clean(product.currency).toUpperCase() || null;
  const unit = clean(product.unit).toUpperCase() || null;
  const selfService = typeof product.selfService === 'boolean' ? product.selfService : null;
  return {
    fuelType: fuelTypeLabel(product.type || product.name),
    price,
    unit,
    currency,
    pricePerGal: pricePerUsGallon(price, unit),
    selfService,
    service: serviceLabel(selfService),
    nonUsd: Boolean(currency && currency !== 'USD'),
    converted: Boolean(unit && unit !== 'USG'),
    limitedAvailability: product.limitedAvailability === true,
    source: 'aviowiki',
    aid: clean(product.aid) || null,
  };
}

function serviceList(provider) {
  const handling = provider.handlingProvider || {};
  const codes = [
    ...(Array.isArray(handling.terminalServices) ? handling.terminalServices : []),
    ...(Array.isArray(handling.aircraftServices) ? handling.aircraftServices : []),
  ];
  const labels = [];
  const seen = new Set();
  for (const code of codes) {
    const label = humanizeCode(code);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  if (!labels.length && clean(provider.category).toUpperCase() === 'FUEL') labels.push('Fuel');
  return labels;
}

export function normalizeProvider(provider, fuelProducts = []) {
  const handling = provider?.handlingProvider || null;
  const fuelMeta = provider?.fuelProvider || provider?.fuelProviders || null;
  const serviceLevel = clean(handling?.serviceLevel || fuelMeta?.serviceLevel) || null;
  const featuredOrder = provider?.featuredOrder == null || provider.featuredOrder === ''
    ? null
    : Number(provider.featuredOrder);
  const fuelPrices = (Array.isArray(fuelProducts) ? fuelProducts : [])
    .map(normalizeFuelProduct)
    .filter(Boolean)
    .sort((a, b) => a.fuelType.localeCompare(b.fuelType) || String(a.selfService).localeCompare(String(b.selfService)));
  return {
    aid: clean(provider?.aid) || null,
    airportAid: clean(provider?.parent) || null,
    category: clean(provider?.category).toUpperCase() || null,
    serviceLevel,
    fbo: serviceLevel === 'FBO',
    name: clean(provider?.name) || 'Provider',
    phone: clean(provider?.phone),
    email: clean(provider?.email),
    website: clean(provider?.website),
    vhf: formatVhf(provider?.vhf),
    address: addressOf(provider || {}),
    city: clean(provider?.locality),
    state: clean(provider?.municipality),
    paymentMethods: Array.isArray(provider?.paymentMethods)
      ? provider.paymentMethods.map((method) => clean(method).toUpperCase()).filter(Boolean)
      : [],
    services: serviceList(provider || {}),
    featuredOrder: Number.isFinite(featuredOrder) ? featuredOrder : null,
    featured: featuredOrder === -1,
    verified: featuredOrder === -1,
    fuelPrices,
    source: 'aviowiki',
  };
}

export function slimProvider(provider) {
  const handling = provider?.handlingProvider;
  const fuelMeta = provider?.fuelProvider || provider?.fuelProviders;
  return {
    aid: provider?.aid || null,
    parent: provider?.parent || null,
    category: provider?.category || null,
    name: provider?.name || '',
    email: provider?.email || null,
    phone: provider?.phone || null,
    outOfHoursPhone: provider?.outOfHoursPhone || null,
    website: provider?.website || null,
    vhf: provider?.vhf ?? null,
    streetName: provider?.streetName || null,
    locality: provider?.locality || null,
    municipality: provider?.municipality || null,
    postalCode: provider?.postalCode || null,
    paymentMethods: provider?.paymentMethods || null,
    featuredOrder: provider?.featuredOrder ?? null,
    handlingProvider: handling ? {
      serviceLevel: handling.serviceLevel || null,
      terminalServices: handling.terminalServices || null,
      aircraftServices: handling.aircraftServices || null,
    } : null,
    fuelProvider: fuelMeta && !Array.isArray(fuelMeta) ? {
      serviceLevel: fuelMeta.serviceLevel || null,
    } : null,
  };
}

function unwrapAirport(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.aid || body.icao) return body;
  if (body.airport?.aid || body.airport?.icao) return body.airport;
  if (Array.isArray(body.content) && (body.content[0]?.aid || body.content[0]?.icao)) return body.content[0];
  return null;
}

export function normalizeAirport(airport) {
  const elevationMeters = numberOrNull(airport?.elevation);
  return {
    aid: clean(airport?.aid) || null,
    icao: clean(airport?.icao).toUpperCase() || null,
    iata: clean(airport?.iata).toUpperCase() || null,
    faa: clean(airport?.faa || airport?.localIdentifier).toUpperCase() || null,
    name: clean(airport?.name),
    servedCity: clean(airport?.servedCity),
    timezone: clean(airport?.timeZone) || null,
    elevationFt: elevationMeters == null ? null : Math.round(elevationMeters * METERS_TO_FEET),
    latitude: finiteOrNull(airport?.coordinates?.latitude),
    longitude: finiteOrNull(airport?.coordinates?.longitude),
    type: clean(airport?.type) || null,
    operator: clean(airport?.operator) || null,
    ifr: airport?.ifr ?? null,
    mandatoryHandling: airport?.mandatoryHandling ?? null,
    nonScheduledPermission: clean(airport?.nonScheduledPermission) || null,
    country: clean(airport?.country?.iso2 || airport?.country) || null,
  };
}

export function normalizeRunway(runway) {
  return {
    aid: clean(runway?.aid) || null,
    identifier: clean(runway?.identifier),
    lengthFt: metersToFeet(runway?.tora ?? runway?.lda ?? runway?.toda),
    widthFt: metersToFeet(runway?.width),
    surface: clean(runway?.surface) || null,
    lighted: runway?.edgeLights === true,
    helipad: runway?.helipad === true,
    heading: numberOrNull(runway?.magneticBearing),
    closed: false,
    source: 'aviowiki',
  };
}

export function normalizeRunways(runways) {
  return (Array.isArray(runways) ? runways : [])
    .map(normalizeRunway)
    .filter((runway) => runway.identifier)
    .sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
}

function clock(value) {
  const match = clean(value).match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function movementDetail(block) {
  const openFor = Array.isArray(block?.info?.openFor) ? block.info.openFor : (Array.isArray(block?.openFor) ? block.openFor : []);
  const notes = openFor.map((entry) => clean(entry?.other)).filter(Boolean);
  if (clean(block?.notes)) notes.push(clean(block.notes));
  const notice = openFor.find((entry) => entry?.priorNoticeRequired != null)?.priorNoticeRequired;
  if (notice != null && notice !== '') notes.push(`${notice}h prior notice`);
  return notes.join(' · ');
}

function fireDetail(block) {
  const info = block?.info || {};
  const parts = [];
  if (info.icaoCatAirplane) parts.push(`ICAO ${info.icaoCatAirplane}`);
  if (info.faaCatAirplane) parts.push(`FAA ${info.faaCatAirplane}`);
  if (info.extensionAvailable && info.extensionUpToIcao) {
    parts.push(`extension to ${info.extensionUpToIcao}`);
  }
  if (info.firestationRemote) parts.push('remote station');
  if (clean(info.firestationNotes)) parts.push(clean(info.firestationNotes));
  return parts.join(' · ');
}

function atcDetail(block) {
  const info = block?.info || {};
  const parts = [];
  if (info.afisOnly === true) parts.push('AFIS only');
  if (info.enRtfAvailable === true) parts.push('English R/T');
  return parts.join(' · ');
}

function simplifyBlocks(blocks, detail) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block) => ({
    from: block?.validFrom || null,
    to: block?.validTo || null,
    fromClock: clock(block?.validFrom),
    toClock: clock(block?.validTo),
    status: clean(block?.status) || 'UNKNOWN',
    detail: detail(block),
  }));
}

export function normalizeAvailability(availability) {
  if (!availability || typeof availability !== 'object') return null;
  const hours = simplifyBlocks(availability.movement, movementDetail);
  return {
    openingIndicator: clean(availability.openingIndicator) || null,
    hours,
    hoursSummary: summarizeHours(hours),
    customs: simplifyBlocks(availability.ciq, (block) => clean(block?.info?.notes || block?.notes)),
    atc: simplifyBlocks(availability.atc, atcDetail),
    fireCover: simplifyBlocks(availability.arff, fireDetail),
  };
}

function summarizeHours(hours) {
  if (!hours.length) return '';
  const allFull = hours.every((block) => block.status === 'FULL');
  const coversDay = hours.some((block) => block.fromClock.startsWith('00:') && /23:5/.test(block.toClock || ''));
  if (hours.length === 1 && allFull && (coversDay || hours[0].fromClock === '00:00')) return '24 hours';
  return hours
    .map((block) => `${block.fromClock || '—'}-${block.toClock || '—'} ${humanizeCode(block.status)}`)
    .join(', ');
}

const NOTE_RANK = { OPERATIONALLY_CRITICAL: 0, OPERATIONALLY_RELEVANT: 1 };

export function normalizeNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .map((note) => ({
      aid: clean(note?.aid) || null,
      kind: clean(note?.kind) || null,
      category: clean(note?.category) || null,
      criticality: clean(note?.criticality) || null,
      source: clean(note?.source) || null,
      notes: clean(note?.notes),
      validFrom: note?.validFrom || null,
      validTo: note?.validTo || null,
    }))
    .filter((note) => note.notes)
    .sort((a, b) => (NOTE_RANK[a.criticality] ?? 9) - (NOTE_RANK[b.criticality] ?? 9))
    .slice(0, 40);
}

export function parseOurAirportsRunways(csv, idents) {
  const wanted = new Set((idents || []).map((code) => clean(code).toUpperCase()).filter(Boolean));
  if (!wanted.size) return [];
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const header = rows[0].map((cell) => clean(cell));
  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  if (index.airport_ident == null) return [];
  const cell = (row, name) => clean(row[index[name]]);
  const feet = (row, name) => {
    const numeric = Number(cell(row, name));
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
  };
  const runways = [];
  for (const row of rows.slice(1)) {
    const ident = cell(row, 'airport_ident').toUpperCase();
    if (!wanted.has(ident)) continue;
    const le = cell(row, 'le_ident');
    const he = cell(row, 'he_ident');
    const lighted = cell(row, 'lighted');
    const closed = cell(row, 'closed');
    runways.push({
      aid: null,
      identifier: le && he ? `${le}/${he}` : (le || he || 'RWY'),
      lengthFt: feet(row, 'length_ft'),
      widthFt: feet(row, 'width_ft'),
      surface: cell(row, 'surface') || null,
      lighted: lighted === '1' || /^yes|true$/i.test(lighted),
      helipad: false,
      heading: null,
      closed: closed === '1' || /^yes|true$/i.test(closed),
      source: 'ourairports',
    });
  }
  return runways.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
}

export async function loadOurAirportsRunways({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = 24 * 60 * 60 * 1000,
  cache = sharedRunwayCache,
} = {}) {
  const current = typeof now === 'function' ? now() : now;
  if (cache.csv && cache.expiresAt > current) return cache.csv;
  const response = await fetchImpl(OURAIRPORTS_RUNWAYS_URL, {
    headers: { 'User-Agent': 'SkywayOps/1.0 (airport fallback; non-navigation)' },
  });
  if (!response.ok) throw new Error(`OurAirports runways fetch failed (${response.status})`);
  const csv = await response.text();
  cache.csv = csv;
  cache.expiresAt = current + ttlMs;
  return csv;
}

const sharedRunwayCache = { csv: '', expiresAt: 0 };

function firestoreStore(db) {
  const collection = db.collection(CACHE_COLLECTION);
  return {
    async get(id) {
      const snap = await collection.doc(id).get();
      return snap.exists ? snap.data() : null;
    },
    async set(id, data) {
      await collection.doc(id).set(firestoreSafe(data));
    },
    async delete(id) {
      await collection.doc(id).delete();
    },
  };
}

async function defaultStoreProvider() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const { getDb } = await import('./_foreflight.js');
    return firestoreStore(getDb());
  } catch (error) {
    console.error('[aviowiki] cache unavailable', redact(error.message));
    return null;
  }
}

export function createAviowikiRuntime({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  storeProvider = defaultStoreProvider,
  runwayCache = { csv: '', expiresAt: 0 },
} = {}) {
  const memory = new Map();
  const inflight = new Map();
  const checkedAt = new Map();

  async function store() {
    return storeProvider();
  }

  function rememberMemory(key, record) {
    memory.set(key, record);
    checkedAt.set(key, now());
  }

  async function persist(key, record) {
    rememberMemory(key, record);
    const disk = await store();
    if (!disk) return;
    await disk.set(key, record);
    for (const aid of record.aids || []) {
      if (!aid) continue;
      const indexId = cacheDocId('idx', aid);
      const existing = await disk.get(indexId);
      const docs = new Set(Array.isArray(existing?.docs) ? existing.docs : []);
      docs.add(key);
      await disk.set(indexId, { kind: 'index', docs: [...docs], updatedAt: now() });
    }
  }

  async function readFreshMemory(key) {
    const record = memory.get(key);
    if (!record || record.expiresAt <= now()) return null;
    const seen = checkedAt.get(key) || 0;
    if (now() - seen < MEMORY_REVALIDATE_MS) return record;
    checkedAt.set(key, now());
    const disk = await store().catch(() => null);
    if (!disk) return record;
    try {
      const stored = await disk.get(key);
      if (!stored) {
        memory.delete(key);
        return null;
      }
      if (stored.fetchedAt && stored.fetchedAt !== record.fetchedAt) {
        memory.set(key, stored);
        return stored.expiresAt > now() ? stored : null;
      }
      return record;
    } catch {
      return record;
    }
  }

  async function readAny(key) {
    const cached = memory.get(key);
    if (cached?.data) return cached;
    const disk = await store().catch(() => null);
    if (!disk) return null;
    try {
      const stored = await disk.get(key);
      if (stored?.data) {
        memory.set(key, stored);
        return stored;
      }
    } catch {
      return null;
    }
    return null;
  }

  async function loadFresh(key, ttlMs, loader) {
    const fresh = await readFreshMemory(key);
    if (fresh) return { ...fresh, stale: false, cache: 'memory' };
    const disk = await store().catch(() => null);
    if (disk) {
      try {
        const stored = await disk.get(key);
        if (stored?.data && stored.expiresAt > now()) {
          rememberMemory(key, stored);
          return { ...stored, stale: false, cache: 'firestore' };
        }
      } catch (error) {
        console.error('[aviowiki] cache read failed', redact(error.message, env.AVIOWIKI_API_TOKEN));
      }
    }
    try {
      const loaded = await loader();
      const record = {
        kind: loaded.kind,
        data: loaded.data,
        aids: loaded.aids || [],
        fetchedAt: now(),
        expiresAt: now() + ttlMs,
      };
      await persist(key, record);
      return { ...record, stale: false, cache: 'network' };
    } catch (error) {
      const stale = await readAny(key);
      if (stale?.data) {
        return { ...stale, stale: true, cache: 'stale', error: redact(error.message, env.AVIOWIKI_API_TOKEN) };
      }
      if (error.partial) {
        const record = {
          kind: error.kind || 'partial',
          data: error.partial,
          aids: error.aids || [],
          fetchedAt: now(),
          expiresAt: now() + (15 * 60 * 1000),
          partial: true,
        };
        rememberMemory(key, record);
        return { ...record, stale: false, cache: 'partial' };
      }
      throw error;
    }
  }

  function getOrLoad(key, ttlMs, loader) {
    const existing = inflight.get(key);
    if (existing) return existing;
    let start;
    const job = new Promise((resolve, reject) => {
      start = () => { loadFresh(key, ttlMs, loader).then(resolve, reject); };
    });
    inflight.set(key, job);
    start();
    job.finally(() => { if (inflight.get(key) === job) inflight.delete(key); });
    return job;
  }

  async function invalidate(aids) {
    const wanted = [...new Set((aids || []).map((aid) => clean(aid)).filter(Boolean))];
    const deleted = new Set();
    for (const [key, record] of memory.entries()) {
      if ((record.aids || []).some((aid) => wanted.includes(aid))) {
        memory.delete(key);
        checkedAt.delete(key);
        deleted.add(key);
      }
    }
    const disk = await store().catch(() => null);
    if (!disk) return [...deleted];
    for (const aid of wanted) {
      const indexId = cacheDocId('idx', aid);
      const index = await disk.get(indexId);
      for (const docId of index?.docs || []) {
        await disk.delete(docId);
        memory.delete(docId);
        deleted.add(docId);
      }
      if (index) {
        await disk.delete(indexId);
        deleted.add(indexId);
      }
    }
    return [...deleted];
  }

  async function aviowikiGet(path, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const token = clean(env.AVIOWIKI_API_TOKEN);
    if (!token) {
      const error = new Error('aviowiki is not configured');
      error.status = 503;
      error.code = 'aviowiki_not_configured';
      throw error;
    }
    const base = clean(env.AVIOWIKI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '') || DEFAULT_BASE_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (response.status === 404) return null;
      const text = await response.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { message: text.slice(0, 180) };
        }
      }
      if (!response.ok) {
        const error = new Error(redact(body?.message || body?.error || `aviowiki request failed (${response.status})`, env.AVIOWIKI_API_TOKEN));
        error.status = 502;
        error.code = response.status === 401 || response.status === 403
          ? 'aviowiki_auth_failed'
          : 'aviowiki_request_failed';
        throw error;
      }
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error('aviowiki request timed out');
        timeout.status = 504;
        timeout.code = 'aviowiki_timeout';
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookupIcao(code) {
    const candidates = icaoCandidates(code);
    if (!candidates.length) {
      const error = new Error('Invalid airport identifier');
      error.status = 400;
      error.code = 'aviowiki_bad_airport';
      throw error;
    }
    for (const candidate of candidates) {
      const body = await aviowikiGet(`/free/airports/icao/${encodeURIComponent(candidate)}`);
      const airport = unwrapAirport(body);
      if (airport?.aid) return normalizeAirport({ ...airport, icao: airport.icao || candidate });
    }
    const missing = new Error(`No aviowiki airport for ${candidates[0]}`);
    missing.status = 404;
    missing.code = 'aviowiki_not_found';
    throw missing;
  }

  async function resolveAirport(requested) {
    const code = icaoCandidates(requested)[0];
    if (!code) {
      const error = new Error('Invalid airport identifier');
      error.status = 400;
      error.code = 'aviowiki_bad_airport';
      throw error;
    }
    return getOrLoad(cacheDocId('aid', code), CACHE_TTL_MS.airport, async () => {
      const airport = await lookupIcao(code);
      return {
        kind: 'aid',
        aids: [airport.aid, airport.icao, code].filter(Boolean),
        data: airport,
      };
    });
  }

  async function loadAirportDetail(aid) {
    const encoded = encodeURIComponent(aid);
    const [airportRes, runwayRes, availabilityRes, notesRes] = await Promise.allSettled([
      aviowikiGet(`/airports/${encoded}`),
      aviowikiGet(`/airports/${encoded}/runways/all`),
      aviowikiGet(`/airports/${encoded}/availability?local=true`),
      aviowikiGet(`/airports/${encoded}/operationalNotes`),
    ]);
    const airportBody = airportRes.status === 'fulfilled' ? unwrapAirport(airportRes.value) : null;
    if (!airportBody) {
      const reason = airportRes.status === 'rejected' ? airportRes.reason : null;
      const error = reason || new Error(`Airport ${aid} was not found`);
      if (!error.status) error.status = 404;
      if (!error.code) error.code = 'aviowiki_not_found';
      throw error;
    }
    const airport = normalizeAirport(airportBody);
    const runways = runwayRes.status === 'fulfilled' ? normalizeRunways(asList(runwayRes.value)) : [];
    const availability = availabilityRes.status === 'fulfilled' ? normalizeAvailability(availabilityRes.value) : null;
    const notes = notesRes.status === 'fulfilled' ? normalizeNotes(asList(notesRes.value)) : [];
    const failed = [runwayRes, availabilityRes, notesRes].filter((result) => result.status === 'rejected');
    const data = { airport, runways, availability, notes };
    const aids = [
      aid,
      airport.aid,
      airport.icao,
      ...runways.map((runway) => runway.aid),
      ...notes.map((note) => note.aid),
    ].filter(Boolean);
    if (failed.length) {
      const error = new Error(failed.map((result) => result.reason?.message || 'aviowiki section failed').join('; '));
      error.partial = data;
      error.aids = aids;
      error.kind = 'airport';
      throw error;
    }
    return { kind: 'airport', aids, data };
  }

  async function getAirportBundle(requested) {
    const resolved = await resolveAirport(requested);
    const airport = resolved.data;
    const detail = await getOrLoad(
      cacheDocId('apt', airport.aid),
      CACHE_TTL_MS.airport,
      () => loadAirportDetail(airport.aid),
    );
    return {
      requested: icaoCandidates(requested)[0] || clean(requested).toUpperCase(),
      stale: Boolean(resolved.stale || detail.stale),
      partial: Boolean(detail.partial),
      fetchedAt: detail.fetchedAt,
      source: 'aviowiki',
      airport: detail.data.airport || airport,
      runways: detail.data.runways || [],
      availability: detail.data.availability || null,
      notes: detail.data.notes || [],
    };
  }

  async function fuelForProvider(provider, airportAid) {
    if (!provider.aid) return [];
    const record = await getOrLoad(cacheDocId('fuel', provider.aid), CACHE_TTL_MS.fuel, async () => {
      const body = await aviowikiGet(`/providers/${encodeURIComponent(provider.aid)}/fuelProducts/all`);
      const products = asList(body);
      return {
        kind: 'fuel',
        aids: [provider.aid, airportAid, ...products.map((product) => product?.aid)].filter(Boolean),
        data: products,
      };
    });
    return record.data || [];
  }

  async function getAirportFbos(requested) {
    const resolved = await resolveAirport(requested);
    const airport = resolved.data;
    const providersRecord = await getOrLoad(cacheDocId('prv', airport.aid), CACHE_TTL_MS.providers, async () => {
      const body = await aviowikiGet(`/airports/${encodeURIComponent(airport.aid)}/providers/all`);
      const providers = asList(body).filter(isRelevantProvider).map(slimProvider);
      return {
        kind: 'providers',
        aids: [airport.aid, airport.icao, ...providers.map((provider) => provider.aid)].filter(Boolean),
        data: providers,
      };
    });
    const fbos = await mapPool(providersRecord.data || [], 4, async (provider) => {
      try {
        const products = await fuelForProvider(provider, airport.aid);
        return normalizeProvider(provider, products);
      } catch (error) {
        const normalized = normalizeProvider(provider, []);
        normalized.fuelError = redact(error.message, env.AVIOWIKI_API_TOKEN);
        return normalized;
      }
    });
    fbos.sort(compareFeatured);
    return {
      requested: icaoCandidates(requested)[0] || clean(requested).toUpperCase(),
      airport: airport.icao || airport.faa || icaoCandidates(requested)[0],
      airportName: airport.name || '',
      aid: airport.aid,
      stale: Boolean(resolved.stale || providersRecord.stale),
      fetchedAt: providersRecord.fetchedAt,
      fbos,
    };
  }

  async function ourAirportsFallback(icao, db) {
    const codes = icaoCandidates(icao);
    if (!codes.length) return null;
    let identity = null;
    if (db) {
      try {
        for (const code of codes) {
          const snap = await db.collection('airport-cache-ourairports').doc(code[0]).get();
          const entry = snap.exists ? snap.data()?.entries?.[code] : null;
          if (entry) {
            identity = { ident: code, ...entry };
            break;
          }
        }
      } catch (error) {
        console.error('[aviowiki] OurAirports identity lookup failed', redact(error.message, env.AVIOWIKI_API_TOKEN));
      }
    }
    let runways = [];
    try {
      const csv = await loadOurAirportsRunways({ fetchImpl, now, cache: runwayCache });
      runways = parseOurAirportsRunways(csv, identity ? [identity.ident, ...codes] : codes);
    } catch (error) {
      console.error('[aviowiki] OurAirports runway fallback failed', redact(error.message, env.AVIOWIKI_API_TOKEN));
    }
    if (!identity && !runways.length) return null;
    return {
      source: 'ourairports',
      airport: {
        aid: null,
        icao: identity?.ident || codes.find((code) => code.length === 4) || codes[0],
        iata: identity?.iata || null,
        name: identity?.name || '',
        servedCity: '',
        latitude: finiteOrNull(identity?.lat),
        longitude: finiteOrNull(identity?.lng),
        country: identity?.iso || null,
        elevationFt: null,
        timezone: null,
      },
      runways,
      availability: null,
      notes: [],
    };
  }

  return {
    aviowikiGet,
    getOrLoad,
    invalidate,
    resolveAirport,
    getAirportBundle,
    getAirportFbos,
    ourAirportsFallback,
    configured: () => aviowikiConfigured(env),
  };
}

const defaultRuntime = createAviowikiRuntime();

export const getAirportBundle = (...args) => defaultRuntime.getAirportBundle(...args);
export const getAirportFbos = (...args) => defaultRuntime.getAirportFbos(...args);
export const invalidateAviowikiCache = (...args) => defaultRuntime.invalidate(...args);
export const ourAirportsFallback = (...args) => defaultRuntime.ourAirportsFallback(...args);

export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function verifyAviowikiSignature(rawBody, signatureHeader, secret, now = Date.now()) {
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!header || !secret) return false;
  const parts = {};
  for (const piece of String(header).split(',')) {
    const index = piece.indexOf('=');
    if (index === -1) continue;
    parts[piece.slice(0, index).trim()] = piece.slice(index + 1).trim();
  }
  const timestamp = Number(parts.t);
  const provided = parts.v1 || '';
  if (!Number.isFinite(timestamp) || !provided) return false;
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_MS) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const computed = crypto.createHmac('sha256', String(secret)).update(`${parts.t}.${body}`).digest('hex');
  const left = Buffer.from(computed);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function sharedSecretMatches(presented, secret) {
  if (!presented || !secret) return false;
  const candidate = String(presented).replace(/^Bearer\s+/i, '').trim();
  const left = Buffer.from(candidate);
  const right = Buffer.from(String(secret).trim());
  if (!candidate || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function aidsFromWebhookPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const found = [];
  const push = (value) => {
    const aid = clean(value);
    if (aid && !found.includes(aid)) found.push(aid);
  };
  push(data.aid);
  push(data.parentAid);
  push(data.airportAid);
  if (typeof data.parent === 'string') push(data.parent);
  push(data.parent?.aid);
  push(data.airport?.aid);
  push(data.icao && String(data.icao).toUpperCase());
  const segments = String(data.url || '').split('/').filter(Boolean);
  for (const segment of segments) {
    if (/^[A-Z]{3}-[A-Z0-9-]+$/.test(segment)) push(segment);
  }
  return found;
}

export async function readRawBody(req) {
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody;
  if (typeof req?.rawBody === 'string') return Buffer.from(req.rawBody);
  if (req?.body == null && req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.length) return Buffer.concat(chunks);
  }
  if (typeof req?.body === 'string') return Buffer.from(req.body);
  if (Buffer.isBuffer(req?.body)) return req.body;
  if (req?.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body));
  return Buffer.from('');
}

const FLIGHT_OPS_ROLES = ['crew', 'pilot', 'sales', 'ops', 'admin'];

export async function authorizeFlightOps(req) {
  const { reviewerSessionBlock } = await import('../src/reviewer-account.js');
  const { default: admin } = await import('firebase-admin');
  const { getAdminApp, getDb } = await import('./_foreflight.js');
  const idToken = req.headers?.authorization?.replace(/^Bearer\s+/i, '') || req.query?.idToken;
  if (!idToken) {
    const error = new Error('Sign in to view FBO and fuel-price data');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = reviewerSessionBlock(await admin.auth(getAdminApp()).verifyIdToken(idToken, true));
  } catch {
    const error = new Error('Invalid or expired session');
    error.status = 401;
    throw error;
  }
  const snap = await getDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (
    !snap.exists
    || !FLIGHT_OPS_ROLES.includes(String(profile.role || '').toLowerCase())
    || profile.active === false
    || profile.approved !== true
  ) {
    const error = new Error('Approved flight-operations access required');
    error.status = 403;
    throw error;
  }
  return { uid: decoded.uid, role: profile.role };
}

export function requestedAirports(req, { single = false } = {}) {
  const source = single
    ? (req.query?.icao || req.query?.airport || '')
    : (req.query?.airports || req.query?.airport || req.query?.icao || '');
  return String(source)
    .split(/[\s,;]+/)
    .map((airport) => airport.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter((airport) => airport.length >= 3 && airport.length <= 7)
    .filter((airport, index, list) => list.indexOf(airport) === index);
}
