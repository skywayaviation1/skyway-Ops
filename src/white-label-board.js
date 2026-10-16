// White-label operations boards.
//
// An admin or ops user stores a company name, logo, accent, and a private
// iCal feed. The public wall at /board/<token> receives only the display
// fields this module builds. The feed URL, storage path, and any Skyway
// document that is not a position for one of this feed's tails never leave
// the server.

import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { buildTripsFromEvents, parseICal } from './ical-parse.js';
import { readTripId } from './fleet-tracking.js';

export const BOARD_COLLECTION = 'white-label-boards';
export const BOARD_CACHE_COLLECTION = 'white-label-feed-cache';
export const LOGO_STORAGE_PREFIX = 'white-label-boards';
export const FEED_CACHE_TTL_MS = 3 * 60 * 1000;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const TOKEN_MIN_LENGTH = 20;
export const MAX_BOARDS = 40;
export const PUBLIC_TRIP_INFO_KEYS = ['tail', 'from', 'to', 'tripCode', 'isFlight', 'isOps'];

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export function generatePublicToken() {
  return randomBytes(24).toString('base64url');
}

export function generateBoardId() {
  return `b${randomBytes(12).toString('hex')}`;
}

export function isPublicToken(value) {
  return TOKEN_PATTERN.test(String(value || ''));
}

export function isBoardId(value) {
  return BOARD_ID_PATTERN.test(String(value || ''));
}

export function publicBoardPath(token) {
  if (!isPublicToken(token)) return null;
  return `/board/${token}`;
}

export function callerMayManageBoards(profile) {
  if (!profile || typeof profile !== 'object') return false;
  if (profile.active === false || profile.approved !== true) return false;
  if (profile.appReviewer === true) return false;
  return profile.role === 'admin' || profile.role === 'ops';
}

export function normalizeCompanyName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 80) return null;
  if (/[<>]/.test(name) || /[\u0000-\u001f]/.test(name)) return null;
  return name;
}

export function normalizeAccentColor(value) {
  const match = String(value || '').trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) return null;
  return `#${match[1].toUpperCase()}`;
}

export function normalizeFlag(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1 || value === 'true' || value === '1') return true;
  if (value === false || value === 0 || value === 'false' || value === '0') return false;
  return fallback;
}

function isIpLiteral(host) {
  if (!host) return false;
  if (host.includes(':')) return true;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

export function isPrivateIp(address) {
  const ip = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice('::ffff:'.length));
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** https hostnames only. IP literals and local names are rejected before DNS. */
export function feedUrlAllowed(feedUrl) {
  let url;
  try { url = new URL(String(feedUrl || '').trim()); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (String(feedUrl).length > 2000) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host === 'metadata.google.internal') return false;
  if (isIpLiteral(host)) return false;
  return true;
}

async function defaultResolveHost(hostname) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return (records || []).map((record) => record.address);
}

export async function assertFeedHostPublic(feedUrl, resolveHost = defaultResolveHost) {
  if (!feedUrlAllowed(feedUrl)) {
    throw Object.assign(new Error('feed host not allowed'), { status: 400 });
  }
  const host = new URL(feedUrl).hostname;
  let addresses = [];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw Object.assign(new Error('feed host not allowed'), { status: 400 });
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((address) => isPrivateIp(address))) {
    throw Object.assign(new Error('feed host not allowed'), { status: 400 });
  }
}

export async function fetchIcs(feedUrl, fetchImpl = fetch, resolveHost, hops = 0) {
  const resolve = resolveHost || defaultResolveHost;
  await assertFeedHostPublic(feedUrl, resolve);
  const response = await fetchImpl(feedUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'User-Agent': 'SkywayOps/1.0 (white-label board)',
      Accept: 'text/calendar, text/plain, */*',
    },
    signal: AbortSignal.timeout(20000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (hops >= 2) throw Object.assign(new Error('feed redirect limit'), { status: 502 });
    const location = response.headers?.get?.('location') || response.headers?.location;
    if (!location) throw Object.assign(new Error('feed redirect limit'), { status: 502 });
    const next = new URL(location, feedUrl).toString();
    return fetchIcs(next, fetchImpl, resolve, hops + 1);
  }
  if (!response.ok) throw Object.assign(new Error('feed unavailable'), { status: 502 });
  const text = await response.text();
  if (!text || !text.includes('BEGIN:VCALENDAR') || text.length > 5_000_000) {
    throw Object.assign(new Error('feed unavailable'), { status: 502 });
  }
  return text;
}

/** Eastern calendar day, matching the office TV's today filter. */
export function easternDayBounds(now) {
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const y = Number(etParts.find((part) => part.type === 'year').value);
  const mo = Number(etParts.find((part) => part.type === 'month').value);
  const d = Number(etParts.find((part) => part.type === 'day').value);
  const naive = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  const etStr = naive.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const utcStr = naive.toLocaleString('en-US', { timeZone: 'UTC' });
  const offset = new Date(etStr).getTime() - new Date(utcStr).getTime();
  const start = naive.getTime() - offset;
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

function publicUid(uid) {
  const value = String(uid || '');
  if (!value || value.includes('@') || value.length > 120) {
    return `leg-${createHash('sha256').update(value || 'anon').digest('hex').slice(0, 16)}`;
  }
  return value;
}

export function publicTripFromParsed(trip) {
  const info = trip?.info || {};
  const start = trip?.start instanceof Date ? trip.start.toISOString() : (trip?.start || null);
  const end = trip?.end instanceof Date ? trip.end.toISOString() : (trip?.end || null);
  const tripCode = readTripId(trip);
  return {
    uid: publicUid(trip?.uid),
    start,
    end,
    info: {
      tail: String(info.tail || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12),
      from: String(info.from || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5),
      to: String(info.to || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5),
      tripCode,
      isFlight: info.isFlight !== false,
      isOps: info.isOps !== false,
    },
  };
}

/** Today's flight legs only. Trip numbers are never copied onto the row. */
export function selectDisplayTrips(trips, now = Date.now()) {
  const { start, end } = easternDayBounds(now);
  return (Array.isArray(trips) ? trips : [])
    .filter((trip) => {
      const ts = new Date(trip?.start).getTime();
      if (!Number.isFinite(ts) || ts < start || ts >= end) return false;
      if (trip?.info?.isOps === false || trip?.info?.isFlight === false) return false;
      if (trip?.info?.from && trip.info.from === trip.info.to) return false;
      return true;
    })
    .map(publicTripFromParsed)
    .filter((trip) => trip.start && trip.info.tail && trip.info.tail !== 'TBD')
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 80);
}

export function tripsFromIcal(text, now = Date.now()) {
  return selectDisplayTrips(buildTripsFromEvents(parseICal(text)), now);
}

export function tailsFromTrips(trips) {
  const tails = new Set();
  for (const trip of Array.isArray(trips) ? trips : []) {
    const tail = String(trip?.info?.tail || '').toUpperCase();
    if (tail && tail !== 'TBD') tails.add(tail);
  }
  return [...tails].sort();
}

export function weatherAirportsFromTrips(trips) {
  const codes = new Set();
  for (const trip of Array.isArray(trips) ? trips : []) {
    for (const raw of [trip?.info?.from, trip?.info?.to]) {
      const value = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!value) continue;
      codes.add(value.length === 3 && /^[A-Z]{3}$/.test(value) ? `K${value}` : value);
    }
  }
  return [...codes].sort().slice(0, 30);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortCode(value) {
  if (value == null || value === '') return null;
  const code = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return code || null;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Whitelist a flightaware-state document. Internal AeroAPI fields stay behind. */
export function sanitizePosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.error) return null;
  return {
    airborne: raw.airborne === true,
    latitude: finiteOrNull(raw.latitude),
    longitude: finiteOrNull(raw.longitude),
    altitude: finiteOrNull(raw.altitude),
    groundspeed: finiteOrNull(raw.groundspeed),
    heading: finiteOrNull(raw.heading),
    origin: shortCode(raw.origin),
    destination: shortCode(raw.destination),
    estimatedOn: isoOrNull(raw.estimatedOn),
    actualOff: isoOrNull(raw.actualOff),
    actualOn: isoOrNull(raw.actualOn),
    actualOut: isoOrNull(raw.actualOut),
    actualIn: isoOrNull(raw.actualIn),
    progressPercent: finiteOrNull(raw.progressPercent),
    groundedAt: shortCode(raw.groundedAt),
    groundedLat: finiteOrNull(raw.groundedLat),
    groundedLon: finiteOrNull(raw.groundedLon),
    lastKnownAirport: shortCode(raw.lastKnownAirport),
    lastKnownLatitude: finiteOrNull(raw.lastKnownLatitude),
    lastKnownLongitude: finiteOrNull(raw.lastKnownLongitude),
    polledAt: finiteOrNull(raw.polledAt),
    originLat: finiteOrNull(raw.originLat),
    originLon: finiteOrNull(raw.originLon),
    destinationLat: finiteOrNull(raw.destinationLat),
    destinationLon: finiteOrNull(raw.destinationLon),
  };
}

export function freshnessFromPositions(positions, now, { stale = false, unavailable = false } = {}) {
  if (unavailable) return { status: 'error', message: 'Schedule feed unavailable' };
  if (stale) return { status: 'error', message: 'Schedule feed delayed' };
  const polls = Object.values(positions || {}).map((position) => position?.polledAt).filter((value) => Number.isFinite(value));
  if (polls.length === 0) {
    return { status: 'idle', message: 'Schedule only — fleet feed has not updated' };
  }
  const ageMin = Math.floor((now - Math.max(...polls)) / 60_000);
  return {
    status: ageMin > 5 ? 'error' : 'ok',
    message: ageMin > 5
      ? `Fleet feed is ${ageMin}m old`
      : `Fleet feed updated ${ageMin === 0 ? 'just now' : `${ageMin}m ago`}`,
  };
}

export function cacheIsFresh(fetchedAt, now, ttl = FEED_CACHE_TTL_MS) {
  return Number.isFinite(fetchedAt) && Number.isFinite(now) && (now - fetchedAt) < ttl;
}

export function metarFromNoaa(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const clouds = Array.isArray(raw.clouds) ? raw.clouds : [];
  const ceiling = clouds.reduce((min, cloud) => {
    if (cloud && ['BKN', 'OVC'].includes(cloud.cover) && cloud.base != null) {
      return min == null ? cloud.base : Math.min(min, cloud.base);
    }
    return min;
  }, null);
  const visibility = raw.visib ?? null;
  const category = raw.fltCat || flightCategory(visibility, ceiling);
  if (!category && raw.wspd == null && visibility == null && ceiling == null) return null;
  return {
    flightCategory: category || null,
    windDir: raw.wdir ?? null,
    windKt: raw.wspd ?? null,
    windGustKt: raw.wgst ?? null,
    visibilitySm: visibility,
    ceilingFt: ceiling,
  };
}

function flightCategory(visibility, ceiling) {
  if (visibility == null && ceiling == null) return null;
  const vis = visibility ?? 99;
  const ceil = ceiling ?? 99999;
  if (vis < 1 || ceil < 500) return 'LIFR';
  if (vis < 3 || ceil < 1000) return 'IFR';
  if (vis < 5 || ceil < 3000) return 'MVFR';
  return 'VFR';
}

export function sanitizeSvg(source) {
  const text = String(source || '').replace(/^\uFEFF/, '').trim();
  if (!text || text.length > LOGO_MAX_BYTES) return null;
  if (!/^<\?xml|^<svg/i.test(text) || !/<svg[\s>]/i.test(text)) return null;
  if (/<!doctype|<html|<script|<\/script|<foreignObject|<iframe|<object|<embed|javascript:|data:text\/html/i.test(text)) {
    return null;
  }
  const clean = text.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (/<script|javascript:|on[a-z]+\s*=/i.test(clean)) return null;
  return clean;
}

export function inspectLogo(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 8 || buffer.length > LOGO_MAX_BYTES) {
    return { ok: false, error: 'Logo must be a PNG, JPG, or SVG under 2MB' };
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ok: true, contentType: 'image/png', body: buffer };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ok: true, contentType: 'image/jpeg', body: buffer };
  }
  const svg = sanitizeSvg(buffer.toString('utf8'));
  if (!svg) return { ok: false, error: 'Logo must be a PNG, JPG, or SVG under 2MB' };
  return { ok: true, contentType: 'image/svg+xml', body: Buffer.from(svg, 'utf8') };
}

export function decodeLogoPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Logo must be a PNG, JPG, or SVG under 2MB' };
  }
  const raw = String(payload.dataBase64 || payload.base64 || '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!raw) return { ok: false, error: 'Logo must be a PNG, JPG, or SVG under 2MB' };
  let bytes;
  try { bytes = Buffer.from(raw, 'base64'); } catch { return { ok: false, error: 'Logo must be a PNG, JPG, or SVG under 2MB' }; }
  return inspectLogo(bytes);
}

export function logoObjectPath(boardId) {
  if (!isBoardId(boardId)) throw Object.assign(new Error('Invalid board'), { status: 400 });
  return `${LOGO_STORAGE_PREFIX}/${boardId}/logo`;
}

export function adminBoardView(id, data) {
  const token = isPublicToken(data?.publicToken) ? data.publicToken : null;
  return {
    id,
    companyName: data?.companyName || '',
    accentColor: data?.accentColor || '#2DD4BF',
    feedUrl: data?.feedUrl || '',
    poweredBy: data?.poweredBy !== false,
    enabled: data?.enabled !== false,
    publicToken: token,
    publicPath: token ? publicBoardPath(token) : null,
    hasLogo: Boolean(data?.logoContentType),
    updatedAt: Number.isFinite(data?.updatedAt) ? data.updatedAt : null,
  };
}

export function publicBoardResponse({
  board,
  trips,
  positions,
  weather,
  fetchedAt,
  now,
  stale = false,
  unavailable = false,
}) {
  const safeTrips = (Array.isArray(trips) ? trips : []).map((trip) => ({
    uid: trip.uid,
    start: trip.start,
    end: trip.end || null,
    info: {
      tail: trip.info?.tail || '',
      from: trip.info?.from || '',
      to: trip.info?.to || '',
      tripCode: readTripId(trip),
      isFlight: trip.info?.isFlight !== false,
      isOps: trip.info?.isOps !== false,
    },
  }));
  const tails = tailsFromTrips(safeTrips);
  const safePositions = {};
  for (const tail of tails) {
    const clean = sanitizePosition(positions?.[tail]);
    if (clean) safePositions[tail] = clean;
  }
  const safeWeather = {};
  for (const [code, payload] of Object.entries(weather || {})) {
    const metar = payload?.metar || payload;
    if (!metar || typeof metar !== 'object') continue;
    safeWeather[String(code).toUpperCase()] = {
      metar: {
        flightCategory: metar.flightCategory || null,
        windDir: metar.windDir ?? null,
        windKt: metar.windKt ?? null,
        windGustKt: metar.windGustKt ?? null,
        visibilitySm: metar.visibilitySm ?? null,
        ceilingFt: metar.ceilingFt ?? null,
      },
    };
  }
  return {
    ok: true,
    companyName: board.companyName,
    accentColor: board.accentColor,
    poweredBy: board.poweredBy !== false,
    hasLogo: Boolean(board.logoContentType),
    fetchedAt: fetchedAt || now,
    stale: stale === true,
    scheduleUnavailable: unavailable === true,
    tails,
    trips: safeTrips,
    positions: safePositions,
    weather: safeWeather,
    freshness: freshnessFromPositions(safePositions, now, { stale, unavailable }),
  };
}

const SECRET_PUBLIC_KEYS = ['feedUrl', 'feed', 'ical', 'storagePath', 'logoPath', 'publicToken', 'serviceAccount', 'faFlightId', 'filedFlights'];

export function publicPayloadLeaks(payload, secrets = []) {
  const blob = JSON.stringify(payload);
  if (SECRET_PUBLIC_KEYS.some((key) => Object.prototype.hasOwnProperty.call(flattenKeys(payload), key))) return true;
  return secrets.filter(Boolean).some((secret) => blob.includes(String(secret)));
}

function flattenKeys(value, out = {}) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    out[key] = true;
    if (child && typeof child === 'object') flattenKeys(child, out);
  }
  return out;
}

export async function loadBoardSchedule({
  feedUrl,
  cached = null,
  now = Date.now(),
  force = false,
  fetchImpl = fetch,
  resolveHost = defaultResolveHost,
  loadWeather = async () => ({}),
}) {
  const fresh = !force && cached && Array.isArray(cached.trips) && cacheIsFresh(cached.fetchedAt, now);
  if (fresh) {
    return {
      trips: cached.trips,
      weather: cached.weather || {},
      fetchedAt: cached.fetchedAt,
      stale: false,
      unavailable: false,
      source: 'cache',
    };
  }
  try {
    const text = await fetchIcs(feedUrl, fetchImpl, resolveHost);
    const trips = tripsFromIcal(text, now);
    let weather = {};
    try { weather = await loadWeather(weatherAirportsFromTrips(trips)); } catch { weather = cached?.weather || {}; }
    return { trips, weather: weather || {}, fetchedAt: now, stale: false, unavailable: false, source: 'feed' };
  } catch {
    if (cached && Array.isArray(cached.trips)) {
      return {
        trips: cached.trips,
        weather: cached.weather || {},
        fetchedAt: cached.fetchedAt || now,
        stale: true,
        unavailable: false,
        source: 'stale',
      };
    }
    return { trips: [], weather: {}, fetchedAt: now, stale: true, unavailable: true, source: 'error' };
  }
}
