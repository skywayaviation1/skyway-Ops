// JetInsight "Crew Itinerary" trip-sheet parser and leg propagation.
//
// pdf.js returns text items in paint order, not reading order, and a crew
// itinerary is a two-column page (departure beside arrival, summary beside
// the tail). Joining items with spaces scrambles passengers, splits the
// arrival Z time off its clock, and makes digit airport codes (9TE2) miss
// the [A-Z]-only regexes. Parsing from item positions — line by y, then
// column by x — is the path the upload uses.

const Y_TOL = 0.8;
const MATCH_WINDOW_MS = 90 * 60 * 1000;

const TZ_OFFSET_HOURS = {
  EDT: -4, EST: -5,
  CDT: -5, CST: -6,
  MDT: -6, MST: -7,
  PDT: -7, PST: -8,
  AKDT: -8, AKST: -9,
  HST: -10,
  ADT: -3, AST: -4,
  UTC: 0, Z: 0, GMT: 0,
};

// Check-in progress we must not throw away when a sheet is uploaded again.
const PAX_PROGRESS = new Set([
  'matched', 'mismatch', 'manual_override', 'skipped', 'carried_over', 'child_verified',
]);
// A removed name is kept only when crew already checked them in.
const PAX_STICKY = new Set([
  'matched', 'mismatch', 'manual_override', 'carried_over', 'child_verified',
]);

const PAX_RE = /^(.+?)\s*\(\s*(Male|Female|M|F)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d+)\s*lbs?\s*\)(?:\s*\(([^)]*)\))?/i;
const SUMMARY_RE = /Leg\s+(\d+):\s*Pax:\s*(\d+)(?:\s*\/\s*\d+)?\s+([A-Z0-9]{3,4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}:\d{2})\s+([A-Z]{2,5})\s*\((\d{1,2}:\d{2})\s*Z\)\s+(\d{1,2}:\d{2})\s+([A-Z0-9]{3,4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}:\d{2})\s+([A-Z]{2,5})\s*\((\d{1,2}:\d{2})\s*Z\)/i;
const DETAIL_RE = /Leg\s+(\d+)\s+:\s+([A-Z0-9]{3,4})\s+([A-Z0-9]{3,4})\s+Part\s+(\d+)(?:\s+Flight\s+#(\d+))?/i;
const DIST_RE = /Distance\s*:\s*([\d.,]+\s*[A-Za-z]+)\s*-\s*Block\s*:\s*([\d:]+)\s*-\s*Flight\s*:\s*([\d:]+)\s*-\s*Time\s*change\s*:\s*([+\-]?\d+)/i;
const SEGMENT_RE = /^([A-Z0-9]{3,4})\s*-\s*([A-Z0-9]{3,4})\s+(Not released|Released)\s+(.+)$/i;

function stripGlyphs(value) {
  return String(value || '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function repairLigatures(text) {
  return String(text || '')
    .replace(/@\s+/g, '@')
    .replace(/([A-Za-z]) fi ([a-z])/g, '$1fi$2')
    .replace(/([A-Za-z]) fl ([a-z])/g, '$1fl$2');
}

function normalizeItem(it) {
  if (!it) return null;
  const str = stripGlyphs(it.str);
  if (!str) return null;
  const width = Number(it.width) > 0 ? Number(it.width) : Math.max(str.length * 4.2, 1);
  return {
    str,
    x: Number(it.x) || 0,
    y: Number(it.y) || 0,
    width,
  };
}

function joinLineItems(items) {
  let out = '';
  let endX = null;
  for (const it of items) {
    if (!out) {
      out = it.str;
      endX = it.x + it.width;
      continue;
    }
    const gap = it.x - endX;
    if (gap > 0.8) out += ' ';
    out += it.str;
    endX = it.x + it.width;
  }
  return repairLigatures(out.replace(/[ \t]+/g, ' ').trim());
}

export function clusterLines(items) {
  const usable = [];
  for (const raw of items || []) {
    const it = normalizeItem(raw);
    if (it) usable.push(it);
  }
  usable.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of usable) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Y_TOL) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.minX = line.items[0].x;
    line.text = joinLineItems(line.items);
  }
  return lines.filter((line) => line.text);
}

export function pagesToReadingText(pages) {
  return (pages || [])
    .map((page) => clusterLines(page.items).map((line) => line.text).join('\n'))
    .filter(Boolean)
    .join('\n');
}

function pageItems(page) {
  return (page?.items || []).map(normalizeItem).filter(Boolean);
}

function linesBelowLabel(items, label, maxDrop) {
  const marker = items.find((it) => it.str === label);
  if (!marker) return [];
  const col = items.filter((it) =>
    Math.abs(it.x - marker.x) < 50
    && it.y < marker.y - 0.5
    && it.y > marker.y - (maxDrop || 48)
  );
  return clusterLines(col).map((line) => line.text).filter((text) => text && text !== label);
}

function parseEmailPhoneLines(lines) {
  const emails = [];
  const phones = [];
  const text = [];
  for (const line of lines) {
    const email = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    const phone = line.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|\b\d{10}\b/);
    if (email) emails.push(email[0]);
    else if (phone && phone[0].replace(/\D/g, '').length >= 10 && line.replace(phone[0], '').trim().length < 4) {
      phones.push(phone[0].trim());
    } else if (phone && line.trim() === phone[0].trim()) phones.push(phone[0].trim());
    else text.push(line.trim());
  }
  return { emails, phones, text };
}

function looksLikeOrg(value) {
  return /\b(inc|llc|ltd|limited|group|aviation|charter|jets|air|corp|company|co)\b/i.test(value || '');
}

function parseClient(lines) {
  if (!lines.length) return null;
  const { emails, phones, text } = parseEmailPhoneLines(lines);
  let company = null;
  let contact = null;
  if (text.length >= 2 && text[0] === text[1]) {
    // JetInsight repeats the company on the contact line when no person is named.
    company = text[0];
    contact = text[1];
  } else if (text.length >= 1 && looksLikeOrg(text[0])) {
    company = text[0];
    contact = text[1] || null;
  } else if (text.length >= 1) {
    contact = text[0];
    company = text[1] && looksLikeOrg(text[1]) ? text[1] : null;
  }
  if (!company && !contact && !emails.length && !phones.length) return null;
  return {
    company,
    contact,
    email: emails[0] || null,
    phone: phones[0] || null,
  };
}

function parsePlanner(lines) {
  if (!lines.length) return null;
  const { emails, phones, text } = parseEmailPhoneLines(lines);
  const name = text.find(Boolean) || null;
  if (!name && !emails.length && !phones.length) return null;
  return { name, email: emails[0] || null, phone: phones[0] || null };
}

function parseOperator(items, itineraryY) {
  const col = items.filter((it) => it.x < 340 && it.y > itineraryY + 2);
  const lines = clusterLines(col).map((line) => line.text);
  if (!lines.length) return null;
  const { emails, phones, text } = parseEmailPhoneLines(lines);
  return {
    name: text[0] || null,
    address: text.slice(1).join(', ') || null,
    email: emails[0] || null,
    phone: phones[0] || null,
  };
}

function parseHeader(page) {
  const items = pageItems(page);
  const itin = items.find((it) => /Crew\s+Itinerary/i.test(it.str));
  const tripCodeMatch = (itin?.str || '').match(/Crew\s+Itinerary\s*\(([A-Z0-9]+)\)/i)
    || pagesToReadingText([page]).match(/Crew\s+Itinerary\s*\(([A-Z0-9]+)\)/i);
  const tripCode = tripCodeMatch ? tripCodeMatch[1].toUpperCase() : null;
  const itineraryY = itin ? itin.y : Infinity;
  const client = parseClient(linesBelowLabel(items, 'Client:', 48));
  const planner = parsePlanner(linesBelowLabel(items, 'Planner:', 48));
  const operator = itin ? parseOperator(items, itineraryY) : null;

  const aircraftItems = items.filter((it) => it.x > 470 && itin && it.y < itin.y - 4 && it.y > itin.y - 100);
  const aircraftLines = clusterLines(aircraftItems).map((line) => line.text);
  let tail = null;
  const typeParts = [];
  for (const line of aircraftLines) {
    if (!tail && /^N\d{1,5}[A-Z]{0,2}$/i.test(line)) tail = line.toUpperCase();
    else if (line && !/^Leg\s+\d+/.test(line)) typeParts.push(line);
  }
  return {
    tripCode,
    tail,
    aircraftType: typeParts.join(' ').replace(/\s+/g, ' ').trim() || null,
    client,
    planner,
    operator,
  };
}

function isDetailHeader(text) {
  return DETAIL_RE.test(text);
}

function parseSummaryLine(text) {
  const m = text.match(SUMMARY_RE);
  if (!m) return null;
  return {
    legNumber: parseInt(m[1], 10),
    paxCount: parseInt(m[2], 10),
    from: m[3].toUpperCase(),
    depDate: m[4],
    depTimeLocal: m[5],
    depTimeLocalTz: m[6].toUpperCase(),
    depTimeZ: m[7],
    summaryBlock: m[8],
    to: m[9].toUpperCase(),
    arrDate: m[10],
    arrTimeLocal: m[11],
    arrTimeLocalTz: m[12].toUpperCase(),
    arrTimeZ: m[13],
  };
}

function parseSegmentLine(text) {
  const m = text.match(SEGMENT_RE);
  if (!m) return null;
  const rest = m[4];
  const vetted = rest.match(/Vetted:\s*(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*Z)/i);
  return {
    from: m[1].toUpperCase(),
    to: m[2].toUpperCase(),
    released: /^released$/i.test(m[3]),
    vettingApplicable: !/vetting not applicable/i.test(rest),
    vettedAt: vetted ? vetted[1].replace(/\s+/g, ' ').trim() : null,
    paxCleared: /all passengers cleared to board/i.test(rest),
  };
}

function parseNotes(lines) {
  const specs = [
    ['pax', /^Trip notes\s*\(pax\)\s*:?\s*(.*)$/i],
    ['crew', /^Trip notes\s*\(crew\)\s*:?\s*(.*)$/i],
    ['customer', /^Customer notes\s*:?\s*(.*)$/i],
    ['specialItems', /^Special items\s*:?\s*(.*)$/i],
  ];
  const buf = { crew: [], pax: [], customer: [], specialItems: [] };
  let active = null;
  for (const line of lines) {
    let started = false;
    for (const [key, re] of specs) {
      const m = line.text.match(re);
      if (m) {
        active = key;
        if (m[1] && m[1].trim()) buf[key].push(m[1].trim());
        started = true;
        break;
      }
    }
    if (started || !active) continue;
    if (/^Leg\s+\d+/.test(line.text) || /^Segment status/i.test(line.text)) continue;
    if (parseSummaryLine(line.text) || parseSegmentLine(line.text)) continue;
    buf[active].push(line.text);
  }
  const notes = {};
  for (const key of Object.keys(buf)) {
    const text = buf[key].join('\n').trim();
    notes[key] = text || null;
  }
  return notes;
}

function splitName(full) {
  const tokens = String(full || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: tokens[0] || '',
    lastName: tokens.slice(1).join(' '),
  };
}

function normalizeGender(value) {
  const g = String(value || '').toLowerCase();
  if (g === 'm' || g === 'male') return 'Male';
  if (g === 'f' || g === 'female') return 'Female';
  return value || null;
}

function parsePassengers(lines) {
  const header = lines.find((line) => /Pax\s*\(\s*\d+\s*\)/i.test(line.text));
  const countMatch = header && header.text.match(/Pax\s*\(\s*(\d+)\s*\)/i);
  const declared = countMatch ? parseInt(countMatch[1], 10) : null;
  const pax = [];
  let none = false;
  for (const line of lines) {
    if (/no passengers for this segment/i.test(line.text)) {
      none = true;
      continue;
    }
    const m = line.text.match(PAX_RE);
    if (!m) continue;
    const name = m[1].replace(/^Pax\s*\(\s*\d+\s*\)\s*/i, '').replace(/^[\s·•-]+/, '').trim();
    if (!name || /^(pax|for|name)$/i.test(name)) continue;
    const { firstName, lastName } = splitName(name);
    pax.push({
      firstName,
      lastName,
      gender: normalizeGender(m[2]),
      dob: m[3],
      weight: parseInt(m[4], 10),
      primary: m[5] ? /primary/i.test(m[5]) : false,
    });
  }
  if (none && pax.length === 0) return { count: declared ?? 0, pax: [] };
  return { count: declared ?? pax.length, pax };
}

function parsePhoneFreq(text) {
  if (!text) return { phone: null, frequencyKind: null, frequency: null };
  const freq = text.match(/(A2G|UNICOM)\s*:\s*([\d.]+)/i);
  const phone = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return {
    phone: phone ? phone[0].trim() : null,
    frequencyKind: freq ? freq[1].toUpperCase() : null,
    frequency: freq ? freq[2] : null,
  };
}

function parsePlaceColumn(items) {
  const texts = clusterLines(items).map((line) => line.text).filter(Boolean);
  if (!texts.length) return null;
  const head = texts[0].match(/^([A-Z0-9]{3,4})\s+-\s+(.+)$/);
  const code = head ? head[1].toUpperCase() : null;
  const name = head ? head[2].trim() : null;
  const rest = head ? texts.slice(1) : texts.slice();
  const phoneIdx = rest.findIndex((line) => /(A2G|UNICOM)\s*:/i.test(line) || /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(line));
  const phoneLine = phoneIdx >= 0 ? rest[phoneIdx] : null;
  const body = phoneIdx >= 0 ? rest.slice(0, phoneIdx) : rest;
  const addressStart = body.findIndex((line) => /^\d/.test(line) || /,\s*[A-Z]{2}\b/.test(line) || /,\s*[A-Za-z]+\s+\d{5}/.test(line));
  const fboLines = addressStart === -1 ? body : body.slice(0, addressStart);
  const addressLines = addressStart === -1 ? [] : body.slice(addressStart);
  const contact = parsePhoneFreq(phoneLine);
  const fbo = fboLines.map((line) => line.trim()).filter(Boolean);
  return {
    code,
    name,
    fbo: fbo[0] || null,
    fboDetail: fbo.slice(1).join(' · ') || null,
    address: addressLines.join(', ') || null,
    phone: contact.phone,
    frequencyKind: contact.frequencyKind,
    frequency: contact.frequency,
  };
}

function moneyAfter(text, label) {
  const re = new RegExp(label + '\\s*:\\s*(?:\\$\\s*)?([\\d,]+(?:\\.\\d+)?)?', 'i');
  const m = text.match(re);
  if (!m || m[1] == null || m[1] === '') return null;
  const n = parseFloat(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseFeeBlob(text) {
  const m = text.match(/^Fees\s*\(([A-Z0-9]{3,4})\)\s*:\s*([\s\S]*)$/i);
  if (!m) return null;
  const body = m[2];
  const fbo = body.split('/')[0].trim() || null;
  const parkingWaiver = body.match(/Parking\s*fee\s*:\s*(?:\$\s*)?[\d,]*\s*,\s*(\d+)\s*nights?\s*waived\s*with\s*(\d+)\s*gals?/i);
  const handlingWaiver = body.match(/Ground\s*handling\s*fee\s*:\s*(?:\$\s*)?[\d,]*\s*,?\s*waived\s*with\s*(\d+)\s*gals?/i);
  return {
    code: m[1].toUpperCase(),
    fbo,
    landing: moneyAfter(body, 'Landing\\s*fee'),
    parking: moneyAfter(body, 'Parking\\s*fee'),
    parkingWaivedNights: parkingWaiver ? parseInt(parkingWaiver[1], 10) : null,
    parkingWaivedGals: parkingWaiver ? parseInt(parkingWaiver[2], 10) : null,
    groundHandling: moneyAfter(body, 'Ground\\s*handling\\s*fee'),
    groundHandlingWaivedGals: handlingWaiver ? parseInt(handlingWaiver[1], 10) : null,
    infrastructure: moneyAfter(body, 'Infrastructure\\s*fee'),
  };
}

function parseFuelBlob(text, vendorNote) {
  const m = text.match(/^Fuel\s*\(([A-Z0-9]{3,4})\)\s*:\s*([\s\S]*)$/i);
  if (!m) return null;
  const rest = m[2].trim();
  const tiers = [];
  const tierRe = /(\d+)\+\s*:\s*\$?\s*([\d.]+)/g;
  let tm;
  while ((tm = tierRe.exec(rest)) !== null) {
    tiers.push({ minGals: parseInt(tm[1], 10), price: parseFloat(tm[2]) });
  }
  const structured = rest.match(/^(.+?)\s*\/\s*([A-Za-z][A-Za-z0-9 ]*?)\s*:/);
  if (structured && tiers.length) {
    return {
      code: m[1].toUpperCase(),
      fbo: structured[1].trim() || null,
      brand: structured[2].trim() || null,
      tiers,
      note: vendorNote || null,
    };
  }
  return {
    code: m[1].toUpperCase(),
    fbo: null,
    brand: null,
    tiers,
    note: rest || vendorNote || null,
  };
}

function isBlockStart(text) {
  return /^(Fees\s*\(|Fuel\s*\(|Pax\s*\(|PIC\s*:|SIC\s*:|Release status|DEPARTS:|ARRIVES:|Leg\s+\d+|Total pax|Airport\s*\(|TSA\b|Crew$)/i.test(text);
}

function parseCrewLine(text) {
  const m = text.match(/^(PIC|SIC):\s*(.+?)\s+-\s+(.+?),\s*(\S+@\S+)/i);
  if (!m) return null;
  return {
    role: m[1].toUpperCase(),
    name: m[2].trim(),
    phone: m[3].trim().replace(/\s+/g, ' '),
    email: m[4].trim(),
  };
}

function parseRelease(lines) {
  const line = lines.find((entry) => /^Release status/i.test(entry.text));
  if (!line) return null;
  const text = line.text.replace(/^Release status:\s*/i, '').trim();
  if (/segment has not been released/i.test(text)) {
    return { released: false, releasedAt: null, releasedBy: null, releaseText: 'Segment has not been released' };
  }
  const on = text.match(/Released on:\s*(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*Z)(?:\s*by\s*(.+))?/i);
  if (on) {
    return {
      released: true,
      releasedAt: on[1].replace(/\s+/g, ' ').trim(),
      releasedBy: on[2] ? on[2].trim() : null,
      releaseText: text,
    };
  }
  if (/released/i.test(text)) {
    return { released: true, releasedAt: null, releasedBy: null, releaseText: text };
  }
  return { released: false, releasedAt: null, releasedBy: null, releaseText: text || null };
}

function parseCatering(lines) {
  const start = lines.findIndex((line) => /Pax\s*\(\s*\d+\s*\)/i.test(line.text) || /no passengers/i.test(line.text));
  if (start < 0) return { items: [], arrangedBy: null };
  const items = [];
  let arrangedBy = null;
  for (const line of lines.slice(start + 1)) {
    const text = line.text;
    if (!text) continue;
    if (/^Total pax weight/i.test(text)) continue;
    if (/TSA ID checks/i.test(text)) continue;
    if (/^_+$/.test(text.replace(/\s/g, ''))) continue;
    if (/^For\s+Name\s+Address/i.test(text)) continue;
    if (/Arranged by broker/i.test(text)) {
      arrangedBy = 'broker';
      continue;
    }
    if (PAX_RE.test(text)) continue;
    if (isBlockStart(text)) continue;
    const qty = text.match(/^(\d+)\s+(.+)$/);
    if (qty) items.push({ quantity: parseInt(qty[1], 10), description: qty[2].trim() });
    else items.push({ quantity: null, description: text });
  }
  return { items, arrangedBy };
}

function parseTransport(lines) {
  const joined = lines.map((line) => line.text).join('\n');
  const head = joined.match(/TRANSPORT\s*:\s*(.+?)\s{2,}(\S.*?)\s+CONF\s*#\s*(\S+)/i);
  if (!head) return null;
  const pickup = joined.match(/Pickup\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2})/i);
  return {
    passenger: head[1].trim(),
    provider: head[2].trim(),
    confirmation: head[3].trim(),
    pickup: pickup ? pickup[1] : null,
  };
}

function parseAirportNotes(lines) {
  const notes = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.match(/^Airport\s*\(([A-Z0-9]{3,4})\)\s*:\s*([\s\S]*)$/i);
    if (!m) continue;
    const parts = [m[2].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      if (isBlockStart(lines[j].text) || /^Airport\s*\(/i.test(lines[j].text)) break;
      parts.push(lines[j].text);
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) notes[m[1].toUpperCase()] = text.slice(0, 1500);
  }
  return notes;
}

function columnItems(lines, minX, maxX) {
  const out = [];
  for (const line of lines) {
    for (const item of line.items) {
      if (item.x >= minX && item.x < maxX) out.push(item);
    }
  }
  return out;
}

function parseLegSection(lines) {
  const header = lines[0]?.text || '';
  const detail = header.match(DETAIL_RE);
  const dist = header.match(DIST_RE);
  const airportEnd = lines.findIndex((line, index) =>
    index > 0 && /^(Crew|PIC\s*:|SIC\s*:|Release status|Fees\s*\(|Fuel\s*\(|Pax\s*\()/i.test(line.text)
  );
  const airportLines = lines.slice(1, airportEnd === -1 ? undefined : airportEnd);
  const departs = parsePlaceColumn(columnItems(airportLines, 100, 300));
  const arrives = parsePlaceColumn(columnItems(airportLines, 370, 10000));

  const crew = { pic: null, sic: null };
  for (const line of lines) {
    const person = parseCrewLine(line.text);
    if (!person) continue;
    const slot = {
      name: person.name,
      phone: person.phone,
      email: person.email,
    };
    if (person.role === 'PIC') crew.pic = slot;
    else crew.sic = slot;
  }

  const release = parseRelease(lines);
  const fees = {};
  const fuel = {};
  let kind = null;
  let buf = null;
  const close = () => {
    if (!buf) return;
    if (kind === 'fee') {
      const fee = parseFeeBlob(buf.text);
      if (fee) fees[fee.code] = fee;
    } else if (kind === 'fuel') {
      const row = parseFuelBlob(buf.text, buf.vendorNote);
      if (row) fuel[row.code] = row;
    }
    buf = null;
    kind = null;
  };
  for (const line of lines) {
    const text = line.text;
    if (/^Fees\s*\(/i.test(text)) {
      close();
      kind = 'fee';
      buf = { text, vendorNote: null };
      continue;
    }
    if (/^Fuel\s*\(/i.test(text)) {
      close();
      kind = 'fuel';
      buf = { text, vendorNote: null };
      continue;
    }
    if (kind && !isBlockStart(text)) {
      // Passenger rows can sit a few pixels above the "Pax (N)" label, so
      // they show up before that header and must not be glued onto the fuel line.
      if (PAX_RE.test(text) || /no passengers for this segment/i.test(text)) {
        close();
        continue;
      }
      if (kind === 'fuel' && /^[A-Z0-9]{3,4}\s+[A-Z]/.test(text) && !text.includes(':')) buf.vendorNote = text;
      else if (!/^_+$/.test(text.replace(/\s/g, '')) && !/TSA ID checks/i.test(text)) buf.text += ' ' + text;
      continue;
    }
    if (kind && isBlockStart(text)) close();
  }
  close();

  // Drop the code key from the stored fee/fuel objects. Callers look up by airport.
  for (const code of Object.keys(fees)) delete fees[code].code;
  for (const code of Object.keys(fuel)) delete fuel[code].code;

  const passengers = parsePassengers(lines);
  const weightLine = lines.find((line) => /Total\s*pax\s*weight/i.test(line.text));
  const weightMatch = weightLine && weightLine.text.match(/Total\s*pax\s*weight\s*:\s*([\d,]+)/i);
  const catering = parseCatering(lines);

  return {
    legNumber: detail ? parseInt(detail[1], 10) : null,
    from: detail ? detail[2].toUpperCase() : departs?.code || null,
    to: detail ? detail[3].toUpperCase() : arrives?.code || null,
    partClass: detail ? `Part ${detail[4]}` : null,
    flightNumber: detail && detail[5] ? parseInt(detail[5], 10) : null,
    distance: dist ? dist[1].replace(/\s+/g, ' ').trim() : null,
    blockTime: dist ? dist[2] : null,
    flightTime: dist ? dist[3] : null,
    timeChange: dist ? dist[4] : null,
    departs,
    arrives,
    crew,
    release,
    fees,
    fuel,
    passengers,
    totalPaxWeight: weightMatch ? parseInt(weightMatch[1].replace(/,/g, ''), 10) : null,
    catering,
    transport: parseTransport(lines),
    airportNotes: parseAirportNotes(lines),
  };
}

function endpointFields(endpoint, prefix) {
  const src = endpoint || {};
  const a2g = src.frequencyKind === 'A2G' ? src.frequency : null;
  return {
    [`${prefix}Fbo`]: src.fbo || null,
    [`${prefix}FboDetail`]: src.fboDetail || null,
    [`${prefix}AirportName`]: src.name || null,
    [`${prefix}Address`]: src.address || null,
    [`${prefix}AirportPhone`]: src.phone || null,
    [`${prefix}Frequency`]: src.frequency || null,
    [`${prefix}FrequencyKind`]: src.frequencyKind || null,
    [`${prefix}AirportA2G`]: a2g,
  };
}

function assembleLeg(summary, section, segment) {
  const fromBlock = section?.departs || null;
  const toBlock = section?.arrives || null;
  const pax = section?.passengers?.pax || [];
  const release = section?.release || null;
  const released = release ? release.released : !!segment?.released;
  return {
    legNumber: summary?.legNumber || section?.legNumber || null,
    paxCount: summary?.paxCount ?? section?.passengers?.count ?? pax.length,
    from: summary?.from || section?.from || fromBlock?.code || null,
    to: summary?.to || section?.to || toBlock?.code || null,
    depDate: summary?.depDate || null,
    depTimeLocal: summary?.depTimeLocal || null,
    depTimeLocalTz: summary?.depTimeLocalTz || null,
    depTimeZ: summary?.depTimeZ || null,
    arrDate: summary?.arrDate || null,
    arrTimeLocal: summary?.arrTimeLocal || null,
    arrTimeLocalTz: summary?.arrTimeLocalTz || null,
    arrTimeZ: summary?.arrTimeZ || null,
    summaryBlock: summary?.summaryBlock || null,
    pax,
    partClass: section?.partClass || null,
    flightNumber: section?.flightNumber ?? null,
    distance: section?.distance || null,
    blockTime: section?.blockTime || summary?.summaryBlock || null,
    flightTime: section?.flightTime || null,
    timeChange: section?.timeChange || null,
    ...endpointFields(fromBlock, 'from'),
    ...endpointFields(toBlock, 'to'),
    crew: section?.crew || { pic: null, sic: null },
    released,
    releaseText: release?.releaseText || null,
    releasedAt: release?.releasedAt || null,
    releasedBy: release?.releasedBy || null,
    vetted: !!segment?.vettedAt,
    vettedAt: segment?.vettedAt || null,
    vettingApplicable: segment ? segment.vettingApplicable : null,
    paxCleared: !!segment?.paxCleared,
    totalPaxWeight: section?.totalPaxWeight ?? null,
    fees: section?.fees || {},
    fuel: section?.fuel || {},
    airportNotes: section?.airportNotes || {},
    catering: section?.catering || { items: [], arrangedBy: null },
    transport: section?.transport || null,
  };
}

/**
 * Parse positioned pdf.js text items grouped by page.
 * pages: [{ items: [{ str, x, y, width }] }]
 */
export function parseTripSheetPages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return null;
  const allLines = [];
  for (const page of list) allLines.push(...clusterLines(page.items));
  const reading = allLines.map((line) => line.text).join('\n');
  const crew = /Crew\s+Itinerary/i.test(reading);
  const passenger = /Passenger\s+Itinerary/i.test(reading) && !crew;
  if (passenger) return parseJetInsightPassengerItinerary(reading);
  if (!crew) return null;

  const header = parseHeader(list[0]);
  const preamble = [];
  const sectionLines = [];
  let current = null;
  for (const line of allLines) {
    if (isDetailHeader(line.text)) {
      current = [line];
      sectionLines.push(current);
    } else if (current) current.push(line);
    else preamble.push(line);
  }

  const summaries = [];
  const segments = [];
  for (const line of preamble) {
    const summary = parseSummaryLine(line.text);
    if (summary) {
      summaries.push(summary);
      continue;
    }
    const segment = parseSegmentLine(line.text);
    if (segment) segments.push(segment);
  }
  const notes = parseNotes(preamble);
  const sections = sectionLines.map(parseLegSection);

  const bySummary = new Map(summaries.map((row) => [row.legNumber, row]));
  const bySection = new Map(sections.filter((row) => row.legNumber != null).map((row) => [row.legNumber, row]));
  const numbers = [...new Set([...bySummary.keys(), ...bySection.keys()])].sort((a, b) => a - b);
  const unusedSegments = [...segments];
  const legs = numbers.map((legNumber) => {
    const summary = bySummary.get(legNumber) || null;
    const section = bySection.get(legNumber) || null;
    const from = summary?.from || section?.from;
    const to = summary?.to || section?.to;
    const idx = unusedSegments.findIndex((row) => row.from === from && row.to === to);
    const segment = idx >= 0 ? unusedSegments.splice(idx, 1)[0] : null;
    return assembleLeg(summary, section, segment);
  });

  const crewSource = legs.find((leg) => leg.crew?.pic || leg.crew?.sic);
  if (!header.tail) {
    const fallback = reading.match(/\b(N\d{1,5}[A-Z]{0,2})\b/);
    if (fallback) header.tail = fallback[1].toUpperCase();
  }

  return {
    tripCode: header.tripCode,
    tail: header.tail,
    aircraftType: header.aircraftType,
    operator: header.operator,
    client: header.client,
    planner: header.planner,
    notes,
    crewContacts: crewSource ? crewSource.crew : { pic: null, sic: null },
    segmentStatus: segments,
    legs,
    _source: 'crew-itinerary',
  };
}

export function legDepartureUtcMs(leg) {
  if (!leg?.depDate || !leg?.depTimeLocal) return null;
  const date = String(leg.depDate).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const time = String(leg.depTimeLocal).match(/(\d{1,2}):(\d{2})/);
  if (!date || !time) return null;
  const offset = TZ_OFFSET_HOURS[String(leg.depTimeLocalTz || '').toUpperCase()];
  if (offset == null) return null;
  return Date.UTC(
    parseInt(date[3], 10),
    parseInt(date[1], 10) - 1,
    parseInt(date[2], 10),
    parseInt(time[1], 10) - offset,
    parseInt(time[2], 10),
    0,
    0,
  );
}

export function airportCodesMatch(a, b) {
  if (!a || !b) return false;
  const expand = (code) => {
    const upper = String(code).toUpperCase().trim();
    const set = new Set([upper]);
    if (/^K[A-Z]{3}$/.test(upper)) set.add(upper.slice(1));
    else if (/^[A-Z]{3}$/.test(upper)) set.add(`K${upper}`);
    return set;
  };
  const left = expand(a);
  const right = expand(b);
  for (const code of left) if (right.has(code)) return true;
  return false;
}

function paxNameKey(pax) {
  const first = String(pax?.firstName || '').trim().toLowerCase();
  const last = String(pax?.lastName || '').trim().toLowerCase();
  return `${first}|${last}`;
}

function freshPreloadedPax(parsedPax, tripUid) {
  return (parsedPax || []).map((pax, index) => ({
    id: `pre-${tripUid}-${index}`,
    firstName: pax.firstName || '',
    lastName: pax.lastName || '',
    gender: pax.gender || null,
    dob: pax.dob || null,
    weight: pax.weight ?? null,
    primary: !!pax.primary,
    scannedPaxId: null,
    checkInStatus: 'pending',
  }));
}

/**
 * Re-apply a parsed passenger list without wiping check-in progress.
 * Pending-only manifests are replaced. Anyone already matched, skipped,
 * or carried keeps that status and their scanned-pax link; weight, DOB,
 * and gender refresh from the sheet.
 */
export function mergePreloadedPax(existing, parsedPax, tripUid) {
  const prior = Array.isArray(existing) ? existing : [];
  const hasProgress = prior.some((pax) => PAX_PROGRESS.has(pax?.checkInStatus) || pax?.scannedPaxId);
  if (!hasProgress) return freshPreloadedPax(parsedPax, tripUid);

  const used = new Set();
  const merged = [];
  (parsedPax || []).forEach((incoming, index) => {
    const key = paxNameKey(incoming);
    const found = prior.findIndex((pax, priorIndex) => !used.has(priorIndex) && paxNameKey(pax) === key);
    if (found >= 0) {
      used.add(found);
      const prev = prior[found];
      merged.push({
        ...prev,
        firstName: incoming.firstName || prev.firstName,
        lastName: incoming.lastName || prev.lastName,
        gender: incoming.gender ?? prev.gender ?? null,
        dob: incoming.dob ?? prev.dob ?? null,
        weight: incoming.weight ?? prev.weight ?? null,
        primary: !!incoming.primary,
      });
      return;
    }
    merged.push({
      id: `pre-${tripUid}-n${index}`,
      firstName: incoming.firstName || '',
      lastName: incoming.lastName || '',
      gender: incoming.gender || null,
      dob: incoming.dob || null,
      weight: incoming.weight ?? null,
      primary: !!incoming.primary,
      scannedPaxId: null,
      checkInStatus: 'pending',
    });
  });
  prior.forEach((pax, index) => {
    if (used.has(index)) return;
    if (PAX_STICKY.has(pax?.checkInStatus) || pax?.scannedPaxId) merged.push(pax);
  });
  return merged;
}

export function resolveTripSheetNotes(existing, parsedNotes) {
  if (existing?.tripSheetNotesEditedAt) {
    return {
      notes: existing.tripSheetNotes || null,
      preservedManualNotes: true,
    };
  }
  const notes = parsedNotes || null;
  const hasAny = notes && (notes.crew || notes.pax || notes.customer || notes.specialItems);
  return { notes: hasAny ? notes : null, preservedManualNotes: false };
}

export function buildTripSheetData(parsed, leg, now = Date.now()) {
  return {
    partClass: leg.partClass || null,
    flightNumber: leg.flightNumber ?? null,
    distance: leg.distance || null,
    blockTime: leg.blockTime || null,
    flightTime: leg.flightTime || null,
    timeChange: leg.timeChange || null,
    depDate: leg.depDate || null,
    depTimeLocal: leg.depTimeLocal || null,
    depTimeLocalTz: leg.depTimeLocalTz || null,
    depTimeZ: leg.depTimeZ || null,
    arrDate: leg.arrDate || null,
    arrTimeLocal: leg.arrTimeLocal || null,
    arrTimeLocalTz: leg.arrTimeLocalTz || null,
    arrTimeZ: leg.arrTimeZ || null,
    released: !!leg.released,
    releaseText: leg.releaseText || null,
    releasedAt: leg.releasedAt || null,
    releasedBy: leg.releasedBy || null,
    vetted: !!leg.vetted,
    vettedAt: leg.vettedAt || null,
    vettingApplicable: leg.vettingApplicable ?? null,
    paxCleared: !!leg.paxCleared,
    totalPaxWeight: leg.totalPaxWeight ?? null,
    paxCount: leg.paxCount ?? (leg.pax || []).length,
    fees: leg.fees || {},
    fuel: leg.fuel || {},
    from: leg.from || null,
    to: leg.to || null,
    fromFbo: leg.fromFbo || null,
    toFbo: leg.toFbo || null,
    fromAirportName: leg.fromAirportName || null,
    toAirportName: leg.toAirportName || null,
    fromAddress: leg.fromAddress || null,
    toAddress: leg.toAddress || null,
    fromAirportPhone: leg.fromAirportPhone || null,
    toAirportPhone: leg.toAirportPhone || null,
    fromAirportA2G: leg.fromAirportA2G || null,
    toAirportA2G: leg.toAirportA2G || null,
    fromFrequency: leg.fromFrequency || null,
    toFrequency: leg.toFrequency || null,
    fromFrequencyKind: leg.fromFrequencyKind || null,
    toFrequencyKind: leg.toFrequencyKind || null,
    fromFboDetail: leg.fromFboDetail || null,
    toFboDetail: leg.toFboDetail || null,
    airportNotes: leg.airportNotes || {},
    transport: leg.transport || null,
    catering: leg.catering && (leg.catering.items?.length || leg.catering.arrangedBy)
      ? leg.catering
      : null,
    crew: leg.crew || null,
    tripCode: parsed?.tripCode || null,
    tail: parsed?.tail || null,
    aircraftType: parsed?.aircraftType || null,
    client: parsed?.client || null,
    planner: parsed?.planner || null,
    operator: parsed?.operator || null,
    parsedAt: now,
  };
}

function rankScheduleTrips(leg, tail, allTrips, codesMatch) {
  const expected = legDepartureUtcMs(leg);
  const ranked = [];
  for (const trip of allTrips || []) {
    if (!trip?.uid || !trip.info || !trip.start) continue;
    if (!codesMatch(trip.info.from, leg.from) || !codesMatch(trip.info.to, leg.to)) continue;
    const start = new Date(trip.start).getTime();
    if (!Number.isFinite(start)) continue;
    if (expected == null) continue;
    const delta = Math.abs(start - expected);
    if (delta > MATCH_WINDOW_MS) continue;
    const tripTail = String(trip.info.tail || '').toUpperCase();
    ranked.push({
      trip,
      delta,
      tailMismatch: !!tail && tripTail !== String(tail).toUpperCase(),
    });
  }
  ranked.sort((a, b) => a.delta - b.delta || String(a.trip.uid).localeCompare(String(b.trip.uid)));
  return ranked;
}

/**
 * Decide which schedule legs receive this sheet. Matching is itinerary-wide:
 * every parsed leg is paired to a schedule leg by route and departure instant
 * (local time + timezone), preferring the sheet tail. A schedule leg is used
 * at most once, so two same-route legs on the same day stay distinct.
 * Legs with no schedule counterpart are returned unmatched and are not created.
 */
export function planTripSheetPropagation({
  parsed,
  allTrips,
  statesByUid = {},
  codesMatch = airportCodesMatch,
  now = Date.now(),
} = {}) {
  const legs = parsed?.legs || [];
  const tail = parsed?.tail || null;
  const used = new Set();
  const matches = legs.map((leg) => {
    const ranked = rankScheduleTrips(leg, tail, allTrips, codesMatch).filter((row) => !used.has(row.trip.uid));
    const strict = ranked.filter((row) => !row.tailMismatch);
    const best = (strict.length ? strict : ranked)[0] || null;
    if (!best) {
      return {
        leg,
        trip: null,
        tailMismatch: false,
        unmatchedReason: 'no-schedule-leg',
        preservedManualNotes: false,
        preservedPaxProgress: false,
        update: null,
      };
    }
    used.add(best.trip.uid);
    const existing = statesByUid ? statesByUid[best.trip.uid] : null;
    const notes = resolveTripSheetNotes(existing, parsed.notes);
    const preloadedPax = mergePreloadedPax(existing?.preloadedPax, leg.pax, best.trip.uid);
    const preservedPaxProgress = (existing?.preloadedPax || []).some((pax) =>
      PAX_PROGRESS.has(pax?.checkInStatus) || pax?.scannedPaxId
    );
    return {
      leg,
      trip: { ...best.trip, _tailMismatch: best.tailMismatch },
      tailMismatch: best.tailMismatch,
      unmatchedReason: null,
      preservedManualNotes: notes.preservedManualNotes,
      preservedPaxProgress,
      update: {
        tripUid: best.trip.uid,
        preloadedPax,
        tripSheetNotes: notes.notes,
        fromFbo: leg.fromFbo || null,
        toFbo: leg.toFbo || null,
        tripSheetData: buildTripSheetData(parsed, leg, now),
      },
    };
  });
  return {
    tripCode: parsed?.tripCode || null,
    tail,
    matches,
    attachedCount: matches.filter((match) => match.update).length,
    unmatchedCount: matches.filter((match) => !match.update).length,
  };
}

export function fboForAirport(parsed, code, codesMatch = airportCodesMatch) {
  if (!parsed || !code) return null;
  for (const leg of parsed.legs || []) {
    if (codesMatch(leg.from, code) && leg.fromFbo) return leg.fromFbo;
    if (codesMatch(leg.to, code) && leg.toFbo) return leg.toFbo;
  }
  return null;
}

export async function extractTripSheetPages(fileOrBuffer) {
  const pdfjsLib = await import('pdfjs-dist/build/pdf.mjs');
  if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
  }
  const arrayBuffer = (fileOrBuffer && typeof fileOrBuffer.arrayBuffer === 'function')
    ? await fileOrBuffer.arrayBuffer()
    : fileOrBuffer;
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push({
      pageNumber: i,
      items: content.items
        .filter((item) => item && item.str && String(item.str).trim())
        .map((item) => ({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width || 0,
        })),
    });
  }
  return pages;
}

// Passenger Itinerary (broker sheet, names only). Kept so an upload of that
// export still attaches legs; crew sheets go through parseTripSheetPages.
function to24HourTime(timeStr, ampm) {
  const parts = String(timeStr || '').split(':');
  if (parts.length < 2) return null;
  let hour = parseInt(parts[0], 10);
  const minute = parseInt(parts[1], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const marker = String(ampm || '').trim().toLowerCase();
  if (marker === 'pm' && hour < 12) hour += 12;
  if (marker === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function parseJetInsightPassengerItinerary(text) {
  if (!text || typeof text !== 'string') return null;
  const tripCodeMatch = text.match(/Passenger\s+Itinerary\s*\(([A-Z0-9]+)\)/i);
  const tailMatch = text.match(/\b(N\d{1,5}[A-Z]{0,2})\b/);
  const legRe = /Leg\s+(\d+)\s*:\s*([A-Z0-9]{3,4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}:\d{2})\s*(am|pm)\s+([A-Z]{2,4})\s+([A-Z0-9]{3,4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}:\d{2})\s*(am|pm)\s+([A-Z]{2,4})/gi;
  const legSummaries = [];
  let lm;
  while ((lm = legRe.exec(text)) !== null) {
    legSummaries.push({
      legNumber: parseInt(lm[1], 10),
      paxCount: 0,
      from: lm[2].toUpperCase(),
      depDate: lm[3],
      depTimeLocal: to24HourTime(lm[4], lm[5]),
      depTimeLocalTz: lm[6],
      depTimeZ: null,
      to: lm[7].toUpperCase(),
      arrDate: lm[8],
      arrTimeLocal: to24HourTime(lm[9], lm[10]),
      arrTimeLocalTz: lm[11],
      arrTimeZ: null,
    });
  }
  const picMatch = text.match(/PIC\s*:\s*([^\n\r]{2,80}?)(?=\s{2,}|SIC\s*:|Passengers?\s*\(|Crew\b|$)/i);
  const sicMatch = text.match(/SIC\s*:\s*([^\n\r]{2,80}?)(?=\s{2,}|PIC\s*:|Passengers?\s*\(|Crew\b|$)/i);
  const pic = picMatch ? picMatch[1].trim() : null;
  const sic = sicMatch ? sicMatch[1].trim() : null;
  const fboByCode = {};
  const feesRe = /Fees\s*\(([A-Z0-9]{3,4})\)\s*:\s*([^/\n]+?)\s*\//gi;
  let feeMatch;
  while ((feeMatch = feesRe.exec(text)) !== null) {
    const fbo = feeMatch[2].trim().replace(/\s+/g, ' ');
    if (fbo.length >= 2 && fbo.length <= 60 && /[A-Za-z]/.test(fbo)) {
      fboByCode[feeMatch[1].toUpperCase()] = fbo;
    }
  }
  const paxByLeg = {};
  const paxHeaderRe = /Passengers?\s*\((\d+)\)/gi;
  let phMatch;
  let blockIdx = 0;
  while ((phMatch = paxHeaderRe.exec(text)) !== null) {
    const startIdx = phMatch.index + phMatch[0].length;
    const rest = text.slice(startIdx);
    const stopRe = /(?:Passengers?\s*\(|Name\s+Address\s+Phone|TRANSPORT\s*:|Arranged\s+by|Leg\s+\d+\s*:|Crew\b)/i;
    const stopMatch = rest.match(stopRe);
    const endIdx = stopMatch ? startIdx + stopMatch.index : Math.min(text.length, startIdx + 500);
    const body = text.slice(startIdx, endIdx).trim();
    const names = body.split(/\s{2,}|\n+/).map((part) => part.trim()).filter((part) => {
      if (!part || part.length > 60 || part.length < 4) return false;
      const tokens = part.split(/\s+/).filter(Boolean);
      return tokens.length >= 2 && tokens.length <= 5 && tokens.every((token) => /^[A-Z][a-zA-Z'.-]*$/.test(token));
    });
    paxByLeg[blockIdx + 1] = names.map((name) => {
      const tokens = name.split(/\s+/).filter(Boolean);
      return {
        firstName: tokens[0] || '',
        lastName: tokens.slice(1).join(' '),
        gender: null,
        dob: null,
        weight: null,
        primary: false,
      };
    });
    blockIdx += 1;
  }
  const legs = legSummaries.map((summary) => ({
    ...summary,
    pax: paxByLeg[summary.legNumber] || [],
    fromFbo: fboByCode[summary.from] || null,
    toFbo: fboByCode[summary.to] || null,
    partClass: null,
    flightNumber: null,
    distance: null,
    blockTime: null,
    flightTime: null,
    timeChange: null,
    fees: {},
    fuel: {},
    crew: {
      pic: pic ? { name: pic, phone: null, email: null } : null,
      sic: sic ? { name: sic, phone: null, email: null } : null,
    },
    released: false,
    catering: null,
    transport: null,
    airportNotes: {},
  }));
  return {
    tripCode: tripCodeMatch ? tripCodeMatch[1] : null,
    tail: tailMatch ? tailMatch[1] : null,
    aircraftType: null,
    legs,
    notes: { crew: null, pax: null, customer: null, specialItems: null },
    crewContacts: {
      pic: pic ? { name: pic, phone: null, email: null } : null,
      sic: sic ? { name: sic, phone: null, email: null } : null,
    },
    client: null,
    planner: null,
    operator: null,
    _isPassengerItinerary: true,
    _source: 'passenger-itinerary',
  };
}

export function parseJetInsightTripSheet(text) {
  if (!text || typeof text !== 'string') return null;
  if (/Passenger\s+Itinerary/i.test(text) && !/Crew\s+Itinerary/i.test(text)) {
    return parseJetInsightPassengerItinerary(text);
  }
  return null;
}
