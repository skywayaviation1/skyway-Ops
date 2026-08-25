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

const DEFAULT_API_BASE = 'https://dev.iflightplanner.com/api/v2';
const REQUEST_TIMEOUT_MS = 20_000;
const DATA_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Provider base URL.
 *
 * iFlightPlanner issues *different* credentials for their dev and production
 * environments, so a production Client ID used against the dev host is
 * authenticated but unauthorized. Keeping this configurable means moving to
 * production credentials is an environment change, not a code change.
 */
export function apiBase() {
  return (clean(process.env.IFLIGHTPLANNER_BASE_URL) || DEFAULT_API_BASE).replace(/\/+$/, '');
}

const tokenUrl = () => `${apiBase()}/oauth2/token`;
const fboDataUrl = () => `${apiBase()}/airports/fbos/data`;
const fuelPriceDataUrl = () => `${apiBase()}/airports/fuel-prices/data`;

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

function firstMatching(index, patterns) {
  for (const [header, value] of index.entries()) {
    if (clean(value) && patterns.some((pattern) => pattern.test(header))) return clean(value);
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
  if (/selfserve|selfservice|ssprice|pricess|retailss/.test(normalized)) return 'Self service';
  if (/fullserve|fullservice|fsprice|pricefs|retailfs/.test(normalized)) return 'Full service';
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
  ]) || firstMatching(index, [
    /^icao(?:id|code)?$/,
    /^faa(?:lid|id|code)$/,
    /^airport.*(?:icao|identifier|ident|code|id)$/,
  ]));
  const name = first(index, [
    'fboname', 'businessname', 'companyname', 'locationname', 'vendorname', 'name',
  ]) || firstMatching(index, [
    /^(?:fbo|business|company|vendor).*name$/,
    /^name.*(?:fbo|business|company|vendor)$/,
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

/** Which credential variables this deployment is missing, by name. */
export function missingCredentialNames() {
  return [
    ['IFLIGHTPLANNER_CLIENT_ID', clean(process.env.IFLIGHTPLANNER_CLIENT_ID)],
    ['IFLIGHTPLANNER_CLIENT_SECRET', clean(process.env.IFLIGHTPLANNER_CLIENT_SECRET)],
  ].filter(([, value]) => !value).map(([name]) => name);
}

/**
 * Which deployment answered the request.
 *
 * Environment variables are scoped per environment on most hosts, so a value
 * present in production is still absent from a branch preview. Naming the
 * environment and branch is the difference between "the credentials are wrong"
 * and "you are looking at a deployment they were never added to".
 */
export function deploymentContext() {
  return {
    environment: clean(process.env.VERCEL_ENV) || 'unknown',
    branch: clean(process.env.VERCEL_GIT_COMMIT_REF) || null,
  };
}

function configuredCredentials() {
  const missing = missingCredentialNames();
  if (missing.length > 0) {
    const { environment, branch } = deploymentContext();
    const error = new Error(
      `iFlightPlanner credentials are missing from this deployment (${environment}`
      + `${branch ? ` · ${branch}` : ''}): ${missing.join(' and ')}. `
      + 'Add them for this environment and redeploy — values added to another '
      + 'environment, or added without a redeploy, do not reach this function.',
    );
    error.status = 503;
    error.code = 'iflightplanner_not_configured';
    error.missingEnv = missing;
    throw error;
  }
  return {
    clientId: clean(process.env.IFLIGHTPLANNER_CLIENT_ID),
    clientSecret: clean(process.env.IFLIGHTPLANNER_CLIENT_SECRET),
  };
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

  // The provider documents this request as HTTP Basic client authentication
  // with an application/x-www-form-urlencoded body. Sending JSON instead can
  // still yield a token — the Basic header alone identifies the client — but
  // the grant parameters never get parsed, and the resulting token is refused
  // by the data endpoints. Follow the documented form exactly.
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  const scope = clean(process.env.IFLIGHTPLANNER_SCOPE);
  if (scope) form.set('scope', scope);

  const response = await fetchWithTimeout(tokenUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
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
    scope: data.scope || scope || null,
  };
  return tokenCache.token;
}

/**
 * Read the provider's own explanation out of their result envelope.
 *
 * Every response is an `AviationApiDataResult`: `status` (0 means success),
 * plus a `title` and a `messages[]` array of `{ type, code, message }` where
 * the descriptive text actually lives. Reporting only `status` yields a bare
 * integer like "3", which tells nobody anything.
 */
export function describeProviderResult(result, fallbackBody = '') {
  if (!result || typeof result !== 'object') {
    return String(fallbackBody || '').trim().slice(0, 300) || 'no response body';
  }
  const messages = (Array.isArray(result.messages) ? result.messages : [])
    .map((entry) => {
      const code = clean(entry?.code);
      const text = clean(entry?.message);
      if (!text && !code) return '';
      return code && !text.includes(code) ? `${text} [${code}]` : text;
    })
    .filter(Boolean);

  const parts = [];
  const title = clean(result.title);
  if (title) parts.push(title);
  parts.push(...messages);
  if (parts.length === 0) {
    const direct = clean(result.message) || clean(result.errorMessage) || clean(result.error);
    if (direct) parts.push(direct);
  }
  if (parts.length === 0 && result.status != null) {
    // Status alone is nearly useless, so say what it is rather than printing a
    // naked number that reads like a message.
    parts.push(`provider returned result status ${result.status} with no message`);
  }
  return parts.join(' · ').slice(0, 500)
    || String(fallbackBody || '').trim().slice(0, 300)
    || 'no response body';
}

/**
 * Pull one CSV dataset.
 *
 * A 403 here means the client authenticated but is not entitled to this
 * dataset, which is an account provisioning matter rather than anything the
 * request can fix. The provider's own words are carried through verbatim so
 * they can be forwarded to their support without re-running anything.
 */
async function downloadCsv(url, label, forceToken = false) {
  const token = await accessToken(forceToken);
  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (response.status === 401 && !forceToken) {
    tokenCache = null;
    return downloadCsv(url, label, true);
  }

  const body = await response.text();
  let result = {};
  try { result = JSON.parse(body); } catch { /* non-JSON error page */ }

  if (!response.ok || typeof result.data !== 'string') {
    const providerMessage = describeProviderResult(result, body);
    const error = new Error(
      `iFlightPlanner ${label} request failed (${response.status}): ${providerMessage}`,
    );
    error.status = 502;
    error.httpStatus = response.status;
    error.providerMessage = providerMessage;
    error.providerStatus = result?.status ?? null;
    error.requestUrl = url;
    error.code = response.status === 403
      ? 'iflightplanner_forbidden'
      : 'iflightplanner_data_failed';
    throw error;
  }
  return result.data;
}

async function downloadFboCsv() {
  try {
    return { csv: await downloadCsv(fboDataUrl(), 'FBO'), dataset: 'fbos' };
  } catch (error) {
    if (error.code !== 'iflightplanner_forbidden') throw error;
    // The two datasets are licensed separately. If only the fuel-price feed is
    // enabled, prices are still worth having, so try it before giving up.
    try {
      return {
        csv: await downloadCsv(fuelPriceDataUrl(), 'fuel price'),
        dataset: 'fuel-prices',
        note: 'The FBO dataset is not enabled for this API client; retail fuel '
          + 'prices are shown without FBO contact details.',
      };
    } catch {
      throw error;
    }
  }
}

export async function getFboDataset({ force = false } = {}) {
  if (!force && dataCache?.records && dataCache.expiresAt > Date.now()) return dataCache;
  if (!force && inFlightData) return inFlightData;

  const load = async () => {
    const { csv, dataset, note } = await downloadFboCsv();
    const normalized = normalizeFboCsv(csv);
    dataCache = {
      ...normalized,
      dataset,
      note: note || null,
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
  const missingEnv = missingCredentialNames();
  const base = apiBase();
  return {
    configured: missingEnv.length === 0,
    missingEnv,
    deployment: deploymentContext(),
    source: 'iFlightPlanner',
    endpoint: 'FBO & Fuel Price Data v2',
    apiBase: base,
    // Their dev and production environments issue different credentials, so a
    // host/credential mismatch is a first thing to rule out on a 403.
    environmentKind: /(^|\/\/)dev\./i.test(base) ? 'development' : 'production',
    scopeConfigured: Boolean(clean(process.env.IFLIGHTPLANNER_SCOPE)),
  };
}
