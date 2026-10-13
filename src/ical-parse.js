// JetInsight iCal parsing shared by the ops client and the broker-link server.
//
// The browser used to be the only place that turned a feed title into a leg.
// Broker links then froze that parse. The public tracking page now parses the
// same feed on the server, so this module is the one implementation.

import { finalizeScheduleCategory, splitScheduleTypeSuffix } from './crew-day.js';
import { readTripId } from './fleet-tracking.js';

export const DEFAULT_ICAL_URL = 'https://portal.jetinsight.com/schedule/7a32dd47-6a5c-4c9c-b53b-864381bacebf/1243136b-b3ab-4dff-b0cf-edf264e20fbf.ics';

export const ICAL_HOSTS = [
  'portal.jetinsight.com',
  'calendar.google.com',
  'p44-caldav.icloud.com',
  'caldav.icloud.com',
];

export function icalHostAllowed(feedUrl) {
  try {
    const host = new URL(feedUrl).hostname;
    return ICAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Unfold continuation lines and pull each VEVENT into a flat key/value map. */
export function parseICal(text) {
  if (!text) return [];
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') current = {};
    else if (trimmed === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
    } else if (current) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const keyPart = line.substring(0, colonIdx);
      const value = line.substring(colonIdx + 1)
        .replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
      const baseKey = keyPart.split(';')[0];
      current[baseKey] = value;
    }
  }
  return events;
}

export function parseICalDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', se = '0', z] = m;
  if (z === 'Z') return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  return new Date(+y, +mo - 1, +d, +h, +mi, +se);
}

/**
 * JetInsight title: [TAIL] CUSTOMER (FROM - TO) - TYPE
 * Trip code lives in the description as `Trip ID: XXXXXX`.
 */
export function extractTripInfo(event) {
  const summary = event.SUMMARY || '';
  const description = event.DESCRIPTION || '';
  const location = event.LOCATION || '';
  const url = event.URL || '';

  const tailMatch = summary.match(/^\s*(?:HOLD:\s*)?\[([^\]]+)\]\s*(.*)$/);

  let tail = 'TBD';
  let customer = '';
  let from = location || '----';
  let to = '----';
  let tripType = '';

  if (tailMatch) {
    tail = tailMatch[1].trim();
    let rest = tailMatch[2] || '';

    const routeRegex = /\(\s*([A-Z0-9]{2,5})\s*-\s*([A-Z0-9]{2,5})\s*\)/gi;
    let lastRoute = null;
    let lastRouteIdx = -1;
    let match;
    while ((match = routeRegex.exec(rest)) !== null) {
      lastRoute = match;
      lastRouteIdx = match.index;
    }

    if (lastRoute) {
      from = lastRoute[1].trim().toUpperCase();
      to = lastRoute[2].trim().toUpperCase();
      customer = rest.substring(0, lastRouteIdx).replace(/[\s,-]+$/, '').trim();
      const afterRoute = rest.substring(lastRouteIdx + lastRoute[0].length);
      tripType = afterRoute.replace(/^\s*-\s*/, '').trim();
    } else {
      customer = rest.replace(/[,\s]+$/, '').trim();
      const split = splitScheduleTypeSuffix(customer);
      if (split) {
        customer = split.customer;
        tripType = split.tripType;
      }
    }
  } else {
    const bareTail = summary.match(/\bN\d{1,5}[A-Z]{0,2}\b/);
    if (bareTail) tail = bareTail[0];
    const haystack = `${summary} ${description} ${location}`;
    const exclude = new Set(['PAX', 'TAIL', 'FROM', 'DEST', 'CREW', 'CAPT', 'TRIP', 'HOLD']);
    const codes = (haystack.match(/\b[A-Z0-9]{3,5}\b/g) || [])
      .filter((c) => !exclude.has(c) && !/^N\d/.test(c));
    if (codes[0]) from = codes[0];
    if (codes[1]) to = codes[1];
  }

  const paxMatch = description.match(/pax[\s:=]*(\d+)/i);
  const pax = paxMatch ? parseInt(paxMatch[1], 10) : 0;
  const picMatch = description.match(/PIC[:\s]+([^\n]+)/i);
  const sicMatch = description.match(/SIC[:\s]+([^\n]+)/i);
  const pic = picMatch ? picMatch[1].trim() : '';
  const sic = sicMatch ? sicMatch[1].trim() : '';

  const tripIdMatch = description.match(/\bTrip\s*ID\s*[:=]\s*([A-Z0-9]{6,7})\b/i);
  const tripCode = readTripId(tripIdMatch ? tripIdMatch[1] : '');

  const notes = description
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(pax|pic|sic)\s*:/i.test(l))
    .join(' • ');

  const classified = finalizeScheduleCategory({
    tripType, summary, customer, from, to, pax, description,
  });

  return {
    tail, customer, from, to, pax, pic, sic, notes,
    tripCode,
    tripType,
    category: classified.category,
    legType: classified.legType,
    isFlight: classified.isFlight,
    isOps: classified.isOps,
    url,
    rawSummary: summary,
    rawDescription: description,
    rawLocation: location,
  };
}

export function buildTripsFromEvents(events) {
  return (events || [])
    .map((ev) => {
      const start = parseICalDate(ev.DTSTART) || parseICalDate(ev['DTSTART;VALUE=DATE']);
      const end = parseICalDate(ev.DTEND);
      const uid = ev.UID || `auto-${Math.random().toString(36).slice(2, 10)}`;
      return { uid, start, end, info: extractTripInfo(ev), raw: ev };
    })
    .filter((t) => t.start)
    .sort((a, b) => a.start - b.start);
}

/** Compact leg stored on legs/{uid} and in the schedule cache. */
export function tripToScheduleLeg(trip, now = null) {
  const info = trip?.info || {};
  const departure = trip?.start instanceof Date
    ? trip.start.toISOString()
    : (trip?.start || null);
  const arrival = trip?.end instanceof Date
    ? trip.end.toISOString()
    : (trip?.end || null);
  return {
    uid: trip?.uid || null,
    from: info.from || null,
    to: info.to || null,
    departure,
    arrival,
    tail: String(info.tail || '').toUpperCase(),
    category: info.category || 'REVENUE',
    legType: info.legType || info.category || 'REVENUE',
    broker: info.broker || info.customer || '',
    customer: info.customer || '',
    tripCode: info.tripCode || null,
    pic: info.pic || '',
    sic: info.sic || '',
    isFlight: info.isFlight !== false,
    aircraftType: info.aircraftType || null,
    cancelled: false,
    cancelledAt: null,
    lastSeenAt: now,
  };
}

export function eventsToScheduleLegs(text, now = Date.now()) {
  const trips = buildTripsFromEvents(parseICal(text));
  return trips.map((trip) => tripToScheduleLeg(trip, now)).filter((leg) => leg.uid);
}
