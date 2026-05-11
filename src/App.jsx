import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Plane, Calendar, MessageSquare, Users, Bell, MapPin,
  CheckCircle2, Circle, AlertTriangle, Camera, Send, RefreshCw,
  Coffee, ArrowRight, Clock, Shield, X, ScanLine, ChevronLeft,
  Mail, Navigation, Loader2, Wifi, WifiOff, Settings as SettingsIcon,
  Download, Trash2, Plus, FileText, Zap, Radio, AlertCircle,
  CheckCheck, UserCheck, Sparkles, Hash
} from 'lucide-react';
import { formatLocalTime, formatLocalDate } from './airports.js';
import {
  logoUrl, fuelCardDomain, cachedAirlineDomain, cachedHotelDomain,
  detectCardBrand, LOGO_DEV_CONFIGURED,
} from './provider-logos.js';
import {
  buildCheckInUrl, buildHotelDirectionsUrl, buildHotelPhoneUrl,
} from './travel-actions.js';
import { compareNames } from './name-matching.js';

/* ============================================================
   iCal parser — handles line folding & VEVENT extraction
   ============================================================ */
function parseICal(text) {
  if (!text) return [];
  // unfold continuation lines (CRLF + space/tab)
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

function parseICalDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', se = '0', z] = m;
  if (z === 'Z') return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  return new Date(+y, +mo - 1, +d, +h, +mi, +se);
}

function extractTripInfo(event) {
  const summary = event.SUMMARY || '';
  const description = event.DESCRIPTION || '';
  const location = event.LOCATION || '';
  const url = event.URL || '';

  // JetInsight format: [TAIL] CUSTOMER (FROM - TO) - TYPE
  // (HOLD: prefix or no parens for non-flight events)
  const jiMatch = summary.match(/^\s*(?:HOLD:\s*)?\[([^\]]+)\]\s*(.*?)\s*(?:\(([^)]*)\)\s*)?(?:-\s*(.+))?$/);

  let tail = 'TBD';
  let customer = '';
  let from = location || '----';
  let to = '----';
  let tripType = '';

  if (jiMatch) {
    tail = jiMatch[1].trim();
    customer = (jiMatch[2] || '').replace(/[,\s]+$/, '').trim();
    const route = jiMatch[3];
    if (route) {
      const parts = route.split(/\s*-\s*/);
      from = (parts[0] || from).trim();
      to = (parts[1] || from).trim();
    }
    tripType = (jiMatch[4] || '').trim();
  } else {
    // Fallback heuristic for non-JetInsight feeds
    const tailMatch = summary.match(/\bN\d{1,5}[A-Z]{0,2}\b/);
    if (tailMatch) tail = tailMatch[0];
    const haystack = `${summary} ${description} ${location}`;
    const exclude = new Set(['PAX', 'TAIL', 'FROM', 'DEST', 'CREW', 'CAPT', 'TRIP', 'HOLD']);
    const codes = (haystack.match(/\b[A-Z0-9]{3,5}\b/g) || [])
      .filter(c => !exclude.has(c) && !/^N\d/.test(c));
    if (codes[0]) from = codes[0];
    if (codes[1]) to = codes[1];
  }

  // Pax / PIC / SIC from description
  const paxMatch = description.match(/pax[\s:=]*(\d+)/i);
  const pax = paxMatch ? parseInt(paxMatch[1]) : 0;
  const picMatch = description.match(/PIC[:\s]+([^\n]+)/i);
  const sicMatch = description.match(/SIC[:\s]+([^\n]+)/i);
  const pic = picMatch ? picMatch[1].trim() : '';
  const sic = sicMatch ? sicMatch[1].trim() : '';

  // Notes — anything in description that's NOT pax/pic/sic
  const notes = description
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l && !/^(pax|pic|sic)\s*:/i.test(l))
    .join(' • ');

  // Categorize by trip type from summary suffix
  const t = tripType.toLowerCase();
  let category;
  if (t.includes('maintenance') || t.includes('mx out') || t.includes('fms')) category = 'MX';
  else if (t.includes('training')) category = 'TRAINING';
  else if (t.includes('crew assignment') || t.includes('hold') || t.includes('other')) category = 'HOLD';
  else if (t.includes('ferry')) category = 'FERRY';
  else if (t.includes('positioning')) category = 'REPO';
  else if (t.includes('charter')) category = pax === 0 ? 'REPO' : 'REVENUE';
  else if (t.includes('owner')) category = 'OWNER';
  else if (pax >= 1) category = 'REVENUE';
  else category = 'REPO';

  // Same-origin-and-destination is never a real flight — it's a maintenance/admin block
  // (e.g. "MX (TPA - TPA)", "No crews (TPA - TPA)"). Force these out of the flight list.
  const sameAirport = from && to && from.toUpperCase() === to.toUpperCase();
  if (sameAirport && !['MX', 'TRAINING', 'HOLD'].includes(category)) {
    category = 'HOLD';
  }

  // JetInsight publishes placeholder "Needs repositioning to XXX" entries that aren't real
  // scheduled trips — they're flags for ops to plan a future repo. Filter these out.
  const isRepoPlaceholder = /needs?\s+repositioning/i.test(description) ||
                             /needs?\s+repositioning/i.test(summary);
  if (isRepoPlaceholder) {
    category = 'HOLD';
  }

  // legType drives the status flow (5 buttons): only REVENUE shows pax-related steps
  const legType = category === 'REVENUE' || category === 'OWNER' ? 'REVENUE' : 'REPO';

  return {
    tail, customer, from, to, pax, pic, sic, notes,
    tripType, category, legType,
    isFlight: !['MX', 'TRAINING', 'HOLD'].includes(category),
    isOps: ['REVENUE', 'REPO', 'FERRY', 'OWNER'].includes(category),
    url,
    rawSummary: summary,
    rawDescription: description,
    rawLocation: location,
  };
}

/* ============================================================
   Storage helpers — wrap window.storage with safe defaults
   ============================================================ */
const DEFAULT_ICAL_URL = 'https://portal.jetinsight.com/schedule/7a32dd47-6a5c-4c9c-b53b-864381bacebf/1243136b-b3ab-4dff-b0cf-edf264e20fbf.ics';

// Hardcoded ops email — always CC'd on broker notifications. Cannot be
// changed per-user (was previously a settings field, but ops policy is
// that all status emails go to charters@flyskyway.com regardless of user).
const OPS_EMAIL = 'charters@flyskyway.com';

// All Skyway aircraft registrations. Used for the Malfunction/Incident Report
// dropdown and any other place we need to enumerate the fleet.
// Update this list when aircraft are added or retired.
const SKYWAY_TAILS = [
  'N20UF', 'N168ZZ', 'N286N', 'N444AM',
  'N651TW', 'N551FP', 'N85AH', 'N525CR',
];

// ICAO ↔ IATA airport-code map for international airports Skyway flies to.
// Used by findMatchingTrips to match trip-sheet legs (which JetInsight tends
// to publish in ICAO) against iCal feed legs (which can use either format).
//
// US airports are NOT in this table because the K-prefix stripping rule
// handles them generically (KTPA ↔ TPA, KSAV ↔ SAV, etc).
//
// Add new airports as Skyway expands — both entries (ICAO→IATA and IATA→ICAO)
// are auto-derived from a single source list, so just add to the AIRPORT_PAIRS
// array and both lookups update.
const AIRPORT_PAIRS = [
  // Caribbean
  ['MWCR', 'GCM'],  // Owen Roberts Intl, Grand Cayman
  ['MWCB', 'CYB'],  // Charles Kirkconnell Intl, Cayman Brac
  ['MYNN', 'NAS'],  // Lynden Pindling Intl, Nassau, Bahamas
  ['MYGF', 'FPO'],  // Grand Bahama Intl, Freeport
  ['MYEH', 'ELH'],  // North Eleuthera Intl
  ['MYAM', 'MHH'],  // Marsh Harbour Intl, Abacos
  ['MYEM', 'GHB'],  // Governors Harbour
  ['MYAT', 'TCB'],  // Treasure Cay
  ['MYBS', 'TBI'],  // South Bimini
  ['MYEX', 'GGT'],  // Exuma Intl
  ['MYSM', 'ZSA'],  // San Salvador Intl
  // Dominican Republic
  ['MDSD', 'SDQ'],  // Las Americas Intl, Santo Domingo
  ['MDPC', 'PUJ'],  // Punta Cana Intl
  ['MDPP', 'POP'],  // Puerto Plata
  ['MDST', 'STI'],  // Santiago de los Caballeros
  ['MDLR', 'LRM'],  // La Romana
  ['MDSB', 'AZS'],  // Samana El Catey
  // Cuba
  ['MUHA', 'HAV'],  // Jose Marti Intl, Havana
  ['MUVR', 'VRA'],  // Juan Gualberto Gomez, Varadero
  ['MUCC', 'COB'],  // Cayo Coco
  ['MUSC', 'SNU'],  // Abel Santamaria Intl, Santa Clara
  // Jamaica
  ['MKJP', 'KIN'],  // Norman Manley Intl, Kingston
  ['MKJS', 'MBJ'],  // Sangster Intl, Montego Bay
  // Puerto Rico / USVI
  ['TJSJ', 'SJU'],  // Luis Munoz Marin Intl, San Juan
  ['TIST', 'STT'],  // Cyril E. King, St. Thomas
  ['TISX', 'STX'],  // Henry E. Rohlsen, St. Croix
  // Lesser Antilles
  ['TNCM', 'SXM'],  // Princess Juliana Intl, St. Maarten
  ['TNCA', 'AUA'],  // Reina Beatrix Intl, Aruba
  ['TNCB', 'BON'],  // Flamingo Intl, Bonaire
  ['TNCC', 'CUR'],  // Hato Intl, Curacao
  ['TKPK', 'SKB'],  // Robert L. Bradshaw, St. Kitts
  ['TKPN', 'NEV'],  // Vance W. Amory, Nevis
  ['TUPJ', 'EIS'],  // Terrance B. Lettsome, Tortola, BVI
  ['TBPB', 'BGI'],  // Grantley Adams Intl, Barbados
  ['TGPY', 'GND'],  // Maurice Bishop Intl, Grenada
  ['TLPL', 'SLU'],  // George FL Charles, St. Lucia
  ['TLPC', 'UVF'],  // Hewanorra Intl, St. Lucia
  ['TFFF', 'FDF'],  // Martinique Aime Cesaire Intl
  ['TFFR', 'PTP'],  // Pointe-a-Pitre Intl, Guadeloupe
  ['TTPP', 'POS'],  // Piarco Intl, Trinidad
  ['TQPF', 'AXA'],  // Anguilla (alt code)
  ['TVSA', 'AXA'],  // Anguilla
  // Mexico
  ['MMUN', 'CUN'],  // Cancun Intl
  ['MMSD', 'SJD'],  // Los Cabos Intl
  ['MMPR', 'PVR'],  // Puerto Vallarta
  ['MMTO', 'TLC'],  // Toluca
  ['MMMX', 'MEX'],  // Benito Juarez, Mexico City
  // Central America
  ['MROC', 'SJO'],  // Juan Santamaria Intl, San Jose, Costa Rica
  ['MRLB', 'LIR'],  // Daniel Oduber Quiros, Liberia, Costa Rica
  ['MPTO', 'PTY'],  // Tocumen Intl, Panama City
  ['MGGT', 'GUA'],  // La Aurora, Guatemala City
  ['MHTG', 'TGU'],  // Toncontin, Tegucigalpa
  ['MNMG', 'MGA'],  // Managua Intl, Nicaragua
  ['MZBZ', 'BZE'],  // Philip S.W. Goldson Intl, Belize
];

// Build bidirectional lookup tables. ICAO_TO_IATA is many→one (an ICAO can
// have only one canonical IATA); IATA_TO_ICAO is one→many because some IATA
// codes correspond to multiple ICAO entries (e.g. AXA above). For matching
// we only need to know if any link exists, so both tables map to a Set.
const ICAO_TO_IATA = new Map();
const IATA_TO_ICAO = new Map();
for (const [icao, iata] of AIRPORT_PAIRS) {
  if (!ICAO_TO_IATA.has(icao)) ICAO_TO_IATA.set(icao, new Set());
  ICAO_TO_IATA.get(icao).add(iata);
  if (!IATA_TO_ICAO.has(iata)) IATA_TO_ICAO.set(iata, new Set());
  IATA_TO_ICAO.get(iata).add(icao);
}

// Generate the canonical normalization candidates for an airport code. Any
// pair of codes whose candidate sets share at least one element are
// considered the same airport.
//
// Examples:
//   'MWCR'  →  {'MWCR', 'GCM'}
//   'GCM'   →  {'GCM', 'MWCR'}
//   'KTPA'  →  {'KTPA', 'TPA'}                 (US: K-prefix stripped)
//   'TPA'   →  {'TPA', 'KTPA'}                 (US: K-prefix added)
//   'SAV'   →  {'SAV', 'KSAV'}
//   'AXA'   →  {'AXA', 'TQPF', 'TVSA'}         (multiple ICAO for one IATA)
function airportCodeCandidates(code) {
  if (!code) return new Set();
  const upper = String(code).toUpperCase().trim();
  const cands = new Set([upper]);

  // ICAO → IATA from the table
  const iataFromIcao = ICAO_TO_IATA.get(upper);
  if (iataFromIcao) for (const c of iataFromIcao) cands.add(c);

  // IATA → ICAO from the table
  const icaoFromIata = IATA_TO_ICAO.get(upper);
  if (icaoFromIata) for (const c of icaoFromIata) cands.add(c);

  // US convention: ICAO 'K' + IATA. If 4 letters starting with K, the last 3
  // are likely the IATA. Conversely if 3 letters, prepend K to get the ICAO.
  // This is a heuristic that's safe in practice because the table above
  // handles every non-K airport we care about.
  if (upper.length === 4 && upper.startsWith('K')) {
    cands.add(upper.slice(1));
  } else if (upper.length === 3) {
    cands.add('K' + upper);
  }

  return cands;
}

// True if two airport codes can be normalized to refer to the same airport.
function airportCodesMatch(a, b) {
  if (!a || !b) return false;
  const ca = airportCodeCandidates(a);
  const cb = airportCodeCandidates(b);
  for (const x of ca) if (cb.has(x)) return true;
  return false;
}

const CATEGORY_META = {
  REVENUE:  { label: 'REVENUE',     tone: 'cyan',    icon: 'Users' },
  REPO:     { label: 'REPO',        tone: 'violet',  icon: 'Plane' },
  OWNER:    { label: 'OWNER',       tone: 'amber',   icon: 'Crown' },
  FERRY:    { label: 'FERRY',       tone: 'violet',  icon: 'Plane' },
  MX:       { label: 'MAINTENANCE', tone: 'red',     icon: 'Wrench' },
  TRAINING: { label: 'TRAINING',    tone: 'neutral', icon: 'GraduationCap' },
  HOLD:     { label: 'CREW HOLD',   tone: 'neutral', icon: 'Pause' },
  MANUAL:   { label: 'MANUAL',      tone: 'amber',   icon: 'Plus' },
};

const USER_ROLES = {
  crew:       { label: 'CREW',       tone: 'cyan',   description: 'Pilots, SIC, flight attendants' },
  sales:      { label: 'SALES',      tone: 'green',  description: 'Sales team — trip creation, broker contact' },
  ops:        { label: 'OPS',        tone: 'amber',  description: 'Dispatch, scheduling, ground ops' },
  accounting: { label: 'ACCOUNTING', tone: 'violet', description: 'Read-only access to all expenses + CSV export' },
  admin:      { label: 'ADMIN',      tone: 'violet', description: 'Full access — manage users & system' },
};

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function nameMatchesPilot(jetinsightName, pilotName) {
  if (!jetinsightName || !pilotName) return false;
  const tokens = pilotName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const target = jetinsightName.toLowerCase();
  const wordRe = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return wordRe(first).test(target) && wordRe(last).test(target);
}

// Compare two names (e.g. "Adrian Stitts" from trip sheet vs "ADRIAN J STITTS"
// from scanned ID). Returns 'exact' | 'fuzzy' | 'no_match'.
// 'fuzzy' = first AND last token both appear; OK with crew confirmation.
// 'no_match' = either first or last is missing; show a warning.

/**
 * Parse a JetInsight crew-itinerary PDF text dump into a structured object.
 * Returns:
 *   {
 *     tripCode: 'WEQVQD',
 *     tail: 'N444AM',
 *     legs: [
 *       { legNumber, from, to, depDate, depTimeLocal, depTimeZ, paxCount, pax: [{ firstName, lastName, gender, dob, weight, primary }] }
 *     ]
 *   }
 *
 * Format-tolerant — built against the JetInsight crew itinerary format. If
 * a future format change breaks this, we'll need to retune the regexes.
 */
function parseJetInsightTripSheet(text) {
  if (!text || typeof text !== 'string') return null;

  // Trip code lives in "Crew Itinerary (WEQVQD)"
  const tripCodeMatch = text.match(/Crew Itinerary\s*\(([A-Z0-9]+)\)/i);
  const tripCode = tripCodeMatch ? tripCodeMatch[1] : null;

  // Tail is a standalone N-number block — there's only ever one per itinerary
  const tailMatch = text.match(/\b(N\d{1,5}[A-Z]{0,2})\b/);
  const tail = tailMatch ? tailMatch[1] : null;

  // Extract trip-level notes (apply to all legs, not per-leg).
  // Stop at the next top-level section header AND at common company-header
  // markers (so notes don't bleed into the operator's own address block which
  // follows the notes section in JetInsight crew itineraries).
  const extractNote = (labelPattern) => {
    const re = new RegExp(
      `${labelPattern}\\s*:\\s*([\\s\\S]*?)(?=(?:` +
        // section headers
        `Trip notes \\(|Customer notes:|Special items:|Leg \\s*\\d+|Distance:|Client:|Planner:|` +
        // company name (Skyway-specific — adjust if app is reused)
        `Skyway Aviation|` +
        // generic street address: 3-5 digit number + capitalized word + Blvd/St/Ave/Rd/Way/Dr/Ln/Pkwy
        `\\d{3,5}\\s+[A-Z][a-z]+\\s+(?:Blvd|St|Ave|Rd|Way|Dr|Ln|Pkwy)|` +
        // email address
        `[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\\.(?:com|net|org)|` +
        // US-style phone (123-456-7890 / 123.456.7890 / 123 456 7890)
        `\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}` +
      `)|$)`,
      'i'
    );
    const m = text.match(re);
    if (!m) return null;
    const cleaned = m[1].trim().replace(/\s+/g, ' ');
    return cleaned ? cleaned.slice(0, 2000) : null;
  };

  const notes = {
    crew: extractNote('Trip notes \\(crew\\)'),
    pax: extractNote('Trip notes \\(pax\\)'),
    customer: extractNote('Customer notes'),
    specialItems: extractNote('Special items'),
  };

  // Leg summary lines look like (in PDF text after extraction):
  //   Leg 1: Pax: 0 SDF 04/30/2026 - 18:24 EDT (22:24 Z) → 1:06 → CLE 04/30/2026 - 19:30 EDT (23:30 Z)
  // PDF text extraction loses the arrow chars and reorders some content. To be robust,
  // we parse departure and arrival info SEPARATELY, then pair them up by leg number.
  const legSummaries = [];
  // First pass: find "Leg N: Pax: M FROM date - time tz (zulu Z)" — the departure half
  const depRe = /Leg\s+(\d+)\s*:\s*Pax\s*:\s*(\d+)\s+([A-Z0-9]{3,4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}:\d{2})\s+([A-Z]{2,4})\s*\((\d{1,2}:\d{2})\s*Z\)/gi;
  const departures = [];
  let dm;
  while ((dm = depRe.exec(text)) !== null) {
    departures.push({
      legNumber: parseInt(dm[1], 10),
      paxCount: parseInt(dm[2], 10),
      from: dm[3].toUpperCase(),
      depDate: dm[4],
      depTimeLocal: dm[5],
      depTimeLocalTz: dm[6],
      depTimeZ: dm[7],
      depEndIdx: dm.index + dm[0].length,
    });
  }
  // Second pass: find arrival "TO date - time tz (zulu Z)" — extract the destination
  // airport. We look for these AFTER each departure end index.
  const arrRe = /([A-Z0-9]{3,4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}:\d{2})\s+[A-Z]{2,4}\s*\((\d{1,2}:\d{2})\s*Z\)/g;
  for (const dep of departures) {
    arrRe.lastIndex = dep.depEndIdx;
    const am = arrRe.exec(text);
    if (am && am.index < dep.depEndIdx + 200) {
      // Within 200 chars of departure — counts as the arrival
      legSummaries.push({
        legNumber: dep.legNumber,
        paxCount: dep.paxCount,
        from: dep.from,
        depDate: dep.depDate,
        depTimeLocal: dep.depTimeLocal,
        depTimeLocalTz: dep.depTimeLocalTz,
        depTimeZ: dep.depTimeZ,
        to: am[1].toUpperCase(),
      });
    } else {
      // No arrival found — still record the leg with TO unknown so we don't lose it
      legSummaries.push({
        legNumber: dep.legNumber,
        paxCount: dep.paxCount,
        from: dep.from,
        depDate: dep.depDate,
        depTimeLocal: dep.depTimeLocal,
        depTimeLocalTz: dep.depTimeLocalTz,
        depTimeZ: dep.depTimeZ,
        to: '----',
      });
    }
  }

  // Find ALL pax blocks in document order. Each leg has exactly one pax block
  // (either "Pax (N)" with names, or "Pax (0) No passengers"). They appear in
  // leg order (leg 1 first, leg 2 second, etc.).
  // Pre-spec: blocks are separated by section breaks; we capture the block
  // body until we hit another "Pax (N)", a "Distance:" line, or a "Leg N :" header.
  const paxBlocks = [];
  const paxHeaderRe = /Pax\s*\((\d+)\)\s*/g;
  let phMatch;
  while ((phMatch = paxHeaderRe.exec(text)) !== null) {
    const startIdx = phMatch.index + phMatch[0].length;
    // Find the end of this block: the next "Pax (" or "Distance:" or end-of-text
    const rest = text.slice(startIdx);
    const stopRe = /(?:\bPax\s*\(|Distance:|Leg\s+\d+\s*:)/;
    const stopMatch = rest.match(stopRe);
    const endIdx = stopMatch ? startIdx + stopMatch.index : text.length;
    paxBlocks.push({
      count: parseInt(phMatch[1], 10),
      body: text.slice(startIdx, endIdx).trim(),
    });
  }

  // Map blocks to legs by index (first block = leg 1, etc.)
  // Falls back gracefully if # of blocks != # of legs.
  const paxByLeg = {};
  legSummaries.forEach((leg, i) => {
    const block = paxBlocks[i];
    if (!block) {
      paxByLeg[leg.legNumber] = [];
      return;
    }
    if (block.count === 0 || /no passengers/i.test(block.body)) {
      paxByLeg[leg.legNumber] = [];
      return;
    }
    const paxRe = /([A-Za-z][A-Za-z\s\-'.]+?)\s*\(\s*(Male|Female|M|F)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d+)\s*lbs?\s*\)(?:\s*\(([^)]+)\))?/gi;
    const list = [];
    let pm;
    while ((pm = paxRe.exec(block.body)) !== null) {
      const fullName = pm[1].replace(/[,;]+\s*$/, '').trim();
      const tokens = fullName.split(/\s+/).filter(Boolean);
      list.push({
        firstName: tokens[0] || '',
        lastName: tokens.slice(1).join(' ') || '',
        gender: pm[2].length === 1 ? (pm[2].toUpperCase() === 'M' ? 'Male' : 'Female') : pm[2],
        dob: pm[3],
        weight: parseInt(pm[4], 10),
        primary: pm[5] ? /primary/i.test(pm[5]) : false,
      });
    }
    paxByLeg[leg.legNumber] = list;
  });

  // Combine summaries + pax
  const legs = legSummaries.map(s => ({
    ...s,
    pax: paxByLeg[s.legNumber] || [],
  }));

  return { tripCode, tail, legs, notes };
}

/**
 * Find iCal trips in `allTrips` that match a parsed leg from a trip sheet.
 * Match criteria: same tail + same departure date (UTC) + same FROM airport.
 * Returns array of trip objects (usually 1 match per leg, sometimes 0).
 */
function findMatchingTrips(parsedLeg, tail, allTrips) {
  if (!parsedLeg || !tail || !Array.isArray(allTrips)) return [];

  // Parse the depDate (MM/DD/YYYY) into a UTC date string YYYY-MM-DD
  const dateMatch = parsedLeg.depDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!dateMatch) return [];
  const mm = String(parseInt(dateMatch[1], 10)).padStart(2, '0');
  const dd = String(parseInt(dateMatch[2], 10)).padStart(2, '0');
  const yyyy = dateMatch[3];
  const targetDateStr = `${yyyy}-${mm}-${dd}`;

  // Inner predicate: returns true if `trip` matches `parsedLeg` on
  // route + date. Tail comparison is separate so we can do a strict-then-lax
  // two-pass match.
  const dateAndRouteMatches = (trip) => {
    if (!trip || !trip.info) return false;
    // Use ICAO↔IATA-aware matching (handles MWCR↔GCM, KTPA↔TPA, etc).
    if (!airportCodesMatch(trip.info.from, parsedLeg.from)) return false;
    if (!airportCodesMatch(trip.info.to, parsedLeg.to)) return false;
    // Compare date in BOTH UTC and local — JetInsight publishes local times,
    // iCal could be either depending on timezone. Accept match if either lines up.
    if (!trip.start) return false;
    const d = trip.start instanceof Date ? trip.start : new Date(trip.start);
    if (isNaN(d.getTime())) return false;
    const utcStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const locStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return utcStr === targetDateStr || locStr === targetDateStr;
  };

  // First pass: strict — require tail match. This is the common case.
  const strict = allTrips
    .filter(trip => trip && trip.info && (trip.info.tail || '').toUpperCase() === tail.toUpperCase())
    .filter(dateAndRouteMatches)
    .map(trip => ({ ...trip, _tailMismatch: false }));

  if (strict.length > 0) return strict;

  // Second pass: lax — same date+route, any tail. Useful when an aircraft
  // swap happened in JetInsight after the iCal feed last synced. UI surfaces
  // _tailMismatch so the user can confirm before attaching.
  const lax = allTrips
    .filter(dateAndRouteMatches)
    .map(trip => ({
      ...trip,
      _tailMismatch: (trip.info.tail || '').toUpperCase() !== tail.toUpperCase(),
    }));

  return lax;
}

const storage = {
  // Backed by browser localStorage. Keys prefixed by `shared` flag retained for
  // API compatibility with the artifact version, but on a single-device deploy
  // both flags map to the same store.
  _key(key, shared) {
    return shared ? `skyway.shared.${key}` : `skyway.user.${key}`;
  },
  async get(key, shared = false, fallback = null) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return fallback;
      const raw = window.localStorage.getItem(this._key(key, shared));
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch { return raw; }
    } catch { return fallback; }
  },
  async set(key, value, shared = false) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return false;
      const v = typeof value === 'string' ? value : JSON.stringify(value);
      window.localStorage.setItem(this._key(key, shared), v);
      return true;
    } catch { return false; }
  },
  async delete(key, shared = false) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return false;
      window.localStorage.removeItem(this._key(key, shared));
      return true;
    } catch { return false; }
  },
};

/* ============================================================
   Date / time formatting
   ============================================================ */
function fmtZulu(d) {
  if (!d) return '----Z';
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}${m}Z`;
}
function fmtDateZ(d) {
  if (!d) return '';
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Extract a friendly first-name greeting from an email address.
// "john.smith@brokerco.com" → "John"
// "jsmith@brokerco.com" → "Jsmith"
// Falls back to "there" if email is unusable.
function greetingFromEmail(email) {
  if (!email || typeof email !== 'string') return 'there';
  const local = email.split('@')[0] || '';
  const firstPart = local.split(/[._-]/)[0] || '';
  if (!firstPart) return 'there';
  return firstPart.charAt(0).toUpperCase() + firstPart.slice(1).toLowerCase();
}

// Build the email subject + body for a given status update.
// Returns { subject, text } or null if this status doesn't trigger an email.
// REPO legs get repositioning-specific copy; revenue legs get the standard
// passenger-flight wording.
function buildStatusEmail(step, trip, brokerEmail) {
  const greeting = `Hi ${greetingFromEmail(brokerEmail)},`;
  const tail = trip.info.tail || '';
  const route = `${trip.info.from || ''}-${trip.info.to || ''}`;
  const signature = '\n\n— Skyway Aviation\nPrivate Jet & Helicopter Charter Services';
  const isRepo = trip.info.legType === 'REPO';

  switch (step.id) {
    case 'crew_onsite':
      if (isRepo) {
        return {
          subject: `Crew Preparing Aircraft for Repositioning — ${tail} ${route}`,
          text:
            `${greeting}\n\n` +
            `Our crew has arrived at the FBO and is preparing the aircraft for the repositioning ` +
            `flight from ${trip.info.from || ''} to ${trip.info.to || ''}. ` +
            `We will notify you when the aircraft is ready and again when it begins taxi for departure.` +
            signature,
        };
      }
      return {
        subject: `Crew Arrival Notification — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `This email is to inform you that our crew has arrived at the FBO (local time) ` +
          `and is preparing the aircraft for your passengers. We will notify you as soon as ` +
          `the aircraft is ready for boarding.` +
          signature,
      };

    case 'aircraft_ready':
      if (isRepo) {
        return {
          subject: `Aircraft Ready for Repositioning — ${tail} ${route}`,
          text:
            `${greeting}\n\n` +
            `${tail} is ready for the repositioning flight from ${trip.info.from || ''} to ${trip.info.to || ''}. ` +
            `We will send a final notification once the aircraft begins taxi for departure.` +
            signature,
        };
      }
      return {
        subject: `Aircraft Ready for Passengers — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `The aircraft is now ready for your passengers. We will advise you once they have ` +
          `checked in.\n\n` +
          `If catering has been arranged for this flight, you will receive a separate notification ` +
          `once it has been loaded onboard.` +
          signature,
      };

    case 'catering_aboard':
      return {
        subject: `Catering Loaded — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `Catering has been loaded onboard the aircraft.` +
          signature,
      };

    case 'pax_arrived':
      return {
        subject: `Passengers Arrived — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `Passengers have arrived at the FBO. We will notify you once IDs have been ` +
          `verified and they have boarded the aircraft.` +
          signature,
      };

    case 'pax_boarded':
      return {
        subject: `Passengers Checked In — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `Passengers have checked in, IDs have been verified, and they are now boarding the aircraft.\n\n` +
          `The next update will be our taxi notification.` +
          signature,
      };

    case 'taxi_dep':
      if (isRepo) {
        return {
          subject: `Aircraft Taxiing for Repositioning — ${tail} ${route}`,
          text:
            `${greeting}\n\n` +
            `${tail} is now taxiing for the repositioning flight from ${trip.info.from || ''} to ${trip.info.to || ''}. ` +
            `We will provide the aircraft's ETA once it is airborne.` +
            signature,
        };
      }
      return {
        subject: `Aircraft Taxiing for Departure — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `The aircraft is now taxiing for departure. We will provide the aircraft's ETA once ` +
          `it is airborne.` +
          signature,
      };

    case 'wheels_up':
      if (isRepo) {
        return {
          subject: `Wheels Up (Repositioning) — ${tail} ${route}`,
          text:
            `${greeting}\n\n` +
            `${tail} is wheels up from ${trip.info.from || ''} and en route to ${trip.info.to || ''} ` +
            `for the repositioning flight. We will notify you upon landing.` +
            signature,
        };
      }
      return {
        subject: `Wheels Up — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `${tail} is wheels up from ${trip.info.from || ''} and en route to ${trip.info.to || ''}. ` +
          `We will notify you upon landing.` +
          signature,
      };

    case 'landed':
      if (isRepo) {
        return {
          subject: `Landed (Repositioning) — ${tail} ${route}`,
          text:
            `${greeting}\n\n` +
            `${tail} has landed at ${trip.info.to || ''}. The repositioning flight is complete.` +
            signature,
        };
      }
      return {
        subject: `Landed — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `${tail} has landed at ${trip.info.to || ''}. Thank you for choosing Skyway Aviation. ` +
          `We look forward to serving you again.` +
          signature,
      };

    default:
      // Unknown status — don't send an email
      return null;
  }
}

function fmtRelative(d) {
  if (!d) return '';
  const now = new Date();
  const diff = d - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const hr = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const prefix = diff < 0 ? '' : '+';
  if (min < 60) return `${prefix}${min}m`;
  if (hr < 24) return `${prefix}${hr}h`;
  return `${prefix}${days}d`;
}
function fmtChatTime(ts) {
  const d = new Date(ts);
  return `${fmtZulu(d)} · ${fmtDateZ(d).slice(0, 6)}`;
}

/* ============================================================
   Sample iCal feed for demo mode
   ============================================================ */
function buildDemoICal() {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const mkDate = (dayOffset, h, m) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    d.setUTCHours(h, m, 0, 0);
    return d;
  };
  const events = [
    { uid: 'demo-001', tail: 'N456JT', from: 'KMIA', to: 'KTEB', pax: 4, dep: mkDate(0, 13, 0), arr: mkDate(0, 16, 30), broker: 'broker@jetlinx.com' },
    { uid: 'demo-002', tail: 'N456JT', from: 'KTEB', to: 'KMIA', pax: 0, dep: mkDate(0, 18, 0), arr: mkDate(0, 21, 0), broker: '' },
    { uid: 'demo-003', tail: 'N789CL', from: 'KMIA', to: 'KFLL', pax: 2, dep: mkDate(1, 14, 30), arr: mkDate(1, 15, 15), broker: 'ops@privatejet.co' },
    { uid: 'demo-004', tail: 'N789CL', from: 'KFLL', to: 'KOPF', pax: 0, dep: mkDate(1, 17, 0), arr: mkDate(1, 17, 45), broker: '' },
    { uid: 'demo-005', tail: 'N321XS', from: 'KOPF', to: 'KASE', pax: 6, dep: mkDate(2, 12, 0), arr: mkDate(2, 17, 30), broker: 'charter@skybroker.io' },
  ];
  let out = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//PART135//OPS//EN\r\n';
  for (const e of events) {
    out += `BEGIN:VEVENT\r\nUID:${e.uid}\r\nDTSTART:${fmt(e.dep)}\r\nDTEND:${fmt(e.arr)}\r\n`;
    out += `SUMMARY:${e.tail} ${e.from}-${e.to} PAX:${e.pax}\r\n`;
    out += `DESCRIPTION:Tail ${e.tail} routing ${e.from} to ${e.to}.${e.broker ? ' Broker: ' + e.broker : ''}\r\n`;
    out += `LOCATION:${e.from}\r\nEND:VEVENT\r\n`;
  }
  out += 'END:VCALENDAR\r\n';
  return out;
}

/* ============================================================
   Custom hooks
   ============================================================ */
function useGeolocation() {
  const [state, setState] = useState({ status: 'idle', coords: null, error: null });
  const request = useCallback(() => {
    if (!navigator.geolocation) {
      setState({ status: 'error', coords: null, error: 'Geolocation unsupported' });
      return Promise.reject(new Error('unsupported'));
    }
    setState(s => ({ ...s, status: 'requesting' }));
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const c = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp,
          };
          setState({ status: 'ready', coords: c, error: null });
          resolve(c);
        },
        (err) => {
          setState({ status: 'error', coords: null, error: err.message });
          reject(err);
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
      );
    });
  }, []);
  return { ...state, request };
}

/* useAuth: subscribes to Firebase auth state and resolves user profile from Firestore.
 * Returns { authState, profile, signOut } where authState is one of:
 *   'loading' | 'signed-out' | 'unverified' | 'pending' | 'active' | 'no-profile'
 */
function useAuth() {
  const [authState, setAuthState] = useState('loading');
  const [profile, setProfile] = useState(null);
  const [user, setUser] = useState(null);

  useEffect(() => {
    let unsub = null;
    (async () => {
      try {
        const { watchAuth } = await import('./firebase-auth.js');
        unsub = watchAuth(({ state, user: u, profile: p }) => {
          setAuthState(state);
          setUser(u || null);
          setProfile(p || null);
        });
      } catch (err) {
        console.error('Failed to load auth module:', err);
        setAuthState('signed-out');
      }
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  const doSignOut = async () => {
    try {
      const { signOut } = await import('./firebase-auth.js');
      await signOut();
    } catch (err) {
      console.error('Sign out failed:', err);
    }
  };

  return { authState, profile, user, signOut: doSignOut };
}

/* useFirestoreUsers: subscribes to all user profiles in Firestore.
 * Used by admin panel.
 */
function useFirestoreUsers(currentProfile) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentProfile || (currentProfile.role !== 'admin' && currentProfile.role !== 'ops')) {
      // Non-admins can only see themselves
      if (currentProfile) setUsers([currentProfile]);
      setLoading(false);
      return;
    }
    let unsub = null;
    (async () => {
      try {
        const { subscribeToUsers } = await import('./firebase-auth.js');
        unsub = subscribeToUsers((list) => {
          setUsers(list);
          setLoading(false);
        });
      } catch (err) {
        console.error('Failed to load users:', err);
        setLoading(false);
      }
    })();
    return () => { if (unsub) unsub(); };
  }, [currentProfile]);

  const updateUser = async (uid, patch) => {
    try {
      const { updateUserProfile } = await import('./firebase-auth.js');
      await updateUserProfile(uid, patch);
    } catch (err) {
      console.error('Update failed:', err);
      alert('Failed to update user: ' + err.message);
    }
  };

  const removeUser = async (uid) => {
    try {
      // Get the caller's Firebase ID token to authenticate the server-side
      // delete (which uses the Admin SDK to remove from both Auth + Firestore).
      const { auth } = await import('./firebase.js');
      if (!auth.currentUser) throw new Error('Not signed in');
      const idToken = await auth.currentUser.getIdToken();

      const r = await fetch('/api/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, targetUid: uid }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        // If the server endpoint isn't deployed yet OR the service account
        // isn't configured, fall back to Firestore-only delete and warn the
        // admin that they need to manually delete the Auth account.
        const fallback = data.error?.includes('FIREBASE_SERVICE_ACCOUNT_JSON')
          || data.error?.includes('not configured');
        if (fallback) {
          const { deleteUserProfile } = await import('./firebase-auth.js');
          await deleteUserProfile(uid);
          alert(
            `Profile deleted from Firestore, but the Firebase Auth account ` +
            `still exists (server delete is not configured).\n\n` +
            `To free up the email for re-registration:\n` +
            `1. Firebase Console → Authentication → Users\n` +
            `2. Find the email and delete it manually.\n\n` +
            `Server error: ${data.error}`
          );
          return;
        }
        throw new Error(data.error || `Server returned ${r.status}`);
      }

      // Sanity check — both deletes should have succeeded
      if (!data.authDeleted || !data.firestoreDeleted) {
        const issues = [];
        if (!data.authDeleted) issues.push(`Auth: ${data.authError || 'unknown'}`);
        if (!data.firestoreDeleted) issues.push(`Firestore: ${data.firestoreError || 'unknown'}`);
        alert(`User partially deleted. Issues: ${issues.join('; ')}`);
      }
    } catch (err) {
      console.error('Remove failed:', err);
      alert('Failed to remove user: ' + err.message);
    }
  };

  const approveUserAccount = async (uid) => {
    try {
      const { approveUser } = await import('./firebase-auth.js');
      await approveUser(uid);
    } catch (err) {
      console.error('Approve failed:', err);
      alert('Failed to approve user: ' + err.message);
    }
  };

  return { users, loading, updateUser, removeUser, approveUser: approveUserAccount };
}

/* ============================================================
   UI primitives
   ============================================================ */
function Pill({ children, tone = 'neutral', className = '' }) {
  const tones = {
    neutral: 'bg-slate-800/60 text-slate-300 border-slate-700',
    amber: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/40',
    cyan: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/40',
    green: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40',
    red: 'bg-red-500/10 text-red-300 border-red-500/40',
    violet: 'bg-violet-500/10 text-violet-300 border-violet-500/40',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] border ${tones[tone]} ${className}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {children}
    </span>
  );
}

function StatusDot({ tone = 'neutral', pulse = false }) {
  const colors = {
    neutral: 'bg-slate-500',
    amber: 'bg-cyan-400',
    cyan: 'bg-cyan-400',
    green: 'bg-emerald-400',
    red: 'bg-red-400',
  };
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && <span className={`absolute inset-0 rounded-full ${colors[tone]} opacity-50 animate-ping`}></span>}
      <span className={`relative rounded-full h-2 w-2 ${colors[tone]}`}></span>
    </span>
  );
}

/* ============================================================
   Trip card (sidebar)
   ============================================================ */
function TripCard({ trip, selected, onClick, statusCount, hasUpdate, onArchive }) {
  const dep = trip.start;
  // Compare local-day strings — same calendar day in user's local time = "TODAY"
  const isToday = dep && dep.toDateString() === new Date().toDateString();
  const isPast = dep && dep < new Date();
  const meta = CATEGORY_META[trip.info.category] || CATEGORY_META.REPO;
  const totalSteps = trip.info.legType === 'REPO' ? 4 : 5;
  const progress = trip.info.isOps ? statusCount / totalSteps : 0;

  // Swipe-left-to-archive gesture state
  const [dragX, setDragX] = useState(0);
  const touchStartRef = useRef(null);
  const draggingRef = useRef(false);

  const handleTouchStart = (e) => {
    if (!onArchive) return;
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
    draggingRef.current = false;
  };

  const handleTouchMove = (e) => {
    if (!onArchive || !touchStartRef.current) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStartRef.current.x;
    const dy = t.clientY - touchStartRef.current.y;
    // Only treat as horizontal drag if dx clearly dominates dy — otherwise let the page scroll
    if (!draggingRef.current && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      draggingRef.current = true;
    }
    if (draggingRef.current && dx < 0) {
      // Only allow leftward drag, capped at -120px
      setDragX(Math.max(dx, -120));
      e.preventDefault?.();
    }
  };

  const handleTouchEnd = () => {
    if (!onArchive) return;
    const wasDragging = draggingRef.current;
    if (wasDragging && dragX < -80) {
      // Past threshold — archive
      onArchive(trip.uid);
    }
    setDragX(0);
    draggingRef.current = false;
    touchStartRef.current = null;
  };

  const handleClick = (e) => {
    // Suppress click if we just finished a drag
    if (draggingRef.current || Math.abs(dragX) > 5) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onClick();
  };

  return (
    <div className="relative overflow-hidden">
      {/* Red ARCHIVE background revealed by swipe */}
      {dragX < 0 && (
        <div className="absolute inset-y-0 right-0 flex items-center justify-end px-4 bg-red-500/20" style={{ width: Math.abs(dragX) }}>
          <span className="text-[10px] tracking-widest text-red-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            ARCHIVE
          </span>
        </div>
      )}
      <button
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{ transform: `translateX(${dragX}px)`, transition: dragX === 0 ? 'transform 0.2s ease-out' : 'none' }}
        className={`group w-full text-left p-4 border-l-2 transition-colors relative bg-slate-950 ${
          selected
            ? 'border-cyan-400 bg-gradient-to-r from-cyan-500/10 to-transparent'
            : hasUpdate
              ? 'border-cyan-400 bg-cyan-500/5 hover:bg-cyan-500/10'
              : 'border-transparent hover:border-slate-600 hover:bg-slate-900/40'
        } ${!trip.info.isFlight ? 'opacity-70' : ''}`}
      >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone={meta.tone}>{meta.label}</Pill>
          {isToday && <Pill tone="amber">TODAY</Pill>}
          {hasUpdate && !selected && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${
                hasUpdate === 'chat' ? 'bg-amber-400 text-slate-950' : 'bg-cyan-400 text-slate-950'
              }`}
            >
              <span className="w-1.5 h-1.5 bg-slate-950 rounded-full animate-pulse" />
              <span className="text-[10px] tracking-widest font-bold" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {hasUpdate === 'chat' ? 'NEW CHAT' : 'NEW UPDATE'}
              </span>
            </span>
          )}
        </div>
        <span className="text-[10px] text-slate-500 uppercase tracking-wider shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtRelative(dep)}
        </span>
      </div>

      <div className="flex items-baseline gap-3 mb-1 flex-wrap">
        <span className="text-base text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          {trip.info.tail}
        </span>
        <span className="text-[10px] text-slate-500 uppercase tracking-widest">
          {(() => {
            // Show departure-airport local time. Falls back to Zulu when the
            // airport isn't in the timezone database (formatLocalTime handles this).
            const t = formatLocalTime(dep, trip.info.from);
            return `${t.time}${t.tz ? ' ' + t.tz : ''} · ${fmtDateZ(dep).slice(0, 6)}`;
          })()}
        </span>
      </div>

      <div className="flex items-center gap-2 text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <span className="text-sm">{trip.info.from}</span>
        <ArrowRight className="w-3 h-3 text-slate-600" />
        <span className="text-sm">{trip.info.to}</span>
        {trip.info.pax > 0 && (
          <span className="ml-auto text-[10px] text-slate-400 flex items-center gap-1">
            <Users className="w-3 h-3" />{trip.info.pax}
          </span>
        )}
      </div>

      {trip.info.customer && (
        <div className="mt-1 text-[11px] text-slate-500 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {trip.info.customer}
        </div>
      )}

      {trip.info.isOps && (
        <div className="mt-2 h-0.5 bg-slate-800 relative overflow-hidden">
          <div
            className={`absolute left-0 top-0 h-full transition-all ${
              progress === 1 ? 'bg-emerald-400' : isPast ? 'bg-red-400' : 'bg-cyan-400'
            }`}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
    </button>
    </div>
  );
}

/* ============================================================
   Status step button (the 5 ops buttons)
   ============================================================ */
const STATUS_STEPS = [
  { id: 'crew_onsite', label: 'CREW ONSITE', sub: 'GPS lock at FBO', icon: MapPin, requiresGPS: true, applies: ['REPO', 'REVENUE'] },
  { id: 'aircraft_ready', label: 'AIRCRAFT READY', sub: 'Pre-flight complete', icon: CheckCircle2, applies: ['REPO', 'REVENUE'] },
  { id: 'catering_aboard', label: 'CATERING ON BOARD', sub: 'Galley loaded', icon: Coffee, applies: ['REVENUE'] },
  { id: 'pax_arrived', label: 'PASSENGERS ARRIVED', sub: 'Pax on property', icon: Users, applies: ['REVENUE'] },
  { id: 'pax_boarded', label: 'PASSENGERS BOARDED', sub: 'All souls accounted', icon: Users, applies: ['REVENUE'] },
  { id: 'taxi_dep', label: 'TAXI FOR DEPARTURE', sub: 'Pushback / taxi clearance', icon: Plane, applies: ['REPO', 'REVENUE'] },
  { id: 'wheels_up', label: 'WHEELS UP', sub: 'Airborne — auto-detected', icon: Plane, applies: ['REPO', 'REVENUE'] },
  { id: 'landed', label: 'LANDED', sub: 'On the ground — auto-detected', icon: CheckCircle2, applies: ['REPO', 'REVENUE'] },
];

// REPO-leg labels override the generic ones above. The same step IDs are used,
// but on a REPO leg the UI + email content reads "for Repositioning" instead
// of generic flight language.
const REPO_STEP_OVERRIDES = {
  crew_onsite:    { label: 'CREW PREPARING FOR REPOSITIONING', sub: 'GPS lock at FBO' },
  aircraft_ready: { label: 'AIRCRAFT READY FOR REPOSITIONING', sub: 'Pre-flight complete' },
  taxi_dep:       { label: 'AIRCRAFT TAXIING FOR REPOSITIONING', sub: 'Pushback / taxi clearance' },
  wheels_up:      { label: 'REPOSITIONING — WHEELS UP', sub: 'Airborne — auto-detected' },
  landed:         { label: 'REPOSITIONING — LANDED', sub: 'On the ground — auto-detected' },
};

// Return the leg-type-aware step config (label + sub).
// Use this everywhere a step label is rendered to crew/broker.
function getStepDisplay(step, trip) {
  const isRepo = trip?.info?.legType === 'REPO';
  if (isRepo && REPO_STEP_OVERRIDES[step.id]) {
    return { ...step, ...REPO_STEP_OVERRIDES[step.id] };
  }
  return step;
}

function StatusButton({ step, status, onTrigger, onUntrigger, locked, isNext, autoNotify, airportCode }) {
  const Icon = step.icon;
  const completed = !!status;
  const pulsing = isNext && !completed && !locked;

  const handleClick = () => {
    if (locked) return;
    if (completed) {
      // Confirm before un-marking
      if (window.confirm(`Undo "${step.label}"? This will remove the status from the timeline.`)) {
        onUntrigger?.(step);
      }
    } else {
      onTrigger(step);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={locked}
      className={`relative w-full p-4 border text-left transition-all overflow-hidden group ${
        completed
          ? 'border-emerald-500/40 bg-emerald-500/5 hover:border-amber-400/60 hover:bg-amber-500/5 cursor-pointer'
          : locked
          ? 'border-slate-800 bg-slate-900/30 opacity-40 cursor-not-allowed'
          : 'border-slate-700 bg-slate-900/40 hover:border-cyan-400 hover:bg-cyan-500/5 cursor-pointer'
      }`}
    >
      {pulsing && (
        <div className="absolute inset-0 border border-cyan-400/40 animate-pulse pointer-events-none" />
      )}
      <div className="flex items-start gap-4">
        <div className={`shrink-0 w-10 h-10 border flex items-center justify-center ${
          completed ? 'border-emerald-400 bg-emerald-500/10 text-emerald-300' : 'border-slate-600 text-slate-400'
        }`}>
          {completed ? <CheckCheck className="w-5 h-5" /> : <Icon className="w-5 h-5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <h4 className="text-sm tracking-wider text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {step.label}
            </h4>
            {completed && (
              <span className="text-[10px] text-emerald-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {(() => {
                  const d = new Date(status.timestamp);
                  if (airportCode) {
                    const t = formatLocalTime(d, airportCode);
                    return `${t.time}${t.tz ? ' ' + t.tz : ''}`;
                  }
                  return fmtZulu(d);
                })()}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">{step.sub}</p>
          {completed && status.coords && (
            <p className="text-[10px] text-slate-600 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {status.coords.lat.toFixed(4)}°, {status.coords.lon.toFixed(4)}° · ±{Math.round(status.coords.accuracy)}m
            </p>
          )}
          {completed && autoNotify && status.notified && (
            <p className="text-[10px] text-cyan-400 mt-1 flex items-center gap-1">
              <Mail className="w-3 h-3" /> Notification sent
            </p>
          )}
        </div>
      </div>
    </button>
  );
}

/* ============================================================
   Chat panel
   ============================================================ */
function ChatPanel({ tripId, currentUser }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  // Subscribe to real-time updates from Firestore
  useEffect(() => {
    setLoading(true);
    let unsubscribe = null;
    (async () => {
      try {
        const { subscribeToChat } = await import('./firebase-chat.js');
        unsubscribe = subscribeToChat(tripId, (msgs) => {
          setMessages(msgs);
          setLoading(false);
        });
      } catch (err) {
        console.error('Failed to load chat module:', err);
        setLoading(false);
      }
    })();
    return () => { if (unsubscribe) unsubscribe(); };
  }, [tripId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const text = draft.trim();
    setDraft('');
    try {
      const { sendChatMessage } = await import('./firebase-chat.js');
      await sendChatMessage(tripId, currentUser, text);
    } catch (err) {
      console.error('Failed to send message:', err);
      setDraft(text);
      alert('Failed to send message — check connection');
    }
    setSending(false);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm tracking-wider" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>TRIP COMMS</h3>
          <Pill tone="cyan">SHARED</Pill>
        </div>
        <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {messages.length} MSG
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading...
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8">
            <Radio className="w-8 h-8 text-slate-700 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No messages yet.</p>
            <p className="text-xs text-slate-600 mt-1">Comms are visible to all crew on this trip.</p>
          </div>
        ) : (
          messages.map(m => {
            const mine = m.author === currentUser;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
                  <div className={`text-[10px] mb-1 ${mine ? 'text-cyan-400/80' : 'text-slate-500'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {m.author} · {fmtChatTime(m.timestamp)}
                  </div>
                  <div className={`px-3 py-2 text-sm border ${
                    mine ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-50' : 'bg-slate-800/60 border-slate-700 text-slate-200'
                  }`}>
                    {m.text}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="p-3 border-t border-slate-800 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Message crew & ops..."
          className="flex-1 bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        />
        <button
          onClick={send}
          disabled={!draft.trim() || sending}
          className="px-4 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-medium transition-colors flex items-center gap-1.5"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   ID Check-In Panel — photo + checkbox verification
   ============================================================ */

// Document types crew can capture during check-in.
const DOCUMENT_TYPES = [
  { value: 'ID',       label: 'ID',       icon: '\u{1F4C4}' },
  { value: 'PASSPORT', label: 'Passport', icon: '\u{1F4D8}' },
];

/**
 * IDCheckInPanel - single component used for BOTH preloaded check-in and
 * walk-up entry. Crew picks document type, takes a photo, ticks a checkbox,
 * then taps Check In.
 *
 * Props:
 *   - mode: 'preloaded' | 'walkup'
 *   - expectedPax (only when mode === 'preloaded') - { firstName, lastName, dob, weight, gender, ... }
 *   - onComplete(paxData) - called with the assembled pax record
 *   - onCancel() - close the panel
 */
function IDCheckInPanel({ mode, expectedPax, onComplete, onCancel, tripContext }) {
  const isWalkup = mode === 'walkup';

  // Walk-up name fields (preloaded uses expectedPax)
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');

  // Document type toggle
  const [documentType, setDocumentType] = useState('ID');

  // Camera state
  const [phase, setPhase] = useState('intro'); // intro | capturing | review
  const [photo, setPhoto] = useState(null);    // dataURL once captured
  const [error, setError] = useState(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Verification checkbox
  const [idVerified, setIdVerified] = useState(false);

  // Camera refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};
      if (capabilities.torch) setTorchSupported(true);
      // Switch phase first so the <video> element renders. The stream gets
      // attached by the useEffect below once videoRef.current is populated.
      // (iPhone Safari + PWA mode requires the element be in the DOM before
      // assigning srcObject — otherwise the video stays black.)
      setPhase('capturing');
    } catch (e) {
      setError(`Camera error: ${e.message}`);
    }
  };

  // Attach the stream once both (1) the stream exists and (2) the <video>
  // element is mounted (phase === 'capturing'). This is the iPhone-safe
  // ordering — set state first, attach in an effect after render.
  useEffect(() => {
    if (phase !== 'capturing') return;
    if (!videoRef.current || !streamRef.current) return;
    const v = videoRef.current;
    v.srcObject = streamRef.current;
    // iOS Safari needs these attributes set before play() — the JSX has
    // them but assigning srcObject sometimes resets state. Re-affirm.
    v.setAttribute('playsinline', 'true');
    v.setAttribute('webkit-playsinline', 'true');
    v.muted = true;
    const playPromise = v.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(err => {
        console.warn('[IDCheckInPanel] video.play() failed:', err);
      });
    }
  }, [phase]);

  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn(!torchOn);
    } catch (e) { /* ignore */ }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    const maxW = 1280;
    const scale = Math.min(1, maxW / v.videoWidth);
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.75);
    setPhoto(dataUrl);
    stopCamera();
    setPhase('review');
  };

  const retake = () => {
    setPhoto(null);
    startCamera();
  };

  const walkupNamesValid = isWalkup
    ? firstName.trim().length > 0 && lastName.trim().length > 0
    : true;

  const canSubmit = walkupNamesValid && photo && idVerified;

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const handleSubmit = async () => {
    if (!canSubmit || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      // Generate the pax id up-front so we can use it as the Storage filename.
      // This same id is then attached to the pax record below.
      const paxId = `pax-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Upload the photo to Firebase Storage. We get back a download URL that
      // we store on the pax record — the inline dataURL is NOT persisted to
      // Firestore (it's hundreds of KB and would blow past the 1 MB doc limit
      // after a few pax). The Storage bucket has a lifecycle rule that
      // auto-deletes pax-ids/ objects after 5 days.
      const { getStorage, ref, uploadString, getDownloadURL } = await import('firebase/storage');
      // Storage uses the default Firebase app (initialized by firebase.js).
      // Unlike Firestore which uses a NAMED database ('appusers'), Storage
      // attaches to the default storageBucket from firebaseConfig.
      const storage = getStorage();
      const path = `pax-ids/${tripContext.tripUid}/${paxId}.jpg`;
      const fileRef = ref(storage, path);
      // `uploadString` accepts a data URL directly with format 'data_url'
      const snap = await uploadString(fileRef, photo, 'data_url', {
        contentType: 'image/jpeg',
        // Custom metadata helps audit who uploaded what
        customMetadata: {
          tripUid: String(tripContext.tripUid || ''),
          verifiedBy: String(tripContext.verifiedBy || ''),
          documentType,
        },
      });
      const photoUrl = await getDownloadURL(snap.ref);

      const paxData = isWalkup
        ? {
            id: paxId,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            documentType,
            photoUrl,           // ← URL instead of inline dataURL
            photoPath: path,    // for future delete-on-trip-removal
            idVerified: true,
            method: 'PHOTO_VERIFY_WALKUP',
          }
        : {
            ...expectedPax,
            id: paxId,
            documentType,
            photoUrl,
            photoPath: path,
            idVerified: true,
            method: 'PHOTO_VERIFY',
          };
      onComplete(paxData);
    } catch (err) {
      console.error('[IDCheckInPanel] photo upload failed:', err);
      setUploadError(`Photo upload failed: ${err.message || err}. Please try again.`);
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">
          {error}
        </div>
      )}
      {uploadError && (
        <div className="p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">
          {uploadError}
        </div>
      )}

      {/* Trip-sheet details (preloaded only) */}
      {!isWalkup && expectedPax && (
        <div className="p-2.5 border border-slate-700 bg-slate-900/40">
          <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            VERIFY THIS PASSENGER
          </div>
          <div className="text-base text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
            {expectedPax.firstName} {expectedPax.lastName}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {[
              expectedPax.dob && `DOB ${expectedPax.dob}`,
              expectedPax.weight && `${expectedPax.weight} lbs`,
              expectedPax.gender,
            ].filter(Boolean).join(' \u00B7 ')}
          </div>
        </div>
      )}

      {/* Walk-up name fields */}
      {isWalkup && (
        <div className="space-y-2">
          <FieldInput label="FIRST NAME" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="John" />
          <FieldInput label="LAST NAME" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Smith" />
        </div>
      )}

      {/* Document type toggle */}
      <div>
        <div className="text-[10px] tracking-widest text-slate-500 mb-1.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          DOCUMENT TYPE
        </div>
        <div className="grid grid-cols-2 gap-2">
          {DOCUMENT_TYPES.map(d => (
            <button
              key={d.value}
              type="button"
              onClick={() => setDocumentType(d.value)}
              className={`py-2 border text-sm transition ${
                documentType === d.value
                  ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200'
                  : 'border-slate-700 bg-slate-900/40 text-slate-400 hover:border-slate-600'
              }`}
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              <span className="mr-2">{d.icon}</span>{d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Camera area */}
      {phase === 'intro' && !photo && (
        <button
          onClick={startCamera}
          className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-medium tracking-widest flex items-center justify-center gap-2"
          style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
        >
          <Camera className="w-4 h-4" /> TAKE PHOTO OF {documentType === 'PASSPORT' ? 'PASSPORT' : 'ID'}
        </button>
      )}

      {phase === 'capturing' && (
        <div className="space-y-2">
          <div className="relative bg-black aspect-[4/3] overflow-hidden border border-cyan-500/30">
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              autoPlay
              playsInline
              webkit-playsinline="true"
              muted
            />
            <canvas ref={canvasRef} className="hidden" />
            {torchSupported && (
              <button
                onClick={toggleTorch}
                className={`absolute top-2 right-2 px-2 py-1 text-[10px] tracking-widest border ${
                  torchOn
                    ? 'border-amber-400 bg-amber-400/20 text-amber-200'
                    : 'border-slate-600 bg-slate-900/70 text-slate-300'
                }`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {torchOn ? 'TORCH ON' : 'TORCH OFF'}
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { stopCamera(); setPhase('intro'); }}
              className="py-2 border border-slate-700 text-slate-400 hover:bg-slate-800 text-xs tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              CANCEL
            </button>
            <button
              onClick={capturePhoto}
              className="py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-medium tracking-widest flex items-center justify-center gap-2"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              <Camera className="w-4 h-4" /> CAPTURE
            </button>
          </div>
        </div>
      )}

      {phase === 'review' && photo && (
        <div className="space-y-2">
          <div className="border border-emerald-500/30 bg-slate-950 overflow-hidden">
            <img src={photo} alt={`${documentType} captured`} className="w-full h-auto" />
          </div>
          <button
            onClick={retake}
            className="w-full py-1.5 border border-slate-700 text-slate-400 hover:bg-slate-800 text-xs tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            RETAKE PHOTO
          </button>
        </div>
      )}

      {/* Verification checkbox */}
      {photo && (
        <label className="flex items-start gap-2 p-2.5 border border-slate-700 bg-slate-900/40 cursor-pointer hover:bg-slate-900/70">
          <input
            type="checkbox"
            checked={idVerified}
            onChange={(e) => setIdVerified(e.target.checked)}
            className="mt-0.5 accent-cyan-400"
          />
          <span className="text-sm text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            <strong>ID Verified.</strong> I have visually inspected the {documentType === 'PASSPORT' ? 'passport' : 'ID'} and confirm it matches the passenger.
          </span>
        </label>
      )}

      {/* Action buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => { stopCamera(); onCancel(); }}
          className="py-2.5 border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs tracking-widest"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          CANCEL
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || uploading}
          className="py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 text-xs font-medium tracking-widest flex items-center justify-center gap-1.5"
          style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
        >
          {uploading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> UPLOADING...
            </>
          ) : (
            <>
              <CheckCircle2 className="w-3.5 h-3.5" /> CHECK IN PASSENGER
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function FieldInput({ label, value, onChange, type = 'text', placeholder = '', autoComplete }) {
  return (
    <label className="block">
      <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      />
    </label>
  );
}

/* ============================================================
   Notify panel — broker + ops emails
   ============================================================ */
// ============================================================
//   Delay panel — crew reports delays to broker + ops
// ============================================================
//
// Crew enters reason + duration + new ETD + requested pax arrival time.
// Sends an email to broker(s) + ops, and logs a 'delay_reported' entry to
// the trip's status timeline so it's visible alongside other status events.
function DelayPanel({ trip, opsEmail, brokerEmail, currentUser, statuses, setStatuses, persist, passengers, autoNotify, completed, hasCatering, paxOverride }) {
  const [reason, setReason] = useState('');
  const [delayDuration, setDelayDuration] = useState('');
  const [newEtd, setNewEtd] = useState('');
  const [paxArrivalTime, setPaxArrivalTime] = useState('');
  // Toggle: when true, broker is included in the delay email. When false,
  // only ops gets the notification. Default OFF so crew is conscious about
  // including the broker — broker notifications during a delay sometimes
  // need to be coordinated by sales first.
  const [notifyBroker, setNotifyBroker] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const send = async () => {
    if (!reason.trim()) {
      alert('Reason for delay is required.');
      return;
    }
    setSending(true);
    setResult(null);

    // Build recipient list based on the toggle.
    // Ops always gets it. Broker only when crew explicitly opts in.
    const brokerEmails = notifyBroker
      ? (brokerEmail || '')
          .split(/[,;\s]+/)
          .map(e => e.trim())
          .filter(e => e.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      : [];
    const recipients = [opsEmail, ...brokerEmails].filter(Boolean);
    if (recipients.length === 0) {
      setResult({ ok: false, msg: 'No valid recipients. Ops email is missing — contact admin.' });
      setSending(false);
      return;
    }

    const tail = trip.info.tail || '';
    const route = `${trip.info.from || ''}-${trip.info.to || ''}`;
    // Greeting: when broker is notified, address them; when ops-only, keep it neutral
    const greeting = notifyBroker && brokerEmails[0]
      ? `Hi ${greetingFromEmail(brokerEmails[0])},`
      : `Ops,`;
    const signature = '\n\n— Skyway Aviation\nPrivate Jet & Helicopter Charter Services';

    const lines = [
      `${greeting}`,
      ``,
      notifyBroker
        ? `We are writing to inform you of a delay for ${tail} ${route}.`
        : `Internal delay notification for ${tail} ${route}. Broker has NOT been notified.`,
      ``,
      `Reason: ${reason.trim()}`,
    ];
    if (delayDuration.trim()) lines.push(`Estimated delay: ${delayDuration.trim()}`);
    if (newEtd.trim())        lines.push(`New estimated time of departure: ${newEtd.trim()}`);
    if (paxArrivalTime.trim()) lines.push(`Requested passenger arrival time: ${paxArrivalTime.trim()}`);
    lines.push(``);
    lines.push(notifyBroker
      ? `We will keep you informed as the situation develops.`
      : `Reported by ${currentUser?.name || 'crew'}. Coordinate broker comms separately.`);
    const body = lines.join('\n') + signature;

    try {
      const r = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: recipients,
          subject: notifyBroker
            ? `Flight Delay — ${tail} ${route}`
            : `[INTERNAL] Flight Delay — ${tail} ${route}`,
          text: body,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setResult({ ok: false, msg: `Send failed: ${data.error || r.status}` });
        return;
      }

      // Log a delay event to the trip's status timeline
      const delayEvent = {
        timestamp: Date.now(),
        coords: null,
        author: currentUser?.name || 'Unknown',
        notified: true,
        notifyBroker, // record whether broker was looped in
        reason: reason.trim(),
        delayDuration: delayDuration.trim() || null,
        newEtd: newEtd.trim() || null,
        paxArrivalTime: paxArrivalTime.trim() || null,
      };
      const eventKey = `delay_reported_${delayEvent.timestamp}`;
      const nextStatuses = { ...statuses, [eventKey]: delayEvent };
      setStatuses(nextStatuses);
      await persist({ statuses: nextStatuses, passengers, brokerEmail, autoNotify, completed, hasCatering, paxOverride });

      const recipientCount = recipients.length;
      setResult({
        ok: true,
        msg: notifyBroker
          ? `Delay sent to ops + broker (${recipientCount} recipient${recipientCount === 1 ? '' : 's'}).`
          : `Delay sent to ops only. Broker NOT notified.`,
      });
      setReason('');
      setDelayDuration('');
      setNewEtd('');
      setPaxArrivalTime('');
    } catch (err) {
      console.error('[delay] send failed:', err);
      setResult({ ok: false, msg: 'Network error: ' + err.message });
    } finally {
      setSending(false);
    }
  };

  // List previous delays for this trip
  const previousDelays = Object.entries(statuses || {})
    .filter(([k]) => k.startsWith('delay_reported_'))
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="space-y-4">
      <div className="border border-amber-500/30 bg-amber-500/5 p-3">
        <h3 className="text-sm tracking-widest text-amber-300 mb-1" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
          REPORT FLIGHT DELAY
        </h3>
        <p className="text-xs text-slate-400">
          Sends an email to broker + ops with the delay information and logs it on this trip's timeline.
        </p>
      </div>

      <label className="block">
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          REASON FOR DELAY <span className="text-red-400">*</span>
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Weather hold at departure, crew rest required, mechanical inspection..."
          rows={3}
          className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-amber-400"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        />
      </label>

      <label className="block">
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          ESTIMATED DELAY DURATION
        </span>
        <input
          type="text"
          value={delayDuration}
          onChange={(e) => setDelayDuration(e.target.value)}
          placeholder="e.g. 2 hours, 30 minutes"
          className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-amber-400"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        />
      </label>

      <label className="block">
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          NEW ESTIMATED TIME OF DEPARTURE (ETD)
        </span>
        <input
          type="text"
          value={newEtd}
          onChange={(e) => setNewEtd(e.target.value)}
          placeholder="e.g. 14:30 local, 1430Z"
          className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-amber-400"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        />
      </label>

      <label className="block">
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          REQUESTED PASSENGER ARRIVAL TIME
        </span>
        <input
          type="text"
          value={paxArrivalTime}
          onChange={(e) => setPaxArrivalTime(e.target.value)}
          placeholder="e.g. 14:00 local"
          className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-amber-400"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        />
      </label>

      {result && (
        <div className={`p-3 border text-xs ${result.ok ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300' : 'border-red-500/40 bg-red-500/5 text-red-300'}`}>
          {result.msg}
        </div>
      )}

      {/* Notify broker toggle */}
      <div className="border border-slate-700 bg-slate-900/40 p-3">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={notifyBroker}
            onChange={(e) => setNotifyBroker(e.target.checked)}
            className="mt-0.5 w-4 h-4 cursor-pointer accent-amber-500"
          />
          <div className="flex-1">
            <div className="text-xs tracking-widest text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              ALSO NOTIFY BROKER
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              {notifyBroker
                ? `Broker(s) will receive the delay email along with ops.`
                : `Only ops will be notified. Useful when delay needs to be coordinated internally before broker is told.`}
            </div>
            {notifyBroker && !brokerEmail && (
              <div className="text-[11px] text-amber-300 mt-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                ⚠ No broker email on file for this trip — toggle will only send to ops.
              </div>
            )}
          </div>
        </label>
      </div>

      <button
        onClick={send}
        disabled={sending || !reason.trim()}
        className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-medium tracking-widest disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      >
        {sending
          ? 'SENDING...'
          : notifyBroker
            ? 'SEND DELAY → OPS + BROKER'
            : 'SEND DELAY → OPS ONLY'}
      </button>

      {/* Previous delays for this trip */}
      {previousDelays.length > 0 && (
        <div className="pt-4 border-t border-slate-800">
          <h4 className="text-[10px] tracking-widest text-slate-500 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            PREVIOUS DELAYS · {previousDelays.length}
          </h4>
          <div className="space-y-2">
            {previousDelays.map(d => (
              <div key={d.key} className="border border-slate-800 bg-slate-900/40 p-3 text-xs space-y-1">
                <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {new Date(d.timestamp).toLocaleString()} · by {d.author}
                </div>
                <div className="text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  {d.reason}
                </div>
                {(d.delayDuration || d.newEtd || d.paxArrivalTime) && (
                  <div className="text-[11px] text-slate-400 space-y-0.5">
                    {d.delayDuration && <div>Duration: <span className="text-slate-200">{d.delayDuration}</span></div>}
                    {d.newEtd && <div>New ETD: <span className="text-slate-200">{d.newEtd}</span></div>}
                    {d.paxArrivalTime && <div>Pax arrival: <span className="text-slate-200">{d.paxArrivalTime}</span></div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NotifyPanel({ trip, opsEmail, brokerEmail, setBrokerEmail, statuses, autoNotify, setAutoNotify, hasCatering, setHasCatering }) {
  const [customMsg, setCustomMsg] = useState('');
  const lastStatus = useMemo(() => {
    const ordered = STATUS_STEPS.map(s => ({ step: s, status: statuses[s.id] })).filter(x => x.status);
    return ordered[ordered.length - 1];
  }, [statuses]);

  const buildBody = (eventLabel) => {
    const lines = [
      `${trip.info.tail} · ${trip.info.from} → ${trip.info.to}`,
      `${trip.info.legType} · ${trip.info.pax} PAX`,
      `Scheduled: ${fmtDateZ(trip.start)} ${fmtZulu(trip.start)}`,
      ``,
      `STATUS UPDATE: ${eventLabel}`,
      `Time: ${fmtZulu(new Date())} (${new Date().toUTCString()})`,
    ];
    if (customMsg) lines.push('', `Note: ${customMsg}`);
    lines.push('', '— Sent from Part 135 Ops Console');
    return lines.join('\n');
  };

  const sendEmail = (label) => {
    const recipients = [brokerEmail, opsEmail].filter(Boolean).join(',');
    if (!recipients) return;
    const subject = `[${trip.info.tail}] ${label} — ${trip.info.from}-${trip.info.to}`;
    const body = buildBody(label);
    const url = `mailto:${recipients}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <label className="block">
          <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>BROKER EMAIL(S)</span>
          <input
            type="text"
            value={brokerEmail}
            onChange={e => setBrokerEmail(e.target.value)}
            placeholder="broker@charterco.com, ops@flightsupport.com"
            className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          />
          <span className="text-[10px] text-slate-500 mt-1 block" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            Separate multiple addresses with commas. Status emails go to all of them plus the ops email.
          </span>
        </label>
        <div className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          OPS EMAIL: <span className="text-slate-300">{opsEmail || 'not configured'}</span>
        </div>
      </div>

      <label className="flex items-start gap-3 p-3 border border-slate-700 bg-slate-900/40 cursor-pointer hover:border-cyan-500/40">
        <input
          type="checkbox"
          checked={autoNotify}
          onChange={e => setAutoNotify(e.target.checked)}
          className="mt-0.5 accent-cyan-400"
        />
        <div>
          <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>AUTO-NOTIFY ON STATUS</div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            When enabled, tapping any status button opens an email draft to broker + ops with the event details.
          </p>
        </div>
      </label>

      {trip.info.legType === 'REVENUE' && (
        <label className="flex items-start gap-3 p-3 border border-slate-700 bg-slate-900/40 cursor-pointer hover:border-amber-500/40">
          <input
            type="checkbox"
            checked={hasCatering}
            onChange={e => setHasCatering(e.target.checked)}
            className="mt-0.5 accent-amber-400"
          />
          <div>
            <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>CATERING ON THIS TRIP</div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Uncheck if no catering is loaded — removes the CATERING ON BOARD step from the status checklist for this trip.
            </p>
          </div>
        </label>
      )}

      <label className="block">
        <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>OPTIONAL NOTE</span>
        <textarea
          value={customMsg}
          onChange={e => setCustomMsg(e.target.value)}
          rows={2}
          placeholder="Additional context for the next notification..."
          className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400 resize-none"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        />
      </label>

      <div className="border-t border-slate-800 pt-4">
        <div className="text-[10px] tracking-widest text-slate-500 uppercase mb-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>MANUAL DISPATCH</div>
        <div className="grid grid-cols-1 gap-2">
          {STATUS_STEPS.filter(s =>
            s.applies.includes(trip.info.legType) &&
            (s.id !== 'catering_aboard' || hasCatering)
          ).map(step => (
            <button
              key={step.id}
              onClick={() => sendEmail(step.label)}
              disabled={!brokerEmail && !opsEmail}
              className="flex items-center justify-between gap-2 px-3 py-2 border border-slate-700 hover:border-cyan-400 hover:bg-cyan-500/5 disabled:opacity-40 disabled:cursor-not-allowed text-left text-sm text-slate-200 transition-colors"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              <span className="flex items-center gap-2">
                <step.icon className="w-3.5 h-3.5 text-cyan-400" /> {step.label}
              </span>
              <Mail className="w-3.5 h-3.5 text-slate-500" />
            </button>
          ))}
        </div>
      </div>

      {lastStatus && (
        <div className="p-3 border border-slate-700 bg-slate-900/40">
          <div className="text-[10px] tracking-widest text-slate-500 uppercase mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>LAST EVENT</div>
          <div className="text-sm text-slate-200">{lastStatus.step.label}</div>
          <div className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {fmtZulu(new Date(lastStatus.status.timestamp))} · {fmtDateZ(new Date(lastStatus.status.timestamp))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Trip detail view
   ============================================================ */
function TripDetail({ trip, currentUser, currentUserDisplayName, allTrips, opsEmail, onBack, onArchive }) {
  const [tab, setTab] = useState(trip.info.isOps ? 'status' : 'chat');
  const [statuses, setStatuses] = useState({});
  const [passengers, setPassengers] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [brokerEmail, setBrokerEmail] = useState(trip.info.broker || '');
  const [autoNotify, setAutoNotify] = useState(false);
  const [hasCatering, setHasCatering] = useState(true);
  const [paxOverride, setPaxOverride] = useState(null);
  const [completed, setCompleted] = useState(false);
  const [tripSheetUrl, setTripSheetUrl] = useState(null);
  const [tripSheetPath, setTripSheetPath] = useState(null);
  const [tripSheetFilename, setTripSheetFilename] = useState(null);
  const [tripSheetUploadedAt, setTripSheetUploadedAt] = useState(null);
  const [tripSheetUploadedBy, setTripSheetUploadedBy] = useState(null);
  const [preloadedPax, setPreloadedPax] = useState([]);
  const [tripSheetNotes, setTripSheetNotes] = useState(null);
  const [pendingScanPax, setPendingScanPax] = useState(null); // pre-loaded pax being checked in
  const [loading, setLoading] = useState(true);
  // UPDATE ETA flow: tracks whether we're mid-call so we can disable the button
  // and show a small spinner. Result message shows briefly after success/fail.
  const [updatingEta, setUpdatingEta] = useState(false);
  const [etaResult, setEtaResult] = useState(null); // { ok: bool, msg: string }
  const geo = useGeolocation();

  // Reset tab when switching trips
  useEffect(() => {
    setTab(trip.info.isOps ? 'status' : 'chat');
  }, [trip.uid, trip.info.isOps]);

  // Clear the UPDATE ETA result banner when switching trips so the message
  // doesn't leak across trip cards. Also auto-dismiss after 10s.
  useEffect(() => {
    setEtaResult(null);
    setUpdatingEta(false);
  }, [trip.uid]);

  useEffect(() => {
    if (!etaResult) return;
    const t = setTimeout(() => setEtaResult(null), 10000);
    return () => clearTimeout(t);
  }, [etaResult]);

  // Subscribe to trip state in Firebase — real-time updates from all users
  useEffect(() => {
    setLoading(true);
    let unsub = null;
    (async () => {
      try {
        const { subscribeToTripState } = await import('./firebase-data.js');
        unsub = subscribeToTripState(trip.uid, (state) => {
          setStatuses(state.statuses);
          setPassengers(state.passengers);
          setBrokerEmail(state.brokerEmail || trip.info.broker || '');
          setAutoNotify(state.autoNotify);
          setHasCatering(state.hasCatering !== false);
          setPaxOverride(typeof state.paxOverride === 'number' ? state.paxOverride : null);
          setTripSheetUrl(state.tripSheetUrl || null);
          setTripSheetPath(state.tripSheetPath || null);
          setTripSheetFilename(state.tripSheetFilename || null);
          setTripSheetUploadedAt(state.tripSheetUploadedAt || null);
          setTripSheetUploadedBy(state.tripSheetUploadedBy || null);
          setPreloadedPax(Array.isArray(state.preloadedPax) ? state.preloadedPax : []);
          setTripSheetNotes(state.tripSheetNotes || null);
          setCompleted(state.completed === true);
          setLoading(false);
        });
      } catch (err) {
        console.error('Failed to subscribe to trip state:', err);
        setLoading(false);
      }
    })();
    return () => { if (unsub) unsub(); };
  }, [trip.uid, trip.info.broker]);

  // Persist on change — writes to Firebase, real-time listener picks it up everywhere
  // Auto-merges trip-sheet fields from current state since they're mostly read-only
  // from this component's perspective (set by TripSheetPanel via attachTripSheetToLeg).
  const persist = useCallback(async (next) => {
    try {
      const { saveTripState } = await import('./firebase-data.js');
      // tripMeta is what the FlightAware webhook uses to match incoming events
      // to this specific trip-state doc. Without it, auto-fire/auto-email can't
      // work — trip-state UIDs are opaque hashes that contain no route info.
      const tripMeta = {
        tail: (trip.info?.tail || '').toUpperCase(),
        from: (trip.info?.from || '').toUpperCase(),
        to: (trip.info?.to || '').toUpperCase(),
        start: trip.start instanceof Date ? trip.start.toISOString() : (trip.start || null),
        legType: trip.info?.legType || 'REVENUE',
      };
      // Merge in trip-sheet fields and preloadedPax unless caller passed them explicitly
      const merged = {
        tripSheetUrl,
        tripSheetPath,
        tripSheetFilename,
        tripSheetUploadedAt,
        tripSheetUploadedBy,
        preloadedPax,
        tripSheetNotes,
        tripMeta,
        ...next,
      };
      await saveTripState(trip.uid, merged);
    } catch (err) {
      console.error('Failed to save trip state:', err);
      alert('Failed to save — check your connection');
    }
  }, [trip.uid, trip.info?.tail, trip.info?.from, trip.info?.to, trip.start, trip.info?.legType, tripSheetUrl, tripSheetPath, tripSheetFilename, tripSheetUploadedAt, tripSheetUploadedBy, preloadedPax, tripSheetNotes]);

  const openMailto = (url) => {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const updateStatus = async (step, gpsCoords, sendNotif) => {
    const newStatus = {
      timestamp: Date.now(),
      coords: gpsCoords || null,
      author: currentUserDisplayName || (currentUser?.name || 'Unknown'),
      notified: false, // set to true only after email actually sends
    };
    const nextStatuses = { ...statuses, [step.id]: newStatus };
    setStatuses(nextStatuses);
    await persist({ statuses: nextStatuses, passengers, brokerEmail, autoNotify, completed, hasCatering, paxOverride });

    console.log('[email] updateStatus fired for step:', step.id, '· legType:', trip.info?.legType, '· autoNotify:', autoNotify, '· sendNotif:', sendNotif);

    // Parse broker email field — supports comma-separated list of recipients
    // (e.g. "broker@x.com, ops@flightsupport.com")
    const brokerEmails = (brokerEmail || '')
      .split(/[,;\s]+/)
      .map(e => e.trim())
      .filter(e => e.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

    // Auto-send email on every status update
    const recipients = [opsEmail, ...brokerEmails]
      .filter(Boolean)
      .map(e => e.trim())
      .filter(e => e.length > 0);

    console.log('[email] recipients:', recipients, '· opsEmail:', opsEmail, '· brokerEmails:', brokerEmails);

    if (recipients.length === 0) {
      console.warn('[email] Skipping send — no valid recipients. opsEmail:', opsEmail || '(empty)', 'brokerEmail:', brokerEmail || '(empty)');
      return;
    }

    // Use first broker email for the "Hi [Name]" greeting
    const emailContent = buildStatusEmail(step, trip, brokerEmails[0] || '');
    if (!emailContent) {
      console.warn('[email] No email template for step:', step.id, '· legType:', trip.info?.legType);
      return;
    }

    try {
      console.log('[email] Sending to:', recipients.join(', '), '· subject:', emailContent.subject);
      const r = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: recipients,
          subject: emailContent.subject,
          text: emailContent.text,
        }),
      });
      const respData = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('[email] Send failed:', r.status, respData.error || '', respData);
        return;
      }
      // Email sent successfully — mark notified=true now
      const updatedStatuses = { ...nextStatuses, [step.id]: { ...newStatus, notified: true } };
      setStatuses(updatedStatuses);
      await persist({ statuses: updatedStatuses, passengers, brokerEmail, autoNotify, completed, hasCatering, paxOverride });
      console.log('[email] Sent successfully · resend id:', respData.id || '(no id)');
    } catch (err) {
      console.error('[email] Network error:', err);
    }
  };

  // === Update ETA flow ===
  // Fetches the current FlightAware position for this trip's tail and emails
  // all broker emails with the latest estimated arrival time. Ops/admin only.
  // Always sends the email regardless of whether ETA differs from scheduled.
  const handleUpdateEta = async () => {
    if (updatingEta) return;
    const tail = (trip.info?.tail || '').toUpperCase();
    if (!tail) {
      setEtaResult({ ok: false, msg: 'No tail number on this trip.' });
      return;
    }
    const brokerEmails = (brokerEmail || '')
      .split(/[,;\s]+/)
      .map(e => e.trim())
      .filter(e => e.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (brokerEmails.length === 0) {
      setEtaResult({ ok: false, msg: 'No broker email on this trip.' });
      return;
    }

    setUpdatingEta(true);
    setEtaResult(null);

    try {
      // 1. Get a fresh idToken for the position endpoint
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser.getIdToken();

      // 2. Fetch current position for this single tail
      const r = await fetch('/api/flightaware-positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, idents: [tail] }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Position fetch failed (${r.status}): ${t.slice(0, 200)}`);
      }
      const data = await r.json();
      const pos = Array.isArray(data.positions) ? data.positions.find(p => p.ident === tail) : null;
      if (!pos) {
        throw new Error(`No FlightAware data returned for ${tail}.`);
      }
      if (!pos.airborne) {
        setEtaResult({ ok: false, msg: `${tail} is not currently airborne — no live ETA available.` });
        setUpdatingEta(false);
        return;
      }

      // 3. Format the times
      const etaIso = pos.estimatedOn || null;
      if (!etaIso) {
        throw new Error(`FlightAware has no ETA yet for ${tail}.`);
      }
      const etaDate = new Date(etaIso);
      const schedDate = trip.arr instanceof Date ? trip.arr : (trip.arr ? new Date(trip.arr) : null);
      const fmt = (d) => {
        try {
          return d.toLocaleString('en-US', {
            hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
          });
        } catch { return d.toISOString(); }
      };
      const etaStr = fmt(etaDate);
      const schedStr = schedDate ? fmt(schedDate) : null;

      // 4. Build and send email
      const tailLabel = tail;
      const dest = (trip.info?.to || pos.destination || '').toUpperCase();
      const fromAirport = (trip.info?.from || pos.origin || '').toUpperCase();
      const greetingName = brokerEmails[0].split('@')[0].split('.')[0];
      const greeting = greetingName ? `Hi ${greetingName.charAt(0).toUpperCase() + greetingName.slice(1)},` : 'Hello,';
      const signature = '\n\n— Skyway Aviation\nPrivate Jet & Helicopter Charter Services';
      const subject = `Updated ETA — ${tailLabel} ${fromAirport}-${dest}`;
      const bodyLines = [
        greeting,
        '',
        `The estimated arrival time for ${tailLabel} at ${dest} has been updated based on the latest flight tracking.`,
        '',
        `New ETA: ${etaStr}`,
      ];
      if (schedStr) bodyLines.push(`Originally scheduled: ${schedStr}`);
      bodyLines.push('');
      bodyLines.push('We will continue to keep you informed.');
      const text = bodyLines.join('\n') + signature;

      const sendR = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: brokerEmails, subject, text }),
      });
      const sendData = await sendR.json().catch(() => ({}));
      if (!sendR.ok) {
        throw new Error(`Email send failed: ${sendData.error || sendR.status}`);
      }
      setEtaResult({ ok: true, msg: `ETA emailed to ${brokerEmails.join(', ')} — New ETA ${etaStr}` });
    } catch (err) {
      console.error('[update-eta] error:', err);
      setEtaResult({ ok: false, msg: err.message || 'Failed to update ETA.' });
    } finally {
      setUpdatingEta(false);
    }
  };

  const handleStatusTrigger = async (step) => {
    let gpsCoords = null;
    if (step.requiresGPS) {
      try {
        gpsCoords = await geo.request();
      } catch (e) {
        const proceed = window.confirm(
          `GPS unavailable: ${e.message}\n\nLog ${step.label} without GPS coordinates?`
        );
        if (!proceed) return;
      }
    } else if (geo.coords) {
      gpsCoords = geo.coords;
    }
    await updateStatus(step, gpsCoords, autoNotify);
  };

  const handleStatusUntrigger = async (step) => {
    // Remove the status from the timeline
    const nextStatuses = { ...statuses };
    delete nextStatuses[step.id];
    setStatuses(nextStatuses);
    await persist({ statuses: nextStatuses, passengers, brokerEmail, autoNotify, completed, hasCatering, paxOverride });
  };

  const addPassenger = async (pax) => {
    setScanning(false);
    // Pre-loaded check-in: pax was confirmed by photo + crew checkbox in the
    // panel. The trip-sheet name carries through (no AI parsing, no name
    // comparison). Stamp audit fields and link to the preloaded entry.
    if (pendingScanPax) {
      const target = pendingScanPax;
      setPendingScanPax(null);
      const newPax = {
        ...pax,
        // pax.id was already set by IDCheckInPanel so the Storage path
        // matches the pax record. Keep that id.
        id: pax.id,
        preloadedRefId: target.id,
        verifiedBy: currentUser?.name || currentUser?.email || 'unknown',
        verifiedAt: Date.now(),
        scannedAt: Date.now(),
      };
      const nextPassengers = [...passengers, newPax];
      const nextPreloaded = preloadedPax.map(p =>
        p.id === target.id
          ? { ...p, scannedPaxId: newPax.id, checkInStatus: 'matched' }
          : p
      );
      setPassengers(nextPassengers);
      setPreloadedPax(nextPreloaded);
      await persist({
        statuses, passengers: nextPassengers, brokerEmail, autoNotify, completed,
        hasCatering, paxOverride, preloadedPax: nextPreloaded,
      });
      return;
    }

    // Walk-up: not on the trip sheet. Stamp audit fields and add.
    const newPax = {
      ...pax,
      id: pax.id,
      verifiedBy: currentUser?.name || currentUser?.email || 'unknown',
      verifiedAt: Date.now(),
      scannedAt: Date.now(),
    };
    const next = [...passengers, newPax];
    setPassengers(next);
    await persist({ statuses, passengers: next, brokerEmail, autoNotify, completed, hasCatering, paxOverride });
  };

  const removePassenger = async (id) => {
    const next = passengers.filter(p => p.id !== id);
    setPassengers(next);
    await persist({ statuses, passengers: next, brokerEmail, autoNotify, completed, hasCatering, paxOverride });
  };

  // Toggle a passenger's no-show flag. Keeps the record (chain of custody)
  // but excludes them from active count and verified totals.
  const toggleNoShow = async (id) => {
    const next = passengers.map(p =>
      p.id === id ? { ...p, noShow: !p.noShow, noShowAt: !p.noShow ? Date.now() : null } : p
    );
    setPassengers(next);
    await persist({ statuses, passengers: next, brokerEmail, autoNotify, completed, hasCatering, paxOverride });
  };

  // Quick-add a CHILD or PASSPORT passenger (no ID scan).
  const addQuickPax = async (paxType, firstName, lastName) => {
    const pax = {
      id: `pax-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      firstName: (firstName || '').trim(),
      lastName: (lastName || '').trim(),
      dob: '',
      expiration: '',
      licenseNumber: '',
      state: '',
      realIdCompliant: false,
      expired: false,
      photo: null,
      scannedAt: Date.now(),
      method: paxType, // 'CHILD' or 'PASSPORT'
      paxType,        // same value, used for verification logic
      noShow: false,
    };
    const next = [...passengers, pax];
    setPassengers(next);
    await persist({ statuses, passengers: next, brokerEmail, autoNotify, completed, hasCatering, paxOverride });
  };

  // Override the trip's expected pax count (e.g. someone didn't show).
  // Pass null to clear the override and revert to iCal value.
  const updatePaxOverride = async (val) => {
    setPaxOverride(val);
    await persist({ statuses, passengers, brokerEmail, autoNotify, completed, hasCatering, paxOverride: val });
  };

  // Begin checking in a pre-loaded pax. If they're a minor by DOB, skip the
  // ID scan entirely and add them as a verified child. Otherwise open scanner.
  const startPreloadedCheckIn = async (preloadPax) => {
    // Minor check first — federal rules don't require ID for under-18 on private charter
    if (isMinorFromDob(preloadPax.dob)) {
      const age = computeAgeFromDob(preloadPax.dob);
      const proceed = window.confirm(
        `${preloadPax.firstName} ${preloadPax.lastName} is ${age} years old (DOB ${preloadPax.dob}).\n\n` +
        `Children under 18 don't require ID. Add to manifest as a verified child?`
      );
      if (!proceed) return;
      // Build a child passenger record with name from the trip sheet
      const newPax = {
        id: `pax-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        firstName: preloadPax.firstName,
        lastName: preloadPax.lastName,
        dob: preloadPax.dob,
        expiration: '',
        licenseNumber: '',
        state: '',
        realIdCompliant: false,
        expired: false,
        photo: null,
        scannedAt: Date.now(),
        method: 'CHILD_AUTO',
        paxType: 'CHILD',
        noShow: false,
        preloadedRefId: preloadPax.id,
      };
      const nextPassengers = [...passengers, newPax];
      const nextPreloaded = preloadedPax.map(p =>
        p.id === preloadPax.id
          ? { ...p, scannedPaxId: newPax.id, checkInStatus: 'child_verified' }
          : p
      );
      setPassengers(nextPassengers);
      setPreloadedPax(nextPreloaded);
      await persist({
        statuses, passengers: nextPassengers, brokerEmail, autoNotify, completed,
        hasCatering, paxOverride, preloadedPax: nextPreloaded,
      });
      return;
    }
    // Adult — open the scanner with target name
    setPendingScanPax(preloadPax);
    setScanning(true);
  };

  // Toggle skip status on a preloaded pax. Doesn't add to passengers[],
  // just flags this pre-loaded entry as 'skipped'.
  const togglePreloadedSkip = async (preloadPax) => {
    const next = preloadedPax.map(p =>
      p.id === preloadPax.id
        ? {
            ...p,
            checkInStatus: p.checkInStatus === 'skipped' ? 'pending' : 'skipped',
          }
        : p
    );
    setPreloadedPax(next);
    await persist({
      statuses, passengers, brokerEmail, autoNotify, completed, hasCatering, paxOverride,
      preloadedPax: next,
    });
  };

  // Clear trip sheet from this leg only (pre-loaded pax cleared, scanned pax preserved).
  const clearTripSheet = async () => {
    try {
      const { attachTripSheetToLeg } = await import('./firebase-data.js');
      await attachTripSheetToLeg({ tripUid: trip.uid, clear: true });
    } catch (err) {
      console.error('Failed to clear trip sheet:', err);
      alert('Failed to clear — check your connection');
    }
  };

  const updateBroker = async (email) => {
    setBrokerEmail(email);
    await persist({ statuses, passengers, brokerEmail: email, autoNotify, completed, hasCatering, paxOverride });
  };
  const updateAutoNotify = async (val) => {
    setAutoNotify(val);
    await persist({ statuses, passengers, brokerEmail, autoNotify: val, completed, hasCatering, paxOverride });
  };
  const updateHasCatering = async (val) => {
    setHasCatering(val);
    // If turning OFF catering and the catering step was already marked done,
    // remove the status entry so the timeline stays accurate.
    let nextStatuses = statuses;
    if (!val && statuses['catering_aboard']) {
      nextStatuses = { ...statuses };
      delete nextStatuses['catering_aboard'];
      setStatuses(nextStatuses);
    }
    await persist({ statuses: nextStatuses, passengers, brokerEmail, autoNotify, completed, hasCatering: val, paxOverride });
  };

  const applicableSteps = STATUS_STEPS.filter(s =>
    s.applies.includes(trip.info.legType) &&
    (s.id !== 'catering_aboard' || hasCatering)
  );
  const completedCount = applicableSteps.filter(s => statuses[s.id]).length;
  const nextStep = applicableSteps.find(s => !statuses[s.id]);
  // Effective pax count: crew-overridden value if set, otherwise iCal value
  // Helper: parse JetInsight DOB string (e.g. "1/21/68") and compute age in years.
  // Returns null if unparseable. 2-digit year heuristic: 00-30 → 2000s, 31-99 → 1900s.
  const computeAgeFromDob = (dobStr) => {
    if (!dobStr) return null;
    const m = String(dobStr).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += year > 30 ? 1900 : 2000;
    const dob = new Date(year, month, day);
    if (isNaN(dob.getTime())) return null;
    const ms = Date.now() - dob.getTime();
    return Math.floor(ms / (365.25 * 24 * 3600 * 1000));
  };
  const isMinorFromDob = (dobStr) => {
    const age = computeAgeFromDob(dobStr);
    return age !== null && age < 18;
  };

  const effectivePax = paxOverride !== null ? paxOverride : (trip.info.pax || 0);
  // Active passengers = anyone in the manifest who hasn't been marked NO SHOW
  const activePassengers = passengers.filter(p => !p.noShow);
  // Verified = any active passenger who's been added to the manifest by ANY path.
  // The act of crew adding them = chain of custody. We don't gate on REAL ID
  // compliance because (a) not all valid IDs are REAL ID, (b) photo-only / child /
  // passport are all valid alternatives. If a pax is in the manifest and not a
  // no-show, they're verified.
  const compliantPax = activePassengers.length;
  // Active preloaded pax (from trip sheet, not yet checked in OR checked in).
  // A preloaded pax counts toward verified once their checkInStatus is anything
  // other than 'pending' or 'skipped' (matched / manual_override / mismatch
  // all mean crew has acted on them).
  const preloadedActive = preloadedPax.filter(p => p.checkInStatus !== 'skipped');
  const preloadedVerified = preloadedPax.filter(p =>
    p.checkInStatus === 'matched' ||
    p.checkInStatus === 'manual_override' ||
    p.checkInStatus === 'mismatch' ||
    // Children are auto-verified by DOB — no scan required
    (p.checkInStatus === 'child_verified')
  ).length;
  // Pax tab progression: complete when (verified scanned pax + verified preloaded pax) >= expected count
  // OR if there are no preloaded pax and the manifest is full
  const totalVerified = preloadedActive.length > 0 ? preloadedVerified : compliantPax;
  const totalExpected = preloadedActive.length > 0 ? preloadedActive.length : effectivePax;
  const paxComplete = totalExpected === 0 || totalVerified >= totalExpected;

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Trip header */}
      <div className="px-6 py-5 border-b border-slate-800 bg-gradient-to-b from-slate-900/50 to-transparent">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-slate-500 hover:text-slate-300 text-sm md:hidden"
          >
            <ChevronLeft className="w-4 h-4" /> Trips
          </button>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            {completed && (
              <Pill tone="green">
                <CheckCheck className="w-3 h-3 inline mr-0.5" /> COMPLETE
              </Pill>
            )}
            <Pill tone={(CATEGORY_META[trip.info.category] || CATEGORY_META.REPO).tone}>
              {(CATEGORY_META[trip.info.category] || CATEGORY_META.REPO).label}
            </Pill>
            {trip.info.isOps && (
              <Pill tone={completedCount === applicableSteps.length ? 'green' : 'neutral'}>
                {completedCount}/{applicableSteps.length} STEPS
              </Pill>
            )}
            {trip.info.url && (
              <a
                href={trip.info.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] border border-slate-700 text-slate-400 hover:text-cyan-300 hover:border-cyan-500/40"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                JETINSIGHT ↗
              </a>
            )}
            {/* UPDATE ETA — ops/admin only. Fetches current FlightAware ETA
                and emails it to all broker emails on the trip. Shows result
                inline. Works only when aircraft is actually airborne (the
                handler validates and shows a message otherwise). */}
            {(currentUser?.role === 'ops' || currentUser?.role === 'admin') && trip.info?.tail && brokerEmail && (
              <button
                onClick={handleUpdateEta}
                disabled={updatingEta}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] border border-slate-700 text-slate-400 hover:text-cyan-300 hover:border-cyan-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                title={`Send current ETA to broker via FlightAware`}
              >
                {updatingEta ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    SENDING...
                  </>
                ) : (
                  <>UPDATE ETA</>
                )}
              </button>
            )}
            <button
              onClick={async () => {
                const next = !completed;
                if (next && !window.confirm('Mark this trip as complete? It will move to ARCHIVE and add a leg to the daily Load Manifest.')) return;
                if (!next && !window.confirm('Reopen this trip? It will return to the active schedule.')) return;
                setCompleted(next);
                await persist({
                  statuses, passengers, brokerEmail, autoNotify,
                  completed: next,
                  completedAt: next ? Date.now() : null,
                  archived: next,
                  archivedAt: next ? Date.now() : null,
                  hasCatering,
                  paxOverride,
                });
                // Optimistically update the parent's tripArchived state so the
                // schedule re-categorizes this trip immediately (otherwise we'd
                // wait for the next polling cycle to pick up archived=true).
                if (onArchive) onArchive(trip.uid, next);
                // When marking complete, drop back to the list so the user
                // doesn't sit on a now-archived trip detail.
                if (next && onBack) onBack();
                // Auto-add this completed leg to the daily manifest, but only
                // if it's an actual flying leg (skip CREW HOTEL, MX, HOLD).
                if (next && trip.info?.isFlight) {
                  try {
                    const m = await import('./firebase-manifests.js');
                    const manifestIdResult = await m.autoAddTripToManifest({
                      trip,
                      preloadedPax,
                      addedBy: currentUser?.name || 'auto',
                    });
                    if (manifestIdResult) {
                      console.log('[manifest] leg auto-added to', manifestIdResult);
                    }
                  } catch (err) {
                    console.error('[manifest] auto-add failed:', err);
                  }
                }
              }}
              className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] border ${
                completed
                  ? 'border-slate-600 text-slate-400 hover:text-amber-300 hover:border-amber-500/40'
                  : 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
              }`}
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {completed ? 'Reopen' : 'Mark Complete'}
            </button>
          </div>
        </div>

        {/* Result banner for UPDATE ETA action. Shown briefly after success/fail. */}
        {etaResult && (
          <div
            className={`mb-2 px-3 py-2 text-xs border ${etaResult.ok ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/5' : 'border-amber-500/40 text-amber-300 bg-amber-500/5'}`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <div className="flex items-start justify-between gap-3">
              <span>{etaResult.msg}</span>
              <button
                onClick={() => setEtaResult(null)}
                className="text-slate-500 hover:text-slate-300"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}

        <div className="flex items-baseline gap-4 flex-wrap">
          <h1
            className="text-3xl md:text-4xl tracking-wide text-slate-100"
            style={{ fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.05em' }}
          >
            {trip.info.tail}
          </h1>
          <div className="flex items-center gap-2 text-xl text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <span>{trip.info.from}</span>
            <ArrowRight className="w-5 h-5 text-cyan-400" />
            <span>{trip.info.to}</span>
          </div>
        </div>

        {trip.info.customer && (
          <div className="mt-1 text-sm text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {trip.info.customer}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-2 text-xs text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <span className="flex items-center gap-1.5">
            <Clock className="w-3 h-3" />
            <span>DEP {(() => {
              const t = formatLocalTime(trip.start, trip.info.from);
              return `${t.time} ${t.tz}`;
            })()}</span>
          </span>
          {trip.end && (
            <span className="flex items-center gap-1.5">
              <span>ARR {(() => {
                const t = formatLocalTime(trip.end, trip.info.to);
                return `${t.time} ${t.tz}`;
              })()}</span>
            </span>
          )}
          <span className="flex items-center gap-1.5"><Calendar className="w-3 h-3" /> {formatLocalDate(trip.start, trip.info.from) || fmtDateZ(trip.start)}</span>
          <span className="flex items-center gap-1.5"><Users className="w-3 h-3" /> {trip.info.pax} PAX</span>
        </div>

        {(trip.info.pic || trip.info.sic) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs">
            {trip.info.pic && (
              <span className="flex items-center gap-1.5">
                <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PIC</span>
                <span className="text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>{trip.info.pic}</span>
              </span>
            )}
            {trip.info.sic && (
              <span className="flex items-center gap-1.5">
                <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>SIC</span>
                <span className="text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>{trip.info.sic}</span>
              </span>
            )}
          </div>
        )}

        {trip.info.notes && (
          <div className="mt-2 text-[11px] text-cyan-300/80 bg-cyan-500/5 border border-cyan-500/20 px-2 py-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {trip.info.notes}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-950 sticky top-0 z-10 overflow-x-auto">
        {(() => {
          const hasNotes = tripSheetNotes && (tripSheetNotes.crew || tripSheetNotes.pax || tripSheetNotes.customer || tripSheetNotes.specialItems);
          const canManageSheet = ['ops', 'admin'].includes(currentUser?.role);
          // SHEET tab: visible if trip sheet exists OR user can upload one
          const showSheetTab = trip.info.isOps && (tripSheetUrl || canManageSheet);
          return [
            { id: 'status', label: 'STATUS', icon: Zap, badge: `${completedCount}/${applicableSteps.length}`, hidden: !trip.info.isOps },
            { id: 'pax', label: 'PAX', icon: Users, badge: trip.info.pax === 0 ? null : `${totalVerified}/${totalExpected}`, hidden: trip.info.pax === 0 || !trip.info.isOps },
            { id: 'sheet', label: 'SHEET', icon: FileText, badge: tripSheetUrl ? '✓' : null, hidden: !showSheetTab },
            { id: 'notes', label: 'NOTES', icon: AlertCircle, hidden: !hasNotes },
            { id: 'chat', label: 'COMMS', icon: MessageSquare },
            { id: 'notify', label: 'NOTIFY', icon: Bell, hidden: !trip.info.isOps },
            { id: 'delay', label: 'DELAY', icon: AlertCircle, hidden: !trip.info.isOps },
          ];
        })().filter(t => !t.hidden).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-3 py-3 text-xs tracking-widest transition-colors relative shrink-0 ${
              tab === t.id ? 'text-cyan-400' : 'text-slate-500 hover:text-slate-300'
            }`}
            style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {t.badge && (
              <span className={`text-[10px] px-1.5 py-0.5 ${tab === t.id ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-800 text-slate-400'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {t.badge}
              </span>
            )}
            {tab === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400" />}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={`flex-1 ${tab === 'chat' ? 'overflow-hidden flex flex-col min-h-0' : 'overflow-y-auto'}`}>
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading trip data...
          </div>
        ) : tab === 'status' ? (
          <div className="p-6 space-y-3 max-w-2xl">
            {trip.info.legType === 'REVENUE' && !paxComplete && (
              <div className="p-3 border border-cyan-500/30 bg-cyan-500/5 text-xs text-cyan-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>{totalVerified}/{totalExpected}</strong> passengers verified.
                  Complete passenger check-in before "PASSENGERS BOARDED".
                </span>
              </div>
            )}
            {geo.status === 'error' && (
              <div className="p-3 border border-red-500/30 bg-red-500/5 text-xs text-red-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>GPS error: {geo.error}. Status events will be logged without coordinates.</span>
              </div>
            )}
            {applicableSteps.map((step, idx) => {
              // Steps can be tapped in ANY order — crew often handles things
              // out-of-sequence in real ops (catering arrives while pax board,
              // pax show up while crew is still doing pre-flight, etc).
              // Only data-integrity constraint: PASSENGERS BOARDED requires
              // all expected pax to be checked in (or marked no-show / skipped)
              // because that status is a factual claim about pax accountability.
              const blocked = step.id === 'pax_boarded' && !paxComplete;
              const displayStep = getStepDisplay(step, trip);
              return (
                <StatusButton
                  key={step.id}
                  step={displayStep}
                  status={statuses[step.id]}
                  onTrigger={() => handleStatusTrigger(step)}
                  onUntrigger={() => handleStatusUntrigger(step)}
                  locked={blocked}
                  isNext={nextStep?.id === step.id && !blocked}
                  autoNotify={autoNotify}
                  airportCode={trip.info.from}
                />
              );
            })}
          </div>
        ) : tab === 'pax' ? (
          <div className="p-6 space-y-3 max-w-2xl">
            {scanning ? (
              <IDCheckInPanel
                mode={pendingScanPax ? 'preloaded' : 'walkup'}
                expectedPax={pendingScanPax}
                tripContext={{
                  tripUid: trip.uid,
                  verifiedBy: currentUser?.name || currentUser?.email || 'unknown',
                }}
                onComplete={addPassenger}
                onCancel={() => { setScanning(false); setPendingScanPax(null); }}
              />
            ) : (
              <>
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-xs text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      MANIFEST · {totalVerified}/{totalExpected} VERIFIED
                      {paxOverride !== null && (
                        <span className="ml-2 text-amber-400">(EDITED)</span>
                      )}
                    </div>
                    <PaxCountEditor
                      trip={trip}
                      paxOverride={paxOverride}
                      onChange={updatePaxOverride}
                      canEdit={['crew', 'ops', 'admin'].includes(currentUser?.role)}
                    />
                  </div>
                  <button
                    onClick={() => { setPendingScanPax(null); setScanning(true); }}
                    className="flex items-center gap-2 px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
                    style={{ fontFamily: 'DM Sans, sans-serif' }}
                  >
                    <UserCheck className="w-4 h-4" /> ADD WALK-UP
                  </button>
                </div>

                {/* Pre-loaded pax from trip sheet — crew taps CHECK IN to scan ID */}
                {preloadedPax.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      FROM TRIP SHEET ({preloadedPax.filter(p => p.checkInStatus !== 'skipped').length})
                    </div>
                    {preloadedPax.map(p => (
                      <PreloadedPaxRow
                        key={p.id}
                        pax={p}
                        scanned={passengers.find(s => s.id === p.scannedPaxId)}
                        onCheckIn={startPreloadedCheckIn}
                        onSkip={togglePreloadedSkip}
                      />
                    ))}
                  </div>
                )}

                {/* Quick-add buttons for pax that don't need ID scan */}
                <QuickAddPax onAdd={addQuickPax} />

                {/* Already-scanned manifest */}
                {passengers.length === 0 ? (
                  preloadedPax.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-slate-800">
                      <UserCheck className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                      <p className="text-sm text-slate-500">No passengers verified yet</p>
                      <p className="text-xs text-slate-600 mt-1">Upload a trip sheet, scan IDs, or add child/passport pax.</p>
                    </div>
                  ) : null
                ) : (
                  <div className="space-y-2">
                    <div className="text-[10px] tracking-widest text-slate-500 uppercase pt-2 border-t border-slate-800" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      VERIFIED MANIFEST
                    </div>
                    {passengers.map(p => (
                      <PassengerRow
                        key={p.id}
                        passenger={p}
                        onRemove={() => removePassenger(p.id)}
                        onToggleNoShow={toggleNoShow}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ) : tab === 'sheet' ? (
          <div className="p-6 max-w-2xl">
            <TripSheetPanel
              trip={trip}
              allTrips={allTrips}
              currentUser={currentUser}
              currentUserUid={currentUser?.uid || currentUser?.id}
              tripSheetUrl={tripSheetUrl}
              tripSheetFilename={tripSheetFilename}
              tripSheetUploadedAt={tripSheetUploadedAt}
              tripSheetUploadedBy={tripSheetUploadedBy}
              preloadedPax={preloadedPax}
              onUploaded={() => { /* trip-state listener picks up the change */ }}
              onCleared={clearTripSheet}
            />
          </div>
        ) : tab === 'notes' ? (
          <div className="p-6 max-w-2xl space-y-4">
            <TripNotesPanel notes={tripSheetNotes} />
          </div>
        ) : tab === 'chat' ? (
          <ChatPanel tripId={trip.uid} currentUser={currentUserDisplayName || currentUser?.name || ''} />
        ) : tab === 'notify' ? (
          <div className="p-6 max-w-2xl">
            <NotifyPanel
              trip={trip}
              opsEmail={opsEmail}
              brokerEmail={brokerEmail}
              setBrokerEmail={updateBroker}
              statuses={statuses}
              autoNotify={autoNotify}
              setAutoNotify={updateAutoNotify}
              hasCatering={hasCatering}
              setHasCatering={updateHasCatering}
            />
          </div>
        ) : tab === 'delay' ? (
          <div className="p-6 max-w-2xl">
            <DelayPanel
              trip={trip}
              opsEmail={opsEmail}
              brokerEmail={brokerEmail}
              currentUser={currentUser}
              statuses={statuses}
              setStatuses={setStatuses}
              persist={persist}
              passengers={passengers}
              autoNotify={autoNotify}
              completed={completed}
              hasCatering={hasCatering}
              paxOverride={paxOverride}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QuickAddPax({ onAdd }) {
  const [open, setOpen] = useState(null); // null | 'CHILD'
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');

  const submit = async () => {
    if (!first.trim() || !last.trim()) return;
    await onAdd(open, first, last);
    setFirst('');
    setLast('');
    setOpen(null);
  };

  if (open) {
    return (
      <div className="p-3 border border-violet-500/40 bg-violet-500/5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            ADD {open}
          </span>
          <button onClick={() => { setOpen(null); setFirst(''); setLast(''); }} className="text-slate-500 hover:text-slate-300 text-xs">
            Cancel
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={first}
            onChange={e => setFirst(e.target.value)}
            placeholder="First name"
            className="bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
            autoFocus
          />
          <input
            type="text"
            value={last}
            onChange={e => setLast(e.target.value)}
            placeholder="Last name"
            className="bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          />
        </div>
        <button
          onClick={submit}
          disabled={!first.trim() || !last.trim()}
          className="mt-2 w-full py-2 text-sm font-medium bg-violet-500 hover:bg-violet-400 text-slate-950 disabled:opacity-40 disabled:cursor-not-allowed"

          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          Add to Manifest
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen('CHILD')}
        className="w-full flex items-center justify-center gap-2 py-2 border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 text-sm tracking-wider"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      >
        <Users className="w-4 h-4" /> ADD CHILD (NO ID)
      </button>
    </div>
  );
}

function PaxCountEditor({ trip, paxOverride, onChange, canEdit }) {
  const [editing, setEditing] = useState(false);
  const icalPax = trip.info.pax || 0;
  const current = paxOverride !== null ? paxOverride : icalPax;
  const [draft, setDraft] = useState(String(current));

  useEffect(() => {
    setDraft(String(paxOverride !== null ? paxOverride : icalPax));
  }, [paxOverride, icalPax]);

  if (!canEdit) return null;

  const save = async () => {
    const n = parseInt(draft, 10);
    if (isNaN(n) || n < 0) return;
    // If they set it back to the iCal value, clear the override
    await onChange(n === icalPax ? null : n);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-[10px] text-slate-500 hover:text-cyan-300 mt-0.5 underline-offset-2 hover:underline"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
        title="Edit expected pax count"
      >
        EDIT COUNT
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 mt-1">
      <input
        type="number"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        className="w-16 bg-slate-900/60 border border-slate-700 px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
        min="0"
        max="20"
        autoFocus
      />
      <button
        onClick={save}
        className="text-[10px] px-2 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 tracking-widest"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        SAVE
      </button>
      {paxOverride !== null && (
        <button
          onClick={async () => { await onChange(null); setEditing(false); }}
          className="text-[10px] px-2 py-1 border border-slate-700 hover:border-amber-500/40 text-slate-400 hover:text-amber-300 tracking-widest"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
          title={`Reset to scheduled count (${icalPax})`}
        >
          RESET
        </button>
      )}
      <button
        onClick={() => setEditing(false)}
        className="text-[10px] px-2 py-1 text-slate-500 hover:text-slate-300 tracking-widest"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        CANCEL
      </button>
    </div>
  );
}

/* ============================================================
   Trip sheet PDF — upload (ops/admin), view (all), parse pax
   ============================================================ */

// Extract plain text from a PDF File using pdfjs-dist (dynamically imported
// so the ~500KB library only loads when ops actually uploads a PDF).
async function extractPdfText(file) {
  const pdfjsLib = await import('pdfjs-dist/build/pdf.mjs');
  // Worker setup — load from cloudflare CDN to avoid Vite bundling issues
  // with the worker file (locally-bundled worker was returning HTML 404 fallback).
  // Pinned to the same version as in package.json to avoid API drift.
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(it => it.str).join(' ');
    fullText += pageText + '\n';
  }
  return fullText;
}

// Trip sheet upload + view panel. Upload UI is gated to ops/admin;
// crew see only the viewer + delete-restricted message.
function TripSheetPanel({
  trip, allTrips, currentUser, currentUserUid,
  tripSheetUrl, tripSheetFilename, tripSheetUploadedAt, tripSheetUploadedBy,
  preloadedPax, onUploaded, onCleared,
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [matchPreview, setMatchPreview] = useState(null); // {tripCode, tail, legs, matches: [{leg, candidates}]}
  const [showViewer, setShowViewer] = useState(false);

  const canUpload = ['ops', 'admin'].includes(currentUser.role);
  const hasSheet = !!tripSheetUrl;

  const handleFile = async (e) => {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('File must be a PDF');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large (max 10MB)');
      return;
    }
    setUploading(true);
    try {
      // 1. Extract text and parse
      const text = await extractPdfText(file);
      console.log('[trip-sheet] extracted text length:', text.length);
      console.log('[trip-sheet] first 500 chars:', text.slice(0, 500));
      const parsed = parseJetInsightTripSheet(text);
      console.log('[trip-sheet] parsed:', parsed);
      if (!parsed || !parsed.legs || parsed.legs.length === 0) {
        // Surface the actual text in the error so we can debug
        const preview = text.slice(0, 200).replace(/\s+/g, ' ');
        throw new Error(`Could not parse trip sheet. Got ${text.length} chars. Preview: "${preview}..."`);
      }

      // 2. For each parsed leg, find matching trips in the schedule
      const matches = parsed.legs.map(leg => ({
        leg,
        candidates: findMatchingTrips(leg, parsed.tail, allTrips),
      }));

      // 3. Show preview before uploading
      setMatchPreview({ ...parsed, matches, file });
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      // Reset the input so picking the same file again still triggers onChange
      e.target.value = '';
    }
  };

  const confirmUpload = async () => {
    if (!matchPreview) return;
    setUploading(true);
    setError(null);
    try {
      const { uploadTripSheet, computeTripGroupId } = await import('./firebase-storage.js');
      const tripGroupId = computeTripGroupId(matchPreview.tail, trip.start);
      if (!tripGroupId) throw new Error('Could not compute trip group ID');
      const { url, path } = await uploadTripSheet(matchPreview.file, tripGroupId);

      // For each leg with a matched trip, attach the PDF + preloaded pax
      const { attachTripSheetToLeg } = await import('./firebase-data.js');
      for (const m of matchPreview.matches) {
        if (m.candidates.length === 0) continue;
        // If multiple candidates, take the first (most recent). Could prompt later.
        const matched = m.candidates[0];
        const preloadedPax = m.leg.pax.map((p, i) => ({
          id: `pre-${matched.uid}-${i}`,
          firstName: p.firstName,
          lastName: p.lastName,
          gender: p.gender,
          dob: p.dob,
          weight: p.weight,
          primary: p.primary,
          scannedPaxId: null,
          checkInStatus: 'pending', // 'pending' | 'matched' | 'mismatch' | 'manual_override'
        }));
        await attachTripSheetToLeg({
          tripUid: matched.uid,
          tripSheetUrl: url,
          tripSheetPath: path,
          tripSheetFilename: matchPreview.file.name,
          uploadedBy: currentUserUid || currentUser.name,
          preloadedPax,
          tripSheetNotes: matchPreview.notes || null,
        });
      }

      setMatchPreview(null);
      if (onUploaded) onUploaded();
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Remove the trip sheet from this leg? Pre-loaded passengers will be cleared (already-checked-in passengers stay).')) return;
    if (onCleared) await onCleared();
  };

  // Match preview UI
  if (matchPreview) {
    return (
      <div className="border border-cyan-500/40 bg-cyan-500/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              REVIEW BEFORE UPLOAD
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              Trip {matchPreview.tripCode} · {matchPreview.tail} · {matchPreview.legs.length} legs
            </div>
          </div>
          <button
            onClick={() => setMatchPreview(null)}
            className="text-slate-500 hover:text-slate-300 text-xs"
          >
            Cancel
          </button>
        </div>

        <div className="space-y-2">
          {matchPreview.matches.map((m, i) => {
            const matched = m.candidates[0];
            return (
              <div key={i} className={`p-2 border ${matched ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-xs">
                    <span className="text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      Leg {m.leg.legNumber}: {m.leg.from} → {m.leg.to}
                    </span>
                    <span className="text-slate-500 ml-2">({m.leg.depDate})</span>
                  </div>
                  {matched ? (
                    matched._tailMismatch ? (
                      <span className="text-[10px] text-amber-300" style={{ fontFamily: 'JetBrains Mono, monospace' }} title={`Schedule has tail ${matched.info.tail}, trip sheet has ${matchPreview.tail}`}>
                        → MATCHED · TAIL MISMATCH ({matched.info.tail})
                      </span>
                    ) : (
                      <span className="text-[10px] text-emerald-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        → MATCHED ({m.leg.pax.length} pax)
                      </span>
                    )
                  ) : (
                    <span className="text-[10px] text-amber-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      → NO MATCH IN SCHEDULE
                    </span>
                  )}
                </div>
                {m.leg.pax.length > 0 && (
                  <div className="mt-1 text-[10px] text-slate-400 pl-2">
                    {m.leg.pax.map((p, j) => (
                      <div key={j}>· {p.firstName} {p.lastName} ({p.weight} lbs)</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {error && (
          <div className="p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">{error}</div>
        )}

        <div className="flex gap-2">
          <button
            onClick={confirmUpload}
            disabled={uploading || matchPreview.matches.every(m => m.candidates.length === 0)}
            className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          >
            {uploading ? 'Uploading...' : 'Upload & Attach to Matched Legs'}
          </button>
          <button
            onClick={() => setMatchPreview(null)}
            className="px-4 py-2 border border-slate-700 text-sm text-slate-300"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // No sheet, ops/admin view (upload UI)
  if (!hasSheet && canUpload) {
    return (
      <div className="border border-dashed border-slate-700 p-4 space-y-2">
        <div className="text-xs tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          TRIP SHEET
        </div>
        <p className="text-[10px] text-slate-500">
          Upload the JetInsight crew itinerary PDF. Pax will be auto-populated and the sheet will be attached to all matching legs.
        </p>
        <label className={`block w-full text-center py-2 border ${uploading ? 'border-slate-600 bg-slate-900/40 text-slate-500' : 'border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 cursor-pointer'} text-sm`} style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {uploading ? 'Parsing...' : 'CHOOSE PDF'}
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={handleFile}
            className="hidden"
            disabled={uploading}
          />
        </label>
        {error && (
          <div className="p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">{error}</div>
        )}
      </div>
    );
  }

  // No sheet, crew view
  if (!hasSheet && !canUpload) {
    return null;
  }

  // Has sheet — viewer
  return (
    <div className="border border-cyan-500/30 bg-cyan-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-cyan-400" />
          <div>
            <div className="text-xs text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {tripSheetFilename || 'Trip Sheet'}
            </div>
            <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {tripSheetUploadedAt ? new Date(tripSheetUploadedAt).toLocaleString() : ''}
            </div>
          </div>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setShowViewer(v => !v)}
            className="text-[10px] px-2 py-1 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {showViewer ? 'HIDE' : 'VIEW'}
          </button>
          <a
            href={tripSheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300 tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            OPEN
          </a>
          {canUpload && (
            <button
              onClick={handleClear}
              className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-red-500/40 hover:text-red-300 tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              title="Remove trip sheet from this leg"
            >
              REMOVE
            </button>
          )}
        </div>
      </div>
      {showViewer && (
        <div className="aspect-[8.5/11] bg-slate-950 border border-slate-700 overflow-hidden">
          <iframe
            src={tripSheetUrl}
            title="Trip Sheet"
            className="w-full h-full"
            style={{ minHeight: '600px' }}
          />
        </div>
      )}
    </div>
  );
}

// Pre-loaded pax row — what crew sees before scanning. Tap to scan ID.
// Display parsed notes from the trip sheet PDF.
// Notes types: crew (action items, amber), customer (FYI, cyan), pax (luggage, neutral).
// ============================================================
// ============================================================
//   MANIFESTS SECTION (top-level) — daily Load Manifests by tail
// ============================================================
//
// Data model: one manifest per (date, tail). PIC fills out at start of day,
// adds legs throughout the day. Manifests auto-pick-up legs when ops marks
// trips complete. Crew can also add manual legs (positioning, training).
// E-signatures: typed name + saved drawn signature + audit log (UID, email,
// timestamp). Submission is final (record locks); PDF emails to
// Loadmanifest@flyskyway.com.

function ManifestsScreen({ currentUser, allTrips }) {
  const [manifests, setManifests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);

  const isCrew = currentUser?.role === 'crew';
  const isOps = currentUser?.role === 'ops';
  const isAdmin = currentUser?.role === 'admin';

  useEffect(() => {
    let unsub = null;
    let cancelled = false;
    (async () => {
      const m = await import('./firebase-manifests.js');
      if (cancelled) return;
      unsub = m.subscribeToAllManifests((list) => {
        setManifests(list);
        setLoading(false);
      });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  const todayStr = (() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();

  // Group by date — today first
  const grouped = useMemo(() => {
    const byDate = {};
    for (const m of manifests) {
      const date = m.date || 'unknown';
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(m);
    }
    const dates = Object.keys(byDate).sort().reverse();
    return dates.map(date => ({ date, manifests: byDate[date] }));
  }, [manifests]);

  const selected = manifests.find(m => m.id === selectedId);

  const createNewManifest = async ({ date, tail }) => {
    const m = await import('./firebase-manifests.js');
    const id = m.manifestId(date, tail);
    const existing = await m.fetchManifest(id);
    if (existing) {
      setSelectedId(id);
      setShowNewModal(false);
      return;
    }
    await m.saveManifest({
      id, date, tail,
      hobbsOut: '', hobbsIn: '', hobbsTotal: '', waitTime: '',
      dutyTimeIn: '', dutyTimeOut: '', dutyTimeTotal: '',
      legs: [],
      picSig: null, sicSig: null,
      status: 'draft',
      createdBy: currentUser?.name || '',
    });
    setSelectedId(id);
    setShowNewModal(false);
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
      <aside className={`${selected ? 'hidden md:block' : 'block'} w-full md:w-96 md:border-r md:border-slate-800 overflow-y-auto scroll-area`}>
        <div className="px-4 py-3 border-b border-slate-800 bg-slate-950 sticky top-0 z-10">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs tracking-[0.2em]" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
              LOAD MANIFESTS
            </h2>
            <button
              onClick={() => setShowNewModal(true)}
              className="text-[10px] px-2 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 tracking-widest font-medium"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              + NEW
            </button>
          </div>
          <p className="text-[10px] text-slate-500 mt-1">
            One per day per tail. Legs auto-add when trips are marked complete.
          </p>
        </div>

        {showNewModal && (
          <NewManifestPicker
            currentUser={currentUser}
            allTrips={allTrips}
            todayStr={todayStr}
            onCreate={createNewManifest}
            onCancel={() => setShowNewModal(false)}
          />
        )}

        {loading ? (
          <div className="p-8 text-center text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading manifests...
          </div>
        ) : grouped.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="w-8 h-8 text-slate-700 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No manifests yet</p>
            <p className="text-xs text-slate-600 mt-1">
              Manifests are created automatically when ops marks a trip complete, or tap NEW to start one manually.
            </p>
          </div>
        ) : (
          <div>
            {grouped.map(({ date, manifests: dayManifests }) => (
              <div key={date}>
                <div className="px-4 py-2 text-[10px] tracking-[0.2em] text-slate-600 bg-slate-900/40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {formatDate(date)}{date === todayStr ? ' · TODAY' : ''}
                </div>
                {dayManifests.map(m => (
                  <ManifestRow
                    key={m.id}
                    manifest={m}
                    selected={m.id === selectedId}
                    onClick={() => setSelectedId(m.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </aside>

      <main className={`flex-1 overflow-y-auto scroll-area ${selected ? 'block' : 'hidden md:block'}`}>
        {selected ? (
          <ManifestDetail
            manifest={selected}
            currentUser={currentUser}
            allTrips={allTrips}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <div className="h-full flex items-center justify-center p-8 grid-bg">
            <div className="text-center max-w-md">
              <div className="w-20 h-20 mx-auto mb-4 border border-slate-800 flex items-center justify-center">
                <FileText className="w-10 h-10 text-slate-700" />
              </div>
              <h2 className="text-2xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                LOAD MANIFESTS
              </h2>
              <p className="text-sm text-slate-500">
                Select a manifest to view, or tap NEW to create one.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function formatDate(iso) {
  // YYYY-MM-DD → "Saturday, May 2, 2026"
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, mo, d] = iso.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

function ManifestRow({ manifest, selected, onClick }) {
  const isSubmitted = manifest.status === 'submitted';
  const legCount = (manifest.legs || []).length;
  const hasPic = !!manifest.picSig;
  const hasSic = !!manifest.sicSig;
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left p-3 border-b border-slate-800 ${selected ? 'bg-slate-900/60' : 'hover:bg-slate-900/40'} transition-colors`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-sm text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
          {manifest.tail}
        </span>
        <span className={`text-[10px] tracking-widest shrink-0 ${isSubmitted ? 'text-emerald-300' : 'text-amber-300'}`} style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          {isSubmitted ? 'SUBMITTED' : 'DRAFT'}
        </span>
      </div>
      <div className="flex items-center justify-between text-[11px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <span>{legCount} leg{legCount === 1 ? '' : 's'}</span>
        <span className="flex gap-1">
          <span className={hasPic ? 'text-emerald-400' : 'text-slate-600'}>PIC</span>
          <span>·</span>
          <span className={hasSic ? 'text-emerald-400' : 'text-slate-600'}>SIC</span>
        </span>
      </div>
    </button>
  );
}

// New-manifest picker: choose date + tail
function NewManifestPicker({ currentUser, allTrips, todayStr, onCreate, onCancel }) {
  const [date, setDate] = useState(todayStr);
  const [tail, setTail] = useState('');
  // Suggest tails from today's trips
  const suggestedTails = useMemo(() => {
    if (!Array.isArray(allTrips)) return [];
    const tails = new Set();
    for (const t of allTrips) {
      if (!t.info?.tail || !t.start) continue;
      const d = t.start instanceof Date ? t.start : new Date(t.start);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const dStr = `${yyyy}-${mm}-${dd}`;
      if (dStr === date) tails.add(t.info.tail);
    }
    return Array.from(tails).sort();
  }, [allTrips, date]);

  return (
    <div className="p-4 border-b border-slate-800 bg-slate-900/40 space-y-3">
      <div className="text-xs tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
        NEW MANIFEST
      </div>
      <label className="block">
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DATE</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        />
      </label>
      <label className="block">
        <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>TAIL</span>
        <input
          type="text"
          value={tail}
          onChange={(e) => setTail(e.target.value.toUpperCase())}
          placeholder="N123AB"
          className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        />
      </label>
      {suggestedTails.length > 0 && (
        <div>
          <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            FLYING THIS DAY
          </div>
          <div className="flex flex-wrap gap-1">
            {suggestedTails.map(t => (
              <button
                key={t}
                onClick={() => setTail(t)}
                className={`text-[10px] px-2 py-1 border ${tail === t ? 'border-cyan-400 text-cyan-300' : 'border-slate-700 text-slate-400 hover:border-cyan-500/40'} tracking-widest`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2 pt-2">
        <button
          onClick={() => onCreate({ date, tail })}
          disabled={!date || !tail}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          CREATE
        </button>
        <button onClick={onCancel} className="px-4 py-2 border border-slate-700 text-sm text-slate-300">
          CANCEL
        </button>
      </div>
    </div>
  );
}

function ManifestDetail({ manifest, currentUser, allTrips, onBack }) {
  const [draft, setDraft] = useState(manifest);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [submitInfo, setSubmitInfo] = useState(null);

  const isCrew = currentUser?.role === 'crew';
  const isOps = currentUser?.role === 'ops';
  const isAdmin = currentUser?.role === 'admin';
  const canSign = isCrew;
  const canEdit = isCrew || isOps || isAdmin;

  useEffect(() => { setDraft(manifest); }, [manifest.id, manifest.updatedAt]);

  // Trips on the schedule that match this manifest's date+tail.
  // ONLY actual flying legs — exclude CREW HOTEL, MAINTENANCE, TRAINING, HOLD.
  // The `info.isFlight` flag is set during iCal parsing based on category.
  const scheduledTrips = useMemo(() => {
    if (!Array.isArray(allTrips) || !draft) return [];
    return allTrips.filter(t => {
      if (!t.info?.tail || !t.start) return false;
      if (t.info.tail !== draft.tail) return false;
      // Skip non-flying entries (crew hotel, maintenance, hold, training)
      if (!t.info.isFlight) return false;
      const d = t.start instanceof Date ? t.start : new Date(t.start);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}` === draft.date;
    });
  }, [allTrips, draft]);

  // Schedule diff — what's new on the schedule that's NOT yet on the manifest,
  // and what's no longer on the schedule but still on the manifest.
  // Excludes trips the user has explicitly removed (dismissedTripUids).
  const scheduleDiff = useMemo(() => {
    if (!draft) return { newTrips: [], removedTripUids: [], unchanged: true };
    const existingLegs = Array.isArray(draft.legs) ? draft.legs : [];
    const existingTripUids = new Set(existingLegs.filter(l => l.tripUid).map(l => l.tripUid));
    const dismissedTripUids = new Set(Array.isArray(draft.dismissedTripUids) ? draft.dismissedTripUids : []);
    const scheduledTripUids = new Set(scheduledTrips.map(t => t.uid));
    // New trips: on schedule, not on manifest, not previously dismissed
    const newTrips = scheduledTrips.filter(t =>
      !existingTripUids.has(t.uid) && !dismissedTripUids.has(t.uid)
    );
    const removedTripUids = existingLegs
      .filter(l => l.tripUid && !scheduledTripUids.has(l.tripUid))
      .map(l => l.tripUid);
    return {
      newTrips,
      removedTripUids,
      unchanged: newTrips.length === 0 && removedTripUids.length === 0,
    };
  }, [draft, scheduledTrips]);

  const isSubmitted = draft?.status === 'submitted';
  const readOnly = isSubmitted || !canEdit;

  // Pre-populate from schedule on first open if no legs exist yet.
  // Uses a ref-tracked "already attempted" flag so the effect doesn't loop
  // when the save round-trips back through Firestore.
  const populatedRef = useRef(false);
  useEffect(() => {
    if (readOnly) return;
    if (!draft) return;
    if (populatedRef.current) return; // already done for this manifest
    if ((draft.legs || []).length > 0) {
      // Has legs already — mark as done so we don't re-populate later
      populatedRef.current = true;
      return;
    }
    if (!Array.isArray(allTrips) || allTrips.length === 0) {
      // Schedule still loading — wait for next render
      return;
    }
    if (scheduledTrips.length === 0) {
      // Schedule is loaded but no trips for this date+tail. Mark as attempted
      // so we don't keep checking, but allow the SCHEDULE CHANGED banner to
      // surface any future trips.
      populatedRef.current = true;
      console.log('[manifest] no scheduled trips for', draft.tail, draft.date);
      return;
    }
    populatedRef.current = true;
    const sorted = [...scheduledTrips].sort((a, b) => {
      const ta = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
      const tb = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
      return ta - tb;
    });
    console.log('[manifest] pre-populating', sorted.length, 'legs for', draft.tail, draft.date);
    (async () => {
      const m = await import('./firebase-manifests.js');
      const dataModule = await import('./firebase-data.js');
      // Fetch preloadedPax for each trip in parallel
      const paxByTripUid = {};
      await Promise.all(sorted.map(async (t) => {
        try {
          const pax = await dataModule.fetchPreloadedPax(t.uid);
          paxByTripUid[t.uid] = pax;
        } catch (err) {
          console.error('[manifest] fetchPreloadedPax failed for', t.uid, err);
          paxByTripUid[t.uid] = [];
        }
      }));
      const newLegs = sorted.slice(0, 7).map(t =>
        m.buildLegFromTrip(t, paxByTripUid[t.uid] || [], 'auto-prepopulate')
      );
      const next = { ...draft, legs: newLegs };
      setDraft(next);
      try { await m.saveManifest(next); }
      catch (err) { console.error('[manifest] pre-populate save failed:', err); }
    })();
  }, [draft, allTrips, scheduledTrips, readOnly]);
  // Reset the populated ref when the manifest ID changes (new manifest opened)
  useEffect(() => { populatedRef.current = false; }, [manifest?.id]);

  // Live-sync pax names from trip-state for each leg that has a tripUid.
  // When ops uploads a trip sheet or checks pax in/out, the leg's pax names
  // auto-update on this manifest. Only updates pax names — never overwrites
  // crew-edited W&B/CG/etc data on the leg.
  useEffect(() => {
    if (readOnly) return;
    if (!draft || !Array.isArray(draft.legs)) return;
    const tripUids = draft.legs.filter(l => l.tripUid).map(l => l.tripUid);
    if (tripUids.length === 0) return;
    console.log('[manifest] live-sync subscribing to', tripUids.length, 'trip-states:', tripUids);

    let cancelled = false;
    const unsubs = [];
    (async () => {
      const dataModule = await import('./firebase-data.js');
      const manifestModule = await import('./firebase-manifests.js');
      if (cancelled) return;
      for (const tripUid of tripUids) {
        const unsub = dataModule.subscribeToTripState(tripUid, async (state) => {
          if (cancelled) return;
          const incomingPax = Array.isArray(state.preloadedPax) ? state.preloadedPax : [];
          const incomingNames = incomingPax
            .filter(p => p.checkInStatus !== 'skipped')
            .slice(0, 7)
            .map(p => `${p.firstName || ''} ${p.lastName || ''}`.trim())
            .filter(Boolean);
          console.log('[manifest] live-sync got pax for', tripUid, '→', incomingNames.length, 'names');
          // Update the matching leg's passengers, but only if the names array
          // is genuinely different. Persist the change to Firestore too.
          let changedManifest = null;
          setDraft(d => {
            if (!d || !Array.isArray(d.legs)) return d;
            const idx = d.legs.findIndex(l => l.tripUid === tripUid);
            if (idx < 0) return d;
            const currentNames = d.legs[idx].passengers || [];
            const sameLength = currentNames.length === incomingNames.length;
            const sameContent = sameLength && currentNames.every((n, i) => n === incomingNames[i]);
            if (sameContent) return d;
            const legs = [...d.legs];
            legs[idx] = { ...legs[idx], passengers: incomingNames };
            const next = { ...d, legs };
            changedManifest = next; // capture for the persist below
            return next;
          });
          // Persist to Firestore so pax stays after refresh
          if (changedManifest) {
            try {
              await manifestModule.saveManifest(changedManifest);
              console.log('[manifest] persisted pax update for leg', tripUid);
            } catch (err) {
              console.error('[manifest] live-sync persist failed:', err);
            }
          }
        });
        unsubs.push(unsub);
      }
    })();
    return () => {
      cancelled = true;
      for (const u of unsubs) {
        try { u(); } catch {}
      }
    };
  }, [draft?.id, draft?.legs?.length, readOnly]);

  const acceptScheduleChanges = async () => {
    if (readOnly) return;
    const m = await import('./firebase-manifests.js');
    const dataModule = await import('./firebase-data.js');
    let nextLegs = Array.isArray(draft.legs) ? [...draft.legs] : [];
    // Fetch preloadedPax for each new trip in parallel
    const paxByTripUid = {};
    await Promise.all(scheduleDiff.newTrips.map(async (t) => {
      try {
        paxByTripUid[t.uid] = await dataModule.fetchPreloadedPax(t.uid);
      } catch (err) {
        paxByTripUid[t.uid] = [];
      }
    }));
    for (const t of scheduleDiff.newTrips) {
      if (nextLegs.length >= 7) break;
      nextLegs.push(m.buildLegFromTrip(t, paxByTripUid[t.uid] || [], 'auto-merge'));
    }
    const next = { ...draft, legs: nextLegs };
    setDraft(next);
    try { await m.saveManifest(next); }
    catch (err) { setError('Failed to save: ' + err.message); }
  };

  if (!draft) return null;

  const setField = (key) => (value) => {
    if (readOnly) return;
    setDraft(d => ({ ...d, [key]: value }));
  };
  const setLegField = (idx, key) => (value) => {
    if (readOnly) return;
    setDraft(d => {
      const legs = [...(d.legs || [])];
      legs[idx] = { ...legs[idx], [key]: value };
      return { ...d, legs };
    });
  };
  const setPaxName = (legIdx, paxIdx) => (value) => {
    if (readOnly) return;
    setDraft(d => {
      const legs = [...(d.legs || [])];
      const passengers = [...(legs[legIdx]?.passengers || [])];
      passengers[paxIdx] = value;
      legs[legIdx] = { ...legs[legIdx], passengers };
      return { ...d, legs };
    });
  };
  const addLeg = () => {
    if (readOnly) return;
    if ((draft.legs || []).length >= 7) {
      alert('Maximum 7 legs per manifest. Start a new manifest if needed.');
      return;
    }
    setDraft(d => ({
      ...d,
      legs: [...(d.legs || []), {
        tripUid: null,
        from: '', to: '', timeOut: '', timeIn: '', total: '',
        airport: '', cycles: '', nightLdgs: '', passengers: [],
        toWeight: '', maxAllowable: '', fwdCG: '', toCG: '', aftCG: '',
        numPax: '', configuration: '',
        legType: 'REVENUE',
        addedAt: Date.now(),
        addedBy: currentUser?.name || 'manual',
      }],
    }));
  };
  const removeLeg = async (idx) => {
    if (readOnly) return;
    const leg = (draft.legs || [])[idx];
    if (!leg) return;
    const label = leg.from && leg.to ? `${leg.from} → ${leg.to}` : `Leg ${idx + 1}`;
    if (!window.confirm(`Remove ${label} from this manifest?`)) return;
    // If this leg came from a scheduled trip, track its tripUid so the
    // SCHEDULE CHANGED banner doesn't re-suggest adding it back.
    const dismissedTripUids = Array.isArray(draft.dismissedTripUids) ? [...draft.dismissedTripUids] : [];
    if (leg.tripUid && !dismissedTripUids.includes(leg.tripUid)) {
      dismissedTripUids.push(leg.tripUid);
    }
    const next = {
      ...draft,
      legs: (draft.legs || []).filter((_, i) => i !== idx),
      dismissedTripUids,
    };
    setDraft(next);
    // Auto-save so deletion sticks even if user navigates away
    try {
      const m = await import('./firebase-manifests.js');
      await m.saveManifest(next);
    } catch (err) {
      console.error('[manifest] removeLeg save failed:', err);
    }
  };

  const saveDraft = async () => {
    if (readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const m = await import('./firebase-manifests.js');
      await m.saveManifest(draft);
    } catch (err) {
      console.error('[manifest] save failed:', err);
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Inline signing — replaces the saved-signature flow.
  // Each signature is drawn fresh on the manifest itself. State holds
  // which role is being signed (or null when not signing).
  const [signingRole, setSigningRole] = useState(null);

  const completeSign = async (role, typedName, signatureDataUrl) => {
    if (!canSign) {
      alert('Only crew (PIC/SIC) can sign. Admin can edit but cannot sign.');
      return;
    }
    if (!typedName || !typedName.trim()) {
      alert('Type your name before confirming.');
      return;
    }
    if (!signatureDataUrl) {
      alert('Draw your signature before confirming.');
      return;
    }
    const sig = {
      name: typedName.trim(),
      uid: currentUser.uid || currentUser.id,
      email: currentUser.email,
      signatureImg: signatureDataUrl,
      timestamp: Date.now(),
    };
    const next = { ...draft, [`${role}Sig`]: sig };
    setDraft(next);
    setSigningRole(null);
    try {
      const m = await import('./firebase-manifests.js');
      await m.saveManifest(next);
    } catch (err) {
      console.error('[manifest] sign save failed:', err);
      alert('Signature recorded locally but failed to save. Try again.');
    }
  };

  const unsign = async (role) => {
    if (readOnly) return;
    if (!window.confirm(`Remove ${role.toUpperCase()} signature?`)) return;
    const next = { ...draft, [`${role}Sig`]: null };
    setDraft(next);
    try {
      const m = await import('./firebase-manifests.js');
      await m.saveManifest(next);
    } catch (err) {
      console.error('[manifest] unsign failed:', err);
    }
  };

  // Preview PDF state — base64 data URL of the generated PDF, shown in modal
  const [previewPdfUrl, setPreviewPdfUrl] = useState(null);
  const [generatingPreview, setGeneratingPreview] = useState(false);

  const previewPdf = async () => {
    if (!(draft.legs || []).length) {
      alert('Manifest has no legs. Add at least one leg before previewing.');
      return;
    }
    setGeneratingPreview(true);
    setError(null);
    try {
      const payload = {
        ...draft,
        tail: draft.tail,
        tripDate: draft.date,
        tripCode: '',
      };
      const r = await fetch('/api/generate-manifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: payload, previewOnly: true }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.pdfBase64) {
        setError(`Preview failed: ${data.error || r.status}`);
        return;
      }
      // Build a data URL the iframe can render
      const url = `data:application/pdf;base64,${data.pdfBase64}`;
      setPreviewPdfUrl(url);
    } catch (err) {
      console.error('[manifest] preview failed:', err);
      setError('Preview failed: ' + err.message);
    } finally {
      setGeneratingPreview(false);
    }
  };

  const submitManifest = async () => {
    if (!draft.picSig || !draft.sicSig) {
      alert('Both PIC and SIC must sign before submitting.');
      return;
    }
    if (!(draft.legs || []).length) {
      alert('Manifest has no legs. Add at least one leg before submitting.');
      return;
    }
    if (!window.confirm(
      'Submit this load manifest? This action is FINAL.\n\n' +
      'The PDF will be generated and emailed to Loadmanifest@flyskyway.com. ' +
      'After submitting, the manifest cannot be edited.'
    )) return;
    setSaving(true);
    setError(null);
    setSubmitInfo(null);
    try {
      const m = await import('./firebase-manifests.js');
      const submitted = {
        ...draft,
        status: 'submitted',
        submittedAt: Date.now(),
        submittedBy: currentUser?.name || '',
      };
      await m.saveManifest(submitted);
      setDraft(submitted);
      const payload = {
        ...submitted,
        tail: submitted.tail,
        tripDate: submitted.date,
        tripCode: '',
      };
      const r = await fetch('/api/generate-manifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: payload }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(`Manifest submitted but email failed: ${data.error || r.status}.`);
        return;
      }
      if (data.emailError) {
        setError(`Manifest submitted, PDF generated, but email failed: ${data.emailError}`);
      } else {
        setSubmitInfo(`Manifest submitted and emailed to Loadmanifest@flyskyway.com.`);
      }
    } catch (err) {
      console.error('[manifest] submit failed:', err);
      setError(err.message || 'Submit failed');
    } finally {
      setSaving(false);
    }
  };

  const showScheduleBanner = !readOnly && !scheduleDiff.unchanged;

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="md:hidden text-slate-500 hover:text-cyan-400 p-1" aria-label="Back">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            {draft.tail} · {formatDate(draft.date)}
          </h1>
          <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            S-5/R-37/10-30-23 · LOAD MANIFEST
          </div>
        </div>
        {isAdmin && (
          <button
            onClick={async () => {
              if (!window.confirm(
                `Delete this manifest?\n\n` +
                `${draft.tail} · ${formatDate(draft.date)}\n` +
                `${(draft.legs || []).length} legs, ${draft.status}\n\n` +
                `This is permanent and cannot be undone. Use only to remove test/duplicate manifests — not as a substitute for amendments.`
              )) return;
              try {
                const m = await import('./firebase-manifests.js');
                await m.deleteManifest(draft.id);
                onBack();
              } catch (err) {
                console.error('[manifest] delete failed:', err);
                alert('Delete failed: ' + err.message);
              }
            }}
            className="text-[10px] px-2 py-1 border border-red-500/40 text-red-300 hover:bg-red-500/10 tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title="Admin only — permanently delete this manifest"
          >
            DELETE
          </button>
        )}
      </div>

      {isSubmitted && (
        <div className="border border-emerald-500/40 bg-emerald-500/5 p-3">
          <div className="text-[10px] tracking-widest text-emerald-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            SUBMITTED — RECORD LOCKED
          </div>
          <div className="text-sm text-slate-200 mt-1">
            Submitted by {draft.submittedBy} on {new Date(draft.submittedAt).toLocaleString()}
          </div>
        </div>
      )}
      {error && <div className="border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300">{error}</div>}
      {submitInfo && <div className="border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-300">{submitInfo}</div>}

      {showScheduleBanner && (
        <div className="border border-amber-500/40 bg-amber-500/5 p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-[10px] tracking-widest text-amber-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              SCHEDULE CHANGED
            </div>
          </div>
          <div className="text-xs text-slate-300 space-y-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {scheduleDiff.newTrips.length > 0 && (
              <div>
                <span className="text-emerald-300">+ {scheduleDiff.newTrips.length} new leg{scheduleDiff.newTrips.length === 1 ? '' : 's'}:</span>{' '}
                {scheduleDiff.newTrips.map(t => `${t.info?.from || '?'}→${t.info?.to || '?'}${t.info?.legType === 'REPO' ? ' (91)' : ''}`).join(', ')}
              </div>
            )}
            {scheduleDiff.removedTripUids.length > 0 && (
              <div>
                <span className="text-red-300">⚠ {scheduleDiff.removedTripUids.length} leg{scheduleDiff.removedTripUids.length === 1 ? '' : 's'} no longer on schedule</span>
                <span className="text-slate-500"> — review and remove manually if cancelled</span>
              </div>
            )}
          </div>
          {scheduleDiff.newTrips.length > 0 && (
            <button
              onClick={acceptScheduleChanges}
              className="mt-2 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-medium tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              ADD NEW LEGS TO MANIFEST
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <ManifestField label="HOBBS OUT" value={draft.hobbsOut} onChange={setField('hobbsOut')} readOnly={readOnly} mono />
        <ManifestField label="HOBBS IN" value={draft.hobbsIn} onChange={setField('hobbsIn')} readOnly={readOnly} mono />
        <ManifestField label="HOBBS TOTAL" value={draft.hobbsTotal} onChange={setField('hobbsTotal')} readOnly={readOnly} mono />
        <ManifestField label="WAIT TIME" value={draft.waitTime} onChange={setField('waitTime')} readOnly={readOnly} mono />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <ManifestField label="TIME OUT" value={draft.timeOut} onChange={setField('timeOut')} readOnly={readOnly} mono />
        <ManifestField label="TIME IN" value={draft.timeIn} onChange={setField('timeIn')} readOnly={readOnly} mono />
        <ManifestField label="TIME TOTAL" value={draft.timeTotal} onChange={setField('timeTotal')} readOnly={readOnly} mono />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ManifestField label="DUTY TIME IN" value={draft.dutyTimeIn} onChange={setField('dutyTimeIn')} readOnly={readOnly} mono />
        <ManifestField label="DUTY TIME OUT" value={draft.dutyTimeOut} onChange={setField('dutyTimeOut')} readOnly={readOnly} mono />
        <ManifestField label="DUTY TIME TOTAL" value={draft.dutyTimeTotal} onChange={setField('dutyTimeTotal')} readOnly={readOnly} mono />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm tracking-widest text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
            LEGS · {(draft.legs || []).length}/7
          </h3>
          {!readOnly && (
            <div className="flex gap-1">
              <button
                onClick={async () => {
                  const dataModule = await import('./firebase-data.js');
                  const manifestModule = await import('./firebase-manifests.js');
                  const tripUids = (draft.legs || []).filter(l => l.tripUid).map(l => l.tripUid);
                  if (tripUids.length === 0) {
                    alert('No legs are linked to scheduled trips — nothing to refresh.');
                    return;
                  }
                  console.log('[manifest] refresh pax — fetching for', tripUids.length, 'legs');
                  const paxByTripUid = {};
                  await Promise.all(tripUids.map(async (uid) => {
                    paxByTripUid[uid] = await dataModule.fetchPreloadedPax(uid);
                  }));
                  const next = {
                    ...draft,
                    legs: (draft.legs || []).map(l => {
                      if (!l.tripUid) return l;
                      const pax = paxByTripUid[l.tripUid] || [];
                      const names = pax
                        .filter(p => p.checkInStatus !== 'skipped')
                        .slice(0, 7)
                        .map(p => `${p.firstName || ''} ${p.lastName || ''}`.trim())
                        .filter(Boolean);
                      return { ...l, passengers: names };
                    }),
                  };
                  setDraft(next);
                  try {
                    await manifestModule.saveManifest(next);
                    console.log('[manifest] refresh pax — saved');
                  } catch (err) {
                    console.error('[manifest] refresh pax save failed:', err);
                  }
                }}
                className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-amber-500/40 hover:text-amber-300 tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                title="Re-fetch passenger names from each leg's trip sheet"
              >
                ↻ REFRESH PAX
              </button>
              <button
                onClick={addLeg}
                className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300 tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                + ADD MANUAL LEG
              </button>
            </div>
          )}
        </div>
        {(draft.legs || []).length === 0 ? (
          <div className="border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500">
            No legs yet. Legs auto-add when ops marks trips complete, or tap ADD MANUAL LEG.
          </div>
        ) : (
          (draft.legs || []).map((leg, idx) => {
            const isOrphan = leg.tripUid && scheduleDiff.removedTripUids.includes(leg.tripUid);
            return (
              <ManifestLegCard
                key={idx}
                idx={idx}
                leg={leg}
                isOrphan={isOrphan}
                readOnly={readOnly}
                onChange={(key) => setLegField(idx, key)}
                onPaxChange={(paxIdx) => setPaxName(idx, paxIdx)}
                onRemove={() => removeLeg(idx)}
              />
            );
          })
        )}
      </div>

      <div className="border border-slate-700 bg-slate-900/40 p-3 text-xs text-slate-400 italic" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        Acceptance of Flight Release: I have completed a preflight inspection of the aircraft, checked the scale used for weight & balance purposes and completed all duties required by FAA regulations and Skyway Aviation's Operations Manual and hereby accept this aircraft for flight.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SigBlock
          role="pic"
          sig={draft.picSig}
          canSign={canSign && !isSubmitted}
          isActive={signingRole === 'pic'}
          defaultName={currentUser?.name || ''}
          onSignStart={() => setSigningRole('pic')}
          onSignCancel={() => setSigningRole(null)}
          onSignComplete={(name, dataUrl) => completeSign('pic', name, dataUrl)}
          onUnsign={() => unsign('pic')}
        />
        <SigBlock
          role="sic"
          sig={draft.sicSig}
          canSign={canSign && !isSubmitted}
          isActive={signingRole === 'sic'}
          defaultName={currentUser?.name || ''}
          onSignStart={() => setSigningRole('sic')}
          onSignCancel={() => setSigningRole(null)}
          onSignComplete={(name, dataUrl) => completeSign('sic', name, dataUrl)}
          onUnsign={() => unsign('sic')}
        />
      </div>

      {!isSubmitted && (
        <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-800">
          {canEdit && (
            <button
              onClick={saveDraft}
              disabled={saving}
              className="px-4 py-2 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-sm tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {saving ? 'SAVING...' : 'SAVE DRAFT'}
            </button>
          )}
          {canEdit && (
            <button
              onClick={previewPdf}
              disabled={generatingPreview || !(draft.legs || []).length}
              className="px-4 py-2 border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 text-sm tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              title="See the PDF before submitting"
            >
              {generatingPreview ? 'GENERATING...' : '↗ PREVIEW PDF'}
            </button>
          )}
          {canSign && (
            <button
              onClick={submitManifest}
              disabled={saving || !draft.picSig || !draft.sicSig || !(draft.legs || []).length}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-medium tracking-widest disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
              title={!draft.picSig || !draft.sicSig ? 'Both PIC and SIC must sign' : !(draft.legs || []).length ? 'Add at least one leg' : 'Submit final manifest'}
            >
              SUBMIT MANIFEST
            </button>
          )}
        </div>
      )}

      {/* PDF preview modal */}
      {previewPdfUrl && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4"
          onClick={() => setPreviewPdfUrl(null)}
        >
          <div
            className="bg-slate-950 border border-slate-700 max-w-5xl w-full h-full max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-slate-800 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                  PDF PREVIEW
                </h2>
                <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {draft.tail} · {formatDate(draft.date)} · NOT YET SUBMITTED
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={previewPdfUrl}
                  download={(() => {
                    // Match the API filename format: "MM-DD-YYYY TAIL.pdf"
                    // For preview, append " PREVIEW" so users don't confuse it with the submitted version.
                    const tail = String(draft.tail || 'TAIL').toUpperCase().replace(/[^A-Z0-9]/g, '');
                    const m = String(draft.date || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
                    if (m) {
                      const mm = m[2].padStart(2, '0');
                      const dd = m[3].padStart(2, '0');
                      const yyyy = m[1];
                      return `${mm}-${dd}-${yyyy} ${tail} PREVIEW.pdf`;
                    }
                    return `Manifest ${tail} PREVIEW.pdf`;
                  })()}
                  className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300 tracking-widest"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  ↓ DOWNLOAD
                </a>
                <button
                  onClick={() => setPreviewPdfUrl(null)}
                  className="text-slate-500 hover:text-slate-300 p-1"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden bg-slate-900">
              <iframe
                src={previewPdfUrl}
                title="Manifest PDF preview"
                className="w-full h-full border-0"
              />
            </div>
            <div className="p-3 border-t border-slate-800 flex flex-wrap gap-2 items-center">
              <div className="flex-1 min-w-0 text-[11px] text-slate-500" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                Review carefully. Once submitted, the manifest is locked and emailed to Loadmanifest@flyskyway.com.
              </div>
              {canSign && draft.picSig && draft.sicSig && (
                <button
                  onClick={async () => {
                    setPreviewPdfUrl(null);
                    await submitManifest();
                  }}
                  disabled={saving}
                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-medium tracking-widest disabled:opacity-50"
                  style={{ fontFamily: 'DM Sans, sans-serif' }}
                >
                  SUBMIT & EMAIL
                </button>
              )}
              <button
                onClick={() => setPreviewPdfUrl(null)}
                className="px-4 py-2 border border-slate-700 text-sm text-slate-300"
              >
                CLOSE
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ManifestField({ label, value, onChange, readOnly, mono }) {
  return (
    <label className="block">
      <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</span>
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        className={`mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400 disabled:opacity-50 ${readOnly ? 'cursor-not-allowed' : ''}`}
        style={{ fontFamily: mono ? 'JetBrains Mono, monospace' : 'DM Sans, sans-serif' }}
      />
    </label>
  );
}

function ManifestLegCard({ idx, leg, isOrphan, readOnly, onChange, onPaxChange, onRemove }) {
  const isRepo = leg.legType === 'REPO';
  const borderClass = isOrphan
    ? 'border-red-500/40 bg-red-500/5'
    : isRepo
    ? 'border-violet-500/30 bg-violet-500/5'
    : 'border-slate-700 bg-slate-900/40';

  return (
    <div className={`border ${borderClass} p-3 space-y-2`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="text-[10px] tracking-widest text-cyan-400" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            LEG {idx + 1}
          </div>
          {isRepo && (
            <span className="text-[9px] tracking-widest text-violet-300 px-1.5 py-0.5 border border-violet-500/40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              REPO · 91
            </span>
          )}
          {isOrphan && (
            <span className="text-[9px] tracking-widest text-red-300 px-1.5 py-0.5 border border-red-500/40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              ⚠ NOT ON SCHEDULE
            </span>
          )}
        </div>
        {!readOnly && (
          <button
            onClick={onRemove}
            className="text-[10px] text-slate-500 hover:text-red-300 tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            REMOVE
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <ManifestField label="FROM" value={leg.from} onChange={onChange('from')} readOnly={readOnly} mono />
        <ManifestField label="TO" value={leg.to} onChange={onChange('to')} readOnly={readOnly} mono />
        <ManifestField label="AIRPORT" value={leg.airport} onChange={onChange('airport')} readOnly={readOnly} mono />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-2 gap-2">
        <ManifestField label="CYCLES" value={leg.cycles} onChange={onChange('cycles')} readOnly={readOnly} mono />
        <ManifestField label="NIGHT LDGS" value={leg.nightLdgs} onChange={onChange('nightLdgs')} readOnly={readOnly} mono />
      </div>

      {/* Repo legs: skip pax + W&B (just T/O weight = '91' and Configuration shown).
          Revenue legs: show full pax + W&B fields. */}
      {!isRepo && (
        <div>
          <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PASSENGERS (UP TO 7)</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {[0,1,2,3,4,5,6].map(i => (
              <input
                key={i}
                type="text"
                value={(leg.passengers || [])[i] || ''}
                onChange={(e) => onPaxChange(i)(e.target.value)}
                readOnly={readOnly}
                placeholder={`Pax ${i + 1}`}
                className="bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400 disabled:opacity-50"
                style={{ fontFamily: 'DM Sans, sans-serif' }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 border-t border-slate-800">
        <ManifestField label="T/O WEIGHT" value={leg.toWeight} onChange={onChange('toWeight')} readOnly={readOnly} mono />
        {!isRepo && <ManifestField label="MAX ALLOWABLE" value={leg.maxAllowable} onChange={onChange('maxAllowable')} readOnly={readOnly} mono />}
        {!isRepo && <ManifestField label="FWD C.G. LIMIT" value={leg.fwdCG} onChange={onChange('fwdCG')} readOnly={readOnly} mono />}
        {!isRepo && <ManifestField label="T/O C.G." value={leg.toCG} onChange={onChange('toCG')} readOnly={readOnly} mono />}
      </div>
      {!isRepo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <ManifestField label="AFT C.G. LIMIT" value={leg.aftCG} onChange={onChange('aftCG')} readOnly={readOnly} mono />
          <ManifestField label="# PASSENGERS" value={leg.numPax} onChange={onChange('numPax')} readOnly={readOnly} mono />
          <ManifestField label="CONFIGURATION" value={leg.configuration} onChange={onChange('configuration')} readOnly={readOnly} />
        </div>
      )}
      {isRepo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <ManifestField label="CONFIGURATION" value={leg.configuration} onChange={onChange('configuration')} readOnly={readOnly} />
        </div>
      )}
    </div>
  );
}

function SigBlock({ role, sig, canSign, isActive, defaultName, onSignStart, onSignCancel, onSignComplete, onUnsign }) {
  const label = role.toUpperCase();
  const [typedName, setTypedName] = useState(defaultName || '');
  const [drawnSig, setDrawnSig] = useState(null);

  // Reset local state when activation changes
  useEffect(() => {
    if (isActive) {
      setTypedName(defaultName || '');
      setDrawnSig(null);
    }
  }, [isActive, defaultName]);

  return (
    <div className="border border-slate-700 bg-slate-900/40 p-3 space-y-2">
      <div className="text-[10px] tracking-widest text-cyan-400" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
        {label} SIGNATURE
      </div>
      {sig ? (
        // Already signed — show the recorded signature
        <div className="space-y-2">
          <div className="border border-slate-600 bg-white p-2">
            {sig.signatureImg ? (
              <img src={sig.signatureImg} alt={`${label} signature`} className="w-full max-h-20 object-contain" />
            ) : (
              <div className="h-16 flex items-center justify-center text-slate-400 italic text-sm">
                (signature image unavailable)
              </div>
            )}
          </div>
          <div className="text-sm text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
            {sig.name}
          </div>
          <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            Signed electronically by {sig.email}<br />
            at {new Date(sig.timestamp).toLocaleString()}
          </div>
          {canSign && (
            <button
              onClick={onUnsign}
              className="text-[10px] text-slate-500 hover:text-red-300 tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              UNSIGN
            </button>
          )}
        </div>
      ) : isActive && canSign ? (
        // Active signing flow — typed name + fresh signature pad inline
        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              TYPED NAME
            </span>
            <input
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Full legal name"
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </label>
          <div>
            <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DRAW SIGNATURE
            </span>
            {drawnSig ? (
              <div className="mt-1 space-y-1">
                <div className="border border-slate-600 bg-white p-1">
                  <img src={drawnSig} alt="Signature" className="w-full max-h-20 object-contain" />
                </div>
                <button
                  onClick={() => setDrawnSig(null)}
                  className="text-[10px] text-slate-500 hover:text-amber-300 tracking-widest"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  REDRAW
                </button>
              </div>
            ) : (
              <div className="mt-1">
                <SignaturePad
                  height={120}
                  onSave={(dataUrl) => setDrawnSig(dataUrl)}
                  onCancel={() => {}}
                />
              </div>
            )}
          </div>
          <p className="text-[10px] text-slate-500 italic">
            By tapping CONFIRM, you electronically sign this manifest. Your name, email, drawn signature, and timestamp will be recorded.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => onSignComplete(typedName, drawnSig)}
              disabled={!typedName.trim() || !drawnSig}
              className="flex-1 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              CONFIRM SIGNATURE
            </button>
            <button
              onClick={onSignCancel}
              className="px-3 py-2 border border-slate-700 text-sm text-slate-400 hover:border-slate-500"
            >
              CANCEL
            </button>
          </div>
        </div>
      ) : canSign ? (
        // Inactive — show the SIGN button
        <button
          onClick={onSignStart}
          className="w-full py-3 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-sm tracking-widest"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          SIGN AS {label}
        </button>
      ) : (
        <div className="text-xs text-slate-500 italic">Awaiting {label} signature</div>
      )}
    </div>
  );
}

function TripNotesPanel({ notes }) {
  if (!notes || (!notes.crew && !notes.customer && !notes.pax && !notes.specialItems)) {
    return (
      <div className="text-center py-12 border border-dashed border-slate-800">
        <AlertCircle className="w-8 h-8 text-slate-700 mx-auto mb-2" />
        <p className="text-sm text-slate-500">No notes parsed from trip sheet</p>
        <p className="text-xs text-slate-600 mt-1">Upload a JetInsight trip sheet on the SHEET tab to see notes here.</p>
      </div>
    );
  }

  const renderNote = (label, body, tone) => {
    if (!body) return null;
    const toneClass = tone === 'amber'
      ? 'border-amber-500/40 bg-amber-500/5'
      : tone === 'cyan'
      ? 'border-cyan-500/40 bg-cyan-500/5'
      : 'border-slate-700 bg-slate-900/40';
    const labelColor = tone === 'amber' ? 'text-amber-300' : tone === 'cyan' ? 'text-cyan-300' : 'text-slate-400';
    return (
      <div className={`p-3 border ${toneClass}`}>
        <div className={`text-[10px] tracking-widest ${labelColor} mb-1`} style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          {label}
        </div>
        <div className="text-sm text-slate-100 whitespace-pre-wrap" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {body}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="text-xs text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        FROM TRIP SHEET
      </div>
      {renderNote('CREW NOTES (ACTION)', notes.crew, 'amber')}
      {renderNote('CUSTOMER NOTES', notes.customer, 'cyan')}
      {renderNote('PAX NOTES', notes.pax, 'neutral')}
      {renderNote('SPECIAL ITEMS', notes.specialItems, 'neutral')}
    </>
  );
}

function PreloadedPaxRow({ pax, onCheckIn, onSkip, scanned }) {
  // Find the scanned pax matched to this preloaded entry
  const isMatched = pax.checkInStatus === 'matched';
  const isMismatch = pax.checkInStatus === 'mismatch';
  const isOverride = pax.checkInStatus === 'manual_override';
  const isChildVerified = pax.checkInStatus === 'child_verified';
  const isSkipped = pax.checkInStatus === 'skipped';
  const checkedIn = isMatched || isMismatch || isOverride || isChildVerified;

  // Detect if this pax is a minor by DOB (for button label)
  const computeAge = (dobStr) => {
    if (!dobStr) return null;
    const m = String(dobStr).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    let year = parseInt(m[3], 10);
    if (year < 100) year += year > 30 ? 1900 : 2000;
    const dob = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    if (isNaN(dob.getTime())) return null;
    return Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
  };
  const age = computeAge(pax.dob);
  const isMinor = age !== null && age < 18;

  let borderClass;
  if (isSkipped) borderClass = 'border-slate-700 bg-slate-900/30 opacity-60';
  else if (isMatched || isChildVerified) borderClass = 'border-emerald-500/30 bg-emerald-500/5';
  else if (isOverride) borderClass = 'border-amber-500/30 bg-amber-500/5';
  else if (isMismatch) borderClass = 'border-red-500/30 bg-red-500/5';
  else if (isMinor) borderClass = 'border-violet-500/40 bg-violet-500/5';
  else borderClass = 'border-slate-700 bg-slate-900/40 hover:border-cyan-500/40';

  return (
    <div className={`p-3 border ${borderClass}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm ${isSkipped ? 'text-slate-500 line-through' : 'text-slate-100'}`} style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {pax.firstName} {pax.lastName}
            </span>
            {pax.primary && <Pill tone="cyan">PRIMARY</Pill>}
            {isMatched && <Pill tone="green"><Shield className="w-2.5 h-2.5" /> MATCHED</Pill>}
            {isChildVerified && <Pill tone="green"><Users className="w-2.5 h-2.5" /> CHILD ✓</Pill>}
            {isOverride && <Pill tone="amber">OVERRIDE</Pill>}
            {isMismatch && <Pill tone="red">MISMATCH</Pill>}
            {isSkipped && <Pill tone="neutral">SKIPPED</Pill>}
            {!checkedIn && !isSkipped && isMinor && <Pill tone="amber">MINOR · NO ID</Pill>}
            {!checkedIn && !isSkipped && !isMinor && <Pill tone="neutral">PENDING</Pill>}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {pax.gender && <span>{pax.gender}</span>}
            {pax.dob && <span>DOB {pax.dob}{age !== null ? ` (${age} yr)` : ''}</span>}
            {pax.weight && <span>{pax.weight} lbs</span>}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          {!checkedIn && !isSkipped && (
            <>
              <button
                onClick={() => onCheckIn(pax)}
                className={`text-[10px] px-2 py-1 ${isMinor ? 'bg-violet-500 hover:bg-violet-400' : 'bg-cyan-500 hover:bg-cyan-400'} text-slate-950 tracking-widest font-medium`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {isMinor ? 'ADD CHILD' : 'CHECK IN'}
              </button>
              <button
                onClick={() => onSkip(pax)}
                className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-amber-500/40 hover:text-amber-300 tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                title="No-show / not flying"
              >
                SKIP
              </button>
            </>
          )}
          {(isSkipped || checkedIn) && (
            <button
              onClick={() => onSkip(pax)}
              className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300 tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              UNDO
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PassengerRow({ passenger, onRemove, onToggleNoShow }) {
  const expDate = passenger.expiration ? new Date(passenger.expiration) : null;
  const expired = expDate && expDate < new Date();
  const compliant = passenger.realIdCompliant && !expired;
  // Backwards-compat: legacy paxType plus the new documentType field
  const isChild = passenger.paxType === 'CHILD';
  const isLegacyPassport = passenger.paxType === 'PASSPORT';
  const isPassport = isLegacyPassport || passenger.documentType === 'PASSPORT';
  const isPhotoVerified = passenger.idVerified === true;
  const isManualCapture = passenger.paxType === 'MANUAL_CAPTURE';
  const isNoShow = passenger.noShow === true;
  const displayName = (passenger.firstName || passenger.lastName)
    ? `${passenger.firstName} ${passenger.lastName}`.trim()
    : (isManualCapture ? 'PHOTO ONLY' : 'UNKNOWN');

  // Border tone based on type / state
  let borderClass;
  if (isNoShow) borderClass = 'border-slate-700 bg-slate-900/30 opacity-60';
  else if (compliant) borderClass = 'border-emerald-500/30 bg-emerald-500/5';
  else if (isChild) borderClass = 'border-violet-500/40 bg-violet-500/5';
  else if (isPassport) borderClass = 'border-blue-500/40 bg-blue-500/5';
  else if (isManualCapture) borderClass = 'border-amber-500/40 bg-amber-500/5';
  else borderClass = 'border-cyan-500/30 bg-cyan-500/5';

  return (
    <div className={`p-3 border ${borderClass} flex items-start gap-3`}>
      {(passenger.photoUrl || passenger.photo) ? (
        <img src={passenger.photoUrl || passenger.photo} alt="" className="w-12 h-12 object-cover border border-slate-700" />
      ) : (
        <div className="w-12 h-12 border border-slate-700 bg-slate-900 flex items-center justify-center">
          <UserCheck className="w-5 h-5 text-slate-600" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm ${isNoShow ? 'text-slate-500 line-through' : 'text-slate-100'}`} style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
            {displayName}
          </span>
          {isNoShow ? (
            <Pill tone="neutral">NO SHOW</Pill>
          ) : isChild ? (
            <Pill tone="amber"><Users className="w-2.5 h-2.5" /> CHILD</Pill>
          ) : isPassport && isPhotoVerified ? (
            <Pill tone="green"><Shield className="w-2.5 h-2.5" /> PASSPORT VERIFIED</Pill>
          ) : isPassport ? (
            <Pill tone="cyan"><Shield className="w-2.5 h-2.5" /> PASSPORT</Pill>
          ) : isPhotoVerified ? (
            <Pill tone="green"><CheckCircle2 className="w-2.5 h-2.5" /> ID VERIFIED</Pill>
          ) : isManualCapture ? (
            <Pill tone="amber"><Camera className="w-2.5 h-2.5" /> PHOTO</Pill>
          ) : compliant ? (
            <Pill tone="green"><Shield className="w-2.5 h-2.5" /> REAL ID</Pill>
          ) : expired ? (
            <Pill tone="red">EXPIRED</Pill>
          ) : (
            <Pill tone="amber">UNVERIFIED</Pill>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {passenger.dob && <span>DOB {passenger.dob}</span>}
          {passenger.expiration && <span>EXP {passenger.expiration}</span>}
          {passenger.licenseNumber && <span>{passenger.state} {passenger.licenseNumber}</span>}
          <span>· {passenger.method}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {onToggleNoShow && (
          <button
            onClick={() => onToggleNoShow(passenger.id)}
            className={`text-[10px] px-2 py-1 border tracking-widest ${
              isNoShow
                ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                : 'border-slate-700 text-slate-400 hover:border-amber-500/40 hover:text-amber-300'
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title={isNoShow ? 'Mark as showed up' : 'Mark as no-show'}
          >
            {isNoShow ? 'UNDO' : 'NO SHOW'}
          </button>
        )}
        <button
          onClick={onRemove}
          className="text-slate-600 hover:text-red-400 p-1"
          title="Remove"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   My Profile modal — current user edits own profile + signature
   ============================================================ */
// ============================================================
//   REPORTS SECTION — Malfunction/Incident Reports (14 CFR 135.65)
// ============================================================
//
// Crew files Malfunction/Incident Reports per 14 CFR § 135.65 when there is
// a mechanical irregularity or operational incident. The form mirrors the
// paper Skyway Aviation Malfunction/Incident Report.
//
// On submit:
//   - Saves to Firestore `reports` collection
//   - Generates PDF server-side
//   - Emails PDF to: jake@, zack@, jim@, mx@flyskyway.com
//
// Submitted reports are read-only. Admin can delete (test/duplicates only).

function ReportsScreen({ currentUser }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const isAdmin = currentUser?.role === 'admin';

  useEffect(() => {
    let unsub = null;
    let cancelled = false;
    (async () => {
      const m = await import('./firebase-reports.js');
      if (cancelled) return;
      unsub = m.subscribeToAllReports((list) => {
        setReports(list);
        setLoading(false);
      });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  const selected = reports.find(r => r.id === selectedId);

  return (
    <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
      <aside className={`${selected || showNew ? 'hidden md:block' : 'block'} w-full md:w-96 md:border-r md:border-slate-800 overflow-y-auto scroll-area`}>
        <div className="px-4 py-3 border-b border-slate-800 bg-slate-950 sticky top-0 z-10">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs tracking-[0.2em]" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
              MALFUNCTION REPORTS
            </h2>
            <button
              onClick={() => { setShowNew(true); setSelectedId(null); }}
              className="text-[10px] px-2 py-1 bg-red-500 hover:bg-red-400 text-white tracking-widest font-medium"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              + NEW
            </button>
          </div>
          <p className="text-[10px] text-slate-500 mt-1">
            14 CFR § 135.65 record. Auto-emails to jake, zack, jim, mx @flyskyway.com
          </p>
        </div>

        {loading ? (
          <div className="p-8 text-center text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading reports...
          </div>
        ) : reports.length === 0 ? (
          <div className="p-12 text-center">
            <AlertCircle className="w-8 h-8 text-slate-700 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No reports filed yet</p>
            <p className="text-xs text-slate-600 mt-1">
              Tap NEW to file a Malfunction/Incident Report.
            </p>
          </div>
        ) : (
          <div>
            {reports.map(r => (
              <button
                key={r.id}
                onClick={() => { setSelectedId(r.id); setShowNew(false); }}
                className={`block w-full text-left p-3 border-b border-slate-800 ${
                  r.id === selectedId ? 'bg-slate-900/60' : 'hover:bg-slate-900/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-sm text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
                    {r.tail || '?'}
                  </span>
                  <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {r.date || ''}
                  </span>
                </div>
                <div className="text-xs text-slate-300 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  {r.affectedSystem || '(no system)'} — {(r.textOfEvent || '').slice(0, 60)}{(r.textOfEvent || '').length > 60 ? '...' : ''}
                </div>
                <div className="flex gap-2 text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <span>{r.submittedByName}</span>
                  {r.diversion && <span className="text-amber-300">DIV</span>}
                  {r.emergencyDeclared && <span className="text-red-400">EMER</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className={`flex-1 overflow-y-auto scroll-area ${selected || showNew ? 'block' : 'hidden md:block'}`}>
        {showNew ? (
          <NewReport
            currentUser={currentUser}
            onCancel={() => setShowNew(false)}
            onSubmitted={(id) => { setShowNew(false); setSelectedId(id); }}
          />
        ) : selected ? (
          <ReportDetail
            report={selected}
            currentUser={currentUser}
            onBack={() => setSelectedId(null)}
            isAdmin={isAdmin}
          />
        ) : (
          <div className="h-full flex items-center justify-center p-8 grid-bg">
            <div className="text-center max-w-md">
              <div className="w-20 h-20 mx-auto mb-4 border border-slate-800 flex items-center justify-center">
                <AlertCircle className="w-10 h-10 text-slate-700" />
              </div>
              <h2 className="text-2xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                MALFUNCTION REPORTS
              </h2>
              <p className="text-sm text-slate-500">
                Select a report to view, or tap NEW to file one.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function NewReport({ currentUser, onCancel, onSubmitted }) {
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  const [form, setForm] = useState({
    date: today,
    tail: '',
    pic: '',
    sic: '',
    flightMode: '',
    flightConditionIMC: false,  // false=VMC, true=IMC
    flightConditionDay: true,   // true=Day, false=Night
    departureId: '',
    destinationId: '',
    diversion: false,
    divertedTo: '',
    emergencyDeclared: false,
    affectedSystem: '',
    cautionWarningLight: '',
    textOfEvent: '',
    submittedByRole: 'PIC',
    certificateNumber: '',
  });
  const [previewPdfUrl, setPreviewPdfUrl] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const setField = (key) => (val) => setForm(f => ({ ...f, [key]: val }));

  const buildPayload = () => ({
    ...form,
    submittedAt: Date.now(),
    submittedByUid: currentUser?.uid || currentUser?.id,
    submittedByName: currentUser?.name || '',
    submittedByEmail: currentUser?.email || '',
  });

  const previewPdf = async () => {
    setError(null);
    try {
      const r = await fetch('/api/generate-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: buildPayload(), previewOnly: true }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.pdfBase64) {
        setError(`Preview failed: ${data.error || r.status}`);
        return;
      }
      setPreviewPdfUrl(`data:application/pdf;base64,${data.pdfBase64}`);
    } catch (err) {
      setError('Preview failed: ' + err.message);
    }
  };

  const submit = async () => {
    // Required-field validation
    if (!form.tail) { alert('Aircraft Registration is required.'); return; }
    if (!form.pic) { alert('PIC is required.'); return; }
    if (!form.textOfEvent.trim()) { alert('Description of event is required.'); return; }
    if (!form.affectedSystem.trim()) { alert('Affected System is required.'); return; }
    if (!form.certificateNumber.trim()) { alert('Certificate # is required.'); return; }

    if (!window.confirm(
      'Submit this Malfunction/Incident Report?\n\n' +
      'The report will be emailed to:\n' +
      '  • jake@flyskyway.com\n' +
      '  • zack@flyskyway.com\n' +
      '  • jim@flyskyway.com\n' +
      '  • mx@flyskyway.com\n\n' +
      'Once submitted, this record cannot be edited.'
    )) return;

    setSubmitting(true);
    setError(null);
    try {
      const m = await import('./firebase-reports.js');
      const id = m.newReportId();
      const payload = { id, type: 'malfunction', ...buildPayload() };
      // Save to Firestore first (so we have the record even if email fails)
      await m.saveReport(payload);

      // Generate PDF + email
      const r = await fetch('/api/generate-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: payload }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(`Report saved but email failed: ${data.error || r.status}`);
        // Still call onSubmitted so user can see the saved record
        onSubmitted(id);
        return;
      }
      // Update report with email status
      await m.saveReport({
        ...payload,
        pdfEmailedTo: data.recipients || [],
        emailId: data.emailId || null,
        emailError: data.emailError || null,
      });
      onSubmitted(id);
    } catch (err) {
      console.error('[report] submit failed:', err);
      setError(err.message || 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onCancel} className="md:hidden text-slate-500 hover:text-cyan-400 p-1" aria-label="Back">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            NEW MALFUNCTION REPORT
          </h1>
          <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            14 CFR § 135.65 · MALFUNCTION / INCIDENT REPORT
          </div>
        </div>
      </div>

      {error && <div className="border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300">{error}</div>}

      {/* DATE */}
      <RField label="DATE">
        <input
          type="date"
          value={form.date}
          onChange={(e) => setField('date')(e.target.value)}
          className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        />
      </RField>

      {/* AIRCRAFT */}
      <RSection label="AIRCRAFT" />
      <RField label="AIRCRAFT REGISTRATION & TYPE *">
        <select
          value={form.tail}
          onChange={(e) => setField('tail')(e.target.value)}
          className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          <option value="">— Select aircraft —</option>
          {SKYWAY_TAILS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </RField>

      {/* FLIGHT CREW */}
      <RSection label="FLIGHT CREW" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RField label="PIC *">
          <input type="text" value={form.pic} onChange={(e) => setField('pic')(e.target.value)}
            placeholder="Full name" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'DM Sans, sans-serif' }} />
        </RField>
        <RField label="SIC">
          <input type="text" value={form.sic} onChange={(e) => setField('sic')(e.target.value)}
            placeholder="Full name (if applicable)" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'DM Sans, sans-serif' }} />
        </RField>
      </div>

      {/* EVENT */}
      <RSection label="EVENT" />
      <RField label="FLIGHT MODE">
        <input type="text" value={form.flightMode} onChange={(e) => setField('flightMode')(e.target.value)}
          placeholder="e.g., Cruise, Climb, Descent, Taxi" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
          style={{ fontFamily: 'DM Sans, sans-serif' }} />
      </RField>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RField label="FLIGHT CONDITION (IMC/VMC)">
          <RToggle
            options={[{ label: 'IMC', value: true }, { label: 'VMC', value: false }]}
            value={form.flightConditionIMC}
            onChange={(v) => setField('flightConditionIMC')(v)}
          />
        </RField>
        <RField label="FLIGHT CONDITION (DAY/NIGHT)">
          <RToggle
            options={[{ label: 'DAY', value: true }, { label: 'NIGHT', value: false }]}
            value={form.flightConditionDay}
            onChange={(v) => setField('flightConditionDay')(v)}
          />
        </RField>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RField label="DEPARTURE ID">
          <input type="text" value={form.departureId} onChange={(e) => setField('departureId')(e.target.value.toUpperCase())}
            placeholder="ICAO" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'JetBrains Mono, monospace' }} />
        </RField>
        <RField label="DESTINATION ID">
          <input type="text" value={form.destinationId} onChange={(e) => setField('destinationId')(e.target.value.toUpperCase())}
            placeholder="ICAO" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'JetBrains Mono, monospace' }} />
        </RField>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RField label="DIVERSION">
          <RToggle
            options={[{ label: 'YES', value: true }, { label: 'NO', value: false }]}
            value={form.diversion}
            onChange={(v) => setField('diversion')(v)}
          />
        </RField>
        <RField label="EMERGENCY DECLARED">
          <RToggle
            options={[{ label: 'YES', value: true }, { label: 'NO', value: false }]}
            value={form.emergencyDeclared}
            onChange={(v) => setField('emergencyDeclared')(v)}
          />
        </RField>
      </div>

      {form.diversion && (
        <RField label="IF YES, DIVERTED TO">
          <input type="text" value={form.divertedTo} onChange={(e) => setField('divertedTo')(e.target.value.toUpperCase())}
            placeholder="ICAO" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'JetBrains Mono, monospace' }} />
        </RField>
      )}

      {/* DESCRIPTION */}
      <RSection label="DESCRIPTION OF EVENT" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RField label="AFFECTED SYSTEM *">
          <input type="text" value={form.affectedSystem} onChange={(e) => setField('affectedSystem')(e.target.value)}
            placeholder="e.g., Hydraulics, Avionics, Electrical" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'DM Sans, sans-serif' }} />
        </RField>
        <RField label="CAUTION/WARNING LIGHT">
          <input type="text" value={form.cautionWarningLight} onChange={(e) => setField('cautionWarningLight')(e.target.value)}
            placeholder="e.g., HYD PRESS LOW" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'DM Sans, sans-serif' }} />
        </RField>
      </div>

      <RField label="TEXT OF EVENT *">
        <textarea
          value={form.textOfEvent}
          onChange={(e) => setField('textOfEvent')(e.target.value)}
          rows={8}
          placeholder="Describe what happened, when, how the crew responded, and any subsequent observations. Be specific and factual."
          className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        />
      </RField>

      {/* SUBMITTED BY */}
      <RSection label="SUBMITTED BY" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RField label="ROLE">
          <RToggle
            options={[{ label: 'PIC', value: 'PIC' }, { label: 'SIC', value: 'SIC' }]}
            value={form.submittedByRole}
            onChange={(v) => setField('submittedByRole')(v)}
          />
        </RField>
        <RField label="CERTIFICATE # *">
          <input type="text" value={form.certificateNumber} onChange={(e) => setField('certificateNumber')(e.target.value)}
            placeholder="FAA cert number" className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'JetBrains Mono, monospace' }} />
        </RField>
      </div>

      {/* Email recipients reminder */}
      <div className="border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        <div className="text-[10px] tracking-widest text-amber-300 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          ON SUBMIT, PDF WILL BE EMAILED TO:
        </div>
        jake@flyskyway.com · zack@flyskyway.com · jim@flyskyway.com · mx@flyskyway.com
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-800">
        <button
          onClick={previewPdf}
          className="px-4 py-2 border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 text-sm tracking-widest"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          PREVIEW PDF
        </button>
        <button
          onClick={submit}
          disabled={submitting}
          className="px-4 py-2 bg-red-500 hover:bg-red-400 text-white text-sm font-medium tracking-widest disabled:opacity-40"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          {submitting ? 'SUBMITTING...' : 'SUBMIT & EMAIL'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300"
        >
          CANCEL
        </button>
      </div>

      {/* PDF preview modal */}
      {previewPdfUrl && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4" onClick={() => setPreviewPdfUrl(null)}>
          <div className="bg-slate-950 border border-slate-700 max-w-5xl w-full h-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-3 border-b border-slate-800 flex items-center justify-between gap-2">
              <h2 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>REPORT PREVIEW</h2>
              <button onClick={() => setPreviewPdfUrl(null)} className="text-slate-500 hover:text-slate-300 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <iframe src={previewPdfUrl} title="Report PDF" className="flex-1 w-full border-0 bg-slate-900" />
          </div>
        </div>
      )}
    </div>
  );
}

function ReportDetail({ report, currentUser, onBack, isAdmin }) {
  const [previewPdfUrl, setPreviewPdfUrl] = useState(null);
  const [generating, setGenerating] = useState(false);

  const generatePdf = async () => {
    setGenerating(true);
    try {
      const r = await fetch('/api/generate-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report, previewOnly: true }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.pdfBase64) {
        alert('PDF generation failed: ' + (data.error || r.status));
        return;
      }
      setPreviewPdfUrl(`data:application/pdf;base64,${data.pdfBase64}`);
    } finally {
      setGenerating(false);
    }
  };

  const deleteReport = async () => {
    if (!isAdmin) return;
    if (!window.confirm(
      `Delete this Malfunction Report?\n\n${report.tail} · ${report.date}\n\n` +
      `This is permanent and cannot be undone. Use only to remove test/duplicate reports.`
    )) return;
    try {
      const m = await import('./firebase-reports.js');
      await m.deleteReport(report.id);
      onBack();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  };

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="md:hidden text-slate-500 hover:text-cyan-400 p-1" aria-label="Back">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            {report.tail} · {report.date}
          </h1>
          <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            MALFUNCTION REPORT · 14 CFR § 135.65
          </div>
        </div>
        {isAdmin && (
          <button
            onClick={deleteReport}
            className="text-[10px] px-2 py-1 border border-red-500/40 text-red-300 hover:bg-red-500/10 tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            DELETE
          </button>
        )}
      </div>

      {/* Status banner */}
      <div className="border border-emerald-500/40 bg-emerald-500/5 p-3">
        <div className="text-[10px] tracking-widest text-emerald-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          SUBMITTED — RECORD LOCKED
        </div>
        <div className="text-sm text-slate-200 mt-1">
          Submitted by {report.submittedByName} on {new Date(report.submittedAt).toLocaleString()}
        </div>
        {report.pdfEmailedTo && report.pdfEmailedTo.length > 0 && (
          <div className="text-[11px] text-slate-400 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            Emailed to: {report.pdfEmailedTo.join(', ')}
          </div>
        )}
        {report.emailError && (
          <div className="text-[11px] text-red-300 mt-1">
            Email error: {report.emailError}
          </div>
        )}
      </div>

      {/* Read-only display */}
      <div className="space-y-3 text-sm" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        <RDisplay label="Aircraft Registration & Type" value={report.tail} />
        <div className="grid grid-cols-2 gap-3">
          <RDisplay label="PIC" value={report.pic} />
          <RDisplay label="SIC" value={report.sic || '—'} />
        </div>
        <RDisplay label="Flight Mode" value={report.flightMode || '—'} />
        <div className="grid grid-cols-2 gap-3">
          <RDisplay label="Flight Condition" value={report.flightConditionIMC ? 'IMC' : 'VMC'} />
          <RDisplay label="Day/Night" value={report.flightConditionDay ? 'Day' : 'Night'} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <RDisplay label="Departure" value={report.departureId || '—'} />
          <RDisplay label="Destination" value={report.destinationId || '—'} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <RDisplay label="Diversion" value={report.diversion ? `Yes — to ${report.divertedTo || '?'}` : 'No'} />
          <RDisplay label="Emergency Declared" value={report.emergencyDeclared ? 'Yes' : 'No'} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <RDisplay label="Affected System" value={report.affectedSystem} />
          <RDisplay label="Caution/Warning Light" value={report.cautionWarningLight || '—'} />
        </div>
        <div>
          <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            TEXT OF EVENT
          </div>
          <div className="border border-slate-700 bg-slate-900/40 p-3 text-sm text-slate-100 whitespace-pre-wrap">
            {report.textOfEvent}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <RDisplay label="Submitted By Role" value={report.submittedByRole} />
          <RDisplay label="Certificate #" value={report.certificateNumber} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-800">
        <button
          onClick={generatePdf}
          disabled={generating}
          className="px-4 py-2 border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 text-sm tracking-widest disabled:opacity-50"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {generating ? 'GENERATING...' : 'VIEW PDF'}
        </button>
      </div>

      {previewPdfUrl && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4" onClick={() => setPreviewPdfUrl(null)}>
          <div className="bg-slate-950 border border-slate-700 max-w-5xl w-full h-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-3 border-b border-slate-800 flex items-center justify-between gap-2">
              <h2 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>REPORT PDF</h2>
              <a
                href={previewPdfUrl}
                download={`malfunction-${(report.tail || '').replace(/[^A-Z0-9]/gi, '')}-${(report.date || '').replace(/[^0-9]/g, '')}.pdf`}
                className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300 tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                DOWNLOAD
              </a>
              <button onClick={() => setPreviewPdfUrl(null)} className="text-slate-500 hover:text-slate-300 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <iframe src={previewPdfUrl} title="Report PDF" className="flex-1 w-full border-0 bg-slate-900" />
          </div>
        </div>
      )}
    </div>
  );
}

// Small UI helpers for the report form
function RField({ label, children }) {
  return (
    <label className="block">
      <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function RSection({ label }) {
  return (
    <div className="border-t border-slate-700 pt-3 mt-2">
      <div className="text-xs tracking-[0.2em] text-cyan-400" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
        {label}
      </div>
    </div>
  );
}

function RToggle({ options, value, onChange }) {
  return (
    <div className="flex gap-2">
      {options.map(opt => (
        <button
          key={String(opt.value)}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 py-2 px-3 border text-xs tracking-widest ${
            value === opt.value
              ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300'
              : 'border-slate-700 text-slate-400 hover:border-slate-500'
          }`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RDisplay({ label, value }) {
  return (
    <div>
      <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </div>
      <div className="text-sm text-slate-100 px-3 py-2 border border-slate-800 bg-slate-900/40">
        {value || '—'}
      </div>
    </div>
  );
}

// ============================================================
//   WALLET SECTION — Fleet cards + per-user travel bookings
// ============================================================
//
// Two sub-tabs:
//   1. CARDS — fleet credit/fuel cards. All users see these. Only ops + admin
//      can add/edit/delete. Tap a card to reveal full number with audit log.
//   2. TRAVEL — per-user hotel + commercial flight bookings. Each user sees
//      their own. Ops + admin can view and edit any user's travel.

const CARD_TYPES = [
  { value: 'credit', label: 'Credit Card', defaultColor: '#1E40AF', icon: '💳' },
  { value: 'multi-service', label: 'Multi Service Aviation', defaultColor: '#0891B2', icon: '⛽' },
  { value: 'avfuel', label: 'AVfuel', defaultColor: '#15803D', icon: '⛽' },
  { value: 'colt', label: 'Colt International', defaultColor: '#9333EA', icon: '⛽' },
  { value: 'phillips66', label: 'Phillips 66', defaultColor: '#DC2626', icon: '⛽' },
  { value: 'epic', label: 'Epic Card', defaultColor: '#EA580C', icon: '⛽' },
  { value: 'shell', label: 'Shell', defaultColor: '#FCD34D', icon: '⛽' },
  { value: 'fbo', label: 'FBO Card', defaultColor: '#475569', icon: '🏢' },
  { value: 'other', label: 'Other', defaultColor: '#64748B', icon: '💳' },
];

/**
 * ProviderLogo — renders a brand logo from Logo.dev.
 * Falls back gracefully to the provided emoji/text when:
 *   - no domain resolved
 *   - LOGO_DEV_TOKEN not configured
 *   - the image fails to load
 *
 * Props:
 *   domain      string — the brand domain (e.g. 'aa.com')
 *   fallback    ReactNode — what to render when no logo is available
 *   size        number — pixel dimensions (default 40)
 *   theme       'light' | 'dark' (default 'light' — light backgrounds need dark logos)
 *   className   string — extra classes for the wrapper
 *   alt         string — accessible label
 */
function ProviderLogo({ domain, fallback, size = 40, theme = 'light', className = '', alt = '' }) {
  const [errored, setErrored] = useState(false);
  const url = logoUrl(domain, { size, theme });

  if (!url || errored) {
    return <span className={className}>{fallback}</span>;
  }

  return (
    <img
      src={url}
      alt={alt || domain}
      onError={() => setErrored(true)}
      className={className}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
      }}
      loading="lazy"
    />
  );
}

function WalletScreen({ currentUser, users }) {
  const [tab, setTab] = useState('cards'); // 'cards' | 'travel'
  return (
    <div className="flex-1 overflow-y-auto scroll-area">
      <div className="max-w-5xl mx-auto p-4">
        <div className="flex items-center gap-2 mb-4 border-b border-slate-800">
          <button
            onClick={() => setTab('cards')}
            className={`px-4 py-2 text-sm tracking-widest border-b-2 transition-colors ${
              tab === 'cards'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
          >
            CARDS
          </button>
          <button
            onClick={() => setTab('travel')}
            className={`px-4 py-2 text-sm tracking-widest border-b-2 transition-colors ${
              tab === 'travel'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
          >
            TRAVEL
          </button>
        </div>

        {tab === 'cards' && <CardsTab currentUser={currentUser} />}
        {tab === 'travel' && <TravelTab currentUser={currentUser} users={users} />}

        {/* Logo.dev configuration banner — only shown to admins when token is missing */}
        {!LOGO_DEV_CONFIGURED && currentUser?.role === 'admin' && (
          <div className="mt-6 p-3 border border-amber-500/40 bg-amber-500/5 text-xs text-slate-300">
            <div className="text-[10px] tracking-widest text-amber-300 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              LOGOS DISABLED
            </div>
            Logo.dev token not configured. To show provider logos automatically,
            sign up at <a href="https://www.logo.dev" target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline">logo.dev</a> for
            a free publishable key, then set <code className="bg-slate-900 px-1">VITE_LOGO_DEV_TOKEN</code> in your Vercel environment variables.
            Cards and bookings will still display correctly without it (using emoji fallbacks).
          </div>
        )}

        {/* Logo.dev attribution — required for free tier */}
        {LOGO_DEV_CONFIGURED && (
          <div className="mt-6 text-center text-[10px] text-slate-600" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            Logos provided by{' '}
            <a href="https://logo.dev" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-slate-400 underline">
              Logo.dev
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// === CARDS TAB =============================================

function CardsTab({ currentUser }) {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editingCard, setEditingCard] = useState(null);

  const canEdit = ['ops', 'admin'].includes(currentUser?.role);

  useEffect(() => {
    let unsub = null;
    let cancelled = false;
    (async () => {
      const m = await import('./firebase-wallet.js');
      if (cancelled) return;
      unsub = m.subscribeToAllCards((list) => {
        setCards(list);
        setLoading(false);
      });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>FLEET CARDS</h2>
          <p className="text-xs text-slate-500 mt-1">
            Visible to all crew. Tap a card to reveal the full number.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => { setShowNew(true); setEditingCard(null); }}
            className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            + ADD CARD
          </button>
        )}
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading cards...
        </div>
      ) : cards.length === 0 && !showNew ? (
        <div className="border border-dashed border-slate-700 p-12 text-center">
          <Mail className="w-8 h-8 text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No cards yet</p>
          {canEdit && (
            <p className="text-xs text-slate-600 mt-1">
              Tap + ADD CARD to add the first one.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map(card => (
            <FleetCard
              key={card.id}
              card={card}
              canEdit={canEdit}
              onEdit={() => { setEditingCard(card); setShowNew(false); }}
            />
          ))}
        </div>
      )}

      {(showNew || editingCard) && (
        <CardEditModal
          card={editingCard}
          currentUser={currentUser}
          onClose={() => { setShowNew(false); setEditingCard(null); }}
        />
      )}
    </div>
  );
}

function FleetCard({ card, canEdit, onEdit }) {
  const [revealed, setRevealed] = useState(false);
  const typeMeta = CARD_TYPES.find(t => t.value === card.type) || CARD_TYPES[CARD_TYPES.length - 1];
  const color = card.color || typeMeta.defaultColor;
  const isExpired = (() => {
    if (!card.expiration) return false;
    // Expiration format: "MM/YY" or "MM/YYYY" or YYYY-MM
    const parts = String(card.expiration).match(/(\d{1,2})[\/-](\d{2,4})/);
    if (!parts) return false;
    const month = parseInt(parts[1], 10);
    let year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;
    const expDate = new Date(year, month, 0); // last day of month
    return expDate < new Date();
  })();

  const formattedNumber = (num) => {
    if (!num) return '';
    const clean = String(num).replace(/\s+/g, '');
    return clean.replace(/(.{4})/g, '$1 ').trim();
  };

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(card.cardNumber || '');
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  // Resolve a logo domain. For credit cards, detect brand from the BIN
  // (first few digits). For fuel cards, look up from the type.
  const ccBrand = card.type === 'credit' ? detectCardBrand(card.cardNumber) : null;
  const logoDomain = ccBrand?.domain || fuelCardDomain(card.type);
  const logoLabel = ccBrand?.name || typeMeta.label;

  return (
    <div
      className="relative aspect-[1.6/1] rounded-xl shadow-xl overflow-hidden cursor-pointer transition-transform hover:scale-[1.02]"
      style={{
        background: `linear-gradient(135deg, ${color} 0%, ${color}DD 60%, ${color}99 100%)`,
      }}
      onClick={() => setRevealed(r => !r)}
    >
      {/* Top — type label, nickname, brand logo */}
      <div className="absolute top-0 left-0 right-0 p-4 flex items-start justify-between">
        <div>
          <div className="text-[10px] tracking-widest text-white/70 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {logoLabel}
          </div>
          <div className="text-sm font-bold text-white mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {card.nickname || '(unnamed)'}
          </div>
        </div>
        <ProviderLogo
          domain={logoDomain}
          fallback={<span className="text-2xl">{typeMeta.icon}</span>}
          size={40}
          theme="dark"
          alt={logoLabel}
          className="bg-white/95 rounded p-1"
        />
      </div>

      {/* Center — number */}
      <div className="absolute left-0 right-0 top-[55%] -translate-y-1/2 px-4">
        <div className="font-mono text-base tracking-wider text-white" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {revealed && card.cardNumber
            ? formattedNumber(card.cardNumber)
            : `•••• •••• •••• ${card.last4 || '????'}`}
        </div>
      </div>

      {/* Bottom — exp + actions */}
      <div className="absolute bottom-0 left-0 right-0 p-4 flex items-end justify-between">
        <div>
          <div className="text-[9px] tracking-widest text-white/60 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            VALID THRU
          </div>
          <div className={`text-xs ${isExpired ? 'text-red-200' : 'text-white'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {card.expiration || '—'}{isExpired && ' (EXPIRED)'}
          </div>
        </div>
        <div className="flex gap-2">
          {revealed && (
            <button
              onClick={(e) => { e.stopPropagation(); copyNumber(); }}
              className="text-[10px] px-2 py-1 bg-white/20 hover:bg-white/30 text-white tracking-widest backdrop-blur-sm"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              COPY
            </button>
          )}
          {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="text-[10px] px-2 py-1 bg-white/20 hover:bg-white/30 text-white tracking-widest backdrop-blur-sm"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              EDIT
            </button>
          )}
        </div>
      </div>

      {/* Reveal hint */}
      {!revealed && (
        <div className="absolute inset-x-0 bottom-12 text-center">
          <div className="text-[10px] text-white/50 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            TAP TO REVEAL
          </div>
        </div>
      )}

      {/* Decorative chip */}
      <div className="absolute top-1/2 left-4 w-9 h-7 -translate-y-1/2 rounded bg-yellow-300/30 border border-yellow-200/40" style={{ marginTop: '-32px' }} />
    </div>
  );
}

function CardEditModal({ card, currentUser, onClose }) {
  const isNew = !card;
  const [form, setForm] = useState(card || {
    nickname: '',
    type: 'credit',
    cardNumber: '',
    expiration: '',
    billingZip: '',
    pin: '',
    notes: '',
    color: '',
    createdBy: currentUser?.name || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const setField = (key) => (val) => setForm(f => ({ ...f, [key]: val }));

  const save = async () => {
    if (!form.nickname.trim()) { alert('Nickname is required.'); return; }
    if (!form.cardNumber.trim()) { alert('Card number is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const m = await import('./firebase-wallet.js');
      const id = card?.id || m.newCardId();
      await m.saveCard({ ...form, id, createdBy: form.createdBy || currentUser?.name || '' });
      onClose();
    } catch (err) {
      console.error('[wallet] save failed:', err);
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!card) return;
    if (!window.confirm(`Delete the "${card.nickname}" card permanently? This cannot be undone.`)) return;
    setSaving(true);
    try {
      const m = await import('./firebase-wallet.js');
      await m.deleteCard(card.id);
      onClose();
    } catch (err) {
      setError(err.message || 'Delete failed');
    } finally {
      setSaving(false);
    }
  };

  const typeMeta = CARD_TYPES.find(t => t.value === form.type) || CARD_TYPES[0];

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-slate-950 border border-slate-700 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        <div className="p-3 border-b border-slate-800 flex items-center justify-between gap-2">
          <h2 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            {isNew ? 'ADD CARD' : 'EDIT CARD'}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {error && <div className="border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300">{error}</div>}

          <div>
            <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              NICKNAME *
            </label>
            <input
              type="text"
              value={form.nickname}
              onChange={(e) => setField('nickname')(e.target.value)}
              placeholder="e.g., Multi Service Aviation"
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </div>

          <div>
            <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              TYPE
            </label>
            <select
              value={form.type}
              onChange={(e) => setField('type')(e.target.value)}
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {CARD_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              CARD NUMBER *
            </label>
            <input
              type="text"
              value={form.cardNumber}
              onChange={(e) => setField('cardNumber')(e.target.value.replace(/\s+/g, ''))}
              placeholder="1234567890123456"
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                EXPIRATION
              </label>
              <input
                type="text"
                value={form.expiration}
                onChange={(e) => setField('expiration')(e.target.value)}
                placeholder="MM/YY"
                className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                BILLING ZIP
              </label>
              <input
                type="text"
                value={form.billingZip}
                onChange={(e) => setField('billingZip')(e.target.value)}
                placeholder="33101"
                className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                autoComplete="off"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              PIN (OPTIONAL)
            </label>
            <input
              type="text"
              value={form.pin}
              onChange={(e) => setField('pin')(e.target.value)}
              placeholder="For fuel pumps"
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              autoComplete="off"
            />
          </div>

          <div>
            <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              NOTES
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => setField('notes')(e.target.value)}
              rows={2}
              placeholder="e.g., Call to authorize over $5K"
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </div>

          <div>
            <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              CARD COLOR (OPTIONAL — DEFAULT: {typeMeta.defaultColor})
            </label>
            <input
              type="color"
              value={form.color || typeMeta.defaultColor}
              onChange={(e) => setField('color')(e.target.value)}
              className="mt-1 w-full h-10 bg-slate-900/60 border border-slate-700 cursor-pointer"
            />
          </div>
        </div>

        <div className="p-3 border-t border-slate-800 flex flex-wrap gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-50"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          >
            {saving ? 'SAVING...' : 'SAVE CARD'}
          </button>
          {!isNew && (
            <button
              onClick={remove}
              disabled={saving}
              className="px-4 py-2 border border-red-500/40 text-red-300 hover:bg-red-500/10 text-sm tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              DELETE
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 border border-slate-700 text-sm text-slate-300">
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}

// === TRAVEL TAB =============================================

function TravelTab({ currentUser, users }) {
  const isOpsOrAdmin = ['ops', 'admin'].includes(currentUser?.role);
  // For non-ops/admin: always show your own. For ops/admin: pick a user.
  const [selectedUserUid, setSelectedUserUid] = useState(currentUser?.uid || currentUser?.id);
  const targetUser = users.find(u => u.uid === selectedUserUid) || currentUser;
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    let unsub = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const m = await import('./firebase-travel.js');
      if (cancelled) return;
      unsub = m.subscribeToUserBookings(selectedUserUid, (list) => {
        setBookings(list);
        setLoading(false);
      });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [selectedUserUid]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>TRAVEL</h2>
          <p className="text-xs text-slate-500 mt-1">
            Hotels and commercial flights for {targetUser?.name || 'this user'}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isOpsOrAdmin && (
            <select
              value={selectedUserUid}
              onChange={(e) => setSelectedUserUid(e.target.value)}
              className="bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {[...users]
                .filter(u => u.approved !== false)
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                .map(u => (
                  <option key={u.uid} value={u.uid}>{u.name} ({u.role})</option>
                ))}
            </select>
          )}
          {isOpsOrAdmin && (
            <button
              onClick={() => setShowAdd(true)}
              className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              + ADD
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading bookings...
        </div>
      ) : bookings.length === 0 ? (
        <div className="border border-dashed border-slate-700 p-12 text-center">
          <Plane className="w-8 h-8 text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No bookings yet</p>
          {isOpsOrAdmin && (
            <p className="text-xs text-slate-600 mt-1">
              Tap + ADD to upload a confirmation.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {bookings.map(b => (
            b.type === 'flight'
              ? <FlightCard key={b.id} booking={b} canEdit={isOpsOrAdmin} />
              : <HotelCard key={b.id} booking={b} canEdit={isOpsOrAdmin} />
          ))}
        </div>
      )}

      {showAdd && (
        <AddBookingModal
          targetUser={targetUser}
          currentUser={currentUser}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

function FlightCard({ booking, canEdit }) {
  const [showDetail, setShowDetail] = useState(false);
  const fmtTime = (t) => {
    if (!t) return '';
    // "15:25" -> "3:25 PM"
    const [h, m] = String(t).split(':').map(Number);
    if (isNaN(h)) return t;
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m || 0).padStart(2, '0')} ${period}`;
  };
  const fmtDate = (d) => {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <>
      <div
        onClick={() => setShowDetail(true)}
        className="border-l-4 border-emerald-500 bg-slate-900/40 p-4 cursor-pointer hover:bg-slate-900/60 transition-colors"
      >
        <div className="flex items-start justify-between mb-2 gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <ProviderLogo
              domain={cachedAirlineDomain(booking.airline || booking.airlineCode)}
              fallback={<span className="text-3xl">✈</span>}
              size={48}
              theme="dark"
              alt={booking.airline || 'Airline'}
              className="bg-white rounded p-1 shrink-0"
            />
            <div className="min-w-0">
              <div className="text-[10px] tracking-widest text-emerald-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                {booking.airline || 'FLIGHT'}
              </div>
              <h3 className="text-xl mt-1" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                {booking.fromAirport || '?'} → {booking.toAirport || '?'}
              </h3>
              {(booking.fromCity || booking.toCity) && (
                <p className="text-xs text-slate-500 mt-0.5">
                  {booking.fromCity || '?'} to {booking.toCity || '?'}
                </p>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              CONF
            </div>
            <div className="text-sm font-mono text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              {booking.confirmationCode || '—'}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-2 mt-2 flex items-center gap-3">
          <div>
            <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {fmtDate(booking.departureDate)}
            </div>
            <div className="text-sm text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {fmtTime(booking.departureTime)} → {fmtTime(booking.arrivalTime)}
            </div>
          </div>
        </div>

        {booking.passengerName && (
          <div className="text-xs text-slate-400 mt-2">
            <span className="text-slate-500">Passenger:</span> {booking.passengerName}
            {booking.status && <span className="ml-2 text-emerald-400">• {booking.status}</span>}
          </div>
        )}

        {/* MANAGE TRIP button + COPY CONF — opens airline page; conf code copy is one tap */}
        {(() => {
          const ci = buildCheckInUrl(booking);
          if (!ci) return null;
          const conf = String(booking.confirmationCode || '').trim();
          return (
            <div className="mt-3 flex gap-2">
              <a
                href={ci.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex-1 text-center py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold tracking-widest transition-colors"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                title={`Opens ${ci.airline} manage-trip page`}
              >
                MANAGE TRIP ↗
              </a>
              {conf && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                      await navigator.clipboard.writeText(conf);
                      // Briefly indicate success via title; cards rerender often, fine to skip
                      const target = e.currentTarget;
                      const orig = target.textContent;
                      target.textContent = 'COPIED ✓';
                      setTimeout(() => { try { target.textContent = orig; } catch {} }, 1200);
                    } catch (err) {
                      console.error('Copy failed:', err);
                    }
                  }}
                  className="px-3 py-2 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-xs font-bold tracking-widest transition-colors"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  title={`Copy ${conf} to clipboard`}
                >
                  COPY CONF
                </button>
              )}
            </div>
          );
        })()}
      </div>

      {showDetail && (
        <BookingDetailModal
          booking={booking}
          canEdit={canEdit}
          onClose={() => setShowDetail(false)}
        />
      )}
    </>
  );
}

function HotelCard({ booking, canEdit }) {
  const [showDetail, setShowDetail] = useState(false);
  const fmtDate = (d) => {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const nights = (() => {
    if (!booking.checkInDate || !booking.checkOutDate) return null;
    const diff = (new Date(booking.checkOutDate) - new Date(booking.checkInDate)) / (1000 * 60 * 60 * 24);
    return Math.round(diff);
  })();

  return (
    <>
      <div
        onClick={() => setShowDetail(true)}
        className="border-l-4 border-amber-500 bg-slate-900/40 p-4 cursor-pointer hover:bg-slate-900/60 transition-colors"
      >
        <div className="flex items-start justify-between mb-2 gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <ProviderLogo
              domain={cachedHotelDomain(booking.hotelBrand || booking.hotelName)}
              fallback={<span className="text-3xl">🏨</span>}
              size={48}
              theme="dark"
              alt={booking.hotelBrand || booking.hotelName || 'Hotel'}
              className="bg-white rounded p-1 shrink-0"
            />
            <div className="min-w-0">
              <div className="text-[10px] tracking-widest text-amber-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                {booking.hotelBrand || 'HOTEL'}
              </div>
              <h3 className="text-lg mt-1" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                {booking.hotelName || '(unnamed)'}
              </h3>
              {booking.city && (
                <p className="text-xs text-slate-500 mt-0.5">
                  {booking.city}{booking.state ? `, ${booking.state}` : ''}
                </p>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              CONF
            </div>
            <div className="text-sm font-mono text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              {booking.confirmationCode || '—'}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-2 mt-2 flex items-center gap-3">
          <div>
            <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              CHECK-IN → CHECK-OUT
            </div>
            <div className="text-sm text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {fmtDate(booking.checkInDate)} → {fmtDate(booking.checkOutDate)}
              {nights !== null && <span className="text-slate-500 text-xs ml-2">({nights} night{nights === 1 ? '' : 's'})</span>}
            </div>
          </div>
        </div>

        {booking.guestName && (
          <div className="text-xs text-slate-400 mt-2">
            <span className="text-slate-500">Guest:</span> {booking.guestName}
          </div>
        )}

        {/* Hotel actions: directions + phone */}
        {(() => {
          const directionsUrl = buildHotelDirectionsUrl(booking);
          const phoneUrl = buildHotelPhoneUrl(booking);
          if (!directionsUrl && !phoneUrl) return null;
          return (
            <div className="mt-3 flex gap-2">
              {directionsUrl && (
                <a
                  href={directionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 text-center py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold tracking-widest transition-colors"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  DIRECTIONS ↗
                </a>
              )}
              {phoneUrl && (
                <a
                  href={phoneUrl}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 text-center py-2 border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-xs font-bold tracking-widest transition-colors"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  CALL HOTEL
                </a>
              )}
            </div>
          );
        })()}
      </div>

      {showDetail && (
        <BookingDetailModal
          booking={booking}
          canEdit={canEdit}
          onClose={() => setShowDetail(false)}
        />
      )}
    </>
  );
}

function BookingDetailModal({ booking, canEdit, onClose }) {
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!window.confirm('Delete this booking permanently?')) return;
    setDeleting(true);
    try {
      const m = await import('./firebase-travel.js');
      await m.deleteBooking(booking.id);
      onClose();
    } catch (err) {
      alert('Delete failed: ' + err.message);
      setDeleting(false);
    }
  };

  const isFlight = booking.type === 'flight';

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-slate-950 border border-slate-700 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        <div className={`p-4 border-b border-slate-800 ${isFlight ? 'bg-emerald-500/10' : 'bg-amber-500/10'}`}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] tracking-widest text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                {isFlight ? `✈ ${booking.airline || 'FLIGHT'}` : `🏨 ${booking.hotelBrand || 'HOTEL'}`}
              </div>
              <h2 className="text-2xl tracking-wider mt-1" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                {isFlight
                  ? `${booking.fromAirport || '?'} → ${booking.toAirport || '?'}`
                  : booking.hotelName || '(unnamed)'}
              </h2>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-3 text-sm">
          {isFlight ? (
            <>
              <DetailRow label="Confirmation Code" value={booking.confirmationCode} mono />
              <DetailRow label="Ticket Number" value={booking.ticketNumber} mono />
              <DetailRow label="Flight Number" value={booking.flightNumber} mono />
              <DetailRow label="Passenger" value={booking.passengerName} />
              <DetailRow label="From" value={`${booking.fromCity || ''} (${booking.fromAirport || '?'})`} />
              <DetailRow label="To" value={`${booking.toCity || ''} (${booking.toAirport || '?'})`} />
              <DetailRow label="Departure" value={`${booking.departureDate || ''} at ${booking.departureTime || ''}`} mono />
              <DetailRow label="Arrival" value={`${booking.arrivalDate || ''} at ${booking.arrivalTime || ''}`} mono />
              <DetailRow label="Class" value={booking.class} />
              <DetailRow label="Seat" value={booking.seat} mono />
              <DetailRow label="Status" value={booking.status} />
            </>
          ) : (
            <>
              <DetailRow label="Confirmation Code" value={booking.confirmationCode} mono />
              <DetailRow label="Guest" value={booking.guestName} />
              <DetailRow label="Check-in" value={booking.checkInDate} mono />
              <DetailRow label="Check-out" value={booking.checkOutDate} mono />
              <DetailRow label="Address" value={booking.address} />
              <DetailRow label="City" value={`${booking.city || ''}${booking.state ? ', ' + booking.state : ''}`} />
              <DetailRow label="Phone" value={booking.phone} mono />
              <DetailRow label="Room Type" value={booking.roomType} />
              <DetailRow label="Rate" value={booking.rate} />
              <DetailRow label="Total" value={booking.totalPrice} />
            </>
          )}
          {booking.notes && (
            <div className="border border-slate-700 bg-slate-900/40 p-3 text-xs text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                NOTES
              </div>
              {booking.notes}
            </div>
          )}

          {/* Prominent action buttons — large versions of the card-level actions */}
          {isFlight && (() => {
            const ci = buildCheckInUrl(booking);
            if (!ci) return null;
            const conf = String(booking.confirmationCode || '').trim();
            const lastName = (() => {
              const t = String(booking.passengerName || '').trim();
              if (t.includes(',')) return t.split(',')[0].trim();
              const parts = t.split(/\s+/);
              return parts[parts.length - 1] || '';
            })();
            return (
              <>
                <a
                  href={ci.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-base font-bold tracking-widest transition-colors"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  OPEN {ci.airline.toUpperCase()} MANAGE TRIP ↗
                </a>
                {(conf || lastName) && (
                  <div className="grid grid-cols-2 gap-2">
                    {conf && (
                      <button
                        onClick={async (e) => {
                          try {
                            await navigator.clipboard.writeText(conf);
                            const target = e.currentTarget;
                            const orig = target.textContent;
                            target.textContent = 'CONF COPIED ✓';
                            setTimeout(() => { try { target.textContent = orig; } catch {} }, 1500);
                          } catch (err) {
                            console.error('Copy failed:', err);
                          }
                        }}
                        className="py-2 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-sm font-bold tracking-widest"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        COPY CONF · {conf}
                      </button>
                    )}
                    {lastName && (
                      <button
                        onClick={async (e) => {
                          try {
                            await navigator.clipboard.writeText(lastName);
                            const target = e.currentTarget;
                            const orig = target.textContent;
                            target.textContent = 'LAST NAME COPIED ✓';
                            setTimeout(() => { try { target.textContent = orig; } catch {} }, 1500);
                          } catch (err) {
                            console.error('Copy failed:', err);
                          }
                        }}
                        className="py-2 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-sm font-bold tracking-widest"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        COPY · {lastName.toUpperCase()}
                      </button>
                    )}
                  </div>
                )}
                <p className="text-[10px] text-slate-500 text-center" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  Tap above to open the airline. Use COPY buttons to paste your conf code and last name into the airline's form. Online check-in opens 24 hours before departure.
                </p>
              </>
            );
          })()}

          {!isFlight && (() => {
            const directionsUrl = buildHotelDirectionsUrl(booking);
            const phoneUrl = buildHotelPhoneUrl(booking);
            if (!directionsUrl && !phoneUrl) return null;
            return (
              <div className="flex gap-2">
                {directionsUrl && (
                  <a
                    href={directionsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 text-center py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 text-base font-bold tracking-widest transition-colors"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    DIRECTIONS ↗
                  </a>
                )}
                {phoneUrl && (
                  <a
                    href={phoneUrl}
                    className="flex-1 text-center py-3 border-2 border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-base font-bold tracking-widest transition-colors"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    CALL HOTEL
                  </a>
                )}
              </div>
            );
          })()}
        </div>

        {canEdit && (
          <div className="p-3 border-t border-slate-800 flex gap-2">
            <button
              onClick={remove}
              disabled={deleting}
              className="px-4 py-2 border border-red-500/40 text-red-300 hover:bg-red-500/10 text-sm tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {deleting ? 'DELETING...' : 'DELETE'}
            </button>
            <button onClick={onClose} className="flex-1 py-2 border border-slate-700 text-sm text-slate-300">
              CLOSE
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
      <span className="text-[10px] tracking-widest text-slate-500 uppercase shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </span>
      <span className="text-sm text-slate-200 text-right" style={{ fontFamily: mono ? 'JetBrains Mono, monospace' : 'DM Sans, sans-serif' }}>
        {value}
      </span>
    </div>
  );
}

function AddBookingModal({ targetUser, currentUser, onClose }) {
  const [stage, setStage] = useState('upload'); // 'upload' | 'review'
  const [bookingType, setBookingType] = useState('flight');
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);

  const handleFile = async (file) => {
    if (!file) return;
    setParsing(true);
    setError(null);
    try {
      // Read file as base64
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const r = await fetch('/api/parse-travel-confirmation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64,
          mediaType: file.type || 'image/jpeg',
          expectedType: bookingType,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.parsed) {
        setError(`AI extraction failed: ${data.error || r.status}`);
        return;
      }
      if (data.parsed.type === 'unknown') {
        setError(data.parsed.notes || 'Could not determine document type. Try entering manually.');
        return;
      }
      setParsed(data.parsed);
      setBookingType(data.parsed.type); // trust AI's type detection
      setStage('review');
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setParsing(false);
    }
  };

  const startManual = () => {
    setParsed({
      type: bookingType,
      ...(bookingType === 'flight' ? {
        airline: '', confirmationCode: '', passengerName: targetUser?.name || '',
        fromAirport: '', toAirport: '', departureDate: '', departureTime: '',
        arrivalDate: '', arrivalTime: '',
      } : {
        hotelName: '', confirmationCode: '', guestName: targetUser?.name || '',
        checkInDate: '', checkOutDate: '', address: '', city: '', phone: '',
      }),
    });
    setStage('review');
  };

  const save = async () => {
    if (!parsed) return;
    try {
      const m = await import('./firebase-travel.js');
      const id = m.newBookingId(parsed.type);
      const startDate = parsed.type === 'flight' ? parsed.departureDate : parsed.checkInDate;
      await m.saveBooking({
        id,
        userUid: targetUser.uid,
        userName: targetUser.name || '',
        startDate,
        addedBy: currentUser?.name || '',
        ...parsed,
      });
      onClose();
    } catch (err) {
      setError(err.message || 'Save failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-slate-950 border border-slate-700 max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
        <div className="p-3 border-b border-slate-800 flex items-center justify-between gap-2">
          <h2 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            ADD BOOKING FOR {(targetUser?.name || '').toUpperCase()}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {error && <div className="border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300">{error}</div>}

          {stage === 'upload' && (
            <>
              <div>
                <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  BOOKING TYPE
                </label>
                <div className="mt-1 flex gap-2">
                  <button
                    onClick={() => setBookingType('flight')}
                    className={`flex-1 py-3 border text-sm tracking-widest ${
                      bookingType === 'flight'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                        : 'border-slate-700 text-slate-400'
                    }`}
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    ✈ FLIGHT
                  </button>
                  <button
                    onClick={() => setBookingType('hotel')}
                    className={`flex-1 py-3 border text-sm tracking-widest ${
                      bookingType === 'hotel'
                        ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                        : 'border-slate-700 text-slate-400'
                    }`}
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    🏨 HOTEL
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  UPLOAD CONFIRMATION (PDF, IMAGE, OR SCREENSHOT)
                </label>
                <div className="mt-1 border-2 border-dashed border-slate-700 bg-slate-900/40 p-6 text-center hover:border-cyan-500/40 transition-colors">
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => handleFile(e.target.files?.[0])}
                    className="hidden"
                    id="booking-file-upload"
                    disabled={parsing}
                  />
                  <label htmlFor="booking-file-upload" className="cursor-pointer block">
                    {parsing ? (
                      <>
                        <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mx-auto mb-2" />
                        <div className="text-sm text-cyan-300">AI READING CONFIRMATION...</div>
                        <div className="text-xs text-slate-500 mt-1">Usually 3-5 seconds</div>
                      </>
                    ) : (
                      <>
                        <FileText className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                        <div className="text-sm text-slate-300">CHOOSE FILE OR DRAG HERE</div>
                        <div className="text-xs text-slate-500 mt-1">PDF, JPEG, or PNG of the confirmation</div>
                      </>
                    )}
                  </label>
                </div>
              </div>

              <div className="text-center">
                <button
                  onClick={startManual}
                  className="text-xs text-slate-400 hover:text-cyan-300 tracking-widest"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  — OR ENTER MANUALLY —
                </button>
              </div>
            </>
          )}

          {stage === 'review' && parsed && (
            <BookingReview
              parsed={parsed}
              setParsed={setParsed}
              onSave={save}
              onBack={() => setStage('upload')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function BookingReview({ parsed, setParsed, onSave, onBack }) {
  const setField = (key) => (val) => setParsed(p => ({ ...p, [key]: val }));
  const isFlight = parsed.type === 'flight';

  return (
    <div className="space-y-3">
      <div className="text-[10px] tracking-widest text-cyan-300 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
        REVIEW & EDIT
        {parsed.confidence && (
          <span className={`ml-2 ${
            parsed.confidence === 'high' ? 'text-emerald-300' :
            parsed.confidence === 'medium' ? 'text-amber-300' : 'text-red-300'
          }`}>
            (AI confidence: {parsed.confidence})
          </span>
        )}
      </div>

      {isFlight ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="Airline" value={parsed.airline} onChange={setField('airline')} />
            <ReviewField label="Confirmation Code" value={parsed.confirmationCode} onChange={setField('confirmationCode')} mono />
          </div>
          <ReviewField label="Passenger Name" value={parsed.passengerName} onChange={setField('passengerName')} />
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="From Airport" value={parsed.fromAirport} onChange={setField('fromAirport')} mono />
            <ReviewField label="To Airport" value={parsed.toAirport} onChange={setField('toAirport')} mono />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="From City" value={parsed.fromCity} onChange={setField('fromCity')} />
            <ReviewField label="To City" value={parsed.toCity} onChange={setField('toCity')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="Departure Date (YYYY-MM-DD)" value={parsed.departureDate} onChange={setField('departureDate')} mono />
            <ReviewField label="Departure Time (HH:MM)" value={parsed.departureTime} onChange={setField('departureTime')} mono />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="Arrival Date" value={parsed.arrivalDate} onChange={setField('arrivalDate')} mono />
            <ReviewField label="Arrival Time" value={parsed.arrivalTime} onChange={setField('arrivalTime')} mono />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <ReviewField label="Flight #" value={parsed.flightNumber} onChange={setField('flightNumber')} mono />
            <ReviewField label="Seat" value={parsed.seat} onChange={setField('seat')} mono />
            <ReviewField label="Class" value={parsed.class} onChange={setField('class')} />
          </div>
          <ReviewField label="Ticket Number" value={parsed.ticketNumber} onChange={setField('ticketNumber')} mono />
        </>
      ) : (
        <>
          <ReviewField label="Hotel Name" value={parsed.hotelName} onChange={setField('hotelName')} />
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="Brand (optional)" value={parsed.hotelBrand} onChange={setField('hotelBrand')} />
            <ReviewField label="Confirmation Code" value={parsed.confirmationCode} onChange={setField('confirmationCode')} mono />
          </div>
          <ReviewField label="Guest Name" value={parsed.guestName} onChange={setField('guestName')} />
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="Check-in (YYYY-MM-DD)" value={parsed.checkInDate} onChange={setField('checkInDate')} mono />
            <ReviewField label="Check-out (YYYY-MM-DD)" value={parsed.checkOutDate} onChange={setField('checkOutDate')} mono />
          </div>
          <ReviewField label="Address" value={parsed.address} onChange={setField('address')} />
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="City" value={parsed.city} onChange={setField('city')} />
            <ReviewField label="State" value={parsed.state} onChange={setField('state')} mono />
          </div>
          <ReviewField label="Phone" value={parsed.phone} onChange={setField('phone')} mono />
          <div className="grid grid-cols-2 gap-3">
            <ReviewField label="Room Type" value={parsed.roomType} onChange={setField('roomType')} />
            <ReviewField label="Rate" value={parsed.rate} onChange={setField('rate')} />
          </div>
        </>
      )}

      <div className="flex gap-2 pt-3 border-t border-slate-800">
        <button
          onClick={onSave}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          SAVE BOOKING
        </button>
        <button onClick={onBack} className="px-4 py-2 border border-slate-700 text-sm text-slate-300">
          BACK
        </button>
      </div>
    </div>
  );
}

function ReviewField({ label, value, onChange, mono }) {
  return (
    <label className="block">
      <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </span>
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
        style={{ fontFamily: mono ? 'JetBrains Mono, monospace' : 'DM Sans, sans-serif' }}
      />
    </label>
  );
}

function MyProfileModal({ currentUser, onClose, onSave }) {
  const [name, setName] = useState(currentUser?.name || '');
  const [callsign, setCallsign] = useState(currentUser?.callsign || '');
  const [jetinsightName, setJetinsightName] = useState(currentUser?.jetinsightName || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        callsign: callsign.trim(),
        jetinsightName: jetinsightName.trim(),
      });
      onClose();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-slate-950 border border-slate-700 max-w-lg w-full my-8" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>MY PROFILE</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Read-only identity */}
          <div className="space-y-2">
            <div className="flex items-baseline gap-3">
              <div className="w-24 text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>EMAIL</div>
              <div className="text-sm text-slate-300">{currentUser?.email}</div>
            </div>
            <div className="flex items-baseline gap-3">
              <div className="w-24 text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ROLE</div>
              <div className="text-sm text-slate-300">{USER_ROLES[currentUser?.role]?.label || (currentUser?.role || '').toUpperCase()}</div>
            </div>
          </div>

          {/* Editable fields */}
          <FieldInput label="FULL NAME" value={name} onChange={(e) => setName(e.target.value)} />
          <FieldInput label="CALLSIGN" value={callsign} onChange={(e) => setCallsign(e.target.value)} placeholder="e.g. Annalise" />
          <FieldInput label="NAME IN JETINSIGHT" value={jetinsightName} onChange={(e) => setJetinsightName(e.target.value)} placeholder="e.g. Annalise Marie Gonzales" />

          {error && (
            <div className="p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">{error}</div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-medium tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              {saving ? 'SAVING...' : 'SAVE PROFILE'}
            </button>
            <button onClick={onClose} className="px-4 py-3 border border-slate-700 text-sm text-slate-300">
              CANCEL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Drawable signature pad — touch + mouse, outputs a PNG data URL.
function SignaturePad({ onSave, onCancel, height = 160 }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    // Match canvas backing store to display size for crisp lines
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000000';
  }, []);

  const getPoint = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  };

  const start = (e) => {
    e.preventDefault();
    drawingRef.current = true;
    lastRef.current = getPoint(e);
  };
  const move = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const p = getPoint(e);
    const ctx = canvasRef.current.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    if (!hasInk) setHasInk(true);
  };
  const end = () => {
    drawingRef.current = false;
    lastRef.current = null;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    setHasInk(false);
  };

  const save = () => {
    if (!hasInk) return;
    // Resize the signature down to a reasonable size for storage.
    // Max 600x160 — keeps the PNG under ~50KB for typical signatures.
    const src = canvasRef.current;
    const targetW = 600;
    const targetH = 160;
    const tmp = document.createElement('canvas');
    tmp.width = targetW;
    tmp.height = targetH;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, targetW, targetH);
    const dataUrl = tmp.toDataURL('image/png');
    onSave(dataUrl);
  };

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: `${height}px`, touchAction: 'none', backgroundColor: '#fff' }}
        className="border border-slate-600 cursor-crosshair"
        onMouseDown={start}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={end}
        onTouchStart={start}
        onTouchMove={move}
        onTouchEnd={end}
      />
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={!hasInk}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          SAVE SIGNATURE
        </button>
        <button onClick={clear} className="px-4 py-2 border border-slate-700 text-sm text-slate-300 hover:border-amber-500/40">
          CLEAR
        </button>
        <button onClick={onCancel} className="px-4 py-2 border border-slate-700 text-sm text-slate-300">
          CANCEL
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   Settings modal
   ============================================================ */
function TrackingToggle() {
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Subscribe to current state
  useEffect(() => {
    let cancelled = false;
    let unsub = null;
    (async () => {
      try {
        const { db } = await import('./firebase.js');
        const { doc, onSnapshot } = await import('firebase/firestore');
        if (cancelled) return;
        unsub = onSnapshot(doc(db, 'flightaware', 'config'), (snap) => {
          if (cancelled) return;
          if (snap.exists()) {
            const d = snap.data();
            setEnabled(d.trackingEnabled !== false);
          }
        });
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const { db } = await import('./firebase.js');
      const { doc, setDoc } = await import('firebase/firestore');
      const newValue = !enabled;
      await setDoc(doc(db, 'flightaware', 'config'), {
        trackingEnabled: newValue,
        trackingToggledAt: Date.now(),
      }, { merge: true });
      // Optimistic; the subscription will confirm
      setEnabled(newValue);
    } catch (e) {
      setError(e.message || 'Failed to toggle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 p-3 border border-slate-700 bg-slate-900/40 flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          LIVE TRACKING
        </div>
        <div className="text-[11px] text-slate-300 mt-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {enabled
            ? 'Position queries to FlightAware are enabled. Charged per query when tracking tab is viewed.'
            : 'Position queries DISABLED. Map will show offline message.'}
        </div>
        {error && (
          <div className="mt-2 text-[10px] text-red-300">{error}</div>
        )}
      </div>
      <button
        onClick={toggle}
        disabled={busy}
        className={`px-3 py-1.5 text-[10px] tracking-widest border flex-shrink-0 ${enabled ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/5' : 'border-slate-700 text-slate-500'} disabled:opacity-50`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        {busy ? '...' : (enabled ? 'ON' : 'OFF')}
      </button>
    </div>
  );
}

function FlightAwarePanel({ currentUser, allTrips }) {
  const isAdmin = currentUser?.role === 'admin';

  const [endpointStatus, setEndpointStatus] = useState('unknown'); // unknown | registered | error
  const [endpointUrl, setEndpointUrl] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  // Backfill state — tripMeta migration for existing trip-state docs
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillResult, setBackfillResult] = useState(null);

  // Load existing alerts when panel mounts
  const loadAlerts = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingAlerts(true);
    setError(null);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch(`/api/flightaware-alerts?action=list&idToken=${encodeURIComponent(idToken)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAlerts(Array.isArray(data.alerts) ? data.alerts : []);
    } catch (err) {
      setError(err.message || 'Failed to load alerts');
    } finally {
      setLoadingAlerts(false);
    }
  }, [isAdmin]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  // === Backfill tripMeta on all existing trip-state docs ===
  // For each iCal-loaded trip, write tripMeta (tail/from/to/start/legType) to
  // the corresponding trip-state Firestore doc. This is what the FlightAware
  // webhook reads to match incoming events to a trip.
  //
  // Trips that exist in iCal but have no trip-state doc yet: a stub doc gets
  // created with just tripMeta + defaults, so future FA events can match it
  // before any crew member opens the trip.
  const handleBackfillTripMeta = useCallback(async () => {
    if (backfillBusy) return;
    if (!Array.isArray(allTrips) || allTrips.length === 0) {
      setBackfillResult({ ok: false, msg: 'No trips loaded — sync iCal first.' });
      return;
    }
    setBackfillBusy(true);
    setBackfillResult(null);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser.getIdToken();

      // Shape the trips array for the backfill endpoint. Send only the fields
      // the endpoint needs — keeps the payload small for large fleets.
      const trips = allTrips
        .filter(t => t?.uid && t?.info?.tail && t?.info?.from)
        .map(t => ({
          uid: t.uid,
          tail: t.info.tail,
          from: t.info.from,
          to: t.info.to || '',
          start: t.start instanceof Date ? t.start.toISOString() : (t.start || null),
          legType: t.info.legType || 'REVENUE',
        }));

      if (trips.length === 0) {
        setBackfillResult({ ok: false, msg: 'No trips with tail+from to migrate.' });
        setBackfillBusy(false);
        return;
      }

      const r = await fetch('/api/flightaware-backfill-tripmeta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, trips }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      const msg = `${data.updated || 0} updated, ${data.created || 0} created, ${data.skipped || 0} skipped`
        + (data.errors?.length ? `, ${data.errors.length} errors` : '');
      setBackfillResult({ ok: true, msg });
    } catch (err) {
      setBackfillResult({ ok: false, msg: err.message || 'Backfill failed.' });
    } finally {
      setBackfillBusy(false);
    }
  }, [allTrips, backfillBusy]);


  // Check endpoint registration status
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const { db } = await import('./firebase.js');
        const { doc, getDoc } = await import('firebase/firestore');
        const snap = await getDoc(doc(db, 'flightaware', 'config'));
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          setEndpointStatus('registered');
          setEndpointUrl(data.endpointUrl || null);
        } else {
          setEndpointStatus('unknown');
        }
      } catch (err) {
        if (!cancelled) setEndpointStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin]);

  const handleRegisterEndpoint = async () => {
    if (!isAdmin) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/flightaware-set-endpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setEndpointStatus('registered');
      setEndpointUrl(data.webhookUrl);
      setInfo(`Webhook registered: ${data.webhookUrl}`);
    } catch (err) {
      setError(err.message || 'Failed to register endpoint');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateAlert = async (ident) => {
    if (!isAdmin) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/flightaware-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          action: 'create',
          ident,
          events: { out: true, off: true, on: true, in: false },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setInfo(`Alert created for ${ident}`);
      await loadAlerts();
    } catch (err) {
      setError(err.message || `Failed to create alert for ${ident}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAlert = async (alertId, ident) => {
    if (!isAdmin) return;
    if (!window.confirm(`Delete FlightAware alert for ${ident || 'this aircraft'}? You will no longer receive events for it.`)) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/flightaware-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, action: 'delete', alertId }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setInfo('Alert deleted');
      await loadAlerts();
    } catch (err) {
      setError(err.message || 'Failed to delete alert');
    } finally {
      setBusy(false);
    }
  };

  // Map tail → registered alert (so we can show subscribe/unsubscribe per tail)
  const alertByIdent = {};
  for (const a of alerts) {
    if (a.ident) alertByIdent[String(a.ident).toUpperCase()] = a;
  }

  return (
    <section>
      <h3 className="text-xs tracking-widest text-cyan-400 mb-3" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
        FLIGHTAWARE ALERTS
      </h3>

      {info && (
        <div className="mb-3 p-2 border border-emerald-500/40 bg-emerald-500/5 text-xs text-emerald-300">
          {info}
        </div>
      )}
      {error && (
        <div className="mb-3 p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">
          {error}
        </div>
      )}

      {!isAdmin && (
        <div className="p-2 border border-slate-700 bg-slate-900/40 text-[11px] text-slate-500">
          Only admins can configure FlightAware alerts.
        </div>
      )}

      {isAdmin && (
        <>
          {/* Live tracking kill switch */}
          <TrackingToggle />

          {/* Endpoint registration */}
          <div className="mb-3 p-3 border border-slate-700 bg-slate-900/40">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div>
                <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  WEBHOOK ENDPOINT
                </div>
                <div className="text-[11px] text-slate-300 mt-1 break-all" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {endpointUrl || 'Not registered yet'}
                </div>
              </div>
              <Pill tone={endpointStatus === 'registered' ? 'green' : 'amber'}>
                {endpointStatus === 'registered' ? 'REGISTERED' : 'NOT REGISTERED'}
              </Pill>
            </div>
            <button
              onClick={handleRegisterEndpoint}
              disabled={busy}
              className="w-full py-2 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-xs tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {busy ? 'WORKING...' : endpointStatus === 'registered' ? 'RE-REGISTER ENDPOINT' : 'REGISTER ENDPOINT'}
            </button>
            <p className="text-[10px] text-slate-500 mt-2" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              Tells FlightAware where to POST flight events. Do this once before subscribing tails.
            </p>
          </div>

          {/* Backfill tripMeta — writes routing info to all existing trips so
              the FA webhook can match events to them. One-click migration tool. */}
          <div className="border border-slate-800 p-3 mb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                TRIP METADATA
              </div>
            </div>
            <button
              onClick={handleBackfillTripMeta}
              disabled={backfillBusy}
              className="w-full py-2 border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-xs tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {backfillBusy ? 'WORKING...' : 'BACKFILL TRIP META'}
            </button>
            <p className="text-[10px] text-slate-500 mt-2" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              Writes route/tail/start info to every active trip so FlightAware events can auto-fire status updates and emails. Run this once after deploying.
            </p>
            {backfillResult && (
              <div
                className={`mt-2 px-2 py-1 text-[10px] border ${backfillResult.ok ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/5' : 'border-amber-500/40 text-amber-300 bg-amber-500/5'}`}
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {backfillResult.msg}
              </div>
            )}
          </div>

          {/* Per-tail alert subscriptions */}
          <div className="mb-2 text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            FLEET SUBSCRIPTIONS
          </div>
          {loadingAlerts ? (
            <div className="text-xs text-slate-500 flex items-center gap-2 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading alerts...
            </div>
          ) : (
            <div className="space-y-1.5">
              {SKYWAY_TAILS.map(tail => {
                const alert = alertByIdent[tail.toUpperCase()];
                return (
                  <div key={tail} className="flex items-center justify-between gap-2 p-2 border border-slate-800 bg-slate-900/30">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                        {tail}
                      </span>
                      {alert && (
                        <Pill tone="green">SUBSCRIBED</Pill>
                      )}
                    </div>
                    {alert ? (
                      <button
                        onClick={() => handleDeleteAlert(alert.id, tail)}
                        disabled={busy}
                        className="text-[10px] tracking-widest text-red-400 hover:text-red-300 disabled:opacity-50"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        UNSUBSCRIBE
                      </button>
                    ) : (
                      <button
                        onClick={() => handleCreateAlert(tail)}
                        disabled={busy || endpointStatus !== 'registered'}
                        className="text-[10px] tracking-widest text-cyan-400 hover:text-cyan-300 disabled:opacity-30"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}
                        title={endpointStatus !== 'registered' ? 'Register endpoint first' : 'Subscribe to alerts for this tail'}
                      >
                        SUBSCRIBE
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-[10px] text-slate-500 mt-3" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            Subscribed tails will trigger flight-events for block-out, wheels-up, and wheels-down. Events accumulate at <code className="text-slate-400">flight-events</code> in Firestore. Auto-status and broker email wiring ship in the next release.
          </p>
        </>
      )}
    </section>
  );
}

function QuickBooksConnectionPanel({ currentUser }) {
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  const isAdmin = currentUser?.role === 'admin';

  // Subscribe to connection state. Non-admin still sees the panel but it's
  // read-only and the Connect/Disconnect buttons are hidden.
  useEffect(() => {
    let unsub = null;
    let cancelled = false;
    (async () => {
      try {
        const m = await import('./firebase-quickbooks.js');
        if (cancelled) return;
        unsub = m.subscribeToQuickBooksConnection((conn) => {
          setConnection(conn);
          setLoading(false);
        });
      } catch (err) {
        console.error('[qbo-panel] subscribe failed:', err);
        setError(err.message || 'Failed to load connection state');
        setLoading(false);
      }
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  // After OAuth roundtrip, Intuit's redirect adds ?qbo=connected (or =error)
  // to the URL. Surface a one-time toast and clean the params.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const qboParam = params.get('qbo');
    const msg = params.get('msg');
    if (qboParam === 'connected') {
      setInfo(msg ? `Connected to ${msg}` : 'Connected to QuickBooks.');
    } else if (qboParam === 'error') {
      setError(msg || 'QuickBooks connection failed.');
    }
    if (qboParam) {
      // Strip the params + hash so refreshing the page doesn't re-show the toast
      params.delete('qbo');
      params.delete('msg');
      const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
      window.history.replaceState({}, '', cleanUrl);
    }
  }, []);

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const m = await import('./firebase-quickbooks.js');
      const url = await m.buildOAuthStartUrl();
      // Hard redirect — Intuit's auth page replaces the current tab
      window.location.href = url;
    } catch (err) {
      console.error('[qbo-panel] connect failed:', err);
      setError(err.message || 'Failed to start OAuth flow');
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm(
      'Disconnect QuickBooks?\n\n' +
      'This revokes the access token at Intuit and removes the connection ' +
      'from Skyway. You\'ll need to re-authorize to push expenses again. ' +
      'Existing pushed expenses are unaffected.'
    )) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const m = await import('./firebase-quickbooks.js');
      const result = await m.disconnectQuickBooks();
      setInfo(result.message || 'Disconnected.');
    } catch (err) {
      console.error('[qbo-panel] disconnect failed:', err);
      setError(err.message || 'Disconnect failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3 className="text-xs tracking-widest text-cyan-400 mb-3" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
        QUICKBOOKS ONLINE
      </h3>

      {info && (
        <div className="mb-3 p-2 border border-emerald-500/40 bg-emerald-500/5 text-xs text-emerald-300">
          {info}
        </div>
      )}
      {error && (
        <div className="mb-3 p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-slate-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking connection...
        </div>
      ) : connection?.connected ? (
        <div className="space-y-2">
          <div className="p-3 border border-emerald-500/40 bg-emerald-500/5">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                {connection.companyName || 'Connected'}
              </span>
              <Pill tone={connection.environment === 'production' ? 'green' : 'amber'}>
                {(connection.environment || 'sandbox').toUpperCase()}
              </Pill>
            </div>
            <div className="text-[10px] text-slate-500 space-y-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {connection.realmId && <div>Realm ID: {connection.realmId}</div>}
              {connection.connectedByName && <div>Connected by: {connection.connectedByName}</div>}
              {connection.connectedAt && <div>Connected: {new Date(connection.connectedAt).toLocaleString()}</div>}
              {connection.refreshTokenExpiresAt && (() => {
                const days = Math.floor((connection.refreshTokenExpiresAt - Date.now()) / (24 * 3600 * 1000));
                const label = days <= 0
                  ? 'EXPIRED — reconnect required'
                  : days < 7
                  ? `Expires in ${days} day${days === 1 ? '' : 's'} — reconnect soon`
                  : `Refresh token valid for ${days} more day${days === 1 ? '' : 's'}`;
                const colorClass = days <= 0 ? 'text-red-300' : days < 7 ? 'text-amber-300' : 'text-slate-500';
                return <div className={colorClass}>{label}</div>;
              })()}
            </div>
          </div>
          {isAdmin && (
            <button
              onClick={handleDisconnect}
              disabled={busy}
              className="w-full py-2 border border-red-500/40 text-red-300 hover:bg-red-500/10 text-xs tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {busy ? 'WORKING...' : 'DISCONNECT'}
            </button>
          )}
          <p className="text-[10px] text-slate-500" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            Approved expenses can be pushed to QuickBooks from the EXPENSES tab. The push attempts to match each receipt against an existing bank-feed transaction in QBO; reimbursements are pushed as Bills payable to the submitter.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            Connect a QuickBooks Online company to push approved expenses directly. The connection is shared by all users — only one company at a time.
          </p>
          {isAdmin ? (
            <button
              onClick={handleConnect}
              disabled={busy}
              className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-medium tracking-widest"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              {busy ? 'OPENING INTUIT...' : 'CONNECT QUICKBOOKS'}
            </button>
          ) : (
            <div className="p-2 border border-slate-700 bg-slate-900/40 text-[11px] text-slate-500">
              Only admins can connect or disconnect QuickBooks. Ask an admin to set this up.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SettingsModal({ config, setConfig, onClose, onLoadDemo, onLoadFromUrl, onLoadFromText, syncStatus, currentUser, allTrips }) {
  const [icalUrl, setIcalUrl] = useState(config.icalUrl || '');
  const [icalText, setIcalText] = useState('');
  const [crewName, setCrewName] = useState(config.crewName || '');
  const [textMode, setTextMode] = useState(false);

  const save = async () => {
    const next = { ...config, icalUrl, crewName };
    await storage.set('settings:config', next);
    setConfig(next);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-950 border border-slate-700 max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-950">
          <h2 className="text-base tracking-widest" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>OPS CONFIGURATION</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <section>
            <h3 className="text-xs tracking-widest text-cyan-400 mb-3" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              CREW IDENTITY
            </h3>
            <label className="block">
              <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>YOUR CALLSIGN / NAME</span>
              <input
                type="text"
                value={crewName}
                onChange={e => setCrewName(e.target.value)}
                placeholder="CAPT SMITH"
                className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
              <span className="text-[11px] text-slate-500 mt-1 block">Shown next to chat messages and status events.</span>
            </label>
          </section>

          <section>
            <h3 className="text-xs tracking-widest text-cyan-400 mb-3" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              ICAL FEED
            </h3>
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setTextMode(false)}
                className={`flex-1 py-2 text-xs tracking-widest border ${!textMode ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10' : 'border-slate-700 text-slate-400'}`}
                style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
              >URL</button>
              <button
                onClick={() => setTextMode(true)}
                className={`flex-1 py-2 text-xs tracking-widest border ${textMode ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10' : 'border-slate-700 text-slate-400'}`}
                style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
              >PASTE TEXT</button>
            </div>
            {!textMode ? (
              <label className="block">
                <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>FEED URL (.ics)</span>
                <input
                  type="url"
                  value={icalUrl}
                  onChange={e => setIcalUrl(e.target.value)}
                  placeholder="https://scheduler.example.com/feed.ics"
                  className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
                <span className="text-[11px] text-slate-500 mt-1 block">
                  Direct fetch requires CORS-enabled feeds. If the URL fails, paste the .ics content directly.
                </span>
                <button
                  onClick={async () => { await save(); onLoadFromUrl(icalUrl); }}
                  disabled={!icalUrl}
                  className="mt-2 w-full py-2 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 disabled:opacity-50 text-cyan-300 text-xs tracking-widest"
                  style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
                >SYNC FROM URL</button>
              </label>
            ) : (
              <label className="block">
                <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PASTE ICAL CONTENT</span>
                <textarea
                  value={icalText}
                  onChange={e => setIcalText(e.target.value)}
                  rows={6}
                  placeholder="BEGIN:VCALENDAR..."
                  className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-cyan-400 resize-none"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
                <button
                  onClick={async () => { await save(); onLoadFromText(icalText); }}
                  disabled={!icalText.trim()}
                  className="mt-2 w-full py-2 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 disabled:opacity-50 text-cyan-300 text-xs tracking-widest"
                  style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
                >IMPORT TEXT</button>
              </label>
            )}
            <button
              onClick={onLoadDemo}
              className="mt-3 w-full py-2 border border-slate-700 hover:border-slate-500 text-slate-300 text-xs tracking-widest flex items-center justify-center gap-2"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
            >
              <Sparkles className="w-3.5 h-3.5" /> LOAD DEMO TRIPS
            </button>
          </section>

          <FlightAwarePanel currentUser={currentUser} allTrips={allTrips} />

          <QuickBooksConnectionPanel currentUser={currentUser} />

          <button
            onClick={async () => { await save(); onClose(); }}
            className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-medium tracking-widest"
            style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
          >
            SAVE CONFIGURATION
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Login screen
   ============================================================ */
function LoginScreen({ initialMode = 'login' }) {
  const [mode, setMode] = useState(initialMode); // 'login' | 'signup' | 'reset'
  const [form, setForm] = useState({
    email: '', password: '', passwordConfirm: '',
    name: '', callsign: '', jetinsightName: '',
  });
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const setField = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleLogin = async () => {
    if (!form.email || !form.password) {
      setError('Email and password required');
      return;
    }
    setError(''); setInfo(''); setSubmitting(true);
    try {
      const { signIn } = await import('./firebase-auth.js');
      await signIn(form.email, form.password);
      // Auth state listener will take over from here
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignUp = async () => {
    if (!form.email || !form.password) {
      setError('Email and password required');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (form.password !== form.passwordConfirm) {
      setError('Passwords do not match');
      return;
    }
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setError(''); setInfo(''); setSubmitting(true);
    try {
      const { signUp } = await import('./firebase-auth.js');
      const result = await signUp({
        email: form.email,
        password: form.password,
        name: form.name,
        callsign: form.callsign,
        jetinsightName: form.jetinsightName,
      });
      // Auth state listener will pick up the new user
      if (result.isFirstUser) {
        setInfo('Welcome! As the first user, you have admin access.');
      } else {
        setInfo('Account created. An admin will approve your account before you can sign in.');
      }
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async () => {
    if (!form.email) {
      setError('Enter your email first');
      return;
    }
    setError(''); setInfo(''); setSubmitting(true);
    try {
      const { requestPasswordReset } = await import('./firebase-auth.js');
      await requestPasswordReset(form.email);
      setInfo('Password reset email sent. Check your inbox.');
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        body { font-family: 'DM Sans', sans-serif; }
        .grid-bg-login {
          background-image:
            linear-gradient(rgba(148, 163, 184, 0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148, 163, 184, 0.04) 1px, transparent 1px);
          background-size: 32px 32px;
        }
      `}</style>
      <div className="absolute inset-0 grid-bg-login pointer-events-none" />
      <div className="max-w-md w-full relative">
        <div className="text-center mb-8">
          <img
            src="/skyway-logo.png"
            srcSet="/skyway-logo.png 1x, /skyway-logo@2x.png 2x"
            alt="Skyway Aviation"
            className="mx-auto mb-4 h-16 w-auto"
          />
          <p className="text-[10px] tracking-[0.3em] text-slate-500 mt-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            OPS CONSOLE · SECURE LOGIN
          </p>
        </div>

        {error && (
          <div className="mb-3 p-3 border border-red-500/40 bg-red-500/10 text-red-300 text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>{error}</div>
          </div>
        )}
        {info && (
          <div className="mb-3 p-3 border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 text-xs flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <div>{info}</div>
          </div>
        )}

        {mode === 'login' && (
          <div className="space-y-3">
            <div className="text-[10px] tracking-widest text-slate-500 uppercase mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              SIGN IN
            </div>
            <FieldInput label="EMAIL" type="email" value={form.email} onChange={setField('email')} placeholder="you@flyskyway.com" autoComplete="email" />
            <FieldInput label="PASSWORD" type="password" value={form.password} onChange={setField('password')} placeholder="••••••••" autoComplete="current-password" />
            <button
              onClick={handleLogin}
              disabled={submitting}
              className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 tracking-widest mt-2"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'SIGN IN'}
            </button>
            <div className="flex items-center justify-between gap-3 pt-1">
              <button onClick={() => { setMode('reset'); setError(''); setInfo(''); }} className="text-xs text-slate-500 hover:text-slate-300">
                Forgot password?
              </button>
              <button onClick={() => { setMode('signup'); setError(''); setInfo(''); }} className="text-xs text-cyan-400 hover:text-cyan-300">
                Create account →
              </button>
            </div>
          </div>
        )}

        {mode === 'signup' && (
          <div className="space-y-3">
            <div className="text-[10px] tracking-widest text-slate-500 uppercase mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              CREATE ACCOUNT
            </div>
            <FieldInput label="FULL NAME *" value={form.name} onChange={setField('name')} placeholder="Captain John Smith" />
            <FieldInput label="EMAIL *" type="email" value={form.email} onChange={setField('email')} placeholder="you@flyskyway.com" autoComplete="email" />
            <FieldInput label="PASSWORD * (min 8 chars)" type="password" value={form.password} onChange={setField('password')} placeholder="••••••••" autoComplete="new-password" />
            <FieldInput label="CONFIRM PASSWORD *" type="password" value={form.passwordConfirm} onChange={setField('passwordConfirm')} placeholder="••••••••" autoComplete="new-password" />
            <FieldInput label="CALLSIGN" value={form.callsign} onChange={setField('callsign')} placeholder="CAPT SMITH" />
            <FieldInput label="NAME IN JETINSIGHT" value={form.jetinsightName} onChange={setField('jetinsightName')} placeholder="John Michael Smith" />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Use your full name as it appears in JetInsight PIC/SIC fields, so the system can match you to your assigned trips.
            </p>
            <button
              onClick={handleSignUp}
              disabled={submitting}
              className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 tracking-widest mt-2"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'CREATE ACCOUNT'}
            </button>
            <button onClick={() => { setMode('login'); setError(''); setInfo(''); }} className="w-full py-2 text-sm text-slate-500 hover:text-slate-300">
              ← Back to sign in
            </button>
          </div>
        )}

        {mode === 'reset' && (
          <div className="space-y-3">
            <div className="text-[10px] tracking-widest text-slate-500 uppercase mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              RESET PASSWORD
            </div>
            <p className="text-xs text-slate-400">Enter your email; we'll send you a link to set a new password.</p>
            <FieldInput label="EMAIL" type="email" value={form.email} onChange={setField('email')} placeholder="you@flyskyway.com" autoComplete="email" />
            <button
              onClick={handleReset}
              disabled={submitting}
              className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 tracking-widest mt-2"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'SEND RESET EMAIL'}
            </button>
            <button onClick={() => { setMode('login'); setError(''); setInfo(''); }} className="w-full py-2 text-sm text-slate-500 hover:text-slate-300">
              ← Back to sign in
            </button>
          </div>
        )}

        <div className="mt-8 p-3 border border-cyan-500/20 bg-cyan-500/5">
          <div className="text-[10px] tracking-widest text-cyan-300 mb-1 flex items-center gap-1.5" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            <CheckCircle2 className="w-3 h-3" /> SECURE LOGIN
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Authentication powered by Firebase. Passwords are securely hashed; new accounts require email verification.
            Pilot accounts must be approved by an admin before access is granted.
          </p>
        </div>
      </div>
    </div>
  );
}

/* Translates Firebase error codes into human-readable messages. */
function prettyAuthError(err) {
  const code = err?.code || '';
  const map = {
    'auth/email-already-in-use': 'An account with this email already exists. Try signing in instead.',
    'auth/invalid-email': 'That email address looks invalid.',
    'auth/weak-password': 'Password is too weak. Use at least 8 characters.',
    'auth/user-not-found': 'No account with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/too-many-requests': 'Too many failed attempts. Try again in a few minutes.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/user-disabled': 'This account has been disabled.',
  };
  return map[code] || err?.message || 'Something went wrong. Please try again.';
}

/* Screen shown when user is signed in but email is not yet verified. */
function VerificationScreen({ user, profile, onSignOut }) {
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  const handleResend = async () => {
    setSubmitting(true); setError(''); setInfo('');
    try {
      const { resendVerification } = await import('./firebase-auth.js');
      await resendVerification();
      setInfo('Verification email re-sent. Check your inbox (including spam).');
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefresh = async () => {
    setSubmitting(true); setError(''); setInfo('');
    try {
      const { refreshVerification } = await import('./firebase-auth.js');
      const verified = await refreshVerification();
      if (!verified) {
        setError("Email is still not verified. Click the link in the email we sent you, then come back and tap 'I've verified'.");
      }
      // If verified, watchAuth will move us to next state automatically
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-slate-100">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <img src="/skyway-logo.png" srcSet="/skyway-logo.png 1x, /skyway-logo@2x.png 2x" alt="Skyway Aviation" className="mx-auto mb-4 h-16 w-auto" />
        </div>
        <div className="border border-cyan-500/30 bg-cyan-500/5 p-5">
          <h2 className="text-xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>VERIFY YOUR EMAIL</h2>
          <p className="text-sm text-slate-300 leading-relaxed mb-4">
            We sent a verification link to <strong className="text-cyan-300">{user.email}</strong>. Click the link in that email, then tap "I've verified" below.
          </p>
          {info && <div className="mb-3 p-2 border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 text-xs">{info}</div>}
          {error && <div className="mb-3 p-2 border border-red-500/40 bg-red-500/10 text-red-300 text-xs">{error}</div>}
          <div className="space-y-2">
            <button onClick={handleRefresh} disabled={submitting} className="w-full py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm tracking-widest disabled:opacity-50" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "I'VE VERIFIED — CONTINUE"}
            </button>
            <button onClick={handleResend} disabled={submitting} className="w-full py-2 border border-slate-700 hover:border-slate-500 text-xs tracking-widest text-slate-300">
              RESEND VERIFICATION EMAIL
            </button>
            <button onClick={onSignOut} className="w-full py-2 text-xs text-slate-500 hover:text-slate-300">
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Screen shown when user is verified but profile.approved is false. */
function PendingApprovalScreen({ user, profile, onSignOut }) {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-slate-100">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <img src="/skyway-logo.png" srcSet="/skyway-logo.png 1x, /skyway-logo@2x.png 2x" alt="Skyway Aviation" className="mx-auto mb-4 h-16 w-auto" />
        </div>
        <div className="border border-cyan-500/30 bg-cyan-500/5 p-5">
          <h2 className="text-xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>AWAITING APPROVAL</h2>
          <p className="text-sm text-slate-300 leading-relaxed mb-4">
            Thanks <strong className="text-cyan-300">{profile.name}</strong>! Your email is verified. An admin needs to approve your account before you can access trips.
          </p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            This usually happens quickly during business hours. You can close this page; you'll be approved next time you sign in.
          </p>
          <button onClick={onSignOut} className="w-full py-2 border border-slate-700 hover:border-slate-500 text-xs tracking-widest text-slate-300">
            SIGN OUT
          </button>
        </div>
      </div>
    </div>
  );
}

/* Screen shown when user is signed in but their Firestore profile is missing. */
function NoProfileScreen({ user, onSignOut }) {
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [diagnostic, setDiagnostic] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { getLastDiagnostic } = await import('./firebase-auth.js');
        const diag = getLastDiagnostic();
        if (diag) setDiagnostic(diag);
      } catch (err) {
        console.warn('Could not load diagnostic', err);
      }
    })();
  }, []);

  const handleRepair = async () => {
    setRepairing(true);
    setError(''); setInfo('');
    try {
      const { repairProfile } = await import('./firebase-auth.js');
      await repairProfile();
      setInfo('Profile created. Refreshing...');
      // The auth listener should pick up the new profile and move us forward.
      // If it doesn't within 2s, force a reload.
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setError(err.message || 'Repair failed');
    } finally {
      setRepairing(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-slate-100">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <img src="/skyway-logo.png" srcSet="/skyway-logo.png 1x, /skyway-logo@2x.png 2x" alt="Skyway Aviation" className="mx-auto mb-4 h-16 w-auto" />
        </div>
        <div className="border border-cyan-500/30 bg-cyan-500/5 p-5">
          <h2 className="text-xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>SET UP YOUR PROFILE</h2>
          <p className="text-sm text-slate-300 leading-relaxed mb-4">
            Signed in as <strong className="text-cyan-300">{user.email}</strong>, but your profile hasn't been created yet. Tap below to set it up.
          </p>

          {error && (
            <div className="mb-3 p-2 border border-red-500/40 bg-red-500/10 text-red-300 text-xs">
              <div className="font-mono">{error}</div>
              {diagnostic && (
                <div className="mt-2 pt-2 border-t border-red-500/20 text-[10px] text-red-400">
                  Diagnostic: {diagnostic.stage} · {diagnostic.code || 'no-code'}
                </div>
              )}
            </div>
          )}
          {info && (
            <div className="mb-3 p-2 border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 text-xs">{info}</div>
          )}

          <div className="space-y-2">
            <button
              onClick={handleRepair}
              disabled={repairing}
              className="w-full py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              {repairing ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'CREATE MY PROFILE'}
            </button>
            <button
              onClick={() => window.location.reload()}
              className="w-full py-2 border border-slate-700 hover:border-slate-500 text-xs tracking-widest text-slate-300"
            >
              REFRESH
            </button>
            <button onClick={onSignOut} className="w-full py-2 text-xs text-slate-500 hover:text-slate-300">
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Top navigation (post-login chrome)
   ============================================================ */
function TopNav({ currentSection, setCurrentSection, currentUser, onLogout, syncStatus, now, tripCount, onOpenSettings, onOpenProfile }) {
  const sections = [
    { id: 'schedule', label: 'SCHEDULE',  icon: Calendar, roles: ['crew', 'ops', 'admin'] },
    { id: 'tracking', label: 'TRACKING',  icon: Plane,    roles: ['ops', 'admin'] },
    { id: 'archive',  label: 'ARCHIVE',   icon: Hash,     roles: ['crew', 'ops', 'admin'] },
    { id: 'expenses', label: 'EXPENSES',  icon: Mail,     roles: ['crew', 'sales', 'ops', 'accounting', 'admin'] },
    { id: 'manifests',label: 'MANIFESTS', icon: FileText, roles: ['crew', 'ops', 'admin'] },
    { id: 'reports',  label: 'REPORT',    icon: AlertCircle, roles: ['crew', 'ops', 'admin'] },
    { id: 'wallet',   label: 'WALLET',    icon: Mail, roles: ['crew', 'sales', 'ops', 'accounting', 'admin'] },
    { id: 'ops',      label: 'OPS',       icon: Zap,      roles: ['ops', 'admin'] },
    { id: 'users',    label: 'USERS',     icon: Users,    roles: ['ops', 'admin'] },
  ];
  const allowed = sections.filter(s => s.roles.includes(currentUser.role));

  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-30">
      <div className="px-4 md:px-6 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <img
              src="/skyway-logo-nav.png"
              srcSet="/skyway-logo-nav.png 1x, /skyway-logo-nav@2x.png 2x"
              alt="Skyway Aviation"
              className="h-8 w-auto block"
            />
            <div className="text-[10px] text-slate-500 tracking-widest mt-1 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {(() => {
                // Show the user's device-local time. No airport context here —
                // this is "current wall-clock time on your phone." Format:
                //  "6:30 PM EDT · 07 MAY 2026"
                const time = new Intl.DateTimeFormat('en-US', {
                  hour: 'numeric', minute: '2-digit', hour12: true,
                }).format(now);
                const tzAbbr = new Intl.DateTimeFormat('en-US', {
                  timeZoneName: 'short',
                }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value || '';
                return `${time}${tzAbbr ? ' ' + tzAbbr : ''} · ${fmtDateZ(now)}`;
              })()}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {syncStatus.status === 'ok' && (
            <Pill tone="green"><Wifi className="w-2.5 h-2.5" /> SYNC</Pill>
          )}
          {syncStatus.status === 'syncing' && (
            <Pill tone="amber"><Loader2 className="w-2.5 h-2.5 animate-spin" /> SYNC</Pill>
          )}
          {syncStatus.status === 'error' && (
            <Pill tone="red"><WifiOff className="w-2.5 h-2.5" /> SYNC</Pill>
          )}
          <button
            onClick={onOpenProfile}
            className="hidden md:flex items-center gap-2 px-2.5 py-1.5 border border-slate-800 hover:border-cyan-500/40"
            title="Edit my profile (signature, name, callsign)"
          >
            <div className="w-7 h-7 bg-cyan-500/10 border border-cyan-500/40 flex items-center justify-center text-cyan-300 text-sm" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              {currentUser.name.charAt(0).toUpperCase()}
            </div>
            <div className="text-xs text-left">
              <div className="text-slate-200 leading-tight" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                {currentUser.callsign || currentUser.name.split(' ').slice(-1)[0]}
              </div>
              <div className="text-[9px] text-slate-500 leading-tight" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {USER_ROLES[currentUser.role]?.label || currentUser.role.toUpperCase()}
              </div>
            </div>
          </button>
          <button onClick={onOpenProfile} className="md:hidden p-2 border border-slate-800 hover:border-cyan-500/40 text-cyan-300" title="My profile">
            <UserCheck className="w-4 h-4" />
          </button>
          <button onClick={onOpenSettings} className="p-2 border border-slate-800 hover:border-slate-600 text-slate-400 hover:text-slate-200" title="Settings">
            <SettingsIcon className="w-4 h-4" />
          </button>
          <button onClick={onLogout} className="text-[10px] text-slate-500 hover:text-red-400 tracking-widest px-2 py-2 border border-slate-800 hover:border-red-500/40" style={{ fontFamily: 'JetBrains Mono, monospace' }} title="Logout">
            EXIT
          </button>
        </div>
      </div>
      <div className="flex border-t border-slate-800 overflow-x-auto">
        {allowed.map(s => (
          <button
            key={s.id}
            onClick={() => setCurrentSection(s.id)}
            className={`flex items-center gap-2 px-5 py-2.5 text-xs tracking-widest transition-colors relative shrink-0 ${
              currentSection === s.id ? 'text-cyan-400' : 'text-slate-500 hover:text-slate-300'
            }`}
            style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
          >
            <s.icon className="w-3.5 h-3.5" />
            {s.label}
            {currentSection === s.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400" />}
          </button>
        ))}
      </div>
    </header>
  );
}

/* ============================================================
   Manual trip entry modal
   ============================================================ */
function ManualTripModal({ onCancel, onSubmit }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    tail: '', from: '', to: '', date: today, dep: '', arr: '', pax: 0,
    customer: '', broker: '', notes: '', pic: '', sic: '',
  });
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const valid = form.tail && form.from && form.to && form.date && form.dep;

  const submit = () => {
    if (!valid) return;
    const dep = new Date(`${form.date}T${form.dep}:00Z`);
    const arr = form.arr ? new Date(`${form.date}T${form.arr}:00Z`) : new Date(dep.getTime() + 3600000);
    onSubmit({
      tail: form.tail.toUpperCase().trim(),
      from: form.from.toUpperCase().trim(),
      to: form.to.toUpperCase().trim(),
      pax: parseInt(form.pax, 10) || 0,
      customer: form.customer.trim(),
      broker: form.broker.trim(),
      pic: form.pic.trim(),
      sic: form.sic.trim(),
      notes: form.notes.trim(),
      dep, arr,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-950 border border-slate-700 max-w-xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-950">
          <h2 className="text-base tracking-widest" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>ADD TRIP MANUALLY</h2>
          <button onClick={onCancel} className="text-slate-500 hover:text-slate-300"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FieldInput label="TAIL # *" value={form.tail} onChange={set('tail')} placeholder="N123AB" />
            <FieldInput label="DATE *" type="date" value={form.date} onChange={set('date')} />
            <FieldInput label="FROM *" value={form.from} onChange={set('from')} placeholder="KMIA / TPA" />
            <FieldInput label="TO *" value={form.to} onChange={set('to')} placeholder="KTEB / TEB" />
            <FieldInput label="DEP TIME (UTC) *" type="time" value={form.dep} onChange={set('dep')} />
            <FieldInput label="ARR TIME (UTC)" type="time" value={form.arr} onChange={set('arr')} />
            <FieldInput label="PAX COUNT" type="number" value={form.pax} onChange={set('pax')} />
            <FieldInput label="BROKER EMAIL" type="email" value={form.broker} onChange={set('broker')} placeholder="broker@co.com" />
          </div>
          <FieldInput label="CUSTOMER" value={form.customer} onChange={set('customer')} placeholder="ONEflight International" />
          <div className="grid grid-cols-2 gap-3">
            <FieldInput label="PIC" value={form.pic} onChange={set('pic')} placeholder="Captain name" />
            <FieldInput label="SIC" value={form.sic} onChange={set('sic')} placeholder="First officer" />
          </div>
          <label className="block">
            <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>NOTES</span>
            <textarea
              value={form.notes}
              onChange={set('notes')}
              rows={2}
              placeholder="Special instructions, sliding departures, catering notes..."
              className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400 resize-none"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </label>
          <div className="flex gap-2 pt-2">
            <button onClick={onCancel} className="flex-1 py-2.5 border border-slate-700 hover:border-slate-500 text-sm text-slate-300">Cancel</button>
            <button
              onClick={submit}
              disabled={!valid}
              className="flex-1 py-2.5 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-medium tracking-widest"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              CREATE TRIP
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Ops Dashboard
   ============================================================ */
function OpsDashboard({ trips, currentUser, onSelectTrip, onAddManualTrip, onRemoveManualTrip, syncStatus, syncLog, onRunSync, feedStats, hasIcalUrl, onOpenPaste }) {
  const [showManual, setShowManual] = useState(false);

  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 86400000);
    const flightTrips = trips.filter(t => t.info?.isFlight !== false);
    // Only count today + future trips (matching the schedule view)
    const visibleTrips = flightTrips.filter(t => t.start && t.start >= today.getTime());
    return {
      total: visibleTrips.length,
      revenue: visibleTrips.filter(t => t.info.legType === 'REVENUE').length,
      repo: visibleTrips.filter(t => t.info.legType === 'REPO').length,
      todayCount: visibleTrips.filter(t => t.start < tomorrow.getTime()).length,
      upcoming: visibleTrips.length,
      manual: visibleTrips.filter(t => t.raw?.manual).length,
    };
  }, [trips]);

  const recentTrips = useMemo(() => {
    // Show only today's and future trips. Historical trips drop off the schedule
    // automatically once the local day rolls over.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return trips
      .filter(t => t.start && t.start >= startOfToday.getTime())
      .slice(0, 100);
  }, [trips]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-3xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>OPS DASHBOARD</h2>
          <p className="text-xs text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {currentUser.callsign || currentUser.name} · {USER_ROLES[currentUser.role]?.label}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {hasIcalUrl && (
            <button
              onClick={onRunSync}
              disabled={syncStatus.status === 'syncing'}
              className="flex items-center gap-2 px-3 py-2 border border-slate-700 hover:border-cyan-400 text-sm text-slate-200 disabled:opacity-50"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
            >
              {syncStatus.status === 'syncing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              SYNC FEED
            </button>
          )}
          <button
            onClick={onOpenPaste}
            className="flex items-center gap-2 px-3 py-2 border border-slate-700 hover:border-cyan-400 text-sm text-slate-200"
            style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
          >
            <FileText className="w-4 h-4" /> PASTE iCAL
          </button>
          {(currentUser?.role === 'ops' || currentUser?.role === 'admin' || currentUser?.role === 'sales') && (
            <button
              onClick={() => setShowManual(true)}
              className="flex items-center gap-2 px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              <Plus className="w-4 h-4" /> ADD TRIP
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Stat label="TOTAL FLIGHTS" value={stats.total} />
        <Stat label="UPCOMING" value={stats.upcoming} tone="cyan" />
        <Stat label="TODAY" value={stats.todayCount} tone="amber" />
        <Stat label="REVENUE" value={stats.revenue} tone="cyan" />
        <Stat label="MANUAL" value={stats.manual} tone="amber" />
      </div>

      {syncLog.length > 0 && (
        <div className="mb-6 p-3 border border-slate-800 bg-slate-900/40">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              SYNC DIAGNOSTIC LOG
            </div>
            {feedStats && (
              <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                COVERAGE {fmtDateZ(feedStats.firstDate).slice(0, 6)} → {fmtDateZ(feedStats.lastDate).slice(0, 6)} · {feedStats.totalCount} TRIPS
              </div>
            )}
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {syncLog.slice(-25).reverse().map((entry, i) => (
              <div key={i} className="text-[11px] flex items-start gap-2 leading-tight" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <span className="text-slate-600 shrink-0">{fmtZulu(new Date(entry.timestamp))}</span>
                <span className={
                  entry.level === 'error'   ? 'text-red-300' :
                  entry.level === 'warn'    ? 'text-cyan-300' :
                  entry.level === 'success' ? 'text-emerald-300' :
                  'text-slate-300'
                }>{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/40 border-b border-slate-800 text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <tr>
              <th className="text-left p-3">TIME</th>
              <th className="text-left p-3">TAIL</th>
              <th className="text-left p-3">ROUTE</th>
              <th className="text-left p-3">PAX</th>
              <th className="text-left p-3 hidden md:table-cell">CUSTOMER</th>
              <th className="text-left p-3 hidden lg:table-cell">CREW</th>
              <th className="text-right p-3">CATEGORY</th>
            </tr>
          </thead>
          <tbody>
            {recentTrips.map(t => {
              const isPast = t.start && t.start < new Date();
              return (
                <tr
                  key={t.uid}
                  onClick={() => onSelectTrip(t.uid)}
                  className={`border-b border-slate-800/50 hover:bg-slate-900/40 cursor-pointer ${isPast ? 'opacity-60' : ''}`}
                >
                  <td className="p-3 text-slate-400 whitespace-nowrap" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {(() => {
                      const localDate = formatLocalDate(t.start, t.info.from);
                      const dateStr = localDate ? localDate.slice(0, 6) : fmtDateZ(t.start).slice(0, 6);
                      const localTime = formatLocalTime(t.start, t.info.from);
                      return `${dateStr} ${localTime.time} ${localTime.tz}`;
                    })()}
                  </td>
                  <td className="p-3 text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                    {t.info.tail}
                  </td>
                  <td className="p-3 text-slate-300 whitespace-nowrap" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {t.info.from} → {t.info.to}
                  </td>
                  <td className="p-3 text-slate-400">{t.info.pax}</td>
                  <td className="p-3 text-slate-400 truncate max-w-[200px] hidden md:table-cell">{t.info.customer || '—'}</td>
                  <td className="p-3 text-[11px] text-slate-500 hidden lg:table-cell" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                    {t.info.pic ? t.info.pic.split(' ').slice(-1)[0] : '—'}
                    {t.info.sic && ` / ${t.info.sic.split(' ').slice(-1)[0]}`}
                  </td>
                  <td className="p-3 text-right">
                    <Pill tone={(CATEGORY_META[t.info.category] || CATEGORY_META.REPO).tone}>
                      {(CATEGORY_META[t.info.category] || CATEGORY_META.REPO).label}
                    </Pill>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {recentTrips.length === 0 && (
          <div className="p-12 text-center text-slate-500">
            <Calendar className="w-10 h-10 mx-auto mb-3 text-slate-700" />
            <p className="text-sm">No trips loaded</p>
            <p className="text-xs mt-1">Sync the iCal feed, paste content, or add a trip manually.</p>
          </div>
        )}
      </div>

      {showManual && (
        <ManualTripModal
          onCancel={() => setShowManual(false)}
          onSubmit={async (trip) => { await onAddManualTrip(trip); setShowManual(false); }}
        />
      )}
    </div>
  );
}

/* ============================================================
   Expenses screen — receipt upload, AI parsing, approval, export
   ============================================================ */

const EXPENSE_CATEGORIES = [
  'Fuel', 'Catering', 'FBO Fees', 'Hangar', 'Ground Transport',
  'Crew Meals', 'Crew Lodging', 'Supplies', 'Maintenance', 'Office', 'Other',
];

// QuickBooks-relevant payment methods. These values are stored on each
// expense and later used to route the QBO push:
//   'capital_one' | 'amex' → match to bank-feed transaction in QBO
//   'personal'             → push as a Bill payable to the submitter
// Stored as the `value`; UI shows the `label`.
const PAID_WITH_OPTIONS = [
  { value: 'capital_one', label: 'Capital One' },
  { value: 'amex',        label: 'Amex' },
  { value: 'personal',    label: 'Personal card (reimburse me)' },
];

function paidWithLabel(value) {
  if (!value) return null;
  const opt = PAID_WITH_OPTIONS.find(o => o.value === value);
  return opt ? opt.label : value;
}

/* ============================================================
   TRACKING SCREEN — live fleet map (ops/admin only)
   ============================================================ */

/**
 * Load Mapbox GL JS from CDN. Caches the load promise so multiple mounts
 * don't repeatedly load the script.
 */
let _mapboxLoadPromise = null;
function loadMapboxGL() {
  if (_mapboxLoadPromise) return _mapboxLoadPromise;
  if (typeof window === 'undefined') return Promise.reject(new Error('Not in browser'));
  if (window.mapboxgl) return Promise.resolve(window.mapboxgl);

  _mapboxLoadPromise = new Promise((resolve, reject) => {
    // CSS first
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.css';
    document.head.appendChild(link);

    // Then JS
    const script = document.createElement('script');
    script.src = 'https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.js';
    script.async = true;
    script.onload = () => {
      if (window.mapboxgl) {
        resolve(window.mapboxgl);
      } else {
        reject(new Error('Mapbox GL JS failed to load'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load Mapbox GL JS'));
    document.head.appendChild(script);
  });
  return _mapboxLoadPromise;
}

/** Convert FlightAware altitude (hundreds of feet) to "FL340" style string. */
function formatAltitude(ft) {
  if (!ft || ft < 18000) return ft ? `${ft.toLocaleString()} ft` : '—';
  const fl = Math.round(ft / 100);
  return `FL${fl}`;
}

function formatHeading(deg) {
  if (deg == null) return '—';
  return `${Math.round(deg).toString().padStart(3, '0')}°`;
}

function formatGroundspeed(kts) {
  return kts ? `${Math.round(kts)} kts` : '—';
}

/** Local-time HH:MM from ISO string. */
function formatLocalTimeFromIso(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '—';
  }
}


// Airport coordinates lookup for ground-aircraft rendering.
// Used by the TRACKING tab to position parked aircraft on the map when
// FlightAware's flight response doesn't include destination lat/lon.
// Add airports your fleet visits regularly. ICAO or IATA both work.
const AIRPORT_COORDS = {
  // Skyway home base + Florida
  'KTPA': [27.9755, -82.5332], 'TPA': [27.9755, -82.5332],
  'KMCO': [28.4294, -81.3089], 'MCO': [28.4294, -81.3089],
  'KFLL': [26.0742, -80.1506], 'FLL': [26.0742, -80.1506],
  'KMIA': [25.7959, -80.2870], 'MIA': [25.7959, -80.2870],
  'KPBI': [26.6832, -80.0956], 'PBI': [26.6832, -80.0956],
  'KJAX': [30.4941, -81.6879], 'JAX': [30.4941, -81.6879],
  'KSRQ': [27.3954, -82.5544], 'SRQ': [27.3954, -82.5544],
  'KAPF': [26.1525, -81.7752], 'APF': [26.1525, -81.7752],
  'KOPF': [25.9072, -80.2786], 'OPF': [25.9072, -80.2786],
  // Northeast
  'KMMU': [40.7995, -74.4148], 'MMU': [40.7995, -74.4148],
  'KTEB': [40.8501, -74.0608], 'TEB': [40.8501, -74.0608],
  'KHPN': [41.0670, -73.7076], 'HPN': [41.0670, -73.7076],
  'KEWR': [40.6925, -74.1687], 'EWR': [40.6925, -74.1687],
  'KJFK': [40.6398, -73.7787], 'JFK': [40.6398, -73.7787],
  'KLGA': [40.7773, -73.8726], 'LGA': [40.7773, -73.8726],
  'KBOS': [42.3656, -71.0096], 'BOS': [42.3656, -71.0096],
  'KPSM': [43.0779, -70.8233], 'PSM': [43.0779, -70.8233],
  'KBED': [42.4700, -71.2890], 'BED': [42.4700, -71.2890],
  'KCAK': [40.9161, -81.4422], 'CAK': [40.9161, -81.4422],
  'KPIT': [40.4915, -80.2329], 'PIT': [40.4915, -80.2329],
  // Southeast
  'KCLT': [35.2140, -80.9431], 'CLT': [35.2140, -80.9431],
  'KATL': [33.6407, -84.4277], 'ATL': [33.6407, -84.4277],
  'KBNA': [36.1245, -86.6782], 'BNA': [36.1245, -86.6782],
  'KCHS': [32.8986, -80.0405], 'CHS': [32.8986, -80.0405],
  'KSAV': [32.1276, -81.2021], 'SAV': [32.1276, -81.2021],
  'KMSY': [29.9934, -90.2580], 'MSY': [29.9934, -90.2580],
  'KMEM': [35.0424, -89.9767], 'MEM': [35.0424, -89.9767],
  'KINT': [36.1337, -80.2221], 'INT': [36.1337, -80.2221],
  // Texas / Central
  'KDAL': [32.8471, -96.8518], 'DAL': [32.8471, -96.8518],
  'KDFW': [32.8998, -97.0403], 'DFW': [32.8998, -97.0403],
  'KHOU': [29.6454, -95.2789], 'HOU': [29.6454, -95.2789],
  'KIAH': [29.9844, -95.3414], 'IAH': [29.9844, -95.3414],
  'KAUS': [30.1945, -97.6699], 'AUS': [30.1945, -97.6699],
  'KSAT': [29.5337, -98.4698], 'SAT': [29.5337, -98.4698],
  // Midwest
  'KORD': [41.9786, -87.9048], 'ORD': [41.9786, -87.9048],
  'KMDW': [41.7857, -87.7522], 'MDW': [41.7857, -87.7522],
  'KDTW': [42.2124, -83.3534], 'DTW': [42.2124, -83.3534],
  'KCLE': [41.4117, -81.8498], 'CLE': [41.4117, -81.8498],
  'KCVG': [39.0488, -84.6678], 'CVG': [39.0488, -84.6678],
  'KSDF': [38.1744, -85.7361], 'SDF': [38.1744, -85.7361],
  'KIND': [39.7173, -86.2944], 'IND': [39.7173, -86.2944],
  'KSTL': [38.7487, -90.3700], 'STL': [38.7487, -90.3700],
  'KMSP': [44.8848, -93.2223], 'MSP': [44.8848, -93.2223],
  // West
  'KLAX': [33.9425, -118.4081], 'LAX': [33.9425, -118.4081],
  'KSAN': [32.7336, -117.1897], 'SAN': [32.7336, -117.1897],
  'KSFO': [37.6188, -122.3756], 'SFO': [37.6188, -122.3756],
  'KOAK': [37.7213, -122.2207], 'OAK': [37.7213, -122.2207],
  'KSJC': [37.3626, -121.9290], 'SJC': [37.3626, -121.9290],
  'KLAS': [36.0840, -115.1537], 'LAS': [36.0840, -115.1537],
  'KPHX': [33.4343, -112.0116], 'PHX': [33.4343, -112.0116],
  'KSEA': [47.4502, -122.3088], 'SEA': [47.4502, -122.3088],
  'KPDX': [45.5887, -122.5975], 'PDX': [45.5887, -122.5975],
  'KDEN': [39.8617, -104.6731], 'DEN': [39.8617, -104.6731],
  'KSLC': [40.7884, -111.9777], 'SLC': [40.7884, -111.9777],
  // Caribbean / int'l common for charter
  'MWCR': [19.2961, -81.3577], // Grand Cayman
  'MYNN': [25.0390, -77.4661], // Nassau
  'MUHA': [22.9892, -82.4091], // Havana
  'TJSJ': [18.4393, -66.0018], // San Juan PR
  // Private airstrips Skyway visits
  'FA54': [26.7625, -82.2569], // Coral Creek, FL
  // Add more as needed — fleet hits new airports rarely
};
function airportCoords(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  return AIRPORT_COORDS[c] || null;
}

function TrackingScreen({ currentUser, allTrips, trackingEnabled }) {
  const [positions, setPositions] = useState([]);     // [{ ident, airborne, latitude, ... }]
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedIdent, setSelectedIdent] = useState(null);
  const [mapReady, setMapReady] = useState(false);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({}); // { tail: { aircraft, originPin, destPin, sourceId, layerIds } }
  const groundMarkersRef = useRef({}); // { tail: mapboxgl.Marker } — parked-aircraft pins
  const pollTimerRef = useRef(null);
  const aliveRef = useRef(true);

  // Fetch position data for all fleet tails. Only airborne aircraft come back
  // with full position; grounded ones come back as { airborne: false }.
  const fetchPositions = useCallback(async () => {
    if (!trackingEnabled) {
      setLoading(false);
      return;
    }
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/flightaware-positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, idents: SKYWAY_TAILS }),
      });
      const data = await r.json();
      if (!aliveRef.current) return;
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setPositions(Array.isArray(data.positions) ? data.positions : []);
      setFetchedAt(data.fetchedAt || Date.now());
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err.message || 'Failed to fetch positions');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [trackingEnabled]);

  // Mount: fetch immediately + start 2-min foreground polling
  useEffect(() => {
    aliveRef.current = true;
    fetchPositions();
    pollTimerRef.current = setInterval(fetchPositions, 2 * 60 * 1000); // 2 min
    return () => {
      aliveRef.current = false;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [fetchPositions]);

  // Initialize map once container is mounted. The container ref attaches
  // on the React render, but the Mapbox CDN load is async — there's a race
  // where the script resolves with no container, or the effect fires with
  // no script. Solution: poll for both, then initialize. This effect runs
  // exactly once (empty deps); the inner poll handles timing.
  useEffect(() => {
    let cancelled = false;
    let pollHandle = null;

    const tryInit = async () => {
      if (cancelled || mapRef.current) return;
      // Container not mounted yet — retry in 100ms
      if (!mapContainerRef.current) {
        pollHandle = setTimeout(tryInit, 100);
        return;
      }
      try {
        const mapboxgl = await loadMapboxGL();
        if (cancelled || mapRef.current) return;
        // Re-check container after the await
        if (!mapContainerRef.current) {
          pollHandle = setTimeout(tryInit, 100);
          return;
        }

        const token = import.meta.env.VITE_MAPBOX_TOKEN;
        if (!token) {
          setError('VITE_MAPBOX_TOKEN not configured — map cannot load');
          return;
        }
        mapboxgl.accessToken = token;

        console.log('[tracking] initializing map, container:', mapContainerRef.current);
        console.log('[tracking] mapbox token first 12 chars:', token.substring(0, 12));
        const map = new mapboxgl.Map({
          container: mapContainerRef.current,
          // streets-v12 is one of Mapbox's default-included styles; works with
          // any public token. dark-v11 sometimes returns 401 on tokens that
          // weren't created with explicit style permissions even though it's
          // also a default style. streets-v12 has not been observed to fail.
          style: 'mapbox://styles/mapbox/streets-v12',
          center: [-95.7, 37.0],
          zoom: 3.5,
          attributionControl: false,
        });
        // Log the style load explicitly so we can see if it errors
        map.on('styledata', () => console.log('[tracking] style loaded'));
        map.on('styledataloading', () => console.log('[tracking] style loading...'));
        map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
          console.log('[tracking] map loaded');
          if (!cancelled) {
            setMapReady(true);
            // Force a resize in case the container was sized after mount
            setTimeout(() => {
              try { map.resize(); console.log('[tracking] map resized'); } catch {}
            }, 100);
          }
        });
        map.on('error', (e) => {
          console.error('[tracking] map error:', e);
          if (!cancelled) setError(`Map error: ${e.error?.message || 'unknown'}`);
        });
        mapRef.current = map;
      } catch (err) {
        console.error('[tracking] init failed:', err);
        if (!cancelled) setError(`Map load failed: ${err.message}`);
      }
    };

    tryInit();

    return () => {
      cancelled = true;
      if (pollHandle) clearTimeout(pollHandle);
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch {}
        mapRef.current = null;
      }
    };
  }, []);

  // === Render / update markers + track lines + airport pins when positions change ===
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    const mapboxgl = window.mapboxgl;
    if (!mapboxgl) return;

    const airborne = positions.filter(p => p.airborne && p.latitude != null && p.longitude != null);
    const stillPresent = new Set(airborne.map(p => p.ident));

    // === 1. Clean up airborne aircraft markers, labels, airport pins, track layers
    // for tails no longer airborne ===
    for (const ident of Object.keys(markersRef.current)) {
      if (!stillPresent.has(ident)) {
        const bundle = markersRef.current[ident];
        // bundle: { aircraft, originPin, destPin, sourceId, layerIds }
        try { bundle.aircraft?.remove(); } catch {}
        try { bundle.originPin?.remove(); } catch {}
        try { bundle.destPin?.remove(); } catch {}
        if (bundle.layerIds) {
          for (const layerId of bundle.layerIds) {
            if (map.getLayer(layerId)) {
              try { map.removeLayer(layerId); } catch {}
            }
          }
        }
        if (bundle.sourceId && map.getSource(bundle.sourceId)) {
          try { map.removeSource(bundle.sourceId); } catch {}
        }
        delete markersRef.current[ident];
      }
    }

    // === 2. For each airborne aircraft: ensure aircraft icon, airport pins, track line ===
    for (const p of airborne) {
      const sourceId = `track-${p.ident}`;
      const trackLayerId = `track-line-${p.ident}`;

      let bundle = markersRef.current[p.ident];
      if (!bundle) {
        // ----- Aircraft icon (SVG airplane silhouette, sleek cyan) -----
        // Explicit width MUST be set or the wrapper div stretches to fill its
        // parent, which causes the SVG (left-aligned by default) to render far
        // from the actual lat/lon point.
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position: relative; cursor: pointer; pointer-events: auto; width: 36px; height: 36px;';

        const planeEl = document.createElement('div');
        planeEl.style.cssText = `
          width: 36px; height: 36px;
          transform-origin: center;
          transition: transform 0.6s linear;
          filter: drop-shadow(0 0 4px rgba(6, 182, 212, 0.6));
        `;
        // Top-down airplane silhouette, points "up" by default (heading 0)
        planeEl.innerHTML = `
          <svg viewBox="0 0 24 24" width="36" height="36" fill="#06b6d4" stroke="#0f172a" stroke-width="0.5" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2 L13 3 L13 9 L22 14 L22 16 L13 14 L13 19 L15 20 L15 22 L12 21 L9 22 L9 20 L11 19 L11 14 L2 16 L2 14 L11 9 L11 3 Z"/>
          </svg>
        `;
        wrap.appendChild(planeEl);

        const label = document.createElement('div');
        label.textContent = p.ident;
        label.style.cssText = `
          position: absolute; top: 38px; left: 50%; transform: translateX(-50%);
          background: rgba(15, 23, 42, 0.92); color: #06b6d4;
          font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600;
          padding: 2px 6px; border-radius: 2px; white-space: nowrap;
          pointer-events: none;
        `;
        wrap.appendChild(label);

        wrap.addEventListener('click', (e) => {
          e.stopPropagation();
          setSelectedIdent(p.ident);
        });

        const aircraft = new mapboxgl.Marker({ element: wrap, anchor: 'center' })
          .setLngLat([p.longitude, p.latitude])
          .addTo(map);

        bundle = { aircraft, planeEl, sourceId, layerIds: [trackLayerId] };
        markersRef.current[p.ident] = bundle;
      } else {
        // Move existing
        bundle.aircraft.setLngLat([p.longitude, p.latitude]);
      }

      // Rotate the SVG (NOT the wrapping marker, which would skew the label)
      if (p.heading != null && bundle.planeEl) {
        bundle.planeEl.style.transform = `rotate(${p.heading}deg)`;
      }

      // ----- Origin airport pin (red) -----
      if (p.originLat != null && p.originLon != null) {
        if (!bundle.originPin) {
          const el = document.createElement('div');
          el.style.cssText = `position: relative; pointer-events: none;`;
          el.innerHTML = `
            <div style="
              width: 14px; height: 14px; border-radius: 50%;
              background: #dc2626; border: 2px solid #fff;
              box-shadow: 0 0 4px rgba(0,0,0,0.5);
            "></div>
            <div style="
              position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
              background: rgba(15, 23, 42, 0.92); color: #f87171;
              font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600;
              padding: 2px 5px; border-radius: 2px; white-space: nowrap;
            ">${p.origin || 'ORIG'}</div>
          `;
          bundle.originPin = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([p.originLon, p.originLat])
            .addTo(map);
        } else {
          bundle.originPin.setLngLat([p.originLon, p.originLat]);
        }
      }

      // ----- Destination airport pin (red) -----
      if (p.destinationLat != null && p.destinationLon != null) {
        if (!bundle.destPin) {
          const el = document.createElement('div');
          el.style.cssText = `position: relative; pointer-events: none;`;
          el.innerHTML = `
            <div style="
              width: 14px; height: 14px; border-radius: 50%;
              background: #dc2626; border: 2px solid #fff;
              box-shadow: 0 0 4px rgba(0,0,0,0.5);
            "></div>
            <div style="
              position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
              background: rgba(15, 23, 42, 0.92); color: #f87171;
              font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600;
              padding: 2px 5px; border-radius: 2px; white-space: nowrap;
            ">${p.destination || 'DEST'}</div>
          `;
          bundle.destPin = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([p.destinationLon, p.destinationLat])
            .addTo(map);
        } else {
          bundle.destPin.setLngLat([p.destinationLon, p.destinationLat]);
        }
      }

      // ----- Track line (red, actual path flown so far) -----
      const trackCoords = Array.isArray(p.track) && p.track.length > 1 ? p.track : null;
      if (trackCoords) {
        const geojson = {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: trackCoords },
        };
        if (map.getSource(sourceId)) {
          map.getSource(sourceId).setData(geojson);
        } else {
          map.addSource(sourceId, { type: 'geojson', data: geojson });
          map.addLayer({
            id: trackLayerId,
            type: 'line',
            source: sourceId,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': '#dc2626',
              'line-width': 3,
              'line-opacity': 0.85,
            },
          });
        }
      }
    }

    // === 3. Ground markers: gray plane icon at last-known parking airport ===
    // First try FlightAware-provided coords; fall back to AIRPORT_COORDS
    // lookup by airport code. Tails with neither stay hidden.
    const grounded = positions
      .filter(p => !p.airborne)
      .map(p => {
        let lat = p.groundedLat;
        let lon = p.groundedLon;
        if ((lat == null || lon == null) && p.groundedAt) {
          const coords = airportCoords(p.groundedAt);
          if (coords) { lat = coords[0]; lon = coords[1]; }
        }
        return (lat != null && lon != null) ? { ...p, groundedLat: lat, groundedLon: lon } : null;
      })
      .filter(Boolean);
    const groundedSet = new Set(grounded.map(p => p.ident));

    // Clean up ground markers for tails no longer grounded (e.g. just took off)
    for (const ident of Object.keys(groundMarkersRef.current)) {
      if (!groundedSet.has(ident)) {
        try { groundMarkersRef.current[ident].remove(); } catch {}
        delete groundMarkersRef.current[ident];
      }
    }

    // Add or update grounded-aircraft pins
    for (const p of grounded) {
      let marker = groundMarkersRef.current[p.ident];
      if (!marker) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position: relative; cursor: pointer; pointer-events: auto; width: 30px; height: 30px;';

        const planeEl = document.createElement('div');
        planeEl.style.cssText = `
          width: 30px; height: 30px;
          filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.7));
          opacity: 0.85;
        `;
        // Gray top-down airplane silhouette to distinguish from airborne (cyan)
        planeEl.innerHTML = `
          <svg viewBox="0 0 24 24" width="30" height="30" fill="#94a3b8" stroke="#0f172a" stroke-width="0.5" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2 L13 3 L13 9 L22 14 L22 16 L13 14 L13 19 L15 20 L15 22 L12 21 L9 22 L9 20 L11 19 L11 14 L2 16 L2 14 L11 9 L11 3 Z"/>
          </svg>
        `;
        wrap.appendChild(planeEl);

        const label = document.createElement('div');
        label.textContent = `${p.ident} · ${p.groundedAt || ''}`;
        label.style.cssText = `
          position: absolute; top: 32px; left: 50%; transform: translateX(-50%);
          background: rgba(15, 23, 42, 0.92); color: #94a3b8;
          font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 500;
          padding: 2px 5px; border-radius: 2px; white-space: nowrap;
          pointer-events: none;
        `;
        wrap.appendChild(label);

        wrap.addEventListener('click', (e) => {
          e.stopPropagation();
          setSelectedIdent(p.ident);
        });

        marker = new window.mapboxgl.Marker({ element: wrap, anchor: 'center' })
          .setLngLat([p.groundedLon, p.groundedLat])
          .addTo(map);
        groundMarkersRef.current[p.ident] = marker;
      } else {
        marker.setLngLat([p.groundedLon, p.groundedLat]);
      }
    }
  }, [positions, mapReady]);

  // === Find trip context for a given tail (matches by tail to current/upcoming trip)
  const findTripForTail = (tail) => {
    if (!Array.isArray(allTrips)) return null;
    const now = Date.now();
    // Look for a trip with this tail that's started but not ended
    const active = allTrips.find(t =>
      t?.info?.tail === tail
      && t.start && t.end
      && (t.start.getTime?.() || t.start) <= now
      && (t.end.getTime?.() || t.end) > now - 6 * 3600 * 1000  // within 6h past
    );
    return active || null;
  };

  // === If tracking is disabled, show the kill-switch message ===
  if (!trackingEnabled) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <Plane className="w-12 h-12 mx-auto mb-4 text-slate-700" />
          <h2 className="text-sm tracking-widest text-slate-300 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            LIVE TRACKING DISABLED
          </h2>
          <p className="text-xs text-slate-500" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            An admin has turned off live tracking to control FlightAware costs. Enable it in Settings → FlightAware Alerts.
          </p>
        </div>
      </div>
    );
  }

  const selectedPosition = positions.find(p => p.ident === selectedIdent);
  const selectedTrip = selectedIdent ? findTripForTail(selectedIdent) : null;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Status bar */}
      <div className="px-4 py-2 border-b border-slate-800 bg-slate-950 flex items-center justify-between gap-3 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <div className="flex items-center gap-3 text-slate-500">
          <span className="tracking-widest text-cyan-400">LIVE FLEET TRACKING</span>
          {fetchedAt && (
            <span>UPDATED {new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-slate-500">
          <span>{positions.filter(p => p.airborne).length} AIRBORNE / {SKYWAY_TAILS.length} TOTAL</span>
          {loading && <Loader2 className="w-3 h-3 animate-spin" />}
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 border-b border-red-500/40 bg-red-500/5 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Map (top half) + list (bottom half) on mobile; side-by-side on desktop */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden" style={{ minHeight: 0 }}>
        {/* MAP — explicit height since Mapbox needs a sized parent */}
        <div
          className="relative md:w-3/5 border-b md:border-b-0 md:border-r border-slate-800 flex-1"
          style={{ minHeight: '60vh' }}
        >
          <div ref={mapContainerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
          {!mapReady && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80">
              <div className="text-xs text-slate-500 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading map...
              </div>
            </div>
          )}
        </div>

        {/* LIST + DETAIL */}
        <aside className="md:w-2/5 overflow-y-auto scroll-area bg-slate-950">
          {selectedPosition && selectedPosition.airborne ? (
            // === Aircraft detail panel ===
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: '#06b6d4' }}>
                  {selectedPosition.ident}
                </h3>
                <button
                  onClick={() => setSelectedIdent(null)}
                  className="text-[10px] text-slate-500 hover:text-slate-300 tracking-widest"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  CLEAR
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>FROM</div>
                  <div className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{selectedPosition.origin || '—'}</div>
                </div>
                <div>
                  <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>TO</div>
                  <div className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{selectedPosition.destination || '—'}</div>
                </div>
                <div>
                  <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ALTITUDE</div>
                  <div className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{formatAltitude(selectedPosition.altitude)}</div>
                </div>
                <div>
                  <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>GROUND SPEED</div>
                  <div className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{formatGroundspeed(selectedPosition.groundspeed)}</div>
                </div>
                <div>
                  <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>HEADING</div>
                  <div className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{formatHeading(selectedPosition.heading)}</div>
                </div>
                <div>
                  <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ETA</div>
                  <div className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{formatLocalTimeFromIso(selectedPosition.estimatedOn)}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DEPARTED</div>
                  <div className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{formatLocalTimeFromIso(selectedPosition.actualOff)}</div>
                </div>
                {selectedPosition.progressPercent != null && (
                  <div className="col-span-2">
                    <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PROGRESS</div>
                    <div className="h-2 bg-slate-800 rounded overflow-hidden">
                      <div className="h-full bg-cyan-500" style={{ width: `${selectedPosition.progressPercent}%` }} />
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {Math.round(selectedPosition.progressPercent)}%
                    </div>
                  </div>
                )}
                {selectedTrip && (
                  <div className="col-span-2 mt-2 pt-3 border-t border-slate-800">
                    <div className="text-[9px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>SKYWAY TRIP</div>
                    <div className="text-xs text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                      {selectedTrip.info?.broker || selectedTrip.info?.client || '(unknown broker)'}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {selectedTrip.info?.from} → {selectedTrip.info?.to}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // === List of all tails ===
            <div className="p-2">
              <div className="text-[10px] tracking-widest text-slate-500 px-2 py-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                FLEET STATUS
              </div>
              {SKYWAY_TAILS.map(tail => {
                const p = positions.find(x => x.ident === tail);
                const airborne = p?.airborne === true;
                return (
                  <button
                    key={tail}
                    onClick={() => airborne ? setSelectedIdent(tail) : null}
                    disabled={!airborne}
                    className={`w-full text-left p-2 border-b border-slate-800 flex items-center justify-between gap-2 ${airborne ? 'hover:bg-slate-900/50 cursor-pointer' : 'opacity-50 cursor-default'}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${airborne ? 'bg-emerald-400 animate-pulse' : 'bg-slate-700'}`}
                      />
                      <span className="text-sm flex-shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, color: airborne ? '#e2e8f0' : '#64748b' }}>
                        {tail}
                      </span>
                      <span className="text-[10px] text-slate-500 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        {airborne
                          ? `${p.origin || '???'} → ${p.destination || '???'}`
                          : (p?.groundedAt
                              ? `On the ground · ${p.groundedAt}`
                              : 'On the ground')}
                      </span>
                    </div>
                    {airborne && (
                      <div className="flex items-center gap-2 text-[10px] text-slate-400 flex-shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        <span>{formatAltitude(p.altitude)}</span>
                        <span>{formatGroundspeed(p.groundspeed)}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function ExpensesScreen({ currentUser, currentUserUid, currentUserDisplayName }) {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('mine'); // 'mine' | 'all' | 'pending' | 'approved' | 'unexported'
  const [selectedId, setSelectedId] = useState(null);
  const [showUploader, setShowUploader] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  // Month filter for totals panel — null = current month, or 'YYYY-MM' string
  const [statsMonth, setStatsMonth] = useState(null);

  const isOpsOrAdmin = ['ops', 'admin'].includes(currentUser?.role);
  const isAccounting = currentUser?.role === 'accounting';
  const isAdmin = currentUser?.role === 'admin';
  // Anyone who can see all expenses (accounting + ops + admin)
  const canSeeAll = isOpsOrAdmin || isAccounting;
  // Approval moved from ops → accounting. Now: accounting + admin only.
  const canApprove = isAccounting || isAdmin;
  // Only ops/admin/accounting can export.
  const canExport = isOpsOrAdmin || isAccounting;
  // Accounting cannot upload (they're a downstream consumer of data).
  const canUpload = !isAccounting;

  // Default the filter for accounting users to "unexported" — that's the
  // natural workflow for downloading new expenses each pay period.
  useEffect(() => {
    if (isAccounting && filter === 'mine') setFilter('unexported');
  }, [isAccounting]); // eslint-disable-line

  useEffect(() => {
    if (!currentUserUid) return;
    let unsub = null;
    let cancelled = false;
    (async () => {
      const m = await import('./firebase-expenses.js');
      if (cancelled) return;
      if (canSeeAll) {
        unsub = m.subscribeToAllExpenses((list) => {
          setExpenses(list);
          setLoading(false);
        });
      } else {
        unsub = m.subscribeToUserExpenses(currentUserUid, (list) => {
          setExpenses(list);
          setLoading(false);
        });
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [currentUserUid, canSeeAll]);

  const filteredExpenses = useMemo(() => {
    let out = expenses;
    if (canSeeAll) {
      if (filter === 'mine') out = out.filter(e => e.uid === currentUserUid);
      else if (filter === 'pending') out = out.filter(e => e.status === 'pending');
      else if (filter === 'review') out = out.filter(e => e.status === 'needs_review');
      else if (filter === 'approved') out = out.filter(e => e.status === 'approved');
      else if (filter === 'unexported') out = out.filter(e => e.status === 'approved' && !e.exportedAt);
      // 'all' = no filter
    }
    return out;
  }, [expenses, filter, canSeeAll, currentUserUid]);

  // Monthly totals — group APPROVED (or synced) expenses by category for the selected month
  const monthlyStats = useMemo(() => {
    // Use filteredExpenses if accounting/ops, otherwise just user's own
    const source = canSeeAll ? expenses : expenses.filter(e => e.uid === currentUserUid);
    const counted = source.filter(e =>
      (e.status === 'approved' || e.status === 'synced') &&
      e.totalAmount != null
    );

    const targetMonth = statsMonth || new Date().toISOString().slice(0, 7); // YYYY-MM
    const byCategory = {};
    let total = 0;
    let count = 0;
    for (const e of counted) {
      const date = e.transactionDate || (e.approvedAt ? new Date(e.approvedAt).toISOString().slice(0,10) : null);
      if (!date) continue;
      const month = date.slice(0, 7);
      if (month !== targetMonth) continue;
      const cat = e.category || 'Other';
      byCategory[cat] = (byCategory[cat] || 0) + Number(e.totalAmount);
      total += Number(e.totalAmount);
      count += 1;
    }
    // Available months for the month picker
    const allMonths = new Set();
    for (const e of counted) {
      const date = e.transactionDate || (e.approvedAt ? new Date(e.approvedAt).toISOString().slice(0,10) : null);
      if (date) allMonths.add(date.slice(0, 7));
    }
    const monthList = Array.from(allMonths).sort().reverse();
    return { byCategory, total, count, targetMonth, monthList };
  }, [expenses, canSeeAll, currentUserUid, statsMonth]);

  const handleUpload = async (file) => {
    setUploadError(null);
    setShowUploader(false);
    try {
      const m = await import('./firebase-expenses.js');
      const id = m.newExpenseId();
      const draft = {
        id,
        uid: currentUserUid,
        authorName: currentUserDisplayName || currentUser?.name || 'Unknown',
        authorEmail: currentUser?.email || '',
        authorRole: currentUser?.role || 'crew',
        status: 'draft',
        category: 'Other',
        currency: 'USD',
        lineItems: [],
        notes: 'Parsing receipt with AI...',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await m.saveExpense(draft);
      setSelectedId(id);

      const { url, path, contentType, sizeBytes } = await m.uploadReceipt(file, currentUserUid);
      await m.saveExpense({
        ...draft, receiptUrl: url, receiptPath: path,
        receiptContentType: contentType, receiptSizeBytes: sizeBytes,
        receiptFilename: file.name,
      });

      const base64 = await fileToBase64(file);
      const r = await fetch('/api/parse-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mediaType: contentType || 'image/jpeg' }),
      });
      const data = await r.json();
      if (!r.ok) {
        await m.saveExpense({
          ...draft,
          receiptUrl: url, receiptPath: path, receiptContentType: contentType,
          receiptSizeBytes: sizeBytes, receiptFilename: file.name,
          notes: `AI parse failed: ${data.error}. Edit fields manually.`,
          status: 'draft',
        });
        return;
      }
      const p = data.parsed;
      await m.saveExpense({
        ...draft,
        receiptUrl: url, receiptPath: path, receiptContentType: contentType,
        receiptSizeBytes: sizeBytes, receiptFilename: file.name,
        vendor: p.vendor, transactionDate: p.transactionDate, totalAmount: p.totalAmount,
        currency: p.currency, subtotal: p.subtotal, tax: p.tax, tip: p.tip,
        category: p.category, lineItems: p.lineItems,
        notes: p.notes || '',
        parsedAt: Date.now(), parsedBy: 'claude-vision',
        confidence: p.confidence,
        status: 'draft',
      });
    } catch (err) {
      console.error('[expenses] upload failed:', err);
      setUploadError(err.message || 'Upload failed');
    }
  };

  const submitExpense = async (expense) => {
    const m = await import('./firebase-expenses.js');
    await m.saveExpense({ ...expense, status: 'pending', submittedAt: Date.now() });
  };
  const approveExpense = async (expense) => {
    if (!canApprove) return;
    const m = await import('./firebase-expenses.js');
    await m.saveExpense({
      ...expense, status: 'approved',
      approvedAt: Date.now(),
      approvedBy: currentUserDisplayName || currentUser?.name,
    });
  };
  const rejectExpense = async (expense, reason) => {
    if (!canApprove) return;
    const m = await import('./firebase-expenses.js');
    await m.saveExpense({
      ...expense, status: 'rejected',
      rejectedAt: Date.now(),
      rejectedBy: currentUserDisplayName || currentUser?.name,
      rejectionReason: reason || '',
    });
  };

  // Request review — sets status to 'needs_review' and emails the submitter
  // with the question. Submitter replies to the email; accountant approves
  // manually after they have the info they need.
  const requestReviewExpense = async (expense, question) => {
    if (!canApprove) return;
    if (!question || !question.trim()) {
      alert('Review question is required.');
      return;
    }
    const reviewerName = currentUserDisplayName || currentUser?.name || 'Accounting';
    const reviewerEmail = currentUser?.email || '';
    const m = await import('./firebase-expenses.js');

    // Append to review history (chain of custody — accounting may ask multiple
    // questions over time before approving)
    const reviewEntry = {
      ts: Date.now(),
      by: reviewerName,
      byEmail: reviewerEmail,
      question: question.trim(),
    };
    const history = Array.isArray(expense.reviewHistory) ? expense.reviewHistory : [];

    await m.saveExpense({
      ...expense,
      status: 'needs_review',
      reviewRequestedAt: Date.now(),
      reviewRequestedBy: reviewerName,
      reviewRequestedByEmail: reviewerEmail,
      reviewQuestion: question.trim(),
      reviewHistory: [...history, reviewEntry],
    });

    // Send email to submitter
    const recipient = expense.authorEmail;
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      alert('Status updated, but no valid email on file for submitter — could not notify them. They can still see the request in the app.');
      return;
    }
    try {
      const subject = `Expense review needed — ${expense.vendor || 'receipt'} ${expense.totalAmount != null ? `$${Number(expense.totalAmount).toFixed(2)}` : ''}`;
      const lines = [
        `Hi ${expense.authorName || 'there'},`,
        '',
        `${reviewerName} from accounting has a question about an expense you submitted:`,
        '',
        `> ${question.trim()}`,
        '',
        '— Expense details —',
        `Vendor: ${expense.vendor || '(not parsed)'}`,
        `Date: ${expense.transactionDate || '(not parsed)'}`,
        `Amount: ${expense.totalAmount != null ? `$${Number(expense.totalAmount).toFixed(2)}` : '(not parsed)'}`,
        `Category: ${expense.category || 'Other'}`,
        '',
        `Please reply to this email with the requested info, or log in to https://skyway-ops.vercel.app to update the expense and resubmit.`,
        '',
        '— Skyway Aviation',
      ];
      const r = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: [recipient, ...(reviewerEmail ? [reviewerEmail] : [])], // CC the reviewer so they have a record
          subject,
          text: lines.join('\n'),
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        console.error('[expenses] review email failed:', r.status, data.error || '');
        alert(`Status updated, but the email failed to send (${data.error || r.status}). The submitter can still see the request in the app.`);
      } else {
        console.log('[expenses] review email sent to', recipient);
      }
    } catch (err) {
      console.error('[expenses] review email error:', err);
      alert('Status updated, but the email could not be sent. The submitter can still see the request in the app.');
    }
  };
  const updateExpense = async (expense, changes) => {
    const m = await import('./firebase-expenses.js');
    await m.saveExpense({ ...expense, ...changes });
  };
  const deleteExpenseDoc = async (expense) => {
    if (!window.confirm('Delete this expense? This cannot be undone.')) return;
    const m = await import('./firebase-expenses.js');
    await m.deleteExpense(expense);
    setSelectedId(null);
  };

  // Export — two modes:
  //   'new' — only approved + not previously exported (default workflow)
  //   'full' — all approved (re-download for audits / recovery)
  // Marks exported items with exportedAt + exportedBy timestamp so the next
  // "new" export skips them.
  const exportCsv = async (mode = 'new') => {
    let toExport = filteredExpenses.filter(e => e.status === 'approved');
    if (mode === 'new') {
      toExport = toExport.filter(e => !e.exportedAt);
    }
    if (toExport.length === 0) {
      alert(mode === 'new'
        ? 'No new approved expenses to export. Switch to "FULL EXPORT" to re-download previously exported items.'
        : 'No approved expenses to export.');
      return;
    }

    const confirmMsg = mode === 'new'
      ? `Export ${toExport.length} new expense(s) to CSV? They will be marked as exported and excluded from future "new" exports.`
      : `Re-export ${toExport.length} approved expense(s) to CSV (full export — does NOT change exported flags)?`;
    if (!window.confirm(confirmMsg)) return;

    const rows = toExport.map(e => ({
      Date: e.transactionDate || '',
      Vendor: e.vendor || '',
      Category: e.category || '',
      Amount: e.totalAmount || '',
      Subtotal: e.subtotal || '',
      Tax: e.tax || '',
      Tip: e.tip || '',
      Currency: e.currency || 'USD',
      Submitter: e.authorName || '',
      Notes: (e.notes || '').replace(/[\r\n]+/g, ' '),
      ApprovedAt: e.approvedAt ? new Date(e.approvedAt).toISOString() : '',
      ApprovedBy: e.approvedBy || '',
      ExpenseID: e.id || '',
      ReceiptURL: e.receiptUrl || '',
    }));
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => csvEscape(r[h])).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const tag = mode === 'new' ? 'new' : 'full';
    a.download = `expenses_${tag}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    // Mark items as exported (only for 'new' mode — full mode preserves history)
    if (mode === 'new') {
      const m = await import('./firebase-expenses.js');
      const now = Date.now();
      const exportedBy = currentUserDisplayName || currentUser?.name || 'unknown';
      for (const e of toExport) {
        try {
          await m.saveExpense({
            ...e,
            exportedAt: now,
            exportedBy,
            // Preserve a history of all exports — accountants may re-export and we want a paper trail
            exportHistory: [...(e.exportHistory || []), { ts: now, by: exportedBy, mode: 'new' }],
          });
        } catch (err) {
          console.error('[expenses] failed to mark exported:', e.id, err);
        }
      }
    }
  };

  const selected = filteredExpenses.find(e => e.id === selectedId) || expenses.find(e => e.id === selectedId);

  return (
    <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
      <aside className={`${selected ? 'hidden md:block' : 'block'} w-full md:w-96 md:border-r md:border-slate-800 overflow-y-auto scroll-area`}>
        {/* Monthly totals panel */}
        <ExpenseMonthlyStats
          stats={monthlyStats}
          onMonthChange={setStatsMonth}
        />

        <div className="px-4 py-3 border-b border-slate-800 bg-slate-950 sticky top-0 z-10">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="text-xs tracking-[0.2em]" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
              EXPENSES{isAccounting ? ' · ACCOUNTING' : ''}
            </h2>
            {canUpload && (
              <button
                onClick={() => setShowUploader(true)}
                className="text-[10px] px-2 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 tracking-widest font-medium"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                + UPLOAD
              </button>
            )}
          </div>
          {canSeeAll && (
            <div className="flex flex-wrap gap-1">
              {[
                { id: 'unexported', label: 'NEW', title: 'Approved + not yet exported' },
                { id: 'mine', label: 'MINE' },
                { id: 'all', label: 'ALL' },
                { id: 'pending', label: 'PENDING' },
                { id: 'review', label: 'REVIEW', title: 'Needs review — waiting on submitter' },
                { id: 'approved', label: 'APPROVED' },
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  title={f.title}
                  className={`text-[10px] px-2 py-1 border ${filter === f.id ? 'border-cyan-400 text-cyan-300' : 'border-slate-700 text-slate-500 hover:text-slate-300'} tracking-widest`}
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
          {canExport && (
            <div className="flex gap-1 mt-2">
              <button
                onClick={() => exportCsv('new')}
                className="flex-1 text-[10px] px-2 py-1.5 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                title="Download approved expenses not previously exported"
              >
                ↓ EXPORT NEW
              </button>
              <button
                onClick={() => exportCsv('full')}
                className="text-[10px] px-2 py-1.5 border border-slate-700 text-slate-500 hover:text-slate-300 tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                title="Re-download all approved (for audits)"
              >
                ⤓ FULL
              </button>
            </div>
          )}
        </div>

        {showUploader && canUpload && (
          <div className="p-4 border-b border-slate-800 bg-slate-900/40">
            <div className="text-xs tracking-widest text-cyan-300 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              NEW RECEIPT
            </div>
            <p className="text-[10px] text-slate-500 mb-3">
              Take a photo or pick from your camera roll. AI will extract vendor, date, amount, and category.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {/* TAKE PHOTO — forces the camera on mobile */}
              <label className="block text-center py-2 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 cursor-pointer text-sm" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                <Camera className="w-4 h-4 inline mr-1" /> CAMERA
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUpload(f);
                    e.target.value = '';
                  }}
                  className="hidden"
                />
              </label>
              {/* CHOOSE FILE — opens photo picker / file browser, never forces camera */}
              <label className="block text-center py-2 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 cursor-pointer text-sm" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                <FileText className="w-4 h-4 inline mr-1" /> CAMERA ROLL
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUpload(f);
                    e.target.value = '';
                  }}
                  className="hidden"
                />
              </label>
            </div>
            <button
              onClick={() => setShowUploader(false)}
              className="mt-2 w-full py-1 text-[10px] text-slate-500 hover:text-slate-300 tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              CANCEL
            </button>
            {uploadError && (
              <div className="mt-2 p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">{uploadError}</div>
            )}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading expenses...
          </div>
        ) : filteredExpenses.length === 0 ? (
          <div className="p-12 text-center">
            <Mail className="w-8 h-8 text-slate-700 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No expenses{filter === 'unexported' ? ' to export' : ' yet'}</p>
            <p className="text-xs text-slate-600 mt-1">
              {filter === 'unexported' ? 'All approved expenses have been exported.' : canUpload ? 'Tap UPLOAD to add a receipt.' : 'Nothing to review yet.'}
            </p>
          </div>
        ) : (
          <div>
            {filteredExpenses.map(e => (
              <ExpenseRow
                key={e.id}
                expense={e}
                selected={e.id === selectedId}
                onClick={() => setSelectedId(e.id)}
              />
            ))}
          </div>
        )}
      </aside>

      <main className={`flex-1 overflow-y-auto scroll-area ${selected ? 'block' : 'hidden md:block'}`}>
        {selected ? (
          <ExpenseDetail
            expense={selected}
            currentUser={currentUser}
            canApprove={canApprove}
            isAccounting={isAccounting}
            onBack={() => setSelectedId(null)}
            onUpdate={updateExpense}
            onSubmit={submitExpense}
            onApprove={approveExpense}
            onReject={rejectExpense}
            onRequestReview={requestReviewExpense}
            onDelete={deleteExpenseDoc}
          />
        ) : (
          <div className="h-full flex items-center justify-center p-8 grid-bg">
            <div className="text-center max-w-md">
              <div className="w-20 h-20 mx-auto mb-4 border border-slate-800 flex items-center justify-center">
                <Mail className="w-10 h-10 text-slate-700" />
              </div>
              <h2 className="text-2xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                EXPENSES
              </h2>
              <p className="text-sm text-slate-500">
                {isAccounting
                  ? 'Read-only access to all expenses. Use EXPORT NEW to download new approved items.'
                  : 'Select a receipt to view details, or tap UPLOAD to add a new one.'}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// Monthly totals panel — shown above the expense list
function ExpenseMonthlyStats({ stats, onMonthChange }) {
  const [expanded, setExpanded] = useState(true);
  const fmt = (n) => `$${Number(n).toFixed(2)}`;
  const formatMonth = (m) => {
    if (!m) return '';
    const [y, mo] = m.split('-');
    const d = new Date(parseInt(y), parseInt(mo) - 1, 1);
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  };

  return (
    <div className="border-b border-slate-800 bg-slate-950">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full px-4 py-2 flex items-center justify-between hover:bg-slate-900/40"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            MONTHLY TOTAL
          </span>
          <span className="text-base text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {fmt(stats.total)}
          </span>
          <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            ({stats.count} item{stats.count === 1 ? '' : 's'})
          </span>
        </div>
        <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {/* Month picker */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>MONTH</span>
            <select
              value={stats.targetMonth}
              onChange={(e) => onMonthChange(e.target.value)}
              className="bg-slate-900/60 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {/* Always show current month even if no data */}
              {!stats.monthList.includes(stats.targetMonth) && (
                <option value={stats.targetMonth}>{formatMonth(stats.targetMonth)}</option>
              )}
              {stats.monthList.map(m => (
                <option key={m} value={m}>{formatMonth(m)}</option>
              ))}
            </select>
          </div>

          {/* Category breakdown */}
          {Object.keys(stats.byCategory).length === 0 ? (
            <div className="text-[11px] text-slate-600 italic">No approved expenses for {formatMonth(stats.targetMonth)}</div>
          ) : (
            <div className="space-y-0.5">
              {Object.entries(stats.byCategory)
                .sort((a, b) => b[1] - a[1])
                .map(([cat, amount]) => {
                  const pct = stats.total > 0 ? (amount / stats.total) * 100 : 0;
                  return (
                    <div key={cat} className="flex items-center gap-2 text-xs">
                      <span className="flex-1 text-slate-300 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                        {cat}
                      </span>
                      <span className="text-slate-500 text-[10px] w-10 text-right" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        {pct.toFixed(0)}%
                      </span>
                      <span className="text-slate-100 text-right shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, minWidth: 70 }}>
                        {fmt(amount)}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = String(dataUrl).split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ExpenseRow({ expense, selected, onClick }) {
  const status = expense.status || 'draft';
  const tone = status === 'approved'
    ? { border: 'border-emerald-500/30', bg: 'bg-emerald-500/5', label: 'text-emerald-300', text: 'APPROVED' }
    : status === 'rejected'
    ? { border: 'border-red-500/30', bg: 'bg-red-500/5', label: 'text-red-300', text: 'REJECTED' }
    : status === 'needs_review'
    ? { border: 'border-amber-500/40', bg: 'bg-amber-500/5', label: 'text-amber-300', text: 'NEEDS REVIEW' }
    : status === 'pending'
    ? { border: 'border-amber-500/30', bg: 'bg-amber-500/5', label: 'text-amber-300', text: 'PENDING' }
    : status === 'synced'
    ? { border: 'border-cyan-500/30', bg: 'bg-cyan-500/5', label: 'text-cyan-300', text: 'SYNCED' }
    : { border: 'border-slate-700', bg: 'bg-slate-900/40', label: 'text-slate-400', text: 'DRAFT' };
  const isParsing = expense.notes === 'Parsing receipt with AI...';
  const isExported = !!expense.exportedAt;
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left p-3 border-b border-slate-800 ${selected ? 'bg-slate-900/60' : 'hover:bg-slate-900/40'} transition-colors`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-sm text-slate-100 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
          {expense.vendor || (isParsing ? 'Parsing...' : '(no vendor)')}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {isExported && (
            <span className="text-[9px] tracking-widest text-violet-300" style={{ fontFamily: 'JetBrains Mono, monospace' }} title={`Exported ${new Date(expense.exportedAt).toLocaleString()}`}>
              ↓EXP
            </span>
          )}
          <span className={`text-[10px] tracking-widest ${tone.label}`} style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {tone.text}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-slate-500 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {expense.category || 'Uncategorized'}
          {expense.transactionDate && ` · ${expense.transactionDate}`}
        </div>
        <span className="text-sm text-slate-200 shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
          {expense.totalAmount != null ? `$${Number(expense.totalAmount).toFixed(2)}` : '—'}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-0.5">
        <div className="text-[10px] text-slate-600 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {expense.authorName || 'Unknown'}
        </div>
        {expense.paidWith ? (
          <span className="text-[9px] tracking-widest text-cyan-400 shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace' }} title="Card tagged">
            {paidWithLabel(expense.paidWith).toUpperCase()}
          </span>
        ) : expense.status !== 'draft' && (
          <span className="text-[9px] tracking-widest text-amber-400 shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace' }} title="No card tagged — required to push to QuickBooks">
            ⚠ TAG CARD
          </span>
        )}
      </div>
    </button>
  );
}

function ExpenseDetail({ expense, currentUser, canApprove, isAccounting, onBack, onUpdate, onSubmit, onApprove, onReject, onRequestReview, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(expense);
  const [showImg, setShowImg] = useState(true);
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  const [reviewQuestion, setReviewQuestion] = useState('');

  useEffect(() => { setDraft(expense); }, [expense.id, expense.updatedAt]);

  const isOwner = expense.uid === (currentUser?.uid || currentUser?.id);
  const status = expense.status || 'draft';
  const isParsing = expense.notes === 'Parsing receipt with AI...';
  // Owner can edit own drafts/rejected/needs_review. Admin can edit anything.
  // Accounting is read-only on the data; their power is approve/reject/review.
  const canEdit = !isAccounting && ((isOwner && (status === 'draft' || status === 'rejected' || status === 'needs_review')) || canApprove);

  const set = (k) => (v) => setDraft(d => ({ ...d, [k]: v }));

  const saveEdits = async () => {
    await onUpdate(expense, {
      vendor: draft.vendor,
      transactionDate: draft.transactionDate,
      totalAmount: draft.totalAmount != null ? Number(draft.totalAmount) : null,
      subtotal: draft.subtotal != null && draft.subtotal !== '' ? Number(draft.subtotal) : null,
      tax: draft.tax != null && draft.tax !== '' ? Number(draft.tax) : null,
      tip: draft.tip != null && draft.tip !== '' ? Number(draft.tip) : null,
      category: draft.category,
      paidWith: draft.paidWith || null,
      notes: draft.notes,
    });
    setEditing(false);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={onBack}
          className="md:hidden text-slate-500 hover:text-cyan-400 p-1"
          aria-label="Back"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-xl tracking-wider flex-1" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
          {expense.vendor || (isParsing ? 'PARSING RECEIPT...' : 'EXPENSE')}
        </h1>
        {isOwner && (status === 'draft' || status === 'rejected') && (
          <button
            onClick={() => onDelete(expense)}
            className="text-[10px] px-2 py-1 border border-slate-700 text-slate-400 hover:border-red-500/40 hover:text-red-300 tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            DELETE
          </button>
        )}
      </div>

      {expense.receiptUrl && (
        <div className="mb-4">
          <button
            onClick={() => setShowImg(v => !v)}
            className="text-[10px] tracking-widest text-slate-500 hover:text-cyan-300 mb-1"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {showImg ? 'HIDE RECEIPT' : 'SHOW RECEIPT'}
          </button>
          {showImg && (
            <div className="border border-slate-800 bg-slate-900/40 overflow-hidden">
              {(expense.receiptContentType || '').includes('pdf') ? (
                <iframe src={expense.receiptUrl} title="Receipt" className="w-full" style={{ minHeight: 500 }} />
              ) : (
                <img src={expense.receiptUrl} alt="Receipt" className="w-full max-h-96 object-contain bg-black" />
              )}
            </div>
          )}
          <a
            href={expense.receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-1 text-[10px] tracking-widest text-cyan-500 hover:text-cyan-300"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            OPEN ORIGINAL ↗
          </a>
        </div>
      )}

      {/* Status banner */}
      <div className={`mb-4 p-3 border ${status === 'needs_review' ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-700 bg-slate-900/40'} flex items-center justify-between gap-2`}>
        <div className="flex-1">
          <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>STATUS</div>
          <div className={`text-sm ${status === 'needs_review' ? 'text-amber-200' : 'text-slate-100'}`} style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
            {status === 'needs_review' ? 'NEEDS REVIEW' : status.toUpperCase()}
            {status === 'approved' && expense.approvedBy && ` · by ${expense.approvedBy}`}
            {status === 'rejected' && expense.rejectionReason && ` · ${expense.rejectionReason}`}
            {status === 'needs_review' && expense.reviewRequestedBy && ` · from ${expense.reviewRequestedBy}`}
          </div>
        </div>
        {expense.confidence && (
          <div className="text-right shrink-0">
            <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>AI CONFIDENCE</div>
            <div className={`text-sm ${expense.confidence === 'high' ? 'text-emerald-300' : expense.confidence === 'medium' ? 'text-amber-300' : 'text-red-300'}`} style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {expense.confidence.toUpperCase()}
            </div>
          </div>
        )}
      </div>

      {/* Review question banner — prominent when accounting has asked for info */}
      {status === 'needs_review' && expense.reviewQuestion && (
        <div className="mb-4 p-3 border border-amber-500/40 bg-amber-500/10">
          <div className="text-[10px] tracking-widest text-amber-300 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            REVIEW QUESTION
          </div>
          <div className="text-sm text-slate-100 whitespace-pre-wrap" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {expense.reviewQuestion}
          </div>
          <div className="text-[10px] text-slate-500 mt-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            Asked by {expense.reviewRequestedBy} · {expense.reviewRequestedAt ? new Date(expense.reviewRequestedAt).toLocaleString() : ''}
          </div>
          {isOwner && (
            <p className="text-[11px] text-amber-200 mt-2">
              Reply to the email you received, or edit the expense below and resubmit.
            </p>
          )}
        </div>
      )}

      {/* Fields */}
      {editing ? (
        <div className="space-y-3">
          <FieldRow label="VENDOR">
            <input value={draft.vendor || ''} onChange={(e) => set('vendor')(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" />
          </FieldRow>
          <FieldRow label="DATE (YYYY-MM-DD)">
            <input value={draft.transactionDate || ''} onChange={(e) => set('transactionDate')(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" placeholder="2026-05-02" />
          </FieldRow>
          <FieldRow label="CATEGORY">
            <select value={draft.category || 'Other'} onChange={(e) => set('category')(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400">
              {EXPENSE_CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </FieldRow>
          <FieldRow label="PAID WITH">
            <select value={draft.paidWith || ''} onChange={(e) => set('paidWith')(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400">
              <option value="">— Select card —</option>
              {PAID_WITH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </FieldRow>
          <div className="grid grid-cols-3 gap-2">
            <FieldRow label="SUBTOTAL"><input type="number" step="0.01" value={draft.subtotal ?? ''} onChange={(e) => set('subtotal')(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" /></FieldRow>
            <FieldRow label="TAX"><input type="number" step="0.01" value={draft.tax ?? ''} onChange={(e) => set('tax')(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" /></FieldRow>
            <FieldRow label="TIP"><input type="number" step="0.01" value={draft.tip ?? ''} onChange={(e) => set('tip')(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" /></FieldRow>
          </div>
          <FieldRow label="TOTAL">
            <input type="number" step="0.01" value={draft.totalAmount ?? ''} onChange={(e) => set('totalAmount')(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" />
          </FieldRow>
          <FieldRow label="NOTES">
            <textarea value={draft.notes || ''} onChange={(e) => set('notes')(e.target.value)} rows={3} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" />
          </FieldRow>
          <div className="flex gap-2">
            <button onClick={saveEdits} className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium" style={{ fontFamily: 'DM Sans, sans-serif' }}>SAVE</button>
            <button onClick={() => { setDraft(expense); setEditing(false); }} className="px-4 py-2 border border-slate-700 text-sm text-slate-300">CANCEL</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {!expense.paidWith && expense.status !== 'draft' && (
            <div className="p-2 border border-amber-500/40 bg-amber-500/5 text-[11px] text-amber-200 flex items-start gap-2 mb-2" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                <strong>No card tagged.</strong> Tap EDIT and select which card paid for this — required to push to QuickBooks.
              </span>
            </div>
          )}
          <ReadField label="VENDOR" value={expense.vendor || '—'} />
          <ReadField label="DATE" value={expense.transactionDate || '—'} />
          <ReadField label="CATEGORY" value={expense.category || '—'} />
          <ReadField label="PAID WITH" value={paidWithLabel(expense.paidWith) || '— not tagged —'} />
          <div className="grid grid-cols-3 gap-2">
            <ReadField label="SUBTOTAL" value={expense.subtotal != null ? `$${Number(expense.subtotal).toFixed(2)}` : '—'} />
            <ReadField label="TAX" value={expense.tax != null ? `$${Number(expense.tax).toFixed(2)}` : '—'} />
            <ReadField label="TIP" value={expense.tip != null ? `$${Number(expense.tip).toFixed(2)}` : '—'} />
          </div>
          <ReadField label="TOTAL" value={expense.totalAmount != null ? `$${Number(expense.totalAmount).toFixed(2)}` : '—'} highlight />
          {expense.lineItems && expense.lineItems.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>LINE ITEMS</div>
              <div className="border border-slate-800 bg-slate-900/40 divide-y divide-slate-800">
                {expense.lineItems.map((li, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <div className="flex-1 truncate text-slate-300">{li.description}</div>
                    <div className="text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {li.qty && li.qty !== 1 ? `${li.qty} × ` : ''}{li.unitPrice != null ? `$${Number(li.unitPrice).toFixed(2)}` : ''}
                    </div>
                    <div className="text-slate-200 shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      {li.amount != null ? `$${Number(li.amount).toFixed(2)}` : '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {expense.notes && <ReadField label="NOTES" value={expense.notes} />}
          <ReadField label="SUBMITTED BY" value={expense.authorName || '—'} />
          {expense.exportedAt && (
            <div className="mt-3 p-2 border border-violet-500/30 bg-violet-500/5">
              <div className="text-[10px] tracking-widest text-violet-300 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                EXPORT HISTORY
              </div>
              <div className="text-[11px] text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                Last exported {new Date(expense.exportedAt).toLocaleString()}
                {expense.exportedBy && ` by ${expense.exportedBy}`}
              </div>
              {Array.isArray(expense.exportHistory) && expense.exportHistory.length > 1 && (
                <details className="mt-1">
                  <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-300">
                    {expense.exportHistory.length} export{expense.exportHistory.length === 1 ? '' : 's'} total
                  </summary>
                  <ul className="mt-1 ml-3 space-y-0.5">
                    {expense.exportHistory.map((h, i) => (
                      <li key={i} className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        · {new Date(h.ts).toLocaleString()} by {h.by} ({h.mode})
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-6 flex flex-wrap gap-2">
        {canEdit && !editing && (
          <button onClick={() => setEditing(true)} className="px-3 py-2 border border-slate-700 text-sm text-slate-200 hover:border-cyan-500/40">EDIT</button>
        )}
        {/* Submitter actions */}
        {isOwner && (status === 'draft' || status === 'rejected') && !editing && (
          <button
            onClick={() => onSubmit(expense)}
            disabled={!expense.vendor || !expense.totalAmount}
            className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          >
            {status === 'rejected' ? 'RESUBMIT' : 'SUBMIT FOR APPROVAL'}
          </button>
        )}
        {isOwner && status === 'needs_review' && !editing && (
          <button
            onClick={() => onSubmit(expense)}
            disabled={!expense.vendor || !expense.totalAmount}
            className="px-3 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
            title="Resubmit after addressing the review question"
          >
            RESUBMIT FOR APPROVAL
          </button>
        )}

        {/* Approver actions (accounting + admin) — Request Review form */}
        {canApprove && status === 'pending' && !editing && showReviewPrompt && (
          <div className="w-full p-3 border border-amber-500/40 bg-amber-500/5">
            <div className="text-[10px] tracking-widest text-amber-300 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              REVIEW QUESTION (will be emailed to submitter)
            </div>
            <textarea
              value={reviewQuestion}
              onChange={(e) => setReviewQuestion(e.target.value)}
              rows={3}
              placeholder="e.g. Was this for the trip to Naples? Need a leg/trip number to allocate it."
              className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-amber-400"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={async () => {
                  await onRequestReview(expense, reviewQuestion);
                  setReviewQuestion('');
                  setShowReviewPrompt(false);
                }}
                disabled={!reviewQuestion.trim()}
                className="px-3 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ fontFamily: 'DM Sans, sans-serif' }}
              >
                SEND REVIEW REQUEST
              </button>
              <button
                onClick={() => { setShowReviewPrompt(false); setReviewQuestion(''); }}
                className="px-3 py-2 border border-slate-700 text-sm text-slate-300"
              >
                CANCEL
              </button>
            </div>
          </div>
        )}
        {canApprove && status === 'pending' && !editing && !showReviewPrompt && (
          <>
            <button onClick={() => onApprove(expense)} className="px-3 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-medium" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              APPROVE
            </button>
            <button
              onClick={() => setShowReviewPrompt(true)}
              className="px-3 py-2 border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-sm"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
              title="Ask the submitter a question before approving"
            >
              REQUEST REVIEW
            </button>
            <button
              onClick={() => {
                const reason = window.prompt('Rejection reason (optional):') || '';
                onReject(expense, reason);
              }}
              className="px-3 py-2 border border-red-500/40 text-red-300 hover:bg-red-500/10 text-sm"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              REJECT
            </button>
          </>
        )}
        {/* On needs_review, approver can re-ask, approve directly, or reject */}
        {canApprove && status === 'needs_review' && !editing && !showReviewPrompt && (
          <>
            <button onClick={() => onApprove(expense)} className="px-3 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-medium" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              APPROVE NOW
            </button>
            <button
              onClick={() => setShowReviewPrompt(true)}
              className="px-3 py-2 border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-sm"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              ASK ANOTHER QUESTION
            </button>
            <button
              onClick={() => {
                const reason = window.prompt('Rejection reason (optional):') || '';
                onReject(expense, reason);
              }}
              className="px-3 py-2 border border-red-500/40 text-red-300 hover:bg-red-500/10 text-sm"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            >
              REJECT
            </button>
          </>
        )}
        {canApprove && status === 'needs_review' && !editing && showReviewPrompt && (
          <div className="w-full p-3 border border-amber-500/40 bg-amber-500/5">
            <div className="text-[10px] tracking-widest text-amber-300 mb-2" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              FOLLOW-UP QUESTION
            </div>
            <textarea
              value={reviewQuestion}
              onChange={(e) => setReviewQuestion(e.target.value)}
              rows={3}
              className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-amber-400"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={async () => {
                  await onRequestReview(expense, reviewQuestion);
                  setReviewQuestion('');
                  setShowReviewPrompt(false);
                }}
                disabled={!reviewQuestion.trim()}
                className="px-3 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ fontFamily: 'DM Sans, sans-serif' }}
              >
                SEND
              </button>
              <button
                onClick={() => { setShowReviewPrompt(false); setReviewQuestion(''); }}
                className="px-3 py-2 border border-slate-700 text-sm text-slate-300"
              >
                CANCEL
              </button>
            </div>
          </div>
        )}
        {canApprove && status === 'approved' && !editing && (
          <button onClick={() => onReject(expense, 'Reverted from approved')} className="px-3 py-2 border border-slate-700 text-slate-400 hover:border-amber-500/40 hover:text-amber-300 text-sm">
            REVERT
          </button>
        )}
      </div>
    </div>
  );
}

function FieldRow({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      {children}
    </label>
  );
}

function ReadField({ label, value, highlight }) {
  return (
    <div className="flex items-baseline gap-3">
      <div className="w-24 text-[10px] tracking-widest text-slate-500 shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      <div className={`flex-1 text-sm ${highlight ? 'text-cyan-300 font-bold' : 'text-slate-200'}`} style={{ fontFamily: 'DM Sans, sans-serif' }}>
        {value}
      </div>
    </div>
  );
}

/* ============================================================
   Users management screen
   ============================================================ */
function UsersScreen({ users, currentUser, realUserRole, onApproveUser, onUpdateUser, onRemoveUser, onImpersonate }) {
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  // Use realUserRole when present (so admin keeps admin powers even while impersonating)
  const effectiveRole = realUserRole || currentUser.role;
  const isAdmin = effectiveRole === 'admin' || effectiveRole === 'ops';
  const canImpersonate = effectiveRole === 'admin';

  // Sort: pending first (so admin sees them), then by name
  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      const aPending = !a.approved ? 0 : 1;
      const bPending = !b.approved ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [users]);

  const counts = useMemo(() => ({
    pending: users.filter(u => !u.approved).length,
    crew: users.filter(u => u.role === 'crew' && u.approved).length,
    sales: users.filter(u => u.role === 'sales' && u.approved).length,
    ops: users.filter(u => u.role === 'ops' && u.approved).length,
    admin: users.filter(u => u.role === 'admin' && u.approved).length,
  }), [users]);

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-3xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>USER ACCOUNTS</h2>
          <p className="text-xs text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {users.length} TOTAL · {counts.pending > 0 && <span className="text-cyan-300">{counts.pending} PENDING · </span>}
            {counts.crew} CREW · {counts.sales} SALES · {counts.ops} OPS · {counts.admin} ADMIN
          </p>
        </div>
      </div>

      {counts.pending > 0 && isAdmin && (
        <div className="mb-4 p-3 border border-cyan-500/30 bg-cyan-500/5 text-xs text-cyan-200">
          <strong>{counts.pending}</strong> {counts.pending === 1 ? 'account is' : 'accounts are'} pending approval. Review below.
        </div>
      )}

      <div className="space-y-2">
        {sortedUsers.map(u => {
          const isYou = u.uid === currentUser.id;
          const isPending = !u.approved;
          return (
            <div
              key={u.uid}
              className={`p-4 border ${isPending ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-slate-800 bg-slate-900/40'} flex items-center gap-4 flex-wrap`}
            >
              <div className="w-12 h-12 border border-slate-700 flex items-center justify-center text-cyan-400 text-lg shrink-0" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                {(u.name || '?').charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-slate-100 truncate" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                    {u.name || u.email}
                  </span>
                  {isYou && <Pill tone="amber">YOU</Pill>}
                  {isPending && <Pill tone="amber">PENDING</Pill>}
                  <Pill tone={USER_ROLES[u.role]?.tone || 'neutral'}>{USER_ROLES[u.role]?.label || (u.role || 'crew').toUpperCase()}</Pill>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {u.email || 'no email'} · {u.callsign || 'no callsign'}
                  {u.jetinsightName && u.jetinsightName !== u.name && ` · JI: ${u.jetinsightName}`}
                </div>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-1 flex-wrap">
                  {isPending && (
                    <button
                      onClick={() => onApproveUser(u.uid)}
                      className="px-3 py-1.5 text-[10px] tracking-widest border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20"
                      style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
                    >
                      APPROVE
                    </button>
                  )}
                  {!isYou && (
                    <button
                      onClick={() => setEditingId(editingId === u.uid ? null : u.uid)}
                      className="px-2 py-1.5 text-[10px] tracking-widest border border-slate-700 text-slate-300 hover:border-slate-500"
                    >
                      EDIT
                    </button>
                  )}
                  {!isYou && canImpersonate && u.approved && (
                    <button
                      onClick={() => onImpersonate?.(u.uid)}
                      className="px-2 py-1.5 text-[10px] tracking-widest border border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                      title="View the app as this user (testing only)"
                    >
                      VIEW AS
                    </button>
                  )}
                  {!isYou && (
                    confirmRemoveId === u.uid ? (
                      <>
                        <button
                          onClick={() => { onRemoveUser(u.uid); setConfirmRemoveId(null); }}
                          className="px-2 py-1.5 text-[10px] tracking-widest border border-red-500/40 text-red-300 hover:bg-red-500/10"
                        >
                          CONFIRM
                        </button>
                        <button
                          onClick={() => setConfirmRemoveId(null)}
                          className="px-2 py-1.5 text-[10px] tracking-widest border border-slate-700 text-slate-400"
                        >
                          CANCEL
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmRemoveId(u.uid)}
                        className="text-slate-600 hover:text-red-400 p-1.5"
                        title="Remove user"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )
                  )}
                </div>
              )}
              {editingId === u.uid && (
                <UserEditPanel
                  user={u}
                  onSave={(patch) => { onUpdateUser(u.uid, patch); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </div>
          );
        })}
      </div>

      {!isAdmin && (
        <div className="mt-4 p-3 border border-slate-800 bg-slate-900/40 text-xs text-slate-500">
          You are signed in as <strong>{USER_ROLES[currentUser.role]?.label}</strong>. Only Ops and Admin roles can manage users.
        </div>
      )}

      <div className="mt-6 p-3 border border-slate-800 bg-slate-900/40 text-[11px] text-slate-500 leading-relaxed">
        <strong className="text-slate-300">How accounts work:</strong> New users sign up themselves at the login screen with email + password. They must verify their email and then be approved here before they can access trips.
      </div>
    </div>
  );
}

function UserEditPanel({ user, onSave, onCancel }) {
  const [form, setForm] = useState({
    name: user.name || '',
    callsign: user.callsign || '',
    jetinsightName: user.jetinsightName || '',
    role: user.role || 'crew',
  });
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="w-full mt-3 pt-3 border-t border-slate-800 space-y-3">
      <FieldInput label="FULL NAME" value={form.name} onChange={set('name')} />
      <FieldInput label="CALLSIGN" value={form.callsign} onChange={set('callsign')} />
      <FieldInput label="NAME IN JETINSIGHT" value={form.jetinsightName} onChange={set('jetinsightName')} />
      <div>
        <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ROLE</span>
        <div className="grid grid-cols-2 gap-2 mt-1">
          {Object.entries(USER_ROLES).map(([key, meta]) => (
            <button
              key={key}
              onClick={() => setForm(f => ({ ...f, role: key }))}
              className={`p-2 border text-xs tracking-widest ${form.role === key ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
            >
              {meta.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 py-2 border border-slate-700 text-sm text-slate-300">Cancel</button>
        <button
          onClick={() => onSave(form)}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm tracking-widest"
          style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
        >
          SAVE
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   Main app
   ============================================================ */
export default function CharterOps() {
  // Auth & users
  const { authState, profile, user, signOut } = useAuth();
  const { users, loading: usersLoading, updateUser, removeUser, approveUser } = useFirestoreUsers(profile);

  // App state
  const [config, setConfig] = useState({ icalUrl: DEFAULT_ICAL_URL, opsEmail: '', crewName: '' });
  const [trips, setTrips] = useState([]);
  const [manualTrips, setManualTrips] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(() => {
    // Auto-open Settings on return from QBO OAuth so the user sees the result
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      if (p.get('qbo') === 'connected' || p.get('qbo') === 'error') return true;
    }
    return false;
  });
  const [showProfile, setShowProfile] = useState(false);
  const [syncStatus, setSyncStatus] = useState({ status: 'idle', message: '' });
  const [syncLog, setSyncLog] = useState([]);
  const [tripStatusCounts, setTripStatusCounts] = useState({});
  const [tripUpdatedAt, setTripUpdatedAt] = useState({});  // { [tripUid]: timestamp } — kept for audio alert effect
  const [tripChatAt, setTripChatAt] = useState({});        // { [tripUid]: timestamp } — latest chat msg
  const [tripStateAt, setTripStateAt] = useState({});      // { [tripUid]: timestamp } — latest state change
  const [tripLastSeen, setTripLastSeen] = useState({});  // { [tripUid]: timestamp }
  const [tripArchived, setTripArchived] = useState({});  // { [tripUid]: true } — manually archived
  const [showArchived, setShowArchived] = useState(false);
  const [now, setNow] = useState(new Date());
  const [showAllCategories, setShowAllCategories] = useState(false);
  // Tail filter — single-select. Empty string means "ALL". Persists in
  // localStorage so ops doesn't have to re-filter every page load. Visible
  // only to ops + admin (gated in render below).
  const [tailFilter, setTailFilter] = useState(() => {
    try { return localStorage.getItem('skyway-tail-filter') || ''; }
    catch { return ''; }
  });
  useEffect(() => {
    try {
      if (tailFilter) localStorage.setItem('skyway-tail-filter', tailFilter);
      else localStorage.removeItem('skyway-tail-filter');
    } catch { /* ignore quota errors */ }
  }, [tailFilter]);
  const [section, setSection] = useState('schedule');
  // FlightAware live tracking kill switch — synced from Firestore so admin can
  // disable it cluster-wide if costs spike. Default: enabled.
  const [trackingEnabled, setTrackingEnabled] = useState(true);

  // Subscribe to FlightAware tracking config — admin kill switch
  useEffect(() => {
    let unsub = null;
    let cancelled = false;
    (async () => {
      try {
        const { db } = await import('./firebase.js');
        const { doc, onSnapshot } = await import('firebase/firestore');
        if (cancelled) return;
        unsub = onSnapshot(doc(db, 'flightaware', 'config'), (snap) => {
          if (cancelled) return;
          if (snap.exists()) {
            const data = snap.data();
            // Default to true if field missing; only false explicitly disables
            setTrackingEnabled(data.trackingEnabled !== false);
          }
        });
      } catch (err) {
        console.warn('[tracking] config subscribe failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, []);

  // Load lastSeen from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('skyway:lastSeen');
      if (raw) setTripLastSeen(JSON.parse(raw));
    } catch (e) { /* ignore */ }
  }, []);

  // When a trip is opened, mark it as seen
  const markTripSeen = useCallback((tripUid) => {
    setTripLastSeen(prev => {
      const next = { ...prev, [tripUid]: Date.now() };
      try {
        localStorage.setItem('skyway:lastSeen', JSON.stringify(next));
      } catch (e) { /* ignore */ }
      return next;
    });
  }, []);

  // Has this trip been updated since the user last viewed it?
  // Returns 'chat' if newest unread thing is a chat msg,
  // 'update' if it's a status/state change, or null if seen.
  const tripHasUpdates = useCallback((tripUid) => {
    const seen = tripLastSeen[tripUid] || 0;
    const chatTs = tripChatAt[tripUid] || 0;
    const stateTs = tripStateAt[tripUid] || 0;
    const newChat = chatTs > seen;
    const newState = stateTs > seen;
    if (!newChat && !newState) return null;
    // If both are new since last seen, label by whichever is more recent
    if (newChat && newState) return chatTs >= stateTs ? 'chat' : 'update';
    return newChat ? 'chat' : 'update';
  }, [tripChatAt, tripStateAt, tripLastSeen]);

  // Archive logic — three states:
  //   active      = visible in SCHEDULE
  //   archived    = in ARCHIVE tab (manual archive, marked complete, or 24+ hours past arrival)
  //   hidden      = archived more than 15 days ago — never shown anywhere
  // Returns: 'active' | 'archived' | 'hidden'
  const tripArchiveState = useCallback((trip) => {
    if (!trip) return 'active';
    const FIFTEEN_DAYS_MS = 15 * 24 * 3600 * 1000;
    const TWO_HOURS_MS = 2 * 3600 * 1000;

    // 1. Manually archived OR completed (Firestore-backed)
    const manualArchivedAt = tripArchived[trip.uid];
    if (manualArchivedAt) {
      const ts = typeof manualArchivedAt === 'number' ? manualArchivedAt : Date.now();
      if (Date.now() - ts > FIFTEEN_DAYS_MS) return 'hidden';
      return 'archived';
    }

    // 2. Auto-archive 2+ hours past scheduled arrival. This catches trips
    // that crew forgot to Mark Complete. Conservative window: 2 hours is
    // long enough that a real delay doesn't bump a trip off the active
    // schedule prematurely, but short enough that yesterday's flights
    // aren't cluttering the view. When ADS-B integration lands, real
    // arrival events will move the trip to archived earlier than this
    // fallback would.
    if (trip.end) {
      const arrivalMs = trip.end instanceof Date ? trip.end.getTime() : trip.end;
      const ageMs = Date.now() - arrivalMs;
      if (ageMs > FIFTEEN_DAYS_MS) return 'hidden';
      if (ageMs > TWO_HOURS_MS) return 'archived';
    }
    return 'active';
  }, [tripArchived]);

  // Convenience helpers
  const isTripArchived = useCallback((trip) => tripArchiveState(trip) === 'archived', [tripArchiveState]);
  const isTripHidden = useCallback((trip) => tripArchiveState(trip) === 'hidden', [tripArchiveState]);

  // Archive a trip (writes archived=true to Firestore so it syncs to all devices)
  const archiveTrip = useCallback(async (tripUid) => {
    try {
      const { saveTripState } = await import('./firebase-data.js');
      const { getDoc, doc } = await import('firebase/firestore');
      const { db } = await import('./firebase.js');
      const safeId = String(tripUid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
      // Read current state, set archived=true, write back
      const snap = await getDoc(doc(db, 'trip-state', safeId));
      const current = snap.exists() ? snap.data() : {};
      await saveTripState(tripUid, {
        ...current,
        archived: true,
        archivedAt: Date.now(),
      });
      // Optimistic update
      setTripArchived(prev => ({ ...prev, [tripUid]: Date.now() }));
    } catch (err) {
      console.error('Failed to archive trip:', err);
    }
  }, []);

  // Unarchive (restore) a trip
  const unarchiveTrip = useCallback(async (tripUid) => {
    try {
      const { saveTripState } = await import('./firebase-data.js');
      const { getDoc, doc } = await import('firebase/firestore');
      const { db } = await import('./firebase.js');
      const safeId = String(tripUid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
      const snap = await getDoc(doc(db, 'trip-state', safeId));
      const current = snap.exists() ? snap.data() : {};
      await saveTripState(tripUid, {
        ...current,
        archived: false,
        archivedAt: null,
      });
      setTripArchived(prev => {
        const next = { ...prev };
        delete next[tripUid];
        return next;
      });
    } catch (err) {
      console.error('Failed to unarchive trip:', err);
    }
  }, []);

  // Map Firebase profile to legacy currentUser shape so the rest of the app keeps working
  // Admin impersonation: when set to another user's uid, currentUser appears as that user
  // for testing different role views. Only works if the actual logged-in user is admin.
  const [impersonateUid, setImpersonateUid] = useState(null);

  const currentUser = useMemo(() => {
    if (!profile) return null;
    // Use the LIVE version of the profile from `users` (subscribed to
    // Firestore) when available — `profile` itself only updates on auth
    // state changes, so saving e.g. savedSignature wouldn't reflect without
    // this. Fall back to `profile` if users list hasn't loaded yet.
    const liveProfile = users.find(u => u.uid === profile.uid) || profile;
    const realUser = {
      id: liveProfile.uid,
      uid: liveProfile.uid,
      name: liveProfile.name || '',
      email: liveProfile.email || '',
      callsign: liveProfile.callsign || '',
      jetinsightName: liveProfile.jetinsightName || liveProfile.name || '',
      role: liveProfile.role || 'crew',
      active: liveProfile.active !== false,
      approved: liveProfile.approved === true,
      savedSignature: liveProfile.savedSignature || null,
    };
    // Only admins can impersonate
    if (impersonateUid && realUser.role === 'admin') {
      const target = users.find(u => u.uid === impersonateUid);
      if (target) {
        return {
          id: target.uid,
          name: target.name || '',
          email: target.email || '',
          callsign: target.callsign || '',
          jetinsightName: target.jetinsightName || target.name || '',
          role: target.role || 'crew',
          active: target.active !== false,
          approved: target.approved === true,
          _impersonating: true,
          _realName: realUser.name,
        };
      }
    }
    return realUser;
  }, [profile, impersonateUid, users]);

  // Tick clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // === In-app alert system: beep + tab title flash on new updates ===
  // Plays a brief tone using Web Audio API (no external file needed) and flashes the
  // browser tab title so the user notices when on another tab. Both stop when user
  // returns to the app or after a few cycles.
  const lastAlertCheckRef = useRef(Date.now());
  const tabFlashRef = useRef(null);

  const playAlertBeep = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      // Two-tone "ding": 880Hz for 120ms, then 660Hz for 120ms
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {
      // Audio may be blocked until first user interaction — silently ignore
    }
  }, []);

  const flashTabTitle = useCallback((message) => {
    // Don't flash if user is currently looking at this tab
    if (!document.hidden) return;
    if (tabFlashRef.current) clearInterval(tabFlashRef.current);
    const original = 'Skyway Aviation Ops';
    let alt = true;
    tabFlashRef.current = setInterval(() => {
      document.title = alt ? `🔵 ${message}` : original;
      alt = !alt;
    }, 1000);
    // Stop flashing once tab regains focus
    const stopOnFocus = () => {
      if (!document.hidden) {
        if (tabFlashRef.current) {
          clearInterval(tabFlashRef.current);
          tabFlashRef.current = null;
        }
        document.title = original;
        document.removeEventListener('visibilitychange', stopOnFocus);
      }
    };
    document.addEventListener('visibilitychange', stopOnFocus);
  }, []);

  // Watch tripUpdatedAt for new updates since last check — alert when something fires
  useEffect(() => {
    let newCount = 0;
    for (const uid in tripUpdatedAt) {
      const ts = tripUpdatedAt[uid];
      if (ts > lastAlertCheckRef.current) {
        newCount++;
      }
    }
    if (newCount > 0) {
      playAlertBeep();
      flashTabTitle(`${newCount} new update${newCount > 1 ? 's' : ''}`);
      lastAlertCheckRef.current = Date.now();
    }
  }, [tripUpdatedAt, playAlertBeep, flashTabTitle]);

  // Diagnostic log helper
  const log = useCallback((level, message) => {
    setSyncLog(l => [...l.slice(-49), { level, message, timestamp: Date.now() }]);
  }, []);

  // Load config + cached iCal + manual trips on mount
  useEffect(() => {
    (async () => {
      const cfg = await storage.get('settings:config', false, null);
      const effectiveCfg = cfg || { icalUrl: DEFAULT_ICAL_URL, opsEmail: '', crewName: '' };
      if (!effectiveCfg.icalUrl) effectiveCfg.icalUrl = DEFAULT_ICAL_URL;
      setConfig(effectiveCfg);

      const cached = await storage.get('cached:ical', false, null);
      if (cached?.text) {
        const events = parseICal(cached.text);
        setTrips(buildTripsFromEvents(events));
        log('info', `Loaded ${events.length} events from cache`);
      }

      // Manual trips now sync via Firebase (handled by useEffect below)
      setLoading(false);

      // Auto-fetch fresh data in the background
      if (effectiveCfg.icalUrl) {
        autoFetch(effectiveCfg.icalUrl);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Combined trips list: iCal + manual, sorted, filtered by user role.
  // Pilots only see trips where their JetInsight name matches PIC or SIC.
  // Ops and admins see everything.
  const allTrips = useMemo(() => {
    const merged = [...trips, ...manualTrips]
      .filter(t => t.start)
      .sort((a, b) => a.start - b.start);
    if (!currentUser || currentUser.role !== 'crew') return merged;
    const pilotName = currentUser.jetinsightName || currentUser.name;
    return merged.filter(t =>
      nameMatchesPilot(t.info?.pic, pilotName) ||
      nameMatchesPilot(t.info?.sic, pilotName)
    );
  }, [trips, manualTrips, currentUser]);

  // Subscribe to manual trips from Firebase (real-time sync across all users)
  useEffect(() => {
    let unsub = null;
    (async () => {
      try {
        const { subscribeToManualTrips } = await import('./firebase-data.js');
        unsub = subscribeToManualTrips((trips) => {
          setManualTrips(trips);
        });
      } catch (err) {
        console.error('Failed to subscribe to manual trips:', err);
      }
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  // Refresh status counts for sidebar — only for visible upcoming trips
  // (limited to ~50 to keep Firestore reads reasonable; full scan of 1000+ trips would burn quota)
  useEffect(() => {
    if (allTrips.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { getDoc, doc, collection, query, orderBy, limit, getDocs } = await import('firebase/firestore');
        const { db } = await import('./firebase.js');
        // Poll trips in a window from 14 days ago through the future. The
        // backwards window is needed so trips marked complete in the recent
        // past keep their archived flag in local state across refreshes —
        // otherwise the next poll wouldn't read their archived=true and they'd
        // pop back into the active schedule.
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const fourteenDaysAgo = startOfToday.getTime() - (14 * 24 * 3600 * 1000);
        const visibleTrips = allTrips
          .filter(t => t.start && t.start >= fourteenDaysAgo)
          .slice(0, 100);

        const counts = {};
        const updates = {};
        const chatTs = {};
        const stateTs = {};
        const archived = {};
        for (const t of visibleTrips) {
          if (cancelled) return;
          try {
            const safeId = String(t.uid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
            const snap = await getDoc(doc(db, 'trip-state', safeId));
            const state = snap.exists() ? snap.data() : {};
            const stat = state.statuses || {};
            counts[t.uid] = Object.keys(stat).length;
            // A trip is treated as archived if EITHER:
            // - state.archived === true (manual archive or marked complete)
            // - state.completed === true (defensive: covers cases where archived
            //   wasn't written for some reason, or older records)
            if (state.archived === true || state.completed === true) {
              archived[t.uid] = state.archivedAt || state.completedAt || true;
            }
            const sTs = state.updatedAt || 0;
            if (sTs > 0) stateTs[t.uid] = sTs;
            let latest = sTs;
            // Read latest chat message timestamp ONLY if trip-state exists
            if (snap.exists()) {
              try {
                const chatRef = collection(db, 'trips', safeId, 'messages');
                const q = query(chatRef, orderBy('timestamp', 'desc'), limit(1));
                const chatSnap = await getDocs(q);
                if (!chatSnap.empty) {
                  const m = chatSnap.docs[0].data();
                  const msgTs = m.timestamp?.toMillis?.() ?? (typeof m.timestamp === 'number' ? m.timestamp : 0);
                  if (msgTs > 0) chatTs[t.uid] = msgTs;
                  if (msgTs > latest) latest = msgTs;
                }
              } catch (err) { /* chat may not exist yet */ }
            }
            if (latest > 0) updates[t.uid] = latest;
          } catch (err) {
            counts[t.uid] = 0;
          }
        }
        if (!cancelled) {
          setTripStatusCounts(counts);
          setTripUpdatedAt(prev => ({ ...prev, ...updates }));
          setTripChatAt(prev => ({ ...prev, ...chatTs }));
          setTripStateAt(prev => ({ ...prev, ...stateTs }));
          setTripArchived(archived);
        }
      } catch (err) {
        console.error('Failed to load status counts:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [allTrips, selectedId, now]);

  function buildTripsFromEvents(events) {
    return events
      .map(ev => {
        const start = parseICalDate(ev.DTSTART) || parseICalDate(ev['DTSTART;VALUE=DATE']);
        const end = parseICalDate(ev.DTEND);
        const uid = ev.UID || `auto-${Math.random().toString(36).slice(2, 10)}`;
        return { uid, start, end, info: extractTripInfo(ev), raw: ev };
      })
      .filter(t => t.start)
      .sort((a, b) => a.start - b.start);
  }

  const loadFromText = async (text) => {
    setSyncStatus({ status: 'syncing', message: 'Parsing iCal...' });
    log('info', `Parsing ${text.length} bytes...`);
    try {
      const events = parseICal(text);
      if (events.length === 0) {
        setSyncStatus({ status: 'error', message: 'No events in feed' });
        log('error', 'Parsed 0 events from iCal');
        return;
      }
      const newTrips = buildTripsFromEvents(events);
      setTrips(newTrips);
      await storage.set('cached:ical', { text, fetchedAt: Date.now() });
      setSyncStatus({ status: 'ok', message: `Loaded ${newTrips.length} trips` });
      log('success', `Parsed ${events.length} events → ${newTrips.length} trips`);
      setShowSettings(false);
    } catch (e) {
      setSyncStatus({ status: 'error', message: e.message });
      log('error', `Parse error: ${e.message}`);
    }
  };

  // Multi-proxy sync with full diagnostic logging
  const loadFromUrl = async (url) => {
    if (!url) return;
    setSyncStatus({ status: 'syncing', message: 'Starting sync...' });
    log('info', `Sync start → ${url.slice(0, 80)}`);

    const proxies = [
      { name: 'skyway-proxy',   build: u => `/api/ical?url=${encodeURIComponent(u)}` },
      { name: 'direct',         build: u => u },
      { name: 'corsproxy.io',   build: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
      { name: 'allorigins.win', build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
      { name: 'codetabs',       build: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
    ];

    for (const proxy of proxies) {
      try {
        log('info', `Attempt: ${proxy.name}`);
        setSyncStatus({ status: 'syncing', message: `Via ${proxy.name}...` });
        const target = proxy.build(url);
        const r = await fetch(target);
        if (!r.ok) {
          log('warn', `${proxy.name} → HTTP ${r.status} ${r.statusText}`);
          continue;
        }
        const text = await r.text();
        if (!text || !text.includes('BEGIN:VCALENDAR')) {
          log('warn', `${proxy.name} → ${text.length}b, not iCal format`);
          continue;
        }
        log('success', `${proxy.name} → ${text.length}b OK`);
        await loadFromText(text);
        return;
      } catch (e) {
        log('error', `${proxy.name} → ${e.message}`);
      }
    }

    setSyncStatus({ status: 'error', message: 'All proxies failed — paste content' });
    log('error', 'All sync paths exhausted. Use "PASTE iCAL" instead.');
  };

  const autoFetch = async (url) => {
    if (!url) return;
    await loadFromUrl(url);
  };

  const loadDemo = async () => {
    await loadFromText(buildDemoICal());
  };

  // Manual trip creation (Ops can add trips directly)
  const addManualTrip = async (data) => {
    const trip = {
      uid: genId('manual'),
      start: data.dep,
      end: data.arr,
      info: {
        tail: data.tail,
        from: data.from,
        to: data.to,
        pax: data.pax,
        customer: data.customer,
        broker: data.broker,
        pic: data.pic,
        sic: data.sic,
        notes: data.notes,
        category: data.pax === 0 ? 'REPO' : 'REVENUE',
        legType: data.pax === 0 ? 'REPO' : 'REVENUE',
        isFlight: true,
        isOps: true,
        rawSummary: `[${data.tail}] ${data.customer || 'Manual entry'} (${data.from} - ${data.to}) - Manual`,
        rawDescription: `Pax: ${data.pax}\nPIC: ${data.pic}\nSIC: ${data.sic}\n${data.notes || ''}`,
        rawLocation: data.from,
        url: '',
        tripType: 'Manual',
      },
      raw: { manual: true, createdBy: currentUser?.id, createdAt: Date.now() },
    };
    try {
      const { saveManualTrip } = await import('./firebase-data.js');
      await saveManualTrip(trip);
      log('success', `Manual trip created: ${trip.info.tail} ${trip.info.from}→${trip.info.to}`);
    } catch (err) {
      console.error('Failed to save manual trip:', err);
      alert('Failed to save trip — check your connection');
    }
  };

  const removeManualTrip = async (uid) => {
    try {
      const { deleteManualTrip } = await import('./firebase-data.js');
      await deleteManualTrip(uid);
    } catch (err) {
      console.error('Failed to delete manual trip:', err);
      alert('Failed to delete trip — check your connection');
    }
  };

  const selectedTrip = useMemo(
    () => allTrips.find(t => t.uid === selectedId),
    [allTrips, selectedId]
  );

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, [now]);
  const tomorrow = useMemo(() => new Date(today.getTime() + 86400000), [today]);

  const groupedTrips = useMemo(() => {
    const groups = { past: [], today: [], tomorrow: [], later: [], archived: [] };
    let filtered = showAllCategories ? allTrips : allTrips.filter(t => t.info.isFlight);
    // Apply tail filter (single-select). Empty = ALL.
    // Trips without a tail are hidden when a specific tail is active.
    if (tailFilter) {
      const tf = tailFilter.toUpperCase();
      filtered = filtered.filter(t => (t.info.tail || '').toUpperCase() === tf);
    }
    for (const t of filtered) {
      if (!t.start) continue;
      // Hidden (>15 days archived) — skip entirely, never show
      if (isTripHidden(t)) continue;
      // Archived trips go to their own bucket regardless of date
      if (isTripArchived(t)) {
        groups.archived.push(t);
        continue;
      }
      if (t.start < today) groups.past.push(t);
      else if (t.start < tomorrow) groups.today.push(t);
      else if (t.start < new Date(tomorrow.getTime() + 86400000)) groups.tomorrow.push(t);
      else groups.later.push(t);
    }
    groups.past.reverse(); // newest past first
    groups.archived.sort((a, b) => (b.start?.getTime?.() || 0) - (a.start?.getTime?.() || 0)); // newest archived first
    return groups;
  }, [allTrips, today, tomorrow, showAllCategories, tailFilter, isTripArchived, isTripHidden]);

  const feedStats = useMemo(() => {
    if (allTrips.length === 0) return null;
    const flightTrips = allTrips.filter(t => t.info.isFlight && t.start);
    if (flightTrips.length === 0) return null;
    const firstDate = flightTrips[0].start;
    const lastDate = flightTrips[flightTrips.length - 1].start;
    const futureCount = flightTrips.filter(t => t.start >= today).length;
    return { firstDate, lastDate, futureCount, totalCount: flightTrips.length };
  }, [allTrips, today]);

  // === Loading & login gate ===
  if (authState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (authState === 'signed-out') {
    return <LoginScreen />;
  }

  if (authState === 'unverified') {
    return <VerificationScreen user={user} profile={profile} onSignOut={signOut} />;
  }

  if (authState === 'pending') {
    return <PendingApprovalScreen user={user} profile={profile} onSignOut={signOut} />;
  }

  if (authState === 'no-profile') {
    return <NoProfileScreen user={user} onSignOut={signOut} />;
  }

  // authState === 'active' — full access. Wait for users list to load too.
  if (usersLoading || !currentUser) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  const userDisplayName = currentUser.callsign || currentUser.name;

  // === Authenticated app ===
  return (
    <div className="h-screen w-full bg-slate-950 text-slate-100 antialiased overflow-hidden">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        body { font-family: 'DM Sans', sans-serif; }
        * { font-feature-settings: "ss01", "cv11"; }
        .grid-bg {
          background-image:
            linear-gradient(rgba(148, 163, 184, 0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148, 163, 184, 0.04) 1px, transparent 1px);
          background-size: 32px 32px;
        }
        .scroll-area::-webkit-scrollbar { width: 6px; }
        .scroll-area::-webkit-scrollbar-track { background: transparent; }
        .scroll-area::-webkit-scrollbar-thumb { background: #334155; }
      `}</style>

      <div className="grid-bg h-full flex flex-col">
        {currentUser?._impersonating && (
          <div className="bg-amber-500 text-slate-950 px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              VIEWING AS <span className="uppercase">{currentUser.name}</span> · {USER_ROLES[currentUser.role]?.label || currentUser.role.toUpperCase()}
              <span className="text-slate-700 ml-2">(real user: {currentUser._realName})</span>
            </div>
            <button
              onClick={() => setImpersonateUid(null)}
              className="px-3 py-1 text-[10px] tracking-widest bg-slate-950 text-amber-400 hover:bg-slate-800"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
            >
              STOP & RETURN TO ADMIN
            </button>
          </div>
        )}
        <TopNav
          currentSection={section}
          setCurrentSection={(s) => { setSection(s); setSelectedId(null); }}
          currentUser={currentUser}
          onLogout={signOut}
          syncStatus={syncStatus}
          now={now}
          tripCount={allTrips.length}
          onOpenSettings={() => setShowSettings(true)}
          onOpenProfile={() => setShowProfile(true)}
        />

        {/* === SCHEDULE SECTION (existing trip view) === */}
        {section === 'schedule' && (
          <div className="flex-1 flex overflow-hidden">
            <aside className={`w-full md:w-80 lg:w-96 border-r border-slate-800 bg-slate-950/80 overflow-y-auto scroll-area ${selectedId ? 'hidden md:block' : 'block'}`}>
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
                <h2 className="text-xs tracking-[0.2em]" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>SCHEDULE</h2>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setShowAllCategories(v => !v)}
                    className={`text-[10px] tracking-widest px-2 py-1 border ${showAllCategories ? 'border-cyan-400 text-cyan-300' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                    title="Toggle ground events"
                  >
                    {showAllCategories ? 'ALL' : 'OPS'}
                  </button>
                  <button
                    onClick={() => loadFromUrl(config.icalUrl)}
                    disabled={syncStatus.status === 'syncing' || !config.icalUrl}
                    className="text-[10px] text-slate-500 hover:text-cyan-400 tracking-widest disabled:opacity-50 flex items-center gap-1"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                    title="Refresh from feed"
                  >
                    {syncStatus.status === 'syncing' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    SYNC
                  </button>
                </div>
              </div>

              {/* Tail filter — ops + admin only. Single-select chip row,
                  sticky to the top of the scroll area. ALL chip clears the filter. */}
              {['ops', 'admin'].includes(currentUser?.role) && (
                <div className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-3 py-2">
                  <div className="flex items-center gap-1.5 overflow-x-auto scroll-area pb-1">
                    <button
                      onClick={() => setTailFilter('')}
                      className={`shrink-0 text-[10px] tracking-widest px-2.5 py-1 border transition-colors ${
                        tailFilter === ''
                          ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300'
                          : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                      }`}
                      style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
                    >
                      ALL
                    </button>
                    {SKYWAY_TAILS.map(tail => (
                      <button
                        key={tail}
                        onClick={() => setTailFilter(tail)}
                        className={`shrink-0 text-[10px] tracking-widest px-2.5 py-1 border transition-colors ${
                          tailFilter === tail
                            ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300'
                            : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                        }`}
                        style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
                      >
                        {tail}
                      </button>
                    ))}
                  </div>
                  {tailFilter && (
                    <div className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      Showing only <span className="text-cyan-300">{tailFilter}</span> · Tap ALL to clear
                    </div>
                  )}
                </div>
              )}

              {loading ? (
                <div className="p-8 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </div>
              ) : allTrips.length === 0 ? (
                <div className="p-6 text-center">
                  <Calendar className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                  <p className="text-sm text-slate-400 mb-1">No trips loaded</p>
                  <p className="text-xs text-slate-600 mb-4">Sync feed, paste content, or add manually.</p>
                  <button
                    onClick={() => setShowSettings(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
                  >
                    <SettingsIcon className="w-4 h-4" /> Configure Feed
                  </button>
                </div>
              ) : (
                <div>
                  {feedStats && feedStats.futureCount === 0 && (
                    <div className="mx-3 mt-3 p-3 border border-cyan-500/30 bg-cyan-500/5">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs tracking-widest text-cyan-300" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                            NO UPCOMING TRIPS
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                            Feed has {feedStats.totalCount} flight{feedStats.totalCount !== 1 ? 's' : ''} from{' '}
                            <span className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{fmtDateZ(feedStats.firstDate).slice(0, 6)}</span>
                            {' → '}
                            <span className="text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{fmtDateZ(feedStats.lastDate).slice(0, 6)}</span>.
                            Tap SYNC, paste fresh content, or add a trip manually from the Ops tab.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  {feedStats && feedStats.futureCount > 0 && (
                    <div className="mx-3 mt-3 p-2 border border-slate-800 bg-slate-900/40 text-[11px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {feedStats.futureCount} UPCOMING · {feedStats.totalCount} TOTAL · {fmtDateZ(feedStats.firstDate).slice(0, 6)} → {fmtDateZ(feedStats.lastDate).slice(0, 6)}
                    </div>
                  )}

                  {groupedTrips.today.length > 0 && (
                    <div>
                      <div className="px-4 py-2 text-[10px] tracking-[0.2em] text-cyan-400 bg-cyan-500/5 border-y border-cyan-500/20" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        TODAY · {groupedTrips.today.length}
                      </div>
                      {groupedTrips.today.map(trip => (
                        <TripCard key={trip.uid} trip={trip} selected={trip.uid === selectedId} statusCount={tripStatusCounts[trip.uid] || 0} hasUpdate={tripHasUpdates(trip.uid)} onArchive={archiveTrip} onClick={() => { setSelectedId(trip.uid); markTripSeen(trip.uid); }} />
                      ))}
                    </div>
                  )}
                  {groupedTrips.tomorrow.length > 0 && (
                    <div>
                      <div className="px-4 py-2 text-[10px] tracking-[0.2em] text-cyan-400 bg-cyan-500/5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        TOMORROW · {groupedTrips.tomorrow.length}
                      </div>
                      {groupedTrips.tomorrow.map(trip => (
                        <TripCard key={trip.uid} trip={trip} selected={trip.uid === selectedId} statusCount={tripStatusCounts[trip.uid] || 0} hasUpdate={tripHasUpdates(trip.uid)} onArchive={archiveTrip} onClick={() => { setSelectedId(trip.uid); markTripSeen(trip.uid); }} />
                      ))}
                    </div>
                  )}
                  {groupedTrips.later.length > 0 && (
                    <div>
                      <div className="px-4 py-2 text-[10px] tracking-[0.2em] text-slate-400 bg-slate-900/40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        UPCOMING · {groupedTrips.later.length}
                      </div>
                      {groupedTrips.later.map(trip => (
                        <TripCard key={trip.uid} trip={trip} selected={trip.uid === selectedId} statusCount={tripStatusCounts[trip.uid] || 0} hasUpdate={tripHasUpdates(trip.uid)} onArchive={archiveTrip} onClick={() => { setSelectedId(trip.uid); markTripSeen(trip.uid); }} />
                      ))}
                    </div>
                  )}
                  {groupedTrips.past.length > 0 && (
                    <div>
                      <div className="px-4 py-2 text-[10px] tracking-[0.2em] text-slate-600 bg-slate-900/40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        PAST · {groupedTrips.past.length} · NEWEST FIRST
                      </div>
                      {groupedTrips.past.map(trip => (
                        <TripCard key={trip.uid} trip={trip} selected={trip.uid === selectedId} statusCount={tripStatusCounts[trip.uid] || 0} hasUpdate={tripHasUpdates(trip.uid)} onArchive={archiveTrip} onClick={() => { setSelectedId(trip.uid); markTripSeen(trip.uid); }} />
                      ))}
                    </div>
                  )}
                  {showArchived && false && groupedTrips.archived.length > 0 && (
                    <div>
                      <div className="px-4 py-2 text-[10px] tracking-[0.2em] text-slate-600 bg-slate-900/40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        ARCHIVED · {groupedTrips.archived.length}
                      </div>
                      {groupedTrips.archived.map(trip => (
                        <TripCard key={trip.uid} trip={trip} selected={trip.uid === selectedId} statusCount={tripStatusCounts[trip.uid] || 0} hasUpdate={tripHasUpdates(trip.uid)} onClick={() => { setSelectedId(trip.uid); markTripSeen(trip.uid); }} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </aside>

            <main className={`flex-1 overflow-hidden flex flex-col min-h-0 ${selectedId ? 'block' : 'hidden md:flex'}`}>
              {selectedTrip ? (
                <TripDetail
                  trip={selectedTrip}
                  currentUser={currentUser}
                  currentUserDisplayName={userDisplayName}
                  allTrips={allTrips}
                  opsEmail={OPS_EMAIL}
                  onBack={() => setSelectedId(null)}
                  onArchive={(uid, archived) => archived ? archiveTrip(uid) : unarchiveTrip(uid)}
                />
              ) : (
                <div className="h-full flex items-center justify-center p-8 grid-bg">
                  <div className="text-center max-w-md">
                    <div className="w-20 h-20 mx-auto mb-4 border border-slate-800 flex items-center justify-center">
                      <Plane className="w-10 h-10 text-slate-700" />
                    </div>
                    <h2 className="text-2xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                      SELECT A TRIP
                    </h2>
                    <p className="text-sm text-slate-500">
                      {allTrips.length === 0
                        ? 'Configure your iCal feed or load demo trips to begin.'
                        : 'Choose a leg from the sidebar to view status, comms, and passenger manifest.'}
                    </p>
                    {allTrips.length > 0 && (
                      <div className="mt-6 grid grid-cols-3 gap-3 text-left">
                        <Stat label="TRIPS" value={allTrips.length} />
                        <Stat label="REVENUE" value={allTrips.filter(t => t.info.legType === 'REVENUE').length} tone="cyan" />
                        <Stat label="REPO" value={allTrips.filter(t => t.info.legType === 'REPO').length} tone="violet" />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </main>
          </div>
        )}

        {/* === ARCHIVE SECTION === */}
        {section === 'archive' && (
          <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
            <aside className={`${selectedId ? 'hidden md:block' : 'block'} w-full md:w-96 md:border-r md:border-slate-800 overflow-y-auto scroll-area`}>
              <div className="px-4 py-3 border-b border-slate-800 bg-slate-950 sticky top-0 z-10">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs tracking-[0.2em]" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>ARCHIVE</h2>
                  <span className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {groupedTrips.archived.length} TRIPS
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 mt-1" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  Trips marked complete or 24+ hours past arrival. Auto-hidden after 15 days.
                </p>
              </div>
              {loading ? (
                <div className="p-8 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading archive...
                </div>
              ) : groupedTrips.archived.length === 0 ? (
                <div className="p-12 text-center">
                  <Hash className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                  <p className="text-sm text-slate-500">No archived trips</p>
                  <p className="text-xs text-slate-600 mt-1">
                    Trips appear here when marked complete or 24+ hours after arrival.
                  </p>
                </div>
              ) : (
                <div>
                  {groupedTrips.archived.map(trip => {
                    // Compute archive age for the badge
                    const archivedTs = tripArchived[trip.uid];
                    const arrivalMs = trip.end instanceof Date ? trip.end.getTime() : (typeof trip.end === 'number' ? trip.end : 0);
                    const refTs = typeof archivedTs === 'number' ? archivedTs : arrivalMs;
                    const daysAgo = refTs ? Math.floor((Date.now() - refTs) / (24 * 3600 * 1000)) : null;
                    const daysUntilHidden = daysAgo !== null ? Math.max(0, 15 - daysAgo) : null;
                    return (
                      <div key={trip.uid} className="relative">
                        <TripCard
                          trip={trip}
                          selected={trip.uid === selectedId}
                          statusCount={tripStatusCounts[trip.uid] || 0}
                          hasUpdate={tripHasUpdates(trip.uid)}
                          onClick={() => { setSelectedId(trip.uid); markTripSeen(trip.uid); }}
                        />
                        {daysUntilHidden !== null && (
                          <div className="px-4 -mt-1 pb-2 text-[10px] text-slate-600" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                            {daysUntilHidden === 0
                              ? 'Hides today'
                              : daysUntilHidden === 1
                              ? 'Hides tomorrow'
                              : `Hides in ${daysUntilHidden} days`}
                            {' · '}
                            <button
                              onClick={(e) => { e.stopPropagation(); unarchiveTrip(trip.uid); }}
                              className="text-cyan-500 hover:text-cyan-300 underline-offset-2 hover:underline"
                            >
                              Restore
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </aside>
            <main className={`flex-1 overflow-hidden flex flex-col min-h-0 ${selectedId ? 'block' : 'hidden md:flex'}`}>
              {selectedTrip ? (
                <TripDetail
                  trip={selectedTrip}
                  currentUser={currentUser}
                  currentUserDisplayName={userDisplayName}
                  allTrips={allTrips}
                  opsEmail={OPS_EMAIL}
                  onBack={() => setSelectedId(null)}
                  onArchive={(uid, archived) => archived ? archiveTrip(uid) : unarchiveTrip(uid)}
                />
              ) : (
                <div className="h-full flex items-center justify-center p-8 grid-bg">
                  <div className="text-center max-w-md">
                    <div className="w-20 h-20 mx-auto mb-4 border border-slate-800 flex items-center justify-center">
                      <Hash className="w-10 h-10 text-slate-700" />
                    </div>
                    <h2 className="text-2xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                      ARCHIVE
                    </h2>
                    <p className="text-sm text-slate-500">
                      Select an archived trip to view its history.
                    </p>
                  </div>
                </div>
              )}
            </main>
          </div>
        )}

        {/* === TRACKING SECTION === */}
        {section === 'tracking' && (
          <TrackingScreen
            currentUser={currentUser}
            allTrips={allTrips}
            trackingEnabled={trackingEnabled}
          />
        )}

        {/* === EXPENSES SECTION === */}
        {section === 'expenses' && (
          <ExpensesScreen
            currentUser={currentUser}
            currentUserUid={currentUser?.uid || currentUser?.id}
            currentUserDisplayName={userDisplayName}
          />
        )}

        {/* === MANIFESTS SECTION === */}
        {section === 'manifests' && (
          <ManifestsScreen
            currentUser={currentUser}
            allTrips={allTrips}
          />
        )}

        {/* === REPORTS SECTION === */}
        {section === 'reports' && (
          <ReportsScreen
            currentUser={currentUser}
          />
        )}

        {/* === WALLET SECTION === */}
        {section === 'wallet' && (
          <WalletScreen
            currentUser={currentUser}
            users={users}
          />
        )}

        {/* === OPS DASHBOARD SECTION === */}
        {section === 'ops' && (
          <div className="flex-1 overflow-y-auto scroll-area">
            <OpsDashboard
              trips={allTrips}
              currentUser={currentUser}
              onSelectTrip={(uid) => { setSelectedId(uid); setSection('schedule'); }}
              onAddManualTrip={addManualTrip}
              onRemoveManualTrip={removeManualTrip}
              syncStatus={syncStatus}
              syncLog={syncLog}
              onRunSync={() => loadFromUrl(config.icalUrl)}
              feedStats={feedStats}
              hasIcalUrl={!!config.icalUrl}
              onOpenPaste={() => setShowSettings(true)}
            />
          </div>
        )}

        {/* === USERS SECTION === */}
        {section === 'users' && (
          <div className="flex-1 overflow-y-auto scroll-area">
            <UsersScreen
              users={users}
              currentUser={currentUser}
              realUserRole={profile?.role}
              onApproveUser={approveUser}
              onUpdateUser={updateUser}
              onRemoveUser={removeUser}
              onImpersonate={setImpersonateUid}
            />
          </div>
        )}
      </div>

      {showSettings && (
        <SettingsModal
          config={config}
          setConfig={setConfig}
          syncStatus={syncStatus}
          currentUser={currentUser}
          allTrips={allTrips}
          onClose={() => setShowSettings(false)}
          onLoadDemo={loadDemo}
          onLoadFromUrl={loadFromUrl}
          onLoadFromText={loadFromText}
        />
      )}

      {showProfile && currentUser && (
        <MyProfileModal
          currentUser={currentUser}
          onClose={() => setShowProfile(false)}
          onSave={async (patch) => {
            await updateUser(currentUser.uid || currentUser.id, patch);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'amber' }) {
  const colors = {
    amber: 'text-cyan-400 border-cyan-500/30',
    cyan: 'text-cyan-400 border-cyan-500/30',
    violet: 'text-violet-400 border-violet-500/30',
  };
  return (
    <div className={`p-3 border ${colors[tone]}`}>
      <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      <div className={`text-2xl ${colors[tone].split(' ')[0]}`} style={{ fontFamily: 'Bebas Neue, sans-serif' }}>{value}</div>
    </div>
  );
}
