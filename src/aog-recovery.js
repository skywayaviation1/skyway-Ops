// AOG mechanical recovery coverage — shared rules for the ops tab and the
// server. Premium math lives here so a browser preview and a Checkout Session
// cannot drift. The broker is charged only the premium, never the trip total.

export const COVERAGE_LEVELS = Object.freeze({
  included_50: '50% included',
  purchased_100: '100% purchased',
  gifted_100: '100% gifted by Skyway',
  complimentary_100: '100% complimentary domain',
});

export const PAYMENT_STATUSES = Object.freeze({
  not_required: 'Not required',
  offer_pending: 'Offer sent',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  complimentary: 'Complimentary',
  gifted: 'Gifted',
  unavailable: 'Upgrade unavailable',
});

export const CFS_BIND_TO = 'charter@charterflightsupport.com';
export const CFS_BIND_CC = 'charters@flyskyway.com';

/** Premium percentages. A rate at or above this would stop being "only the premium". */
export const MAX_PREMIUM_PERCENT = 15;

export const DEFAULT_RATES = Object.freeze([
  {
    aircraftType: 'Citation CJ3',
    ratePercent: 1.5,
    aliases: ['CJ3', 'Citation CJ3', 'C525'],
  },
  {
    aircraftType: 'Learjet 60',
    ratePercent: 2,
    aliases: ['Learjet 60', 'Lear 60', 'LR60', 'LJ60'],
  },
]);

export const CSV_COLUMNS = Object.freeze([
  ['tripId', 'Trip ID'],
  ['brokerCompany', 'Broker/company'],
  ['checkoutEmail', 'Checkout email'],
  ['tail', 'Tail'],
  ['aircraftType', 'Aircraft'],
  ['datesLabel', 'Dates'],
  ['route', 'Route'],
  ['tripTotal', 'Trip total'],
  ['coverageLevel', 'Coverage level'],
  ['premium', 'Premium'],
  ['paymentStatus', 'Payment status'],
  ['stripeReference', 'Stripe reference'],
  ['electionContract', 'Election contract'],
  ['charterContract', 'Charter contract'],
  ['offerSentAt', 'Offer sent'],
  ['bindEmailSentAt', 'Bind email sent'],
]);

function typeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function emailDomain(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return '';
  return value.slice(at + 1);
}

export function isComplimentaryDomain(email, domains) {
  const host = emailDomain(email);
  if (!host) return false;
  return (Array.isArray(domains) ? domains : []).some((raw) => {
    const domain = String(raw || '').trim().toLowerCase().replace(/^@/, '');
    if (!domain) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

export function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const domains = [];
  for (const raw of list) {
    let domain = String(raw || '').trim().toLowerCase().replace(/^@/, '');
    domain = domain.replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '');
    if (!domain) continue;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(domain)) {
      throw new Error(`Invalid complimentary domain: ${raw}`);
    }
    domains.push(domain);
  }
  return [...new Set(domains)].slice(0, 100);
}

export function normalizeRateTable(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Add at least one aircraft rate');
  }
  const out = [];
  const seen = new Set();
  for (const row of input) {
    const aircraftType = String(row?.aircraftType || '').trim().slice(0, 80);
    const ratePercent = Number(row?.ratePercent);
    if (!aircraftType) throw new Error('Aircraft type is required on every rate row');
    if (!Number.isFinite(ratePercent) || ratePercent <= 0 || ratePercent >= MAX_PREMIUM_PERCENT) {
      throw new Error(
        `Rate for ${aircraftType} must be greater than 0 and below ${MAX_PREMIUM_PERCENT}%. The broker is charged the premium, not the trip.`,
      );
    }
    const key = typeKey(aircraftType);
    if (seen.has(key)) throw new Error(`Duplicate aircraft type: ${aircraftType}`);
    seen.add(key);
    const aliasSource = Array.isArray(row?.aliases)
      ? row.aliases
      : String(row?.aliases || '').split(',');
    const aliases = [...new Set(
      [aircraftType, ...aliasSource].map((alias) => String(alias || '').trim()).filter(Boolean),
    )].slice(0, 12);
    out.push({
      aircraftType,
      ratePercent: Math.round(ratePercent * 1000) / 1000,
      aliases,
    });
  }
  return out.slice(0, 40);
}

export function findRate(aircraftType, rates = DEFAULT_RATES) {
  const key = typeKey(aircraftType);
  if (!key || !Array.isArray(rates)) return null;
  let best = null;
  let bestLen = 0;
  for (const row of rates) {
    const names = [row.aircraftType, ...(row.aliases || [])];
    for (const name of names) {
      const candidate = typeKey(name);
      if (!candidate) continue;
      const hit = candidate === key || key.includes(candidate) || candidate.includes(key);
      if (hit && candidate.length > bestLen) {
        best = row;
        bestLen = candidate.length;
      }
    }
  }
  return best;
}

/**
 * Premium is rate × trip total, rounded to cents. Refuses a result that is
 * not strictly less than the trip total.
 */
export function quotePremium({ aircraftType, tripTotal, rates = DEFAULT_RATES } = {}) {
  const rate = findRate(aircraftType, rates);
  if (!rate) return { eligible: false, reason: 'no_rate' };
  const total = Number(tripTotal);
  if (!Number.isFinite(total) || total <= 0) return { eligible: false, reason: 'no_total' };
  const premium = Math.round(total * (rate.ratePercent / 100) * 100) / 100;
  const premiumCents = Math.round(premium * 100);
  const tripCents = Math.round(total * 100);
  if (!Number.isInteger(premiumCents) || premiumCents <= 0) {
    return { eligible: false, reason: 'zero_premium' };
  }
  if (premiumCents >= tripCents) {
    return { eligible: false, reason: 'premium_not_less_than_trip' };
  }
  return {
    eligible: true,
    aircraftType: rate.aircraftType,
    ratePercent: rate.ratePercent,
    tripTotal: Math.round(total * 100) / 100,
    premium,
    premiumCents,
  };
}

export function classifyCheckout(parsed, settings = {}) {
  const rates = settings.rates?.length ? settings.rates : DEFAULT_RATES;
  const domains = settings.complimentaryDomains || [];
  const complimentary = isComplimentaryDomain(parsed?.checkoutEmail, domains);
  if (complimentary) {
    return {
      coverageLevel: 'complimentary_100',
      paymentStatus: 'complimentary',
      premium: 0,
      premiumCents: 0,
      ratePercent: null,
      matchedAircraftType: findRate(parsed?.aircraftType, rates)?.aircraftType || parsed?.aircraftType || '',
      upgradeAvailable: false,
      emails: ['broker_covered', 'cfs_bind'],
      electedBy: `Complimentary domain (${emailDomain(parsed?.checkoutEmail)})`,
    };
  }
  const quote = quotePremium({
    aircraftType: parsed?.aircraftType,
    tripTotal: parsed?.tripTotal,
    rates,
  });
  if (!quote.eligible) {
    return {
      coverageLevel: 'included_50',
      paymentStatus: quote.reason === 'no_rate' ? 'unavailable' : 'not_required',
      premium: null,
      premiumCents: null,
      ratePercent: null,
      matchedAircraftType: parsed?.aircraftType || '',
      upgradeAvailable: false,
      upgradeBlockReason: quote.reason,
      emails: ['broker_included_only'],
      electedBy: '',
    };
  }
  return {
    coverageLevel: 'included_50',
    paymentStatus: 'offer_pending',
    premium: quote.premium,
    premiumCents: quote.premiumCents,
    ratePercent: quote.ratePercent,
    matchedAircraftType: quote.aircraftType,
    upgradeAvailable: true,
    emails: ['broker_offer'],
    electedBy: '',
  };
}

export function normalizeAirport(code) {
  const compact = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length === 4 && compact.startsWith('K') && /^[A-Z]{3}$/.test(compact.slice(1))) {
    return compact.slice(1);
  }
  return compact;
}

/**
 * Match a parsed checkout to schedule legs. A trip id wins. Otherwise one
 * tail + first-leg route match is linked, and a same-route date match breaks
 * ties. Several legs of one trip id are all linked. Competing trips stay
 * unmatched so ops can choose.
 */
export function matchCoverageToTrips(parsed, trips) {
  const wantedId = String(parsed?.tripId || '').trim().toUpperCase();
  const tail = String(parsed?.tail || '').trim().toUpperCase();
  const from = normalizeAirport(parsed?.routeFrom);
  const to = normalizeAirport(parsed?.routeTo);
  const departMs = parsed?.departDate ? Date.parse(`${parsed.departDate}T12:00:00Z`) : NaN;

  const scored = [];
  for (const trip of Array.isArray(trips) ? trips : []) {
    if (!trip) continue;
    const reasons = [];
    let score = 0;
    const tripCode = String(trip.tripCode || '').trim().toUpperCase();
    const tripUid = String(trip.id || '').trim().toUpperCase();
    if (wantedId && (wantedId === tripCode || wantedId === tripUid)) {
      score += 60;
      reasons.push(wantedId === tripCode ? 'trip id' : 'trip uid');
    }
    if (tail && tail === String(trip.tail || '').trim().toUpperCase()) {
      score += 15;
      reasons.push('tail');
    }
    if (from && to && from === normalizeAirport(trip.from) && to === normalizeAirport(trip.to)) {
      score += 20;
      reasons.push('route');
    }
    if (Number.isFinite(departMs) && trip.start) {
      const startMs = Date.parse(trip.start);
      if (Number.isFinite(startMs) && Math.abs(startMs - departMs) <= 36 * 60 * 60 * 1000) {
        score += 15;
        reasons.push('date');
      }
    }
    if (score > 0) scored.push({ trip, score, reasons });
  }

  const idHits = scored.filter((row) => row.reasons.includes('trip id') || row.reasons.includes('trip uid'));
  if (idHits.length > 0) {
    return { status: 'linked', matches: idHits.map((row) => row.trip), ambiguous: false };
  }

  const routeHits = scored.filter((row) => row.reasons.includes('tail') && row.reasons.includes('route'));
  if (routeHits.length === 0) return { status: 'unmatched', matches: [], ambiguous: false };

  const dated = routeHits.filter((row) => row.reasons.includes('date'));
  const pool = dated.length > 0 ? dated : routeHits;
  const identities = new Set(pool.map((row) => String(row.trip.tripCode || row.trip.id || '')));
  if (identities.size > 1) {
    return { status: 'unmatched', matches: pool.map((row) => row.trip), ambiguous: true };
  }
  return { status: 'linked', matches: pool.map((row) => row.trip), ambiguous: false };
}

export function buildCoverageDraft({ parsed, settings, match, messageId }) {
  const action = classifyCheckout(parsed, settings);
  const uncertain = Array.isArray(parsed?.uncertainFields) ? parsed.uncertainFields : [];
  const linked = match?.status === 'linked';
  return {
    source: 'inbox',
    parserVersion: parsed?.parserVersion || 'provisional-1',
    graphMessageId: messageId || '',
    tripId: parsed?.tripId || '',
    brokerCompany: parsed?.brokerCompany || '',
    checkoutEmail: String(parsed?.checkoutEmail || '').trim().toLowerCase(),
    tail: String(parsed?.tail || '').trim().toUpperCase(),
    aircraftType: action.matchedAircraftType || parsed?.aircraftType || '',
    route: parsed?.route || '',
    routeFrom: parsed?.routeFrom || '',
    routeTo: parsed?.routeTo || '',
    departDate: parsed?.departDate || '',
    returnDate: parsed?.returnDate || '',
    datesLabel: parsed?.datesLabel || '',
    itinerary: parsed?.itinerary || '',
    tripTotal: Number.isFinite(Number(parsed?.tripTotal)) ? Number(parsed.tripTotal) : null,
    coverageLevel: action.coverageLevel,
    premium: action.premium,
    premiumCents: action.premiumCents,
    ratePercent: action.ratePercent,
    paymentStatus: action.paymentStatus,
    upgradeAvailable: action.upgradeAvailable === true,
    upgradeBlockReason: action.upgradeBlockReason || '',
    stripeReference: '',
    electedBy: action.electedBy || '',
    uncertainFields: uncertain,
    parserNotes: Array.isArray(parsed?.notes) ? parsed.notes : [],
    needsReview: uncertain.length > 0 || !linked || match?.ambiguous === true,
    matchStatus: linked ? 'linked' : 'unmatched',
    matchAmbiguous: match?.ambiguous === true,
    linkedTripUid: linked ? (match.matches[0]?.id || '') : '',
    linkedTripUids: linked ? match.matches.map((trip) => trip.id).filter(Boolean) : [],
    emailsToSend: action.emails,
  };
}

export function fmtMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function premiumLabel(record) {
  if (!record) return '—';
  if (record.coverageLevel === 'complimentary_100' || record.coverageLevel === 'gifted_100') {
    return 'complimentary';
  }
  if (record.premium == null || record.premium === '') return '—';
  return fmtMoney(record.premium);
}

export function coverageLevelLabel(level) {
  return COVERAGE_LEVELS[level] || level || '—';
}

export function paymentStatusLabel(status) {
  return PAYMENT_STATUSES[status] || status || '—';
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function coverageCsv(records) {
  const header = CSV_COLUMNS.map(([, label]) => label).join(',');
  const lines = (Array.isArray(records) ? records : []).map((record) => CSV_COLUMNS.map(([key]) => {
    if (key === 'coverageLevel') return csvCell(coverageLevelLabel(record.coverageLevel));
    if (key === 'paymentStatus') return csvCell(paymentStatusLabel(record.paymentStatus));
    if (key === 'premium') return csvCell(premiumLabel(record));
    if (key === 'tripTotal') return csvCell(record.tripTotal == null ? '' : record.tripTotal);
    if (key === 'electionContract') return csvCell(record.electionContractPath ? 'yes' : '');
    if (key === 'charterContract') return csvCell(record.charterContractPath ? 'yes' : '');
    return csvCell(record[key] || '');
  }).join(','));
  return [header, ...lines].join('\n');
}

/**
 * Decide what a verified Stripe event is allowed to do. The charged amount
 * must be the premium locked when Checkout was created, never the trip total.
 */
export function paymentDecision({ record, session }) {
  if (!record || !session) return { action: 'ignore', reason: 'missing' };
  if (session.metadata?.coverageProduct !== 'aog-recovery') {
    return { action: 'ignore', reason: 'other product' };
  }
  if (session.payment_status !== 'paid') return { action: 'ignore', reason: 'unpaid' };
  const reference = session.payment_intent || session.id || '';
  if (record.paymentStatus === 'paid' && record.stripeReference && record.stripeReference === reference) {
    return { action: 'duplicate' };
  }
  if (record.paymentStatus === 'paid') return { action: 'duplicate' };
  if (record.coverageLevel === 'gifted_100' || record.coverageLevel === 'complimentary_100') {
    return { action: 'reject', reason: 'already complimentary' };
  }
  const expected = Number(record.stripeAmountCents ?? record.premiumCents);
  if (!Number.isInteger(session.amount_total) || session.amount_total !== expected) {
    return { action: 'reject', reason: 'amount mismatch' };
  }
  const tripCents = Math.round(Number(record.tripTotal) * 100);
  if (Number.isFinite(tripCents) && tripCents > 0 && session.amount_total >= tripCents) {
    return { action: 'reject', reason: 'amount is the trip total' };
  }
  return { action: 'capture', stripeReference: reference, amountCents: session.amount_total };
}
