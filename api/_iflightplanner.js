/**
 * Server-only iFlightPlanner FBO and fuel-price client.
 *
 * Credentials must live in the deployment environment:
 *   IFLIGHTPLANNER_CLIENT_ID
 *   IFLIGHTPLANNER_CLIENT_SECRET
 *
 * The upstream endpoint returns a JSON envelope whose `data` field is CSV.
 * This module parses and normalizes that feed, while retaining the original
 * columns so a provider schema addition does not require an emergency deploy.
 */

const API_BASE = 'https://dev.iflightplanner.com/api/v2';
const TOKEN_URL = `${API_BASE}/oauth2/token`;
const FBO_DATA_URL = `${API_BASE}/airports/fbos/data`;
const REQUEST_TIMEOUT_MS = 20_000;
const DATA_TTL_MS = 6 * 60 * 60 * 1000;

let tokenCache = null;
let dataCache = null;
let inFlightData = null;

const clean = (value) => String(value ?? '').trim();
const key = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseCsv(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => clean(cell)));
}

function rowsFromCsv(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { headers: rows[0] || [], records: [] };
  const headers = rows[0].map(clean);
  return {
    headers,
    records: rows.slice(1).map((cells) => Object.fromEntries(
      headers.map((header, index) => [header, clean(cells[index])]),
    )),
  };
}

function indexedRecord(record) {
  return new Map(Object.entries(record).map(([header, value]) => [key(header), value]));
}

function first(index, candidates) {
  for (const candidate of candidates) {
    const value = clean(index.get(candidate));
    if (value) return value;
  }
  return '';
}

function money(value) {
  const normalized = clean(value).replace(/[$,\s]/g, '');
  if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function fuelTypeForHeader(header) {
  const normalized = key(header);
  if (/100ll|avgas/.test(normalized)) return '100LL';
  if (/jeta.*fsii|fsii.*jeta|jeta\+|jetaplus/.test(normalized)) return 'Jet A + FSII';
  if (/jeta/.test(normalized)) return 'Jet A';
  if (/mogas|autogas/.test(normalized)) return 'MOGAS';
  if (/ul94/.test(normalized)) return 'UL94';
  if (/saf|sustainableaviation/.test(normalized)) return 'SAF';
  return null;
}

function serviceForHeader(header) {
  const normalized = key(header);
  if (/selfserve|selfservice|\bss\b/.test(normalized)) return 'Self service';
  if (/fullserve|fullservice|\bfs\b/.test(normalized)) return 'Full service';
  return 'Retail';
}

function isPriceHeader(header) {
  const normalized = key(header);
  return Boolean(fuelTypeForHeader(header))
    && /price|retail|cost|fullserve|selfserve|fullservice|selfservice/.test(normalized)
    && !/date|updated|effective|reported|currency|unit/.test(normalized);
}

function priceDate(record, priceHeader) {
  const wanted = key(priceHeader);
  const candidates = Object.entries(record).filter(([header]) => {
    const normalized = key(header);
    return (
      normalized.includes(wanted)
      || wanted.includes(normalized.replace(/date|updated|effective|reported/g, ''))
    ) && /date|updated|effective|reported/.test(normalized);
  });
  return clean(candidates[0]?.[1]);
}

function normalizeAirport(value) {
  const airport = clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return airport.length >= 3 && airport.length <= 7 ? airport : '';
}

export function normalizeFboRecord(record) {
  const index = indexedRecord(record);
  const airport = normalizeAirport(first(index, [
    'airporticao', 'icao', 'airportidentifier', 'airportident', 'airportid',
    'airportcode', 'faaid', 'faalid', 'airport',
  ]));
  const name = first(index, [
    'fboname', 'businessname', 'companyname', 'locationname', 'vendorname', 'name',
  ]);
  const fuelPrices = Object.entries(record)
    .filter(([header, value]) => isPriceHeader(header) && money(value) != null)
    .map(([header, value]) => ({
      fuelType: fuelTypeForHeader(header),
      service: serviceForHeader(header),
      price: money(value),
      updatedAt: priceDate(record, header) || null,
      sourceColumn: header,
    }))
    .sort((a, b) => a.fuelType.localeCompare(b.fuelType) || a.service.localeCompare(b.service));

  return {
    airport,
    airportName: first(index, ['airportname', 'facilityname']),
    name: name || 'Fuel service',
    phone: first(index, ['phone', 'phonenumber', 'businessphone', 'telephone']),
    tollFree: first(index, ['tollfree', 'tollfreephone']),
    website: first(index, ['website', 'url', 'webaddress']),
    email: first(index, ['email', 'emailaddress']),
    address: first(index, ['address', 'streetaddress', 'address1']),
    city: first(index, ['city']),
    state: first(index, ['state', 'statecode']),
    frequency: first(index, ['frequency', 'unicom', 'asrifrequency']),
    fuelBrand: first(index, ['fuelbrand', 'fuelprovider', 'brand']),
    fuelPrices,
    raw: record,
  };
}

export function normalizeFboCsv(csv) {
  const { headers, records } = rowsFromCsv(csv);
  return {
    headers,
    records: records.map(normalizeFboRecord).filter((record) => record.airport),
  };
}

function configuredCredentials() {
  const clientId = clean(process.env.IFLIGHTPLANNER_CLIENT_ID);
  const clientSecret = clean(process.env.IFLIGHTPLANNER_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    const error = new Error(
      'iFlightPlanner is not configured. Set IFLIGHTPLANNER_CLIENT_ID and '
      + 'IFLIGHTPLANNER_CLIENT_SECRET on the server.',
    );
    error.status = 503;
    error.code = 'iflightplanner_not_configured';
    throw error;
  }
  return { clientId, clientSecret };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function accessToken(force = false) {
  if (!force && tokenCache?.token && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const { clientId, clientSecret } = configuredCredentials();
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error(
      `iFlightPlanner authorization failed (${response.status}): `
      + `${data.error_description || data.error || 'token not returned'}`,
    );
    error.status = 502;
    error.code = 'iflightplanner_auth_failed';
    throw error;
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  return tokenCache.token;
}

async function downloadFboCsv(forceToken = false) {
  const token = await accessToken(forceToken);
  const response = await fetchWithTimeout(FBO_DATA_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (response.status === 401 && !forceToken) {
    tokenCache = null;
    return downloadFboCsv(true);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.data !== 'string') {
    const message = result.message || result.errorMessage || result.error || 'FBO data not returned';
    const error = new Error(`iFlightPlanner FBO request failed (${response.status}): ${message}`);
    error.status = 502;
    error.code = 'iflightplanner_data_failed';
    throw error;
  }
  return result.data;
}

export async function getFboDataset({ force = false } = {}) {
  if (!force && dataCache?.records && dataCache.expiresAt > Date.now()) return dataCache;
  if (!force && inFlightData) return inFlightData;

  const load = async () => {
    const csv = await downloadFboCsv();
    const normalized = normalizeFboCsv(csv);
    dataCache = {
      ...normalized,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + DATA_TTL_MS,
    };
    return dataCache;
  };
  inFlightData = load();
  try {
    return await inFlightData;
  } finally {
    inFlightData = null;
  }
}

export function airportMatches(record, requested) {
  const airport = normalizeAirport(requested);
  if (!airport) return false;
  if (record.airport === airport) return true;
  // U.S. users commonly enter the FAA three-letter code while the feed stores
  // ICAO (APF vs KAPF), or vice versa.
  if (airport.length === 3 && record.airport === `K${airport}`) return true;
  if (airport.startsWith('K') && airport.length === 4 && record.airport === airport.slice(1)) return true;
  return false;
}

export function summarizeAirportFbos(records, requestedAirport) {
  const matches = records.filter((record) => airportMatches(record, requestedAirport));
  const lowestByFuel = {};
  for (const fbo of matches) {
    for (const fuel of fbo.fuelPrices) {
      const current = lowestByFuel[fuel.fuelType];
      if (!current || fuel.price < current.price) {
        lowestByFuel[fuel.fuelType] = {
          ...fuel,
          fboName: fbo.name,
        };
      }
    }
  }
  return {
    airport: normalizeAirport(requestedAirport),
    airportName: matches.find((record) => record.airportName)?.airportName || '',
    fbos: matches,
    lowestByFuel,
  };
}

export function publicIFlightPlannerStatus() {
  return {
    configured: Boolean(
      clean(process.env.IFLIGHTPLANNER_CLIENT_ID)
      && clean(process.env.IFLIGHTPLANNER_CLIENT_SECRET),
    ),
    source: 'iFlightPlanner',
    endpoint: 'FBO & Fuel Price Data v2',
  };
}
