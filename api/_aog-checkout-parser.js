// Provisional parser for broker checkout mail that carries a signed charter
// contract. Skyway does not have a real sample yet. Every label below is a
// guess and every uncertain field is flagged for ops.
//
// ADJUSTING THIS PARSER
// When a real checkout sample arrives:
// 1. Add a redacted fixture under tests/fixtures/aog-checkout/. Do not commit
//    passenger names, real broker identities, or a real contract PDF.
// 2. Update LABELED_FIELDS / CHECKOUT_SIGNAL if the sample uses different
//    headings. Keep the return shape stable so the inbox job does not change.
// 3. Run `node --test tests/aog-recovery.test.mjs`.
// Records store parserVersion `provisional-1` until this file changes.
//
// Input: { subject, from, bodyText, attachmentNames, attachmentText, hasPdf }
// Output: structured trip fields, per-field confidence, and isCheckout.

export const PARSER_VERSION = 'provisional-1';

const CHECKOUT_SIGNAL = /\b(checkout|charter agreement|charter contract|signed contract|signed agreement|trip total|charter total|contract total)\b/i;

const TOTAL_LABEL = /(?:trip\s*total|charter\s*total|grand\s*total|total\s*due|contract\s*total|amount\s*due)\s*[:#-]?\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/gi;

const TRIP_ID_LABEL = /(?:trip\s*(?:id|#|number|no\.?|code)|confirmation(?:\s*(?:#|number|code))?|charter\s*(?:#|id|number))\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,40})|\btrip\s+([A-Z][A-Z0-9-]*\d[A-Z0-9-]*)\b/gi;

const AIRCRAFT_LABEL = /(?:aircraft(?:\s*type)?|equipment|a\/c)\s*[:#-]\s*([^\n]{2,60})/gi;

const TAIL_LABEL = /(?:tail(?:\s*(?:number|#))?|registration|n-?number)\s*[:#-]\s*(N[0-9]{1,5}[A-Z]{0,2})\b/gi;

const ROUTE_LABEL = /(?:route|itinerary|city\s*pair|routing)\s*[:#-]\s*([^\n]{3,80})/gi;

const DEPART_LABEL = /(?:depart(?:ure)?(?:\s*date)?|outbound|trip\s*date|date)\s*[:#-]\s*([A-Za-z0-9,/-][A-Za-z0-9,./ -]{2,30})/gi;

const RETURN_LABEL = /(?:return(?:\s*date)?|inbound|arrival\s*date)\s*[:#-]\s*([A-Za-z0-9,/-][A-Za-z0-9,./ -]{2,30})/gi;

const EMAIL_LABEL = /(?:checkout|broker|billing|contact)\s*e-?mail\s*[:#-]\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

const COMPANY_LABEL = /(?:broker(?:\s*\/\s*company)?|company|client)\s*[:#-]\s*([^\n]{2,80})/gi;

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
  const body = [subject, input.bodyText || '', input.attachmentText || '', attachmentNames.join('\n')].join('\n');
  const notes = [];
  const confidence = {};

  let tripIds = unique(allMatches(TRIP_ID_LABEL, body).map((value) => value.toUpperCase()).filter((value) => /\d/.test(value)));
  let tripIdConfidence = tripIds.length === 1 ? 'high' : (tripIds.length > 1 ? 'low' : 'missing');
  if (tripIds.length === 0) {
    tripIds = unique(String(body).toUpperCase().match(/\b[A-Z]{2,}(?:-[A-Z0-9]+){2,}\b/g) || []);
    tripIdConfidence = tripIds.length === 1 ? 'low' : (tripIds.length > 1 ? 'low' : 'missing');
    if (tripIds.length === 1) notes.push('Trip id was inferred from a code in the message, not a labeled field');
  }
  const tripId = tripIds[0] || null;
  confidence.tripId = tripIdConfidence;
  if (tripIds.length > 1) notes.push(`Multiple trip ids: ${tripIds.join(', ')}`);

  const labeledTails = unique(allMatches(TAIL_LABEL, body).map((value) => value.toUpperCase()));
  const bareTails = unique((body.toUpperCase().match(N_NUMBER) || []));
  let tail = labeledTails[0] || null;
  confidence.tail = labeledTails.length === 1 ? 'high' : 'missing';
  if (!tail && bareTails.length === 1) {
    tail = bareTails[0];
    confidence.tail = 'low';
    notes.push('Tail was inferred from an N-number, not a labeled field');
  } else if (labeledTails.length > 1) {
    confidence.tail = 'low';
    notes.push(`Multiple labeled tails: ${labeledTails.join(', ')}`);
  } else if (tail && bareTails.some((value) => value !== tail)) {
    notes.push(`Other N-numbers also appear: ${bareTails.filter((value) => value !== tail).join(', ')}`);
  }
  if (!tail) confidence.tail = 'missing';

  const aircraftHits = unique(allMatches(AIRCRAFT_LABEL, body).map((value) => value.replace(/\s{2,}/g, ' ').replace(/[.,;]+$/, '')));
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
  const routed = parseRoute(routeHits[0] || '');
  confidence.route = routed.routeFrom && routed.routeTo && parsedRoutes.length === 1 ? 'high' : 'missing';
  if (parsedRoutes.length > 1) {
    confidence.route = 'low';
    notes.push('Multiple route labels');
  }
  if (routed.route && routed.route.split(' → ').length > 2) {
    notes.push('Multi-leg itinerary; route match uses the first leg');
  }
  if (!routed.routeFrom) confidence.route = 'missing';

  const departRaw = allMatches(DEPART_LABEL, body);
  const returnRaw = allMatches(RETURN_LABEL, body);
  const departDate = parseLooseDate(departRaw[0]);
  const returnDate = parseLooseDate(returnRaw[0]);
  confidence.dates = departDate && departRaw.length === 1 ? 'high' : (departRaw.length > 1 ? 'low' : 'missing');
  if (departRaw.length > 0 && !departDate) {
    confidence.dates = 'low';
    notes.push(`Departure date was not understood: ${departRaw[0]}`);
  }
  if (departRaw.length > 1) notes.push('Multiple departure dates');
  const datesLabel = [departDate, returnDate].filter(Boolean).join(' – ');

  const totals = unique(allMatches(TOTAL_LABEL, body).map(money).filter((value) => value != null).map(String)).map(Number);
  let tripTotal = null;
  confidence.tripTotal = 'missing';
  if (totals.length === 1) {
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
  const brokerCompany = companies[0] || '';
  confidence.brokerCompany = companies.length === 1 ? 'high' : (companies.length > 1 ? 'low' : 'missing');

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
    notes.push('Parser is provisional-1. Confirm every field until a real checkout sample is wired in.');
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
    checkoutEmail,
    brokerCompany,
    confidence,
    uncertainFields: isCheckout ? uncertainFields : [],
    notes: isCheckout ? notes : (skipReason ? [skipReason] : []),
  };
}
