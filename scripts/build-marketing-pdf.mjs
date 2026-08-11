// Builds the Skyway Ops marketing booklet from the prepared preview captures.
//
//   node scripts/prepare-marketing-shots.mjs   # trim/crop raw browser captures
//   node scripts/build-marketing-pdf.mjs       # -> marketing/Skyway-Ops-Booklet.pdf
//
// Every screenshot is a real render of the shipping components (see
// vite.preview.config.js), populated with a fictitious operating day rather than
// live customer data. That is stated on each screenshot page so the document
// never implies the numbers are a real operation.
//
// A missing capture degrades to a labelled placeholder rather than aborting the
// build, so the booklet can be regenerated while shots are still being taken.

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'marketing/shots');
const outPath = path.join(root, 'marketing/Skyway-Ops-Booklet.pdf');
mkdirSync(path.dirname(outPath), { recursive: true });

const INK = {
  bg: '#0A0B0D',
  panel: '#121417',
  edge: '#212429',
  text: '#F7F8F9',
  muted: '#92969E',
  subtle: '#686D76',
  accent: '#3FA9CC',
  success: '#4FA97B',
  warning: '#D6A445',
};

const W = 792;
const H = 612;
const M = 52;

const BOLD = 'Helvetica-Bold';
const BODY = 'Helvetica';

const doc = new PDFDocument({
  size: 'LETTER',
  layout: 'landscape',
  margin: 0,
  info: {
    Title: 'Skyway Ops — Part 135 Charter Operations Platform',
    Author: 'Skyway Aviation',
    Subject: 'Product booklet',
  },
});
doc.pipe(createWriteStream(outPath));

const missing = [];
let pageNo = 0;

function page({ first = false } = {}) {
  if (!first) doc.addPage({ size: 'LETTER', layout: 'landscape', margin: 0 });
  doc.rect(0, 0, W, H).fill(INK.bg);
  pageNo += 1;
}

function shot(name) {
  const file = path.join(shots, name);
  if (existsSync(file)) return file;
  if (!missing.includes(name)) missing.push(name);
  return null;
}

function placeholder(box, name) {
  doc.roundedRect(box.x, box.y, box.w, box.h, 6).fill(INK.panel);
  doc.roundedRect(box.x, box.y, box.w, box.h, 6).lineWidth(0.75).strokeColor(INK.edge).stroke();
  doc.font(BODY).fontSize(8).fillColor(INK.subtle)
    .text(`capture pending: ${name}`, box.x + 12, box.y + box.h / 2 - 5, {
      width: box.w - 24, align: 'center',
    });
}

function footer(text) {
  doc.font(BODY).fontSize(7.5).fillColor(INK.subtle)
    .text(text, M, H - 34, { width: W - M * 2 - 28 });
  doc.font(BODY).fontSize(7.5).fillColor(INK.subtle)
    .text(String(pageNo), W - M - 20, H - 34, { width: 20, align: 'right' });
}

function heading(kicker, title, subtitle, { subtitleWidth = W - M * 2 } = {}) {
  doc.font(BOLD).fontSize(8).fillColor(INK.accent)
    .text(kicker.toUpperCase(), M, 42, { characterSpacing: 1.2 });
  doc.font(BOLD).fontSize(20).fillColor(INK.text).text(title, M, 57);
  if (subtitle) {
    doc.font(BODY).fontSize(9.5).fillColor(INK.muted)
      .text(subtitle, M, 84, { width: subtitleWidth, lineGap: 1.5 });
  }
}

/** Fit an image inside a box, centred, and return the drawn rectangle. */
function fitted(file, box, { align = 'center' } = {}) {
  const { width: iw, height: ih } = doc.openImage(file);
  const scale = Math.min(box.w / iw, box.h / ih);
  const w = iw * scale;
  const h = ih * scale;
  const x = box.x + (box.w - w) / 2;
  const y = align === 'top' ? box.y : box.y + (box.h - h) / 2;
  doc.save();
  doc.roundedRect(x, y, w, h, 5).clip();
  doc.image(file, x, y, { width: w, height: h });
  doc.restore();
  doc.roundedRect(x, y, w, h, 5).lineWidth(0.75).strokeColor(INK.edge).stroke();
  return { x, y, w, h };
}

/**
 * A phone capture drawn inside a device frame. Screenshots of a 390x844 viewport
 * read as arbitrary tall rectangles without one; the frame makes it immediately
 * obvious these are the screens a pilot uses on a phone.
 */
function phone(file, { x, y, h, caption }) {
  const screenH = h;
  const screenW = screenH * (390 / 844);
  const bezel = 5;
  const outerW = screenW + bezel * 2;
  const outerH = screenH + bezel * 2;

  doc.roundedRect(x, y, outerW, outerH, 17).fill('#000000');
  doc.roundedRect(x, y, outerW, outerH, 17).lineWidth(0.9).strokeColor('#2A2E34').stroke();

  if (file) {
    doc.save();
    doc.roundedRect(x + bezel, y + bezel, screenW, screenH, 13).clip();
    doc.image(file, x + bezel, y + bezel, { width: screenW, height: screenH });
    doc.restore();
  } else {
    doc.roundedRect(x + bezel, y + bezel, screenW, screenH, 13).fill(INK.panel);
  }

  // Home indicator, to read as a modern handset.
  doc.roundedRect(x + outerW / 2 - 20, y + outerH - 9, 40, 2.6, 1.3).fill('#4A4F57');

  if (caption) {
    doc.font(BOLD).fontSize(8).fillColor(INK.text)
      .text(caption, x - 6, y + outerH + 9, { width: outerW + 12, align: 'center' });
  }
  return { x, y, w: outerW, h: outerH };
}

function bullets(items, { x, y, width, gap = 12, size = 8.8 }) {
  let cursor = y;
  for (const item of items) {
    doc.circle(x + 2.5, cursor + 4.2, 2.5).fill(INK.accent);
    doc.font(BOLD).fontSize(size).fillColor(INK.text)
      .text(item.title, x + 12, cursor, { width: width - 12 });
    if (item.body) {
      doc.font(BODY).fontSize(size - 0.4).fillColor(INK.muted)
        .text(item.body, x + 12, doc.y + 1.5, { width: width - 12, lineGap: 1 });
    }
    cursor = doc.y + gap;
  }
  return cursor;
}

const SAMPLE_NOTE = 'Genuine interface render from the shipping application. Aircraft, crew, brokers, passengers and figures are fictitious sample data.';

/** A full-width desktop screenshot with callouts in a row beneath. */
function desktopPage({ kicker, title, subtitle, image, points, note, imageH = 330, layout = 'wide' }) {
  page();
  heading(kicker, title, subtitle);

  const file = shot(image);
  const top = 118;
  const available = 560 - top;

  // A portrait capture printed full width would be reduced to a sliver, so it
  // runs tall down the left with the callouts stacked beside it instead.
  if (layout === 'tall') {
    const imgW = 316;
    const box = { x: M, y: top, w: imgW, h: 424 };
    const rect = file ? fitted(file, box, { align: 'top' }) : (placeholder(box, image), box);
    const colX = M + imgW + 34;
    bullets(points, { x: colX, y: top + 6, width: W - M - colX });
    footer(note || SAMPLE_NOTE);
    return;
  }

  const box = { x: M, y: top, w: W - M * 2, h: imageH };

  // A wide, short card leaves the lower half of the page empty if it is pinned
  // under the heading, so the image and its callouts are centred as one block.
  if (file) {
    const { width: iw, height: ih } = doc.openImage(file);
    const drawnH = ih * Math.min(box.w / iw, box.h / ih);
    const blockH = drawnH + 96;
    if (blockH < available) box.y = top + (available - blockH) / 2;
  }

  const rect = file ? fitted(file, box, { align: 'top' }) : (placeholder(box, image), box);

  const cols = Math.min(points.length, 4);
  const colW = (W - M * 2 - (cols - 1) * 18) / cols;
  points.slice(0, cols).forEach((point, i) => {
    bullets([point], { x: M + i * (colW + 18), y: rect.y + rect.h + 22, width: colW });
  });

  footer(note || SAMPLE_NOTE);
}

/** One or two phone frames beside a callout column. */
function phonePage({ kicker, title, subtitle, phones, points, note }) {
  page();
  const frameH = 372;
  const frameW = frameH * (390 / 844) + 10;
  const gap = 20;
  const bank = phones.length * frameW + (phones.length - 1) * gap;
  const colX = M + bank + 34;
  const colW = W - M - colX;

  heading(kicker, title, subtitle, { subtitleWidth: W - M * 2 });

  phones.forEach((item, i) => {
    phone(shot(item.image), {
      x: M + i * (frameW + gap),
      y: 134,
      h: frameH,
      caption: item.caption,
    });
  });

  // One phone leaves a wide column; two short columns of callouts fill it far
  // better than one column of half-length lines.
  if (phones.length === 1 && points.length >= 4) {
    const half = Math.ceil(points.length / 2);
    const gutter = 22;
    const halfW = (colW - gutter) / 2;
    bullets(points.slice(0, half), { x: colX, y: 140, width: halfW });
    bullets(points.slice(half), { x: colX + halfW + gutter, y: 140, width: halfW });
  } else {
    bullets(points, { x: colX, y: 140, width: colW });
  }
  footer(note || SAMPLE_NOTE);
}

/** A phone frame beside a desktop capture — the same record on both devices. */
function splitPage({ kicker, title, subtitle, phone: phoneItem, desktop, points, note }) {
  page();
  heading(kicker, title, subtitle);

  const frameH = 356;
  phone(shot(phoneItem.image), { x: M, y: 128, h: frameH, caption: phoneItem.caption });
  const frameW = frameH * (390 / 844) + 10;

  const rightX = M + frameW + 30;
  const rightW = W - M - rightX;
  const file = shot(desktop.image);
  const box = { x: rightX, y: 128, w: rightW, h: 236 };
  const rect = file ? fitted(file, box, { align: 'top' }) : (placeholder(box, desktop.image), box);
  if (desktop.caption) {
    doc.font(BOLD).fontSize(8).fillColor(INK.text)
      .text(desktop.caption, rightX, rect.y + rect.h + 8, { width: rightW, align: 'center' });
  }

  const cols = 2;
  const colW = (rightW - 18) / cols;
  points.slice(0, 4).forEach((point, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    bullets([point], {
      x: rightX + col * (colW + 18),
      y: rect.y + rect.h + 30 + row * 74,
      width: colW,
      size: 8.4,
    });
  });

  footer(note || SAMPLE_NOTE);
}

/* ══════════════════════════ 1. Cover ══════════════════════════ */
page({ first: true });
doc.rect(0, 0, 6, H).fill(INK.accent);

const logoFile = path.join(root, 'public/skyway-logo-reverse.png');
if (existsSync(logoFile)) doc.image(logoFile, M, 88, { width: 240 });

doc.font(BOLD).fontSize(33).fillColor(INK.text)
  .text('Run the whole operation', M, 202, { width: 540 });
doc.font(BOLD).fontSize(33).fillColor(INK.accent)
  .text('from one record.', M, 239, { width: 540 });

doc.font(BODY).fontSize(11.5).fillColor(INK.muted).text(
  'Skyway Ops is a Part 135 charter operations platform built around a single '
  + 'operating day. Dispatch, pilots, maintenance, brokers and accounting all work '
  + 'from the same trip record — live fleet tracking, crew duty and rest, passenger '
  + 'manifests, expenses, company email and Microsoft Teams, and QuickBooks.',
  M, 294, { width: 505, lineGap: 3.5 },
);

const coverStats = [
  ['On the ramp', 'Pilots run the trip from a phone'],
  ['In the office', 'Dispatch sees the whole fleet live'],
  ['For the broker', 'One link, no phone calls'],
];
let sx = M;
for (const [big, small] of coverStats) {
  doc.roundedRect(sx, 424, 148, 68, 8).lineWidth(0.75).strokeColor(INK.edge).stroke();
  doc.font(BOLD).fontSize(10).fillColor(INK.accent).text(big, sx + 13, 439);
  doc.font(BODY).fontSize(8).fillColor(INK.muted).text(small, sx + 13, 454, { width: 124 });
  sx += 160;
}

// The product is used on a phone more than anywhere else, so the cover shows one.
phone(shot('phone-pilot-home.png'), { x: 566, y: 96, h: 424 });

doc.font(BODY).fontSize(8).fillColor(INK.subtle)
  .text('Product booklet · Skyway Aviation · flyskyway.com', M, H - 50);

/* ══════════════════════ 2. How it works ══════════════════════ */
page();
heading('How it works', 'One operating day, one system of record',
  'The schedule drives everything. Each step writes to the same trip record, so dispatch, crew, brokers and accounting are never looking at different versions of the day.');

const flow = [
  ['1', 'The schedule arrives', 'Trips import from your scheduling feed. Aircraft, route, crew and passengers land on one trip record.'],
  ['2', 'Dispatch readies the leg', 'Trip sheet, FBOs, catering and the passenger manifest are completed and checked against a readiness list.'],
  ['3', 'Crew works the trip', 'Pilots go on duty, verify passenger IDs, and tap each milestone from crew on-site through landed.'],
  ['4', 'Everyone sees it live', 'FlightAware positions and crew milestones update the fleet map, the flight board and the broker link at once.'],
  ['5', 'The day settles', 'Duty and flight time are recorded for compliance, expenses match to card charges, and invoices post to QuickBooks.'],
];
let fy = 138;
for (const [num, title, body] of flow) {
  doc.roundedRect(M, fy, W - M * 2, 62, 8).fill(INK.panel);
  doc.circle(M + 30, fy + 31, 15).fill(INK.accent);
  doc.font(BOLD).fontSize(13).fillColor(INK.bg).text(num, M + 25, fy + 24, { width: 12, align: 'center' });
  doc.font(BOLD).fontSize(11.5).fillColor(INK.text).text(title, M + 58, fy + 16);
  doc.font(BODY).fontSize(9).fillColor(INK.muted).text(body, M + 58, fy + 33, { width: W - M * 2 - 80 });
  fy += 70;
}
footer('Roles decide what each person sees: crew get their trips and duty, dispatch gets the fleet, administrators get everything.');

/* ═══════════════════ 3. Live fleet tracking ═══════════════════ */
desktopPage({
  kicker: 'Live fleet tracking',
  title: 'Every aircraft, always located',
  subtitle: 'Airborne aircraft follow their FlightAware track. Aircraft on the ground hold their last known position, so nothing on the fleet ever goes missing from the board.',
  image: 'flight-board-tv.png',
  imageH: 322,
  points: [
    { title: 'Whole fleet, one view', body: 'Airborne and on-ground aircraft together, with the day\'s legs beside the map.' },
    { title: 'Status at a glance', body: 'Airborne, in turn, pre-flight and complete are colour-coded down the board.' },
    { title: 'Built for a wall display', body: 'A full-screen board for the dispatch office that needs no interaction.' },
    { title: 'No manual updates', body: 'Positions come from FlightAware; milestones come from the crew\'s own taps.' },
  ],
});

/* ═════════════════ 4. The dashboard, top to bottom ═════════════════ */
desktopPage({
  kicker: 'Operations control',
  title: 'The whole morning briefing on one screen',
  subtitle: 'Fleet map at the top, personal and shared mail side by side, then the day\'s flight board next to the crews currently on duty — the order a controller actually works in.',
  image: 'crew-grouped.png',
  imageH: 348,
  points: [
    { title: 'Mail where decisions happen', body: 'A pilot\'s own inbox and the shared charter inbox, both live.' },
    { title: 'The day at a glance', body: 'Every leg with live status, crew and scheduled against actual time.' },
    { title: 'Crews and their clocks', body: 'Who is on duty, on which aircraft, and how long they have left.' },
    { title: 'Exceptions counted', body: 'Legs, block hours, aircraft available and anything flagged critical.' },
  ],
});

/* ═════════════ 5. Crew on duty — PIC/SIC grouped ═════════════ */
desktopPage({
  kicker: 'Crew on duty',
  title: 'A two-pilot trip reads as one crew',
  subtitle: 'A crew is dispatched together, so the board shows it together: captain above first officer, on one aircraft, against one duty clock. The clock shown is whichever pilot runs out first, because that is when the crew stops flying.',
  image: 'on-duty-crews.png',
  imageH: 326,
  points: [
    { title: 'Grouped without being told', body: 'Linked duty records pair up, and so do pilots sharing an aircraft and report time.' },
    { title: 'The tightest clock wins', body: 'A crew is legal only as long as its most-limited pilot, so that is the time displayed.' },
    { title: 'Single pilots still shown', body: 'A one-pilot crew is labelled as such rather than left looking incomplete.' },
    { title: 'Closest to the limit first', body: 'Crews sort by time remaining; over-limit reads in red, not buried in a list.' },
  ],
});

/* ═════════════════ 5. Dispatch flight control ═════════════════ */
desktopPage({
  kicker: 'Dispatch',
  title: 'Flight control for the rolling day',
  subtitle: 'A working queue rather than a calendar: every leg in the next 48 hours with what is missing, who is watching it, and what has to happen next.',
  image: 'dispatch.png',
  imageH: 344,
  points: [
    { title: 'Readiness, not guesswork', body: 'Trip sheet, crew, manifest and catering are checked per leg and flagged when incomplete.' },
    { title: 'Filter to the problems', body: 'Jump straight to legs with flags, on hold, unassigned or already in progress.' },
    { title: 'Owned by a controller', body: 'Legs are assigned to a dispatcher with a disposition and a running note.' },
    { title: 'Shift handover included', body: 'The day\'s notes and dispositions carry across to the next controller.' },
  ],
});

/* ══════════════════════ 6. The schedule ══════════════════════ */
desktopPage({
  kicker: 'Schedule',
  title: 'The day, leg by leg',
  subtitle: 'The imported schedule with live status against each leg — airborne, on time, scheduled — plus aircraft, crew, passenger count and the customer on the trip.',
  image: 'schedule.png',
  imageH: 320,
  points: [
    { title: 'Straight from your scheduler', body: 'Legs import from an iCal feed, so the office keeps the scheduling tool it already uses.' },
    { title: 'Filter by aircraft', body: 'One tail at a time when a controller is working a single aircraft\'s day.' },
    { title: 'Revenue and repositioning', body: 'Leg category is derived automatically and counted for the day.' },
    { title: 'Everything links onward', body: 'A leg opens the full trip: manifest, status, expenses, messages and documents.' },
  ],
});

/* ═════════════ 7. The pilot's phone — home and trips ═════════════ */
phonePage({
  kicker: 'For pilots',
  title: 'The whole trip, in a pilot\'s pocket',
  subtitle: 'Pilots do not get a cut-down companion app. They get the operation: the leg they are flying, their duty clock, and every action the trip needs — installed to the home screen, no laptop on the ramp.',
  phones: [
    { image: 'phone-pilot-home.png', caption: 'Home — the leg in progress and the duty clock' },
    { image: 'phone-flights.png', caption: 'Flights — the pilot\'s own schedule' },
  ],
  points: [
    { title: 'What matters, first', body: 'The leg in progress leads: route, aircraft, time since departure and live status.' },
    { title: 'The duty clock is always there', body: 'Hours used against the 14-hour limit, time remaining, and whether the pilot is legal.' },
    { title: 'Only their own trips', body: 'A pilot sees the legs they are assigned as PIC or SIC, matched on the scheduler\'s crew names.' },
    { title: 'Installs like an app', body: 'A progressive web app on iPhone and Android — no app store, no separate build to distribute.' },
    { title: 'Push, not chasing', body: 'Assignment changes, duty confirmations and trip messages arrive as notifications.' },
  ],
});

/* ═════════════ 8. The pilot's phone — working the trip ═════════════ */
phonePage({
  kicker: 'For pilots',
  title: 'Working the trip, one tap per milestone',
  subtitle: 'The crew records the trip as they fly it. Each tap timestamps the step against the pilot who made it, and that is what the office, the flight board and the broker link all read.',
  phones: [
    { image: 'phone-trip.png', caption: 'Trip detail — status, passengers, operational' },
    { image: 'phone-trip-status.png', caption: 'Milestones, timestamped and attributed' },
  ],
  points: [
    { title: 'Crew on-site to landed', body: 'Aircraft ready, catering aboard, passengers arrived and boarded, taxi, wheels up, landed.' },
    { title: 'Signed by name', body: 'Every completed step carries the time and the crew member who recorded it.' },
    { title: 'Wheels up detected for you', body: 'Departure and arrival are confirmed from FlightAware rather than typed in twice.' },
    { title: 'Catering only when there is catering', body: 'Steps that do not apply to a leg are not shown, so the list is never noise.' },
    { title: 'One tap notifies everyone', body: 'A milestone pushes to dispatch and updates the broker\'s tracking page at the same moment.' },
  ],
});

/* ══════════════ 9. Manifests and passenger check-in ══════════════ */
phonePage({
  kicker: 'Manifests',
  title: 'Passengers verified on the ramp',
  subtitle: 'The manifest from the trip sheet is checked against who actually boards. Crew verify each passenger on the phone, add walk-ups, and the manifest closes with the leg.',
  phones: [
    { image: 'phone-trip-pax.png', caption: 'Passenger manifest and verification' },
  ],
  points: [
    { title: 'Expected against actual', body: 'Names from the trip sheet sit beside the verified manifest, so a mismatch is obvious before the door closes.' },
    { title: 'Verified, not assumed', body: 'Crew confirm each passenger against their identification, with age derived from date of birth.' },
    { title: 'Walk-ups and children', body: 'Late additions and passengers without identification are handled without leaving the leg.' },
    { title: 'No-shows recorded', body: 'A passenger who does not travel is marked, not quietly deleted, so the record matches the flight.' },
    { title: 'Feeds the day\'s manifest', body: 'Per-leg manifests roll up to the aircraft\'s daily manifest for the office.' },
  ],
});

/* ═══════════════════ 10. Duty and rest ═══════════════════ */
phonePage({
  kicker: 'Duty and rest',
  title: 'The 14-hour clock belongs to the pilot',
  subtitle: 'Pilots start and end their own duty on the phone, and the aircraft they are assigned is written onto the period and held for the whole window — so the record says which tail the time was flown on.',
  phones: [
    { image: 'phone-duty.png', caption: 'Duty clock, rest before duty and the assigned tail' },
  ],
  points: [
    { title: 'Started, and by how much', body: 'Report time, hours used against the 14-hour limit and time remaining, all on one dial.' },
    { title: 'Rest before duty recorded', body: 'The rest period that qualifies the duty is captured with it, not reconstructed later.' },
    { title: 'The tail is on the record', body: 'The aircraft assigned at the start of the period stays on the duty record for the full window.' },
    { title: 'Crews go on duty together', body: 'Paired pilots start and end as a crew, which is what makes the crew view on the board possible.' },
    { title: 'The pilot can export it', body: 'A pilot can pull their own duty history to CSV or PDF without asking the office.' },
  ],
});

/* ═════════════ 11. Duty compliance reporting ═════════════ */
desktopPage({
  kicker: 'Compliance',
  title: 'The duty record an audit asks for',
  subtitle: 'Every pilot, every period, with legality assessed rather than left to interpretation — duty and flight time, outside commercial flying, average rest, exceptions and any edits made to the record.',
  image: 'duty-report-table.png',
  imageH: 168,
  points: [
    { title: 'Legality is stated', body: 'Each pilot reads legal or warning against the limit, with the live duty time beside it.' },
    { title: 'Outside flying counted', body: 'Commercial flying done elsewhere is included, because the limit follows the pilot.' },
    { title: 'Rest averaged', body: 'Average rest across the window shows whether the schedule is sustainable, not just legal.' },
    { title: 'Edits are visible', body: 'Corrections are counted per pilot, so the record shows what was changed after the fact.' },
  ],
});

/* ═══════════════════ 12. Expenses ═══════════════════ */
phonePage({
  kicker: 'Expenses',
  title: 'Receipts captured where they happen',
  subtitle: 'A crew member photographs the receipt at the FBO counter and it is booked against the leg they are flying, categorised, and already attributed to them. Nothing to reconcile from an envelope at month end.',
  phones: [
    { image: 'phone-expenses.png', caption: 'A pilot\'s own spend for the month, by category' },
  ],
  points: [
    { title: 'Their month, at the top', body: 'Total spend for the month with the category split, before the receipt list.' },
    { title: 'Booked to the leg', body: 'Fuel, catering, hangar and crew costs attach to the trip that incurred them.' },
    { title: 'Card tagging prompted', body: 'A charge still needing its company card flagged is called out rather than left to accounting.' },
    { title: 'Personal spend separated', body: 'Reimbursable personal-card spend is tracked apart from company card charges.' },
    { title: 'Reports on the same screen', body: 'Crew can pull their own history without an export request.' },
  ],
});

/* ═════════════ 13. Expense reconciliation ═════════════ */
desktopPage({
  kicker: 'Accounting',
  title: 'Reconciled against the company file',
  subtitle: 'Accounting sees the same charges rolled up by crew member and by QuickBooks account, with the connection to the production company file live and each category already mapped to an account.',
  image: 'expense-summary.png',
  imageH: 336,
  points: [
    { title: 'Connected, not exported', body: 'A live QuickBooks Online connection to the real company file, shown with who connected it.' },
    { title: 'Mapped once', body: 'Expense categories map to accounts in the chart of accounts and hold for every posting.' },
    { title: 'By crew or by account', body: 'The period totals both ways, which is what a close actually needs.' },
    { title: 'Reimbursements as bills', body: 'Personal-card spend can be raised as reimbursement bills in one action.' },
  ],
});

/* ═══════════════════ 12. Broker live link ═══════════════════ */
desktopPage({
  kicker: 'Broker sharing',
  title: 'One link instead of a morning of phone calls',
  subtitle: 'A read-only page the broker can watch: the aircraft moving on its track, the legs, and the milestones the crew is completing. No login, no access to anything else.',
  image: 'broker.png',
  layout: 'tall',
  points: [
    { title: 'Live, not a snapshot', body: 'The map, the progress and the milestones update as the crew and FlightAware report them.' },
    { title: 'Only what they should see', body: 'Crew names without contact details, and passengers only when the trip is set to show them.' },
    { title: 'Honest about what is not booked', body: 'Catering that was never ordered is simply absent rather than shown as outstanding.' },
    { title: 'Expires on its own', body: 'The link stops working after the trip completes, and can be revoked at any time.' },
    { title: 'Weather at both ends', body: 'Departure and arrival conditions with a flight category, so a delay explains itself.' },
    { title: 'Works on their phone', body: 'The same page on a handset, which is where a broker usually opens it.' },
  ],
});

/* ═══════════════════ 13. Company email ═══════════════════ */
desktopPage({
  kicker: 'Email',
  title: 'Company mail where the trip is',
  subtitle: 'Personal and shared mailboxes over Microsoft 365, signed in with the same Microsoft account. Trip correspondence stays with the trip rather than in one person\'s inbox.',
  image: 'email-open.png',
  imageH: 306,
  points: [
    { title: 'Personal and shared', body: 'A pilot\'s own mail and the shared operations inbox, side by side.' },
    { title: 'Sign in with Microsoft', body: 'No mailbox credentials to distribute or maintain per user.' },
    { title: 'Reply from the trip', body: 'Broker correspondence is answered in context, attachments included.' },
    { title: 'Contacts autocomplete', body: 'Recipients resolve from the company directory as you type.' },
  ],
});

/* ═══════════════════ 14. Microsoft Teams ═══════════════════ */
desktopPage({
  kicker: 'Teams',
  title: 'Teams, without leaving the operation',
  subtitle: 'Channels, chats and files rendered in the platform, so the conversation about a trip happens next to the trip instead of in another window.',
  image: 'teams-channel.png',
  imageH: 306,
  points: [
    { title: 'Real channels and chats', body: 'The company\'s existing Teams, with the same messages and threads.' },
    { title: 'Files open in place', body: 'Documents shared in a channel open without switching applications.' },
    { title: 'One identity', body: 'The same Microsoft sign-in that provides mail and directory access.' },
    { title: 'Crew messaging too', body: 'Direct and group messaging inside the platform for crews who are not on Teams.' },
  ],
});

/* ═══════════════════ 15. Accounting ═══════════════════ */
desktopPage({
  kicker: 'Accounting',
  title: 'Invoices and receivables against QuickBooks',
  subtitle: 'Connected directly to the production QuickBooks Online company file. Trips become invoices, payments and ageing are visible to operations without a second system.',
  image: 'accounting-all.png',
  imageH: 262,
  points: [
    { title: 'The real company file', body: 'A direct connection to QuickBooks Online — not an export, and not a sandbox.' },
    { title: 'Trip to invoice', body: 'Completed trips carry their charges into an invoice with the customer already set.' },
    { title: 'Receivables in view', body: 'Outstanding balances and ageing sit alongside the operation that created them.' },
    { title: 'Accounts stay mapped', body: 'Expense categories map once to QuickBooks accounts and hold for every posting.' },
  ],
});

/* ═══════════════════ 16. Closing ═══════════════════ */
page();
heading('In short', 'One platform instead of six',
  'Most Part 135 operators run a scheduler, a tracking site, a duty spreadsheet, a shared mailbox, a chat tool and an accounting package that never speak to each other. This is those jobs on one record.');

const replaces = [
  ['Tracking site open all day', 'The whole fleet on the dashboard, airborne and on the ground'],
  ['Duty times in a spreadsheet', 'A live 14-hour clock per crew, with an exportable compliance record'],
  ['Status phoned in by the crew', 'One tap per milestone, timestamped and attributed'],
  ['Brokers calling for updates', 'A live link that expires on its own'],
  ['Receipts in an envelope', 'Expenses captured against the leg and posted to QuickBooks'],
  ['Trip email in one inbox', 'Personal and shared Microsoft 365 mail beside the trip'],
];

let ry = 142;
for (const [before, after] of replaces) {
  doc.roundedRect(M, ry, W - M * 2, 44, 6).fill(INK.panel);
  doc.font(BODY).fontSize(9).fillColor(INK.subtle)
    .text(before, M + 16, ry + 16, { width: 268 });
  // Drawn rather than set: an arrow glyph is outside the base font's encoding.
  const ax = M + 296;
  const ay = ry + 22;
  doc.moveTo(ax, ay).lineTo(ax + 13, ay).lineWidth(1.1).strokeColor(INK.accent).stroke();
  doc.moveTo(ax + 12, ay - 3.4).lineTo(ax + 18, ay).lineTo(ax + 12, ay + 3.4).fill(INK.accent);
  doc.font(BOLD).fontSize(9.2).fillColor(INK.text)
    .text(after, M + 322, ry + 16, { width: W - M * 2 - 340 });
  ry += 52;
}

doc.roundedRect(M, ry + 10, W - M * 2, 74, 8).fill(INK.panel);
doc.rect(M, ry + 10, 3, 74).fill(INK.accent);
doc.font(BOLD).fontSize(10.5).fillColor(INK.text)
  .text('What it runs on', M + 20, ry + 24);
doc.font(BODY).fontSize(8.8).fillColor(INK.muted).text(
  'Firebase and Vercel, with Microsoft Entra single sign-on for mail, Teams and the '
  + 'directory; FlightAware AeroAPI for positions; QuickBooks Online for accounting. '
  + 'Installs to a phone home screen as a progressive web app, so there is no app store '
  + 'release to wait on and no separate build to distribute to crews.',
  M + 20, ry + 40, { width: W - M * 2 - 40, lineGap: 1.5 },
);

footer('Skyway Aviation · flyskyway.com · All aircraft, crew, brokers, passengers and figures shown in this booklet are fictitious.');

doc.end();

console.log(`Wrote ${path.relative(root, outPath)} (${pageNo} pages)`);
if (missing.length) {
  console.log('\nCaptures still pending (drawn as placeholders):');
  for (const name of missing) console.log(`  ${name}`);
}
