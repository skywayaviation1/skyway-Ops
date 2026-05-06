// Name matching helpers for ID verification.
//
// Used during pax check-in to compare what the AI extracted from a passenger
// ID against the expected name from the trip sheet. The PIC is the legal
// authority on identity verification — these matches are advisory.
//
// Match levels:
//   exact:    First + last match exactly (case-insensitive, whitespace normalized).
//   close:    Last name matches and first name matches via nickname or initial.
//   partial:  Surname-only match, OR hyphenated/compound name partial match.
//   mismatch: First and last names don't appear to be the same person.
//   no-data:  Either side missing — can't compare.
//
// Honest design notes:
//   - We allow either side to be missing the middle name. That's expected.
//   - We don't try to handle every possible nickname — just the common ones
//     where the formal name on an ID often differs from the casual name on
//     a trip sheet (Bob/Robert, Bill/William, Jim/James).
//   - We DO NOT auto-block check-in. We surface match level for the pilot
//     to make the call. The pilot is looking at the actual person.

// Common nickname pairs. Bidirectional — order doesn't matter.
const NICKNAME_PAIRS = [
  ['robert', 'bob'], ['robert', 'rob'], ['robert', 'bobby'],
  ['william', 'bill'], ['william', 'will'], ['william', 'billy'],
  ['james', 'jim'], ['james', 'jimmy'], ['james', 'jamie'],
  ['richard', 'rick'], ['richard', 'dick'], ['richard', 'rich'], ['richard', 'richie'],
  ['michael', 'mike'], ['michael', 'mikey'],
  ['john', 'jack'], ['john', 'johnny'], ['jonathan', 'jon'], ['jonathan', 'john'],
  ['joseph', 'joe'], ['joseph', 'joey'],
  ['charles', 'charlie'], ['charles', 'chuck'], ['charles', 'chas'],
  ['thomas', 'tom'], ['thomas', 'tommy'],
  ['christopher', 'chris'], ['christopher', 'topher'],
  ['daniel', 'dan'], ['daniel', 'danny'],
  ['anthony', 'tony'], ['matthew', 'matt'], ['benjamin', 'ben'],
  ['nicholas', 'nick'], ['nicholas', 'nicky'],
  ['edward', 'ed'], ['edward', 'eddie'], ['edward', 'ted'], ['edward', 'ned'],
  ['samuel', 'sam'], ['samuel', 'sammy'],
  ['steven', 'steve'], ['stephen', 'steve'],
  ['kenneth', 'ken'], ['kenneth', 'kenny'],
  ['ronald', 'ron'], ['ronald', 'ronnie'],
  ['donald', 'don'], ['donald', 'donny'],
  ['kevin', 'kev'], ['gerald', 'gerry'], ['gerald', 'jerry'],
  ['lawrence', 'larry'], ['frederick', 'fred'], ['frederick', 'freddy'],
  ['gregory', 'greg'], ['timothy', 'tim'], ['walter', 'walt'],
  ['patrick', 'pat'], ['raymond', 'ray'], ['phillip', 'phil'], ['philip', 'phil'],
  ['douglas', 'doug'], ['douglas', 'dougie'],
  ['howard', 'howie'], ['eugene', 'gene'], ['russell', 'russ'],
  ['nathaniel', 'nate'], ['nathan', 'nate'], ['theodore', 'ted'], ['theodore', 'teddy'],
  ['alexander', 'alex'], ['alexander', 'al'], ['albert', 'al'],
  ['vincent', 'vince'], ['vincent', 'vinny'], ['vincent', 'vinnie'],
  ['leonard', 'leo'], ['leonard', 'lenny'], ['leonardo', 'leo'],
  // Female names
  ['elizabeth', 'liz'], ['elizabeth', 'beth'], ['elizabeth', 'lizzy'], ['elizabeth', 'betty'], ['elizabeth', 'eliza'],
  ['katherine', 'kate'], ['katherine', 'kathy'], ['katherine', 'katie'], ['catherine', 'cathy'], ['catherine', 'kate'], ['catherine', 'cat'],
  ['margaret', 'maggie'], ['margaret', 'meg'], ['margaret', 'peggy'], ['margaret', 'marge'],
  ['jennifer', 'jen'], ['jennifer', 'jenny'],
  ['jessica', 'jess'], ['jessica', 'jessie'],
  ['samantha', 'sam'], ['samantha', 'sammy'],
  ['victoria', 'vicky'], ['victoria', 'tori'],
  ['stephanie', 'steph'], ['stephanie', 'stevie'],
  ['rebecca', 'becca'], ['rebecca', 'becky'],
  ['nicole', 'nikki'], ['nicole', 'nicky'],
  ['susan', 'sue'], ['susan', 'susie'],
  ['patricia', 'pat'], ['patricia', 'patty'], ['patricia', 'tricia'],
  ['barbara', 'barb'], ['barbara', 'barbie'],
  ['deborah', 'deb'], ['deborah', 'debbie'], ['debra', 'deb'], ['debra', 'debbie'],
  ['cynthia', 'cindy'], ['christina', 'chris'], ['christina', 'tina'], ['christine', 'chris'],
  ['amanda', 'mandy'], ['alexandra', 'alex'], ['alexandra', 'sandy'],
  ['theresa', 'terry'], ['teresa', 'terry'],
  ['frances', 'fran'], ['francesca', 'fran'],
  ['anne', 'annie'], ['ann', 'annie'], ['annabelle', 'anna'],
  ['kimberly', 'kim'], ['gabriella', 'gabby'], ['gabrielle', 'gabby'],
  ['charlotte', 'charlie'], ['charlotte', 'lottie'],
];

const NICKNAME_MAP = (() => {
  const map = new Map();
  for (const [a, b] of NICKNAME_PAIRS) {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  }
  return map;
})();

/**
 * Normalize a name for comparison: lowercase, strip punctuation/diacritics,
 * collapse whitespace.
 */
function normalize(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')      // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')         // strip non-alphanumeric except hyphens/apostrophes
    .replace(/\s+/g, ' ')
    .trim();
}

/** Are these two first names a match? Considers nicknames and initials. */
function firstNamesMatch(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return { match: false, reason: 'missing' };
  if (a === b) return { match: true, kind: 'exact' };
  // Initial match: "J" matches "John"
  if (a.length === 1 && b.startsWith(a)) return { match: true, kind: 'initial' };
  if (b.length === 1 && a.startsWith(b)) return { match: true, kind: 'initial' };
  // Nickname match
  const aliases = NICKNAME_MAP.get(a);
  if (aliases && aliases.has(b)) return { match: true, kind: 'nickname' };
  // Last-resort: prefix match (Sam/Samuel before nickname list catches it)
  if (a.length >= 3 && b.length >= 3) {
    if (b.startsWith(a) || a.startsWith(b)) return { match: true, kind: 'prefix' };
  }
  return { match: false, reason: 'differ' };
}

/** Are these two last names a match? Tolerates hyphens, suffixes. */
function lastNamesMatch(a, b) {
  a = normalize(a).replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, '');
  b = normalize(b).replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, '');
  if (!a || !b) return { match: false, reason: 'missing' };
  if (a === b) return { match: true, kind: 'exact' };
  // Hyphenated: "Garcia-Lopez" matches "Garcia" or "Lopez"
  const aParts = a.split(/[-\s]+/);
  const bParts = b.split(/[-\s]+/);
  for (const ap of aParts) {
    for (const bp of bParts) {
      if (ap && bp && ap === bp) return { match: true, kind: 'hyphenated' };
    }
  }
  return { match: false, reason: 'differ' };
}

/**
 * Compare an extracted ID identity against the expected pax record.
 * Returns a match descriptor — caller decides what to do with it.
 *
 * Inputs are objects with at least { firstName, lastName }. Middle names
 * are tolerated when missing on either side.
 *
 * Returns:
 *   {
 *     level: 'exact' | 'close' | 'partial' | 'mismatch' | 'no-data',
 *     reasons: string[],   // human-readable explanations of how we matched
 *     warnings: string[],  // anything the pilot should look at
 *   }
 */
export function compareNames(extracted, expected) {
  const reasons = [];
  const warnings = [];
  if (!extracted || !expected) {
    return { level: 'no-data', reasons: ['Missing data on one side.'], warnings: [] };
  }
  const eFirst = extracted.firstName || '';
  const eLast = extracted.lastName || '';
  const xFirst = expected.firstName || '';
  const xLast = expected.lastName || '';

  if (!xFirst && !xLast) {
    return { level: 'no-data', reasons: ['No expected name to compare against.'], warnings: [] };
  }
  if (!eFirst && !eLast) {
    return { level: 'no-data', reasons: ['AI did not extract a name.'], warnings: [] };
  }

  const firstResult = firstNamesMatch(eFirst, xFirst);
  const lastResult = lastNamesMatch(eLast, xLast);

  // Names might be reversed (passport MRZ format puts surname first sometimes)
  const reversedFirst = firstNamesMatch(eFirst, xLast);
  const reversedLast = lastNamesMatch(eLast, xFirst);
  if (!firstResult.match && !lastResult.match && reversedFirst.match && reversedLast.match) {
    warnings.push('Names appear reversed (passport MRZ format?). Reviewed assuming swap.');
    return {
      level: 'close',
      reasons: ['Match found with first/last reversed.'],
      warnings,
    };
  }

  if (firstResult.match && lastResult.match) {
    if (firstResult.kind === 'exact' && lastResult.kind === 'exact') {
      reasons.push('Exact match on both names.');
      return { level: 'exact', reasons, warnings };
    }
    reasons.push(`First name: ${firstResult.kind}. Last name: ${lastResult.kind}.`);
    if (firstResult.kind === 'nickname') {
      warnings.push(`Nickname match: "${eFirst}" ↔ "${xFirst}".`);
    }
    if (lastResult.kind === 'hyphenated') {
      warnings.push(`Partial last-name match (compound surname).`);
    }
    return { level: 'close', reasons, warnings };
  }

  if (lastResult.match && !firstResult.match) {
    reasons.push(`Last name matches (${lastResult.kind}); first name differs.`);
    warnings.push(`First name on ID ("${eFirst}") differs from expected ("${xFirst}").`);
    return { level: 'partial', reasons, warnings };
  }

  if (firstResult.match && !lastResult.match) {
    reasons.push(`First name matches (${firstResult.kind}); last name differs.`);
    warnings.push(`Last name on ID ("${eLast}") differs from expected ("${xLast}").`);
    return { level: 'partial', reasons, warnings };
  }

  reasons.push(`Names do not appear to match: "${eFirst} ${eLast}" vs expected "${xFirst} ${xLast}".`);
  warnings.push('PIC must verify identity directly before proceeding.');
  return { level: 'mismatch', reasons, warnings };
}
