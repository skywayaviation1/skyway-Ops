// Provisional parser for broker checkout mail that carries a signed charter
// contract. The Skyway contract layout (trip locator, charter pricing, local
// leg times, checkout metadata) is covered. Uncertain fields are flagged.
//
// ADJUSTING THIS PARSER
// When a checkout sample arrives:
// 1. Add a redacted fixture under tests/fixtures/aog-checkout/. Do not commit
//    passenger names, real broker identities, IP addresses, signature hashes,
//    or a real contract PDF.
// 2. Update the label patterns if the sample uses different headings. Keep
//    the return shape stable so the inbox job does not change.
// 3. Run `node --test tests/aog-recovery.test.mjs`.
// Records store parserVersion `provisional-3`.
//
// Input: { subject, from, bodyText, attachmentNames, attachmentText, hasPdf }
// Output: structured trip fields, per-field confidence, and isCheckout.

import { acceptTripCode, normalizeTripId, TRIP_ID_LABEL_WORDS } from '../src/trip-id.js';

export const PARSER_VERSION = 'provisional-3';

const CHECKOUT_SIGNAL = /\b(checkout|charter agreement|charter contract|signed contract|signed agreement|trip total|charter total|contract total)\b/i;

const TOTAL_LABEL = /(?:trip\s*total|charter\s*total|grand\s*total|total\s*due|contract\s*total|amount\s*due)\s*[:#-]?\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/gi;

const TRIP_ID_LABEL = /(?:(?:passenger|crew)\s+itinerary\s*\(\s*([A-Z0-9]{6,7})\s*\)|(?:trip\s*(?:id|code|locator)|locator|confirmation\s*code)\s*[:#-]?\s*([A-Z0-9]{6,7})\b|\btrip\s+(?!id\b|code\b|number\b|no\b|total\b|date\b|locator\b)([A-Z0-9]{6,7})\b)/gi;

const FIELD_BLEED = /\b(?:passengers?|pax|tail(?:\s*(?:number|#))?|registration|n-?number|charter|route|itinerary|depart(?:ure)?|return|dates?|broker|phone|e-?mail|email|total)\b/i;

const PAX_LABEL = /\bpassengers?\s*[:#-]\s*(\d{1,3})\b/i;

const PHONE_LABEL = /(?:broker\s*)?phone\s*[:#-]\s*(\+?\(?[0-9][0-9().\-\s]{6,20}[0-9])/gi;

const AIRCRAFT_LABEL = /(?:aircraft(?:\s*type)?|equipment|a\/c)\s*[:#-]\s*([^\n]{2,60})/gi;

const TAIL_LABEL = /(?:tail(?:\s*(?:number|#))?|registration|n-?number)\s*[:#-]\s*(N[0-9]{1,5}[A-Z]{0,2})\b/gi;

const ROUTE_LABEL = /(?:route|itinerary|city\s*pair|routing)\s*[:#-]\s*([^\n]{3,80})/gi;

const DEPART_LABEL = /(?:depart(?:ure)?(?:\s*date)?|outbound|trip\s*date|date)\s*[:#]\s*([A-Za-z0-9,/-][A-Za-z0-9,./ -]{2,30})/gi;

const RETURN_LABEL = /(?:return(?:\s*date)?|inbound|arrival\s*date)\s*[:#]\s*([A-Za-z0-9,/-][A-Za-z0-9,./ -]{2,30})/gi;

const EMAIL_LABEL = /(?:checkout|broker|billing|contact|customer)\s*e-?mail\s*[:#-]\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

const COMPANY_LABEL = /(?:broker(?:\s*\/\s*company)?|company|client)\s*[:#-]\s*([^\n]{2,80})/gi;

const CUSTOMER_NAME = /customer\s*name\s*[:#-]\s*([^\n]{2,80})/gi;

const AIRCRAFT_TAIL = /(?:aircraft(?:\s*type)?|equipment|a\/c)\s*[:#-]\s*[^\n]{0,80}?\(\s*(N[0-9]{1,5}[A-Z]{0,2})\s*\)/gi;

const FOOTER_TRIP = /page\s*\d+\s*\/\s*\d+\s*([A-Z0-9]{6,7})\b/gi;

const LOCATOR_SUFFIX = /trip\s*locator\s*[:#-]?\s*([A-Z0-9]{6,7})-(\d{2})\b/i;

const SIGNED_AT = /signed\s*at\s*[:#-]\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*UTC/i;

const ESIGN_PRESENT = /contract\s*e-?signature\s*[:#-]\s*\S/i;

const MONEY_TOKEN = /([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/;

const LEG_STAMP = /(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2})\s*([AaPp][Mm])\s+([A-Z]{2,4})\b[\s\S]{0,180}?\b([A-Z]{3,4})\s*\(/g;

const N_NUMBER = /\bN[0-9]{1,5}[A-Z]{0,2}\b/g;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseLooseDate(value) {
  const raw = String(value || '').trim().replace(/\.$/, '');
  if (!raw) return null;
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return isoDate(match[1], match[2], match[3]);
  match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (match) {
    const year = match[3].length === 2 ? Number(`20${match[3]}`) : Number(match[3]);
    return isoDate(year, match[1], match[2]);
  }
  match = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (match) {
    const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return isoDate(match[3], month, match[2]);
  }
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function allMatches(regex, text) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const copy = new RegExp(regex.source, flags);
  return [...String(text || '').matchAll(copy)].map((match) => (
    match.slice(1).find((group) => group && String(group).trim()) || ''
  ).trim()).filter(Boolean);
}

function money(value) {
  const amount = Number(String(value || '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
}

function cleanAircraft(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  const stop = text.search(FIELD_BLEED);
  if (stop > 2) text = text.slice(0, stop);
  text = text
    .replace(/\(\s*N[0-9]{1,5}[A-Z]{0,2}\s*\)/ig, ' ')
    .replace(/\bN[0-9]{1,5}[A-Z]{0,2}\b/ig, ' ')
    .replace(/[|•].*$/, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 60);
}

function orderedDates(values) {
  const dates = [...new Set(values.filter(Boolean))].sort();
  if (dates.length === 0) return { departDate: null, returnDate: null, datesLabel: '' };
  const departDate = dates[0];
  const returnDate = dates.length > 1 ? dates[dates.length - 1] : null;
  return {
    departDate,
    returnDate,
    datesLabel: returnDate && returnDate !== departDate ? `${departDate} – ${returnDate}` : departDate,
  };
}

function to24h(hhmm, ampm) {
  const [hRaw, mRaw] = String(hhmm || '').split(':');
  let hour = Number(hRaw);
  const minute = Number(mRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59 || hour < 1 || hour > 12) return null;
  const mer = String(ampm || '').toLowerCase();
  if (mer === 'am') hour = hour === 12 ? 0 : hour;
  else if (mer === 'pm') hour = hour === 12 ? 12 : hour + 12;
  else return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function charterPricingTotal(text) {
  const block = String(text || '').match(/charter\s+pricing([\s\S]{0,800})/i);
  if (!block) return null;
  const slice = block[1];
  const sub = slice.match(new RegExp(`subtotal\\s*\\$?\\s*${MONEY_TOKEN.source}`, 'i'));
  const near = sub ? slice.slice(sub.index, sub.index + sub[0].length + 120) : slice.slice(0, 160);
  const after = near.match(new RegExp(`\\btotal\\s*[:#-]\\s*\\$?\\s*${MONEY_TOKEN.source}`, 'i'));
  const before = near.match(new RegExp(`\\$\\s*${MONEY_TOKEN.source}\\s*total\\s*:`, 'i'));
  const subtotal = sub ? money(sub[1]) : null;
  const total = after ? money(after[1]) : (before ? money(before[1]) : null);
  if (subtotal != null && total != null) {
    return subtotal === total
      ? { amount: subtotal, agree: true }
      : { amount: null, agree: false, values: [subtotal, total] };
  }
  if (subtotal != null || total != null) return { amount: subtotal ?? total, agree: true };
  return null;
}

function parseContractLegs(text) {
  const stamps = [...String(text || '').matchAll(new RegExp(LEG_STAMP.source, 'g'))].map((match) => {
    const date = parseLooseDate(match[1]);
    const time = to24h(match[2], match[3]);
    if (!date || !time) return null;
    return {
      date,
      time,
      zone: match[4].toUpperCase(),
      airport: match[5].toUpperCase(),
    };
  }).filter(Boolean);
  const legs = [];
  for (let index = 0; index + 1 < stamps.length; index += 2) {
    const depart = stamps[index];
    const arrive = stamps[index + 1];
    legs.push({
      from: depart.airport,
      to: arrive.airport,
      departAt: `${depart.date} ${depart.time} ${depart.zone}`,
      arriveAt: `${arrive.date} ${arrive.time} ${arrive.zone}`,
    });
  }
  const seen = new Set();
  const uniqueLegs = legs.filter((leg) => {
    const key = `${leg.from}|${leg.to}|${leg.departAt}|${leg.arriveAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { legs: uniqueLegs, unpaired: stamps.length % 2 === 1 };
}

function routeFromLegs(legs) {
  if (!legs.length) return { route: null, routeFrom: null, routeTo: null, itinerary: null };
  return {
    routeFrom: legs[0].from,
    routeTo: legs[legs.length - 1].to,
    route: legs.map((leg) => `${leg.from} → ${leg.to}`).join(' · '),
    itinerary: [legs[0].from, ...legs.map((leg) => leg.to)].filter(Boolean).join(' → '),
  };
}

function parseRoute(value) {
  const codes = String(value || '').toUpperCase().match(/\b[A-Z0-9]{3,4}\b/g) || [];
  const airports = codes.filter((code) => !['PAX', 'TAIL', 'TRIP', 'FROM', 'DATE', 'AND'].includes(code));
  if (airports.length === 0) return { route: null, routeFrom: null, routeTo: null, itinerary: null };
  return {
    routeFrom: airports[0],
    routeTo: airports[1] || null,
    route: airports.join(' → '),
    itinerary: airports.join(' → '),
  };
}

function knownTypeInText(text, knownAircraft) {
  const haystack = String(text || '').toLowerCase();
  const hits = [];
  for (const name of knownAircraft || []) {
    const label = String(name || '').trim();
    if (label.length < 3) continue;
    if (haystack.includes(label.toLowerCase())) hits.push(label);
  }
  return unique(hits);
}

function internalSender(email) {
  const host = String(email || '').toLowerCase().split('@')[1] || '';
  return host === 'flyskyway.com' || host.endsWith('.flyskyway.com') || host === 'charterflightsupport.com';
}

/**
 * @param {{subject?: string, from?: string, bodyText?: string, attachmentNames?: string[], attachmentText?: string, hasPdf?: boolean}} input
 * @param {{knownAircraft?: string[]}} [options]
 */
export function parseCheckoutEmail(input = {}, options = {}) {
  const subject = String(input.subject || '').replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  const from = String(input.from || '').trim().toLowerCase();
  const attachmentNames = (Array.isArray(input.attachmentNames) ? input.attachmentNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const hasPdf = input.hasPdf === true || attachmentNames.some((name) => /\.pdf$/i.test(name));
  const body = [subject, input.bodyText || '', input.attachmentText || '', attachmentNames.join('\n')]
    .join('\n')
    .replace(/[\u00a0\u202f\u2007]/g, ' ');
  const notes = [];
  const confidence = {};

  const rawTripIds = [...allMatches(TRIP_ID_LABEL, body), ...allMatches(FOOTER_TRIP, body)];
  const rejectedLabels = unique(rawTripIds.map((value) => normalizeTripId(value)).filter((value) => value && TRIP_ID_LABEL_WORDS.has(value)));
  const tripIds = unique(rawTripIds.map((value) => acceptTripCode(value)).filter(Boolean));
  const tripIdConfidence = tripIds.length === 1 ? 'high' : (tripIds.length > 1 ? 'low' : 'missing');
  const tripId = tripIds[0] || null;
  confidence.tripId = tripIdConfidence;
  if (tripIds.length > 1) notes.push(`Multiple trip ids: ${tripIds.join(', ')}`);
  if (rejectedLabels.length > 0) {
    notes.push(`Ignored label words that are not trip codes: ${rejectedLabels.join(', ')}`);
  }

  const labeledTails = unique(allMatches(TAIL_LABEL, body).map((value) => value.toUpperCase()));
  const parenTails = unique(allMatches(AIRCRAFT_TAIL, body).map((value) => value.toUpperCase()));
  const bareTails = unique((body.toUpperCase().match(N_NUMBER) || []));
  let tail = labeledTails[0] || parenTails[0] || null;
  const tailSources = unique([...labeledTails, ...parenTails]);
  confidence.tail = tailSources.length === 1 ? 'high' : 'missing';
  if (labeledTails.length > 1 || parenTails.length > 1 || (labeledTails[0] && parenTails[0] && labeledTails[0] !== parenTails[0])) {
    confidence.tail = 'low';
    notes.push(`Multiple labeled tails: ${tailSources.join(', ')}`);
  } else if (!tail && bareTails.length === 1) {
    tail = bareTails[0];
    confidence.tail = 'low';
    notes.push('Tail was inferred from an N-number, not a labeled field');
  } else if (tail && bareTails.some((value) => value !== tail)) {
    notes.push(`Other N-numbers also appear: ${bareTails.filter((value) => value !== tail).join(', ')}`);
  }
  if (!tail) confidence.tail = 'missing';

  const aircraftHits = unique(allMatches(AIRCRAFT_LABEL, body).map((value) => cleanAircraft(value)).filter((value) => value.length > 1));
  let aircraftType = aircraftHits[0] || null;
  confidence.aircraftType = aircraftHits.length === 1 ? 'high' : (aircraftHits.length > 1 ? 'low' : 'missing');
  if (aircraftHits.length > 1) notes.push(`Multiple aircraft labels: ${aircraftHits.join(' | ')}`);
  if (!aircraftType) {
    const known = knownTypeInText(body, options.knownAircraft);
    if (known.length === 1) {
      aircraftType = known[0];
      confidence.aircraftType = 'low';
      notes.push('Aircraft type matched a rate-table name in the text, not a labeled field');
    } else if (known.length > 1) {
      confidence.aircraftType = 'low';
      notes.push(`Several known aircraft names appear: ${known.join(', ')}`);
    }
  }

  const routeHits = allMatches(ROUTE_LABEL, body);
  const parsedRoutes = unique(routeHits.map((hit) => parseRoute(hit).route).filter(Boolean));
  let routed = parseRoute(routeHits[0] || '');
  const contractLegs = parseContractLegs(body);
  const legs = contractLegs.legs;
  if (!routed.routeFrom && legs.length) routed = routeFromLegs(legs);
  confidence.route = routed.routeFrom && routed.routeTo && (legs.length > 0 || parsedRoutes.length === 1) ? 'high' : 'missing';
  if (parsedRoutes.length > 1) {
    confidence.route = 'low';
    notes.push('Multiple route labels');
  }
  if (routed.route && routed.route.split(' → ').length > 2 && legs.length === 0) {
    notes.push('Multi-leg itinerary; route match uses the first leg');
  }
  if (contractLegs.unpaired) notes.push('A departure or arrival time could not be paired into a leg');
  if (!routed.routeFrom) confidence.route = 'missing';

  const departRaw = allMatches(DEPART_LABEL, body);
  const returnRaw = allMatches(RETURN_LABEL, body);
  const labeledDepart = parseLooseDate(departRaw[0]);
  const labeledReturn = parseLooseDate(returnRaw[0]);
  const ranged = [...String(body).matchAll(/(\d{4}-\d{2}-\d{2})\s*(?:–|-|to)\s*(\d{4}-\d{2}-\d{2})/gi)]
    .flatMap((match) => [match[1], match[2]]);
  const span = orderedDates([
    ...departRaw.map(parseLooseDate),
    ...returnRaw.map(parseLooseDate),
    ...ranged,
  ]);
  let departDate = span.departDate;
  let returnDate = span.returnDate;
  let datesLabel = span.datesLabel;
  confidence.dates = departDate && departRaw.length === 1 ? 'high' : (departRaw.length > 1 ? 'low' : 'missing');
  if (legs.length) {
    const first = legs[0].departAt.slice(0, 10);
    const last = (legs[legs.length - 1].arriveAt || legs[legs.length - 1].departAt).slice(0, 10);
    departDate = first;
    returnDate = last !== first ? last : null;
    datesLabel = returnDate ? `${departDate} – ${returnDate}` : departDate;
    confidence.dates = 'high';
  }
  if (departRaw.length > 0 && !labeledDepart && !departDate) {
    confidence.dates = 'low';
    notes.push(`Departure date was not understood: ${departRaw[0]}`);
  }
  if (departRaw.length > 1) notes.push('Multiple departure dates');
  if (labeledDepart && labeledReturn && labeledReturn < labeledDepart) {
    notes.push('Dates were ordered from the first leg to the last leg');
  }

  const passengerMatch = String(body).match(PAX_LABEL);
  const passengerCount = passengerMatch ? Number(passengerMatch[1]) : null;

  const totals = unique(allMatches(TOTAL_LABEL, body).map(money).filter((value) => value != null).map(String)).map(Number);
  const pricing = charterPricingTotal(body);
  let tripTotal = null;
  confidence.tripTotal = 'missing';
  if (pricing?.agree && pricing.amount != null) {
    tripTotal = pricing.amount;
    confidence.tripTotal = 'high';
    if (totals.some((value) => value !== tripTotal)) {
      notes.push('Charter pricing subtotal and total were used as the trip total');
    }
  } else if (pricing && pricing.agree === false) {
    confidence.tripTotal = 'low';
    notes.push(`Charter pricing subtotal and total disagree: ${pricing.values.join(', ')}`);
  } else if (totals.length === 1) {
    tripTotal = totals[0];
    confidence.tripTotal = 'high';
  } else if (totals.length > 1) {
    confidence.tripTotal = 'low';
    notes.push(`Labeled totals disagree: ${totals.join(', ')}`);
  }

  const labeledEmails = unique(allMatches(EMAIL_LABEL, body).map((value) => value.toLowerCase()));
  let checkoutEmail = labeledEmails.find((value) => !internalSender(value)) || null;
  confidence.checkoutEmail = checkoutEmail ? 'high' : 'missing';
  if (labeledEmails.length > 1) {
    confidence.checkoutEmail = 'low';
    notes.push(`Multiple checkout emails: ${labeledEmails.join(', ')}`);
  }
  if (!checkoutEmail && from && !internalSender(from)) {
    checkoutEmail = from;
    confidence.checkoutEmail = 'low';
    notes.push('Checkout email fell back to the From address');
  }

  const companies = allMatches(COMPANY_LABEL, body)
    .map((value) => value.replace(/\s{2,}/g, ' ').trim())
    .filter((value) => value && !value.includes('@') && !/^checkout$/i.test(value));
  let brokerCompany = companies[0] || '';
  confidence.brokerCompany = companies.length === 1 ? 'high' : (companies.length > 1 ? 'low' : 'missing');
  if (!brokerCompany) {
    const names = allMatches(CUSTOMER_NAME, body)
      .map((value) => value.replace(/\s+/g, ' ').trim())
      .filter((value) => value && !value.includes('@'));
    if (names[0]) {
      brokerCompany = names[0].slice(0, 80);
      confidence.brokerCompany = names.length === 1 ? 'high' : 'low';
    }
  }
  const brokerPhone = (allMatches(PHONE_LABEL, body)[0] || '').replace(/\s+/g, ' ').trim();
  const signedMatch = body.match(SIGNED_AT);
  const signedAt = signedMatch ? `${signedMatch[1]}T${signedMatch[2]}Z` : null;
  const contractSigned = Boolean(signedAt) || ESIGN_PRESENT.test(body);

  const haystack = `${subject}\n${input.bodyText || ''}\n${attachmentNames.join('\n')}`;
  const signal = CHECKOUT_SIGNAL.test(haystack);
  const isCheckout = Boolean(
    hasPdf && (signal || (tripTotal != null && (tail || tripId))),
  );
  let skipReason = null;
  if (!isCheckout) {
    if (!hasPdf) skipReason = 'no signed-contract PDF';
    else skipReason = 'PDF attachment did not look like a charter checkout';
  } else {
    notes.push('Parser is provisional-3.');
    const suffix = body.match(LOCATOR_SUFFIX);
    if (suffix) notes.push(`Trip locator ${suffix[1].toUpperCase()}-${suffix[2]} uses trip id ${acceptTripCode(suffix[1]) || suffix[1].toUpperCase()}`);
    if (signedAt) notes.push(`Contract signed at ${signedAt}`);
    if (!signal) notes.push('Treated as checkout because a PDF, a trip total, and a tail or trip id were present');
  }

  const required = ['tripId', 'tail', 'aircraftType', 'route', 'dates', 'tripTotal', 'checkoutEmail'];
  const uncertainFields = required.filter((field) => confidence[field] !== 'high');

  return {
    parserVersion: PARSER_VERSION,
    isCheckout,
    skipReason,
    hasPdf,
    tripId,
    itinerary: routed.itinerary,
    aircraftType,
    tail,
    route: routed.route,
    routeFrom: routed.routeFrom,
    routeTo: routed.routeTo,
    departDate,
    returnDate,
    datesLabel,
    tripTotal,
    passengerCount,
    legs,
    signedAt,
    contractSigned,
    checkoutEmail,
    brokerCompany,
    brokerPhone,
    confidence,
    uncertainFields: isCheckout ? uncertainFields : [],
    notes: isCheckout ? notes : (skipReason ? [skipReason] : []),
  };
}

/**
 * Pull literal strings out of an uncompressed PDF. Compressed contracts are
 * extracted in the browser and sent along as text; this covers simple PDFs
 * and the synthetic fixtures.
 */
export function extractUncompressedPdfText(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer || '');
  const parts = [];
  const re = /\(((?:\\\)|[^)]){1,400})\)/g;
  let match = re.exec(raw);
  while (match) {
    const text = match[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\([()\\])/g, '$1')
      .trim();
    if (/[A-Za-z0-9]/.test(text)) parts.push(text);
    match = re.exec(raw);
  }
  return parts.join('\n');
}
