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
   AAMVA PDF417 parser for US driver's licenses
   ============================================================ */
const AAMVA_FIELDS = {
  DAA: 'fullName', DAB: 'lastName', DAC: 'firstName', DAD: 'middleName',
  DCS: 'lastName', DCT: 'firstName', DBA: 'expiration', DBB: 'dob',
  DBC: 'sex', DAQ: 'licenseNumber', DAJ: 'state', DAK: 'zip',
  DAG: 'address', DAI: 'city', DAU: 'height', DAY: 'eyeColor',
  DCF: 'documentDiscriminator', DCG: 'country', DCK: 'inventoryControl',
  DDB: 'cardRevisionDate', DDE: 'lastNameTrunc', DDF: 'firstNameTrunc',
};

function parseAAMVA(rawText) {
  if (!rawText) return null;
  const result = { raw: rawText };
  
  // AAMVA barcodes use various formats. Most common:
  // - Multi-line: each field on its own line starting with 3-letter code
  // - Single string: fields separated by ANSI control chars or newlines
  // - Some include @, ANSI, header bytes before data
  // We normalize by splitting on common delimiters and looking for AAMVA codes.
  
  // First, try multi-line split
  let segments = rawText.split(/[\r\n\x1e\x1d\x1f]+/);
  
  // If that didn't yield enough segments, try splitting by codes (3 uppercase letters)
  if (segments.length < 5) {
    // Split before any 3-uppercase-letter pattern
    segments = rawText.split(/(?=[A-Z]{3}[A-Z0-9])/);
  }
  
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed.length < 4) continue;
    // Match leading 3-letter code followed by value
    const m = trimmed.match(/^([A-Z]{3})(.+?)(?:\s*$)/);
    if (!m) continue;
    const [, code, value] = m;
    const key = AAMVA_FIELDS[code];
    if (key) {
      // Don't overwrite if we already have a value (DCS may appear before DAB; prefer first)
      if (!result[key]) result[key] = value.trim();
    }
  }
  
  // If we found nothing structured, try a regex sweep over the whole string
  if (!result.firstName && !result.lastName && !result.fullName) {
    for (const [code, key] of Object.entries(AAMVA_FIELDS)) {
      if (result[key]) continue;
      const re = new RegExp(`${code}([^\\n\\r\\x1e\\x1d\\x1f]+)`);
      const m = rawText.match(re);
      if (m) result[key] = m[1].trim();
    }
  }
  
  // Format dates: AAMVA format is MMDDCCYY (US) or CCYYMMDD (some states/Canada)
  const parseDate = (s) => {
    if (!s) return null;
    // MMDDCCYY (most common US format)
    let m = s.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (m) {
      const [, mm, dd, yyyy] = m;
      // Sanity check: month 01-12, day 01-31
      if (parseInt(mm) >= 1 && parseInt(mm) <= 12 && parseInt(dd) >= 1 && parseInt(dd) <= 31) {
        return `${yyyy}-${mm}-${dd}`;
      }
    }
    // CCYYMMDD format
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) {
      const [, yyyy, mm, dd] = m;
      if (parseInt(mm) >= 1 && parseInt(mm) <= 12 && parseInt(dd) >= 1 && parseInt(dd) <= 31) {
        return `${yyyy}-${mm}-${dd}`;
      }
    }
    return s;
  };
  
  if (result.dob) result.dobISO = parseDate(result.dob);
  if (result.expiration) result.expirationISO = parseDate(result.expiration);
  
  return result;
}

/* ============================================================
   Storage helpers — wrap window.storage with safe defaults
   ============================================================ */
const DEFAULT_ICAL_URL = 'https://portal.jetinsight.com/schedule/7a32dd47-6a5c-4c9c-b53b-864381bacebf/1243136b-b3ab-4dff-b0cf-edf264e20fbf.ics';

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
  crew:  { label: 'CREW',  tone: 'cyan',   description: 'Pilots, SIC, flight attendants' },
  sales: { label: 'SALES', tone: 'green',  description: 'Sales team — trip creation, broker contact' },
  ops:   { label: 'OPS',   tone: 'amber',  description: 'Dispatch, scheduling, ground ops' },
  admin: { label: 'ADMIN', tone: 'violet', description: 'Full access — manage users & system' },
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
function comparePaxNames(preloaded, scanned) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const a = norm(preloaded);
  const b = norm(scanned);
  if (!a || !b) return 'no_match';
  if (a === b) return 'exact';
  const aTokens = a.split(/\s+/).filter(Boolean);
  const bTokens = b.split(/\s+/).filter(Boolean);
  if (aTokens.length < 2 || bTokens.length < 2) return 'no_match';
  const aFirst = aTokens[0], aLast = aTokens[aTokens.length - 1];
  const bHasFirst = bTokens.some(t => t === aFirst);
  const bHasLast = bTokens.some(t => t === aLast);
  if (bHasFirst && bHasLast) return aTokens.length === bTokens.length ? 'exact' : 'fuzzy';
  return 'no_match';
}

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

  // Leg summary lines look like:
  //   Leg 1: Pax: 0 SDF 04/30/2026 - 18:24 EDT (22:24 Z)  1:06  CLE 04/30/2026 - 19:30 EDT (23:30 Z)
  // Capture: leg #, pax count, FROM, dep date, dep local time, dep Z, TO
  const legSummaryRe = /Leg\s+(\d+)\s*:\s*Pax\s*:\s*(\d+)\s+([A-Z]{3,4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}:\d{2})\s+([A-Z]{2,4})\s*\((\d{1,2}:\d{2})\s*Z\)\s+\d{1,2}:\d{2}\s+([A-Z]{3,4})/gi;
  const legSummaries = [];
  let m;
  while ((m = legSummaryRe.exec(text)) !== null) {
    legSummaries.push({
      legNumber: parseInt(m[1], 10),
      paxCount: parseInt(m[2], 10),
      from: m[3].toUpperCase(),
      depDate: m[4],       // MM/DD/YYYY
      depTimeLocal: m[5],
      depTimeLocalTz: m[6],
      depTimeZ: m[7],
      to: m[8].toUpperCase(),
    });
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

  return { tripCode, tail, legs };
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

  // Match against each trip in the schedule
  return allTrips.filter(trip => {
    if (!trip || !trip.info) return false;
    if ((trip.info.tail || '').toUpperCase() !== tail.toUpperCase()) return false;
    const fromMatch = (trip.info.from || '').toUpperCase().slice(-3) === parsedLeg.from.slice(-3);
    if (!fromMatch) return false;
    const toMatch = (trip.info.to || '').toUpperCase().slice(-3) === parsedLeg.to.slice(-3);
    if (!toMatch) return false;
    // Compare date in BOTH UTC and local — JetInsight publishes local times,
    // iCal could be either depending on timezone. Accept match if either lines up.
    if (!trip.start) return false;
    const d = trip.start instanceof Date ? trip.start : new Date(trip.start);
    if (isNaN(d.getTime())) return false;
    const utcStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const locStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return utcStr === targetDateStr || locStr === targetDateStr;
  });
}

function sanitizeKey(s) {
  return String(s).replace(/[\s\/\\'"]/g, '_').slice(0, 180);
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
function buildStatusEmail(step, trip, brokerEmail) {
  const greeting = `Hi ${greetingFromEmail(brokerEmail)},`;
  const tail = trip.info.tail || '';
  const route = `${trip.info.from || ''}-${trip.info.to || ''}`;
  const signature = '\n\n— Skyway Aviation\nPrivate Jet & Helicopter Charter Services';

  switch (step.id) {
    case 'crew_onsite':
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
      return {
        subject: `Aircraft Taxiing for Departure — ${tail} ${route}`,
        text:
          `${greeting}\n\n` +
          `The aircraft is now taxiing for departure. We will provide the aircraft's ETA once ` +
          `it is airborne.` +
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
  const pad = (n) => String(n).padStart(2, '0');
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
      const { deleteUserProfile } = await import('./firebase-auth.js');
      await deleteUserProfile(uid);
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
          {fmtZulu(dep)} · {fmtDateZ(dep).slice(0, 6)}
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
  { id: 'pax_boarded', label: 'PASSENGERS BOARDED', sub: 'All souls accounted', icon: Users, applies: ['REVENUE'] },
  { id: 'taxi_dep', label: 'TAXI FOR DEPARTURE', sub: 'Pushback / taxi clearance', icon: Plane, applies: ['REPO', 'REVENUE'] },
];

function StatusButton({ step, status, onTrigger, onUntrigger, locked, isNext, autoNotify }) {
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
                {fmtZulu(new Date(status.timestamp))}
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
   ID Scanner (PDF417 + photo capture)
   ============================================================ */
function IDScanner({ onComplete, onCancel }) {
  const [phase, setPhase] = useState('intro'); // intro | scan | review | manual
  const [error, setError] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [realIdConfirmed, setRealIdConfirmed] = useState(false);
  const [photoData, setPhotoData] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scannerName, setScannerName] = useState(''); // 'BarcodeDetector' | 'ZXing'
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const detectIntervalRef = useRef(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (detectIntervalRef.current) {
      clearInterval(detectIntervalRef.current);
      detectIntervalRef.current = null;
    }
    // Clean up ZXing reader if it's running
    if (detectorRef.current && typeof detectorRef.current.reset === 'function') {
      try { detectorRef.current.reset(); } catch (e) { /* ignore */ }
    }
    detectorRef.current = null;
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // Toggle torch/flashlight on the active video track
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch (e) {
      console.warn('Torch toggle failed:', e);
    }
  };

  // Detect torch capability after stream starts
  const checkTorchSupport = useCallback(() => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const capabilities = track.getCapabilities?.() || {};
      setTorchSupported(capabilities.torch === true);
    } catch (e) {
      setTorchSupported(false);
    }
  }, []);

  const startScan = async () => {
    setError(null);
    setPhase('scan');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
      }
      setScanning(true);
      checkTorchSupport();

      // Try native BarcodeDetector first (Chrome, Edge, Android — fastest when available)
      if ('BarcodeDetector' in window) {
        try {
          // eslint-disable-next-line no-undef
          detectorRef.current = new BarcodeDetector({ formats: ['pdf417'] });
          detectIntervalRef.current = setInterval(async () => {
            if (!videoRef.current || !detectorRef.current) return;
            try {
              const codes = await detectorRef.current.detect(videoRef.current);
              if (codes && codes.length > 0) {
                const data = parseAAMVA(codes[0].rawValue);
                if (data && (data.firstName || data.lastName || data.fullName)) {
                  capturePhoto();
                  setParsed(data);
                  stopCamera();
                  setScanning(false);
                  setPhase('review');
                }
              }
            } catch (e) { /* keep scanning */ }
          }, 500);
          setScannerName('BarcodeDetector');
          return;
        } catch (e) {
          console.warn('Native BarcodeDetector init failed, falling back to ZXing', e);
        }
      }

      // Fallback: ZXing-js (works on iOS Safari and any other browser without native BarcodeDetector)
      try {
        const zxing = await import('@zxing/browser');
        const { BrowserMultiFormatReader } = zxing;
        const reader = new BrowserMultiFormatReader();
        detectorRef.current = reader;

        await reader.decodeFromStream(
          streamRef.current,
          videoRef.current,
          (result, err) => {
            if (result) {
              const text = result.getText ? result.getText() : (result.text || '');
              const data = parseAAMVA(text);
              if (data && (data.firstName || data.lastName || data.fullName)) {
                capturePhoto();
                setParsed(data);
                stopCamera();
                setScanning(false);
                setPhase('review');
              }
            }
          }
        );
        setScannerName('ZXing');
      } catch (e) {
        console.error('ZXing fallback failed:', e);
        setError('Could not start barcode scanner. Use manual entry.');
      }
    } catch (e) {
      setError(`Camera error: ${e.message}`);
      setPhase('intro');
    }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    setPhotoData(c.toDataURL('image/jpeg', 0.7));
  };

  const handleManualSubmit = (data) => {
    setParsed(data);
    setPhase('review');
  };

  const finalize = () => {
    if (!parsed) return;
    const expDate = parsed.expirationISO ? new Date(parsed.expirationISO) : null;
    const expired = expDate && expDate < new Date();
    const passenger = {
      id: `pax-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      firstName: parsed.firstName || parsed.fullName?.split(',')[1]?.trim() || '',
      lastName: parsed.lastName || parsed.fullName?.split(',')[0]?.trim() || '',
      dob: parsed.dobISO || parsed.dob || '',
      expiration: parsed.expirationISO || parsed.expiration || '',
      licenseNumber: parsed.licenseNumber || '',
      state: parsed.state || '',
      realIdCompliant: realIdConfirmed,
      expired: !!expired,
      photo: photoData,
      scannedAt: Date.now(),
      method: parsed.raw ? 'PDF417_SCAN' : 'MANUAL',
      paxType: parsed.raw ? 'SCAN' : 'MANUAL',
      noShow: false,
    };
    onComplete(passenger);
  };

  if (phase === 'intro') {
    return (
      <div className="space-y-4">
        <div className="text-center py-6">
          <div className="w-16 h-16 mx-auto mb-3 border border-slate-700 flex items-center justify-center">
            <ScanLine className="w-8 h-8 text-cyan-400" />
          </div>
          <h3 className="text-base tracking-wider" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>SCAN PASSENGER ID</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
            Position the back of the driver's license toward the rear camera. The PDF417 barcode will be auto-detected.
          </p>
        </div>
        {error && (
          <div className="p-3 border border-red-500/30 bg-red-500/5 text-xs text-red-300 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </div>
        )}
        <button
          onClick={startScan}
          className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-medium flex items-center justify-center gap-2"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          <Camera className="w-4 h-4" /> START CAMERA
        </button>
        <button
          onClick={() => setPhase('photoOnly')}
          className="w-full py-2 border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-sm"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          PHOTO ONLY (BARCODE WON'T SCAN)
        </button>
        <button
          onClick={() => setPhase('manual')}
          className="w-full py-2 border border-slate-700 hover:border-slate-500 text-slate-300 text-sm"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          ENTER MANUALLY
        </button>
        <button
          onClick={onCancel}
          className="w-full py-2 text-slate-500 hover:text-slate-300 text-sm"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (phase === 'scan') {
    return (
      <div className="space-y-3">
        <div className="relative aspect-[4/3] bg-black overflow-hidden border border-slate-700">
          <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
          <canvas ref={canvasRef} className="hidden" />
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-1/2 left-4 right-4 h-px bg-cyan-400 animate-pulse" />
            <div className="absolute inset-8 border-2 border-cyan-400/40" />
            <div className="absolute top-2 left-2 text-[10px] text-cyan-400 flex items-center gap-1.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <StatusDot tone="amber" pulse /> SCANNING {scannerName && `· ${scannerName.toUpperCase()}`}
            </div>
          </div>
          {torchSupported && (
            <button
              onClick={toggleTorch}
              className={`absolute bottom-3 right-3 pointer-events-auto w-12 h-12 rounded-full border-2 flex items-center justify-center text-xl transition-all ${
                torchOn
                  ? 'bg-cyan-400 border-cyan-300 text-slate-950'
                  : 'bg-slate-900/80 border-slate-600 text-slate-300 hover:border-cyan-400'
              }`}
              title={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
            >
              {torchOn ? '🔦' : '💡'}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500 text-center">
          Scan the <span className="text-cyan-400 font-bold">BACK</span> of the license · Hold steady · Align barcode within the frame
          {torchSupported && ' · Tap 💡 for flashlight'}
        </p>
        {error && (
          <div className="p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => { stopCamera(); setPhase('photoOnly'); }}
            className="flex-1 py-2 border border-amber-500/40 text-sm text-amber-300 hover:bg-amber-500/10"
          >
            Photo Only
          </button>
          <button
            onClick={() => { stopCamera(); setPhase('manual'); }}
            className="flex-1 py-2 border border-slate-700 text-sm text-slate-300"
          >
            Manual Entry
          </button>
          <button
            onClick={() => { stopCamera(); setScanning(false); onCancel(); }}
            className="flex-1 py-2 border border-slate-700 text-sm text-slate-300"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'photoOnly') {
    return (
      <PhotoOnlyCapture
        onComplete={(photo) => {
          // Build a minimal passenger record — photo only, crew confirmed.
          // No name/DOB/expiration — user spec was "photo only, no fields"
          const passenger = {
            id: `pax-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            firstName: '',
            lastName: '',
            dob: '',
            expiration: '',
            licenseNumber: '',
            state: '',
            realIdCompliant: false,
            expired: false,
            photo,
            scannedAt: Date.now(),
            method: 'MANUAL_CAPTURE',
            paxType: 'MANUAL_CAPTURE',
            noShow: false,
          };
          onComplete(passenger);
        }}
        onCancel={() => setPhase('intro')}
      />
    );
  }

  if (phase === 'manual') {
    return <ManualEntryForm onSubmit={handleManualSubmit} onCancel={onCancel} />;
  }

  if (phase === 'review' && parsed) {
    const expDate = parsed.expirationISO ? new Date(parsed.expirationISO) : null;
    const expired = expDate && expDate < new Date();
    const fullName = parsed.fullName || `${parsed.firstName || ''} ${parsed.lastName || ''}`.trim() || 'UNKNOWN';

    return (
      <div className="space-y-4">
        {photoData && (
          <div className="aspect-video bg-black overflow-hidden border border-slate-700">
            <img src={photoData} alt="ID" className="w-full h-full object-cover" />
          </div>
        )}
        <div className="space-y-2 p-4 border border-slate-700 bg-slate-900/40">
          <DataRow label="NAME" value={fullName} />
          <DataRow label="DOB" value={parsed.dobISO || parsed.dob || '—'} />
          <DataRow label="LICENSE" value={parsed.licenseNumber || '—'} />
          <DataRow label="STATE" value={parsed.state || '—'} />
          <DataRow label="EXPIRES" value={parsed.expirationISO || parsed.expiration || '—'} tone={expired ? 'red' : undefined} />
        </div>

        {expired && (
          <div className="p-3 border border-red-500/40 bg-red-500/5 text-xs text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>This ID is <strong>EXPIRED</strong>. Cannot be used for compliant verification.</span>
          </div>
        )}

        <label className="flex items-start gap-3 p-3 border border-slate-700 bg-slate-900/40 cursor-pointer hover:border-cyan-500/40">
          <input
            type="checkbox"
            checked={realIdConfirmed}
            onChange={e => setRealIdConfirmed(e.target.checked)}
            className="mt-0.5 accent-cyan-400"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-cyan-400" />
              <span className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>REAL ID VERIFIED</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              I confirm a gold/black star indicator is visible on the front of the physical ID, consistent with REAL ID Act compliance. Required for domestic flights.
            </p>
          </div>
        </label>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 border border-slate-700 hover:border-slate-500 text-sm text-slate-300"
          >
            Cancel
          </button>
          <button
            onClick={finalize}
            disabled={expired}
            className="flex-1 py-2.5 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-medium"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          >
            ADD PASSENGER
          </button>
        </div>
      </div>
    );
  }

  return null;
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

function PhotoOnlyCapture({ onComplete, onCancel }) {
  const [phase, setPhase] = useState('camera'); // 'camera' | 'review'
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // Start camera when entering camera phase
  useEffect(() => {
    if (phase !== 'camera') return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (e) {
        setError(e.message || 'Camera not available');
      }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  const snap = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      setError('Camera not ready yet — try again');
      return;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);
    // JPEG at 0.7 quality keeps the file small enough for Firestore (<1MB)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    setPhoto(dataUrl);
    stopCamera();
    setPhase('review');
  };

  if (phase === 'review' && photo) {
    return (
      <div className="space-y-3">
        <div className="text-center">
          <h3 className="text-base tracking-wider" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>PHOTO CAPTURED</h3>
          <p className="text-xs text-slate-500 mt-1">No data parsed — only the image is saved.</p>
        </div>
        <div className="aspect-video bg-black overflow-hidden border border-amber-500/40">
          <img src={photo} alt="ID" className="w-full h-full object-contain" />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setPhoto(null); setPhase('camera'); }}
            className="flex-1 py-2 border border-slate-700 text-sm text-slate-300"
          >
            Retake
          </button>
          <button
            onClick={() => onComplete(photo)}
            className="flex-1 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-medium text-sm"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          >
            Save Pax
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-center">
        <h3 className="text-base tracking-wider" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>PHOTO ONLY MODE</h3>
        <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
          Take a photo of the ID. No data will be parsed — the passenger is added with image only.
        </p>
      </div>
      <div className="relative aspect-[4/3] bg-black overflow-hidden border border-amber-500/40">
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />
        <div className="absolute top-2 left-2 text-[10px] text-amber-300 flex items-center gap-1.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <StatusDot tone="amber" pulse /> PHOTO ONLY
        </div>
      </div>
      {error && (
        <div className="p-2 border border-red-500/30 bg-red-500/5 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={snap}
          className="flex-1 py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-medium flex items-center justify-center gap-2"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          <Camera className="w-4 h-4" /> CAPTURE
        </button>
        <button
          onClick={() => { stopCamera(); onCancel(); }}
          className="px-4 py-3 border border-slate-700 text-sm text-slate-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ManualEntryForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', dob: '', expiration: '', licenseNumber: '', state: '',
  });
  const valid = form.firstName && form.lastName && form.dob && form.expiration;
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <div className="space-y-3">
      <h3 className="text-sm tracking-wider" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>MANUAL ID ENTRY</h3>
      <div className="grid grid-cols-2 gap-3">
        <FieldInput label="FIRST NAME" value={form.firstName} onChange={set('firstName')} />
        <FieldInput label="LAST NAME" value={form.lastName} onChange={set('lastName')} />
        <FieldInput label="DATE OF BIRTH" value={form.dob} onChange={set('dob')} type="date" />
        <FieldInput label="ID EXPIRATION" value={form.expiration} onChange={set('expiration')} type="date" />
        <FieldInput label="LICENSE #" value={form.licenseNumber} onChange={set('licenseNumber')} />
        <FieldInput label="STATE" value={form.state} onChange={set('state')} placeholder="FL" />
      </div>
      <div className="flex gap-2 pt-2">
        <button onClick={onCancel} className="flex-1 py-2.5 border border-slate-700 text-sm text-slate-300">Cancel</button>
        <button
          disabled={!valid}
          onClick={() => onSubmit({
            firstName: form.firstName,
            lastName: form.lastName,
            dobISO: form.dob,
            expirationISO: form.expiration,
            licenseNumber: form.licenseNumber,
            state: form.state.toUpperCase(),
          })}
          className="flex-1 py-2.5 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-medium"
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          CONTINUE
        </button>
      </div>
    </div>
  );
}

function DataRow({ label, value, tone }) {
  const colors = { red: 'text-red-300', green: 'text-emerald-300' };
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</span>
      <span className={`text-sm ${colors[tone] || 'text-slate-100'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{value}</span>
    </div>
  );
}

/* ============================================================
   Notify panel — broker + ops emails
   ============================================================ */
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
function TripDetail({ trip, currentUser, currentUserDisplayName, allTrips, opsEmail, onBack }) {
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
  const [pendingScanPax, setPendingScanPax] = useState(null); // pre-loaded pax being checked in
  const [loading, setLoading] = useState(true);
  const geo = useGeolocation();

  // Reset tab when switching trips
  useEffect(() => {
    setTab(trip.info.isOps ? 'status' : 'chat');
  }, [trip.uid, trip.info.isOps]);

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
      // Merge in trip-sheet fields and preloadedPax unless caller passed them explicitly
      const merged = {
        tripSheetUrl,
        tripSheetPath,
        tripSheetFilename,
        tripSheetUploadedAt,
        tripSheetUploadedBy,
        preloadedPax,
        ...next,
      };
      await saveTripState(trip.uid, merged);
    } catch (err) {
      console.error('Failed to save trip state:', err);
      alert('Failed to save — check your connection');
    }
  }, [trip.uid, tripSheetUrl, tripSheetPath, tripSheetFilename, tripSheetUploadedAt, tripSheetUploadedBy, preloadedPax]);

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

    if (recipients.length === 0) {
      console.warn('[email] Skipping send — no valid recipients. opsEmail:', opsEmail || '(empty)', 'brokerEmail:', brokerEmail || '(empty)');
      return;
    }

    // Use first broker email for the "Hi [Name]" greeting
    const emailContent = buildStatusEmail(step, trip, brokerEmails[0] || '');
    if (!emailContent) {
      console.warn('[email] No email template for step:', step.id);
      return;
    }

    try {
      console.log('[email] Sending to:', recipients.join(', '), 'subject:', emailContent.subject);
      const r = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: recipients,
          subject: emailContent.subject,
          text: emailContent.text,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        console.error('[email] Send failed:', r.status, data.error || '');
        return;
      }
      // Email sent successfully — mark notified=true now
      const updatedStatuses = { ...nextStatuses, [step.id]: { ...newStatus, notified: true } };
      setStatuses(updatedStatuses);
      await persist({ statuses: updatedStatuses, passengers, brokerEmail, autoNotify, completed, hasCatering, paxOverride });
      console.log('[email] Sent successfully');
    } catch (err) {
      console.error('[email] Network error:', err);
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
    // If we were checking in a pre-loaded pax, run name match logic
    if (pendingScanPax) {
      const target = pendingScanPax;
      setPendingScanPax(null);
      // Skip match logic for photo-only / no-name pax — just attach the photo
      // to the preloaded entry as 'manual_override' so the row still flips.
      if (pax.paxType === 'MANUAL_CAPTURE' || (!pax.firstName && !pax.lastName)) {
        const newPax = { ...pax, id: pax.id || `pax-${Date.now()}` };
        const nextPassengers = [...passengers, newPax];
        const nextPreloaded = preloadedPax.map(p =>
          p.id === target.id
            ? { ...p, scannedPaxId: newPax.id, checkInStatus: 'manual_override' }
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
      // Compare scanned name against preloaded name
      const preloadedName = `${target.firstName} ${target.lastName}`.trim();
      const scannedName = `${pax.firstName} ${pax.lastName}`.trim();
      const cmp = comparePaxNames(preloadedName, scannedName);

      if (cmp === 'no_match') {
        const proceed = window.confirm(
          `NAME MISMATCH:\n\n` +
          `Trip sheet: ${preloadedName}\n` +
          `Scanned ID: ${scannedName}\n\n` +
          `Press OK to check in this pax under the trip-sheet name (override),\n` +
          `or Cancel to discard the scan.`
        );
        if (!proceed) return;
      }

      const checkInStatus = cmp === 'no_match' ? 'mismatch' : (cmp === 'fuzzy' ? 'manual_override' : 'matched');
      const newPax = { ...pax, id: pax.id || `pax-${Date.now()}`, preloadedRefId: target.id };
      const nextPassengers = [...passengers, newPax];
      const nextPreloaded = preloadedPax.map(p =>
        p.id === target.id
          ? { ...p, scannedPaxId: newPax.id, checkInStatus }
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

    // No preloaded target — just add normally
    const next = [...passengers, pax];
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

  // Begin checking in a pre-loaded pax: stash the target and open the scanner.
  // After scan, the scan completion handler will run name comparison.
  const startPreloadedCheckIn = (preloadPax) => {
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
  const effectivePax = paxOverride !== null ? paxOverride : (trip.info.pax || 0);
  // Active passengers = anyone in the manifest who hasn't been marked NO SHOW
  const activePassengers = passengers.filter(p => !p.noShow);
  // Verified = anyone active whose verification path was satisfied:
  //   - real ID scan (REAL ID compliant + not expired)
  //   - child (no ID needed)
  //   - passport (verified by passport)
  //   - manual capture (photo of ID, crew confirmed)
  const compliantPax = activePassengers.filter(p =>
    (p.realIdCompliant && !p.expired) ||
    p.paxType === 'CHILD' ||
    p.paxType === 'PASSPORT' ||
    p.paxType === 'MANUAL_CAPTURE'
  ).length;
  const paxComplete = effectivePax === 0 || compliantPax >= effectivePax;

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
            <button
              onClick={async () => {
                const next = !completed;
                if (next && !window.confirm('Mark this trip as complete?')) return;
                if (!next && !window.confirm('Reopen this trip?')) return;
                setCompleted(next);
                await persist({
                  statuses, passengers, brokerEmail, autoNotify,
                  completed: next,
                  completedAt: next ? Date.now() : null,
                  hasCatering,
                  paxOverride,
                });
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
        {[
          { id: 'status', label: 'STATUS', icon: Zap, badge: `${completedCount}/${applicableSteps.length}`, hidden: !trip.info.isOps },
          { id: 'pax', label: 'PASSENGERS', icon: Users, badge: trip.info.pax === 0 ? null : `${compliantPax}/${trip.info.pax}`, hidden: trip.info.pax === 0 || !trip.info.isOps },
          { id: 'chat', label: 'COMMS', icon: MessageSquare },
          { id: 'notify', label: 'NOTIFY', icon: Bell, hidden: !trip.info.isOps },
        ].filter(t => !t.hidden).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-xs tracking-widest transition-colors relative shrink-0 ${
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
                  <strong>{compliantPax}/{trip.info.pax}</strong> passengers verified for REAL ID compliance.
                  Complete passenger verification before "PASSENGERS BOARDED".
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
              const previousComplete = idx === 0 || statuses[applicableSteps[idx - 1].id];
              const blocked = step.id === 'pax_boarded' && !paxComplete;
              return (
                <StatusButton
                  key={step.id}
                  step={step}
                  status={statuses[step.id]}
                  onTrigger={handleStatusTrigger}
                  onUntrigger={handleStatusUntrigger}
                  locked={!previousComplete || blocked}
                  isNext={nextStep?.id === step.id && previousComplete && !blocked}
                  autoNotify={autoNotify}
                />
              );
            })}
          </div>
        ) : tab === 'pax' ? (
          <div className="p-6 space-y-3 max-w-2xl">
            {scanning ? (
              <>
                {pendingScanPax && (
                  <div className="p-3 border border-cyan-500/40 bg-cyan-500/10 mb-2">
                    <div className="text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      CHECKING IN
                    </div>
                    <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                      {pendingScanPax.firstName} {pendingScanPax.lastName}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      Scan their ID — names will be compared. Use Photo Only if the barcode won't scan.
                    </div>
                  </div>
                )}
                <IDScanner
                  onComplete={addPassenger}
                  onCancel={() => { setScanning(false); setPendingScanPax(null); }}
                />
              </>
            ) : (
              <>
                {/* Trip sheet PDF — upload (ops/admin) or view (crew) */}
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

                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-xs text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      MANIFEST · {compliantPax}/{effectivePax} VERIFIED
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
                    <ScanLine className="w-4 h-4" /> SCAN ID
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
        ) : null}
      </div>
    </div>
  );
}

function QuickAddPax({ onAdd }) {
  const [open, setOpen] = useState(null); // null | 'CHILD' | 'PASSPORT'
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
    const isChild = open === 'CHILD';
    return (
      <div className={`p-3 border ${isChild ? 'border-violet-500/40 bg-violet-500/5' : 'border-blue-500/40 bg-blue-500/5'}`}>
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
          className={`mt-2 w-full py-2 text-sm font-medium ${
            isChild ? 'bg-violet-500 hover:bg-violet-400' : 'bg-blue-500 hover:bg-blue-400'
          } text-slate-950 disabled:opacity-40 disabled:cursor-not-allowed`}
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          Add to Manifest
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={() => setOpen('CHILD')}
        className="flex items-center justify-center gap-2 py-2 border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 text-sm tracking-wider"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      >
        <Users className="w-4 h-4" /> ADD CHILD
      </button>
      <button
        onClick={() => setOpen('PASSPORT')}
        className="flex items-center justify-center gap-2 py-2 border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 text-sm tracking-wider"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      >
        <Shield className="w-4 h-4" /> ADD PASSPORT
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
                    <span className="text-[10px] text-emerald-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      → MATCHED ({m.leg.pax.length} pax)
                    </span>
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
function PreloadedPaxRow({ pax, onCheckIn, onSkip, scanned }) {
  // Find the scanned pax matched to this preloaded entry
  const isMatched = pax.checkInStatus === 'matched';
  const isMismatch = pax.checkInStatus === 'mismatch';
  const isOverride = pax.checkInStatus === 'manual_override';
  const isSkipped = pax.checkInStatus === 'skipped';
  const checkedIn = isMatched || isMismatch || isOverride;

  let borderClass;
  if (isSkipped) borderClass = 'border-slate-700 bg-slate-900/30 opacity-60';
  else if (isMatched) borderClass = 'border-emerald-500/30 bg-emerald-500/5';
  else if (isOverride) borderClass = 'border-amber-500/30 bg-amber-500/5';
  else if (isMismatch) borderClass = 'border-red-500/30 bg-red-500/5';
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
            {isOverride && <Pill tone="amber">OVERRIDE</Pill>}
            {isMismatch && <Pill tone="red">MISMATCH</Pill>}
            {isSkipped && <Pill tone="neutral">SKIPPED</Pill>}
            {!checkedIn && !isSkipped && <Pill tone="neutral">PENDING</Pill>}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {pax.gender && <span>{pax.gender}</span>}
            {pax.dob && <span>DOB {pax.dob}</span>}
            {pax.weight && <span>{pax.weight} lbs</span>}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          {!checkedIn && !isSkipped && (
            <>
              <button
                onClick={() => onCheckIn(pax)}
                className="text-[10px] px-2 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 tracking-widest font-medium"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                CHECK IN
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
  const isChild = passenger.paxType === 'CHILD';
  const isPassport = passenger.paxType === 'PASSPORT';
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
      {passenger.photo ? (
        <img src={passenger.photo} alt="" className="w-12 h-12 object-cover border border-slate-700" />
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
          ) : isPassport ? (
            <Pill tone="cyan"><Shield className="w-2.5 h-2.5" /> PASSPORT</Pill>
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
   Settings modal
   ============================================================ */
function SettingsModal({ config, setConfig, onClose, onLoadDemo, onLoadFromUrl, onLoadFromText, syncStatus }) {
  const [icalUrl, setIcalUrl] = useState(config.icalUrl || '');
  const [icalText, setIcalText] = useState('');
  const [opsEmail, setOpsEmail] = useState(config.opsEmail || '');
  const [crewName, setCrewName] = useState(config.crewName || '');
  const [textMode, setTextMode] = useState(false);

  const save = async () => {
    const next = { ...config, icalUrl, opsEmail, crewName };
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

          <section>
            <h3 className="text-xs tracking-widest text-cyan-400 mb-3" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              OPS NOTIFICATIONS
            </h3>
            <label className="block">
              <span className="text-[10px] tracking-widest text-slate-500 uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>OPS EMAIL (default recipient)</span>
              <input
                type="email"
                value={opsEmail}
                onChange={e => setOpsEmail(e.target.value)}
                placeholder="ops@charterco.com"
                className="mt-1 w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
              <span className="text-[11px] text-slate-500 mt-1 block">CC'd on all notification emails alongside the broker.</span>
            </label>
          </section>

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
        setInfo('Welcome! As the first user, you have admin access. Check your email for a verification link.');
      } else {
        setInfo('Account created. Check your email for a verification link. Once verified, an admin will approve your account.');
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
            <FieldInput label="EMAIL" type="email" value={form.email} onChange={setField('email')} placeholder="you@skyway.com" autoComplete="email" />
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
            <FieldInput label="EMAIL *" type="email" value={form.email} onChange={setField('email')} placeholder="you@skyway.com" autoComplete="email" />
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
            <FieldInput label="EMAIL" type="email" value={form.email} onChange={setField('email')} placeholder="you@skyway.com" autoComplete="email" />
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
function TopNav({ currentSection, setCurrentSection, currentUser, onLogout, syncStatus, now, tripCount, onOpenSettings }) {
  const sections = [
    { id: 'schedule', label: 'SCHEDULE',  icon: Calendar, roles: ['crew', 'ops', 'admin'] },
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
              {fmtZulu(now)} · {fmtDateZ(now)}
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
          <div className="hidden md:flex items-center gap-2 px-2.5 py-1.5 border border-slate-800">
            <div className="w-7 h-7 bg-cyan-500/10 border border-cyan-500/40 flex items-center justify-center text-cyan-300 text-sm" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              {currentUser.name.charAt(0).toUpperCase()}
            </div>
            <div className="text-xs">
              <div className="text-slate-200 leading-tight" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                {currentUser.callsign || currentUser.name.split(' ').slice(-1)[0]}
              </div>
              <div className="text-[9px] text-slate-500 leading-tight" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {USER_ROLES[currentUser.role]?.label || currentUser.role.toUpperCase()}
              </div>
            </div>
          </div>
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
  const [showSettings, setShowSettings] = useState(false);
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
  const [section, setSection] = useState('schedule');

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

  // Is this trip archived? Either manually archived OR auto-archived 3+ hours after arrival.
  const isTripArchived = useCallback((trip) => {
    if (!trip) return false;
    // Manual archive (Firestore-backed)
    if (tripArchived[trip.uid]) return true;
    // Auto-archive 3 hours after arrival time
    if (trip.end) {
      const arrivalMs = trip.end instanceof Date ? trip.end.getTime() : trip.end;
      if (Date.now() - arrivalMs > 3 * 3600 * 1000) return true;
    }
    return false;
  }, [tripArchived]);

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
    const realUser = {
      id: profile.uid,
      name: profile.name || '',
      email: profile.email || '',
      callsign: profile.callsign || '',
      jetinsightName: profile.jetinsightName || profile.name || '',
      role: profile.role || 'crew',
      active: profile.active !== false,
      approved: profile.approved === true,
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
        // Only poll the trips currently visible on the schedule (today + future, max 50)
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const visibleTrips = allTrips
          .filter(t => t.start && t.start >= startOfToday.getTime())
          .slice(0, 50);

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
            if (state.archived === true) archived[t.uid] = state.archivedAt || true;
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
    const filtered = showAllCategories ? allTrips : allTrips.filter(t => t.info.isFlight);
    for (const t of filtered) {
      if (!t.start) continue;
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
  }, [allTrips, today, tomorrow, showAllCategories, isTripArchived]);

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
          setCurrentSection={setSection}
          currentUser={currentUser}
          onLogout={signOut}
          syncStatus={syncStatus}
          now={now}
          tripCount={allTrips.length}
          onOpenSettings={() => setShowSettings(true)}
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
                    onClick={() => setShowArchived(v => !v)}
                    className={`text-[10px] tracking-widest px-2 py-1 border ${showArchived ? 'border-cyan-400 text-cyan-300' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                    title="Show archived trips"
                  >
                    {groupedTrips.archived.length > 0 && !showArchived && (
                      <span className="text-cyan-400">·</span>
                    )} ARCHIVED
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
                  {showArchived && groupedTrips.archived.length > 0 && (
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
                  opsEmail={config.opsEmail}
                  onBack={() => setSelectedId(null)}
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
          onClose={() => setShowSettings(false)}
          onLoadDemo={loadDemo}
          onLoadFromUrl={loadFromUrl}
          onLoadFromText={loadFromText}
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
