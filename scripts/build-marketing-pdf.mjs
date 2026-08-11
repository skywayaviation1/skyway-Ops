// Builds the Skyway Ops marketing PDF from the prepared preview captures.
//
//   node scripts/prepare-marketing-shots.mjs   # crop raw browser captures
//   node scripts/build-marketing-pdf.mjs       # -> marketing/Skyway-Ops-Overview.pdf
//
// Every screenshot is a real render of the shipping components (see
// vite.preview.config.js), populated with a sample operating day rather than
// live customer data. That is stated on each screenshot page so the document
// never implies the numbers are a real operation.

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'marketing/shots');
const outPath = path.join(root, 'marketing/Skyway-Ops-Overview.pdf');
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

const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 0, info: {
  Title: 'Skyway Ops — Part 135 Charter Operations Platform',
  Author: 'Skyway Aviation',
  Subject: 'Product overview',
} });
doc.pipe(createWriteStream(outPath));

const BOLD = 'Helvetica-Bold';
const BODY = 'Helvetica';

function page({ first = false } = {}) {
  if (!first) doc.addPage({ size: 'LETTER', layout: 'landscape', margin: 0 });
  doc.rect(0, 0, W, H).fill(INK.bg);
}

function logo(x, y, width) {
  const file = path.join(root, 'public/skyway-logo-reverse.png');
  if (existsSync(file)) doc.image(file, x, y, { width });
}

function footer(text) {
  doc.font(BODY).fontSize(7.5).fillColor(INK.subtle)
    .text(text, M, H - 34, { width: W - M * 2 });
}

function pageNumber(n) {
  doc.font(BODY).fontSize(7.5).fillColor(INK.subtle)
    .text(String(n), W - M - 20, H - 34, { width: 20, align: 'right' });
}

/** Heading block shared by every interior page. */
function heading(kicker, title, subtitle) {
  doc.font(BOLD).fontSize(8).fillColor(INK.accent)
    .text(kicker.toUpperCase(), M, 44, { characterSpacing: 1.2 });
  doc.font(BOLD).fontSize(21).fillColor(INK.text).text(title, M, 60);
  if (subtitle) {
    doc.font(BODY).fontSize(10.5).fillColor(INK.muted)
      .text(subtitle, M, 90, { width: W - M * 2 });
  }
}

/** Fit an image inside a box and return the drawn rectangle. */
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

function bullets(items, { x, y, width, gap = 14 }) {
  let cursor = y;
  for (const item of items) {
    doc.circle(x + 2.5, cursor + 4.5, 2.5).fill(INK.accent);
    doc.font(BOLD).fontSize(9).fillColor(INK.text)
      .text(item.title, x + 12, cursor, { width: width - 12 });
    if (item.body) {
      doc.font(BODY).fontSize(8.5).fillColor(INK.muted)
        .text(item.body, x + 12, doc.y + 1.5, { width: width - 12, lineGap: 1 });
    }
    cursor = doc.y + gap;
  }
  return cursor;
}

const SAMPLE_NOTE = 'Genuine interface render from the shipping application. Aircraft, crew, brokers and figures are sample data.';

/**
 * A screenshot page. Layout follows the capture's shape so dense screens stay
 * legible: wide-and-short captures run the full page width with callouts in a
 * row beneath, taller captures sit beside a callout column.
 */
function surfacePage({ kicker, title, subtitle, image, points, note, n }) {
  page();
  heading(kicker, title, subtitle);

  const file = path.join(shots, image);
  const { width: iw, height: ih } = doc.openImage(file);
  const wide = ih / iw < 0.62;

  if (wide) {
    const rect = fitted(file, { x: M, y: 118, w: W - M * 2, h: 356 }, { align: 'top' });
    const colW = (W - M * 2 - 3 * 18) / 4;
    points.slice(0, 4).forEach((point, i) => {
      bullets([point], { x: M + i * (colW + 18), y: rect.y + rect.h + 26, width: colW });
    });
  } else {
    const colW = 232;
    const rect = fitted(file, { x: M, y: 118, w: W - M * 2 - colW - 26, h: 432 });
    bullets(points, { x: W - M - colW, y: rect.y, width: colW });
  }

  footer(note || SAMPLE_NOTE);
  pageNumber(n);
}

/* ─────────────────────────── 1. Cover ─────────────────────────── */
page({ first: true });
doc.rect(0, 0, 6, H).fill(INK.accent);
logo(M, 92, 250);

doc.font(BOLD).fontSize(34).fillColor(INK.text)
  .text('Run the whole operation', M, 212, { width: 520 });
doc.font(BOLD).fontSize(34).fillColor(INK.accent)
  .text('in one place.', M, 250, { width: 520 });

doc.font(BODY).fontSize(12).fillColor(INK.muted).text(
  'Skyway Ops is the Part 135 charter operations platform built around a single '
  + 'operating day: live fleet tracking, dispatch, crew duty and rest, passenger '
  + 'manifests, maintenance, company email and Microsoft Teams, and QuickBooks '
  + 'accounting — for the whole team, on any device.',
  M, 306, { width: 500, lineGap: 3.5 },
);

const stats = [
  ['Fleet', 'Every aircraft, always located'],
  ['Duty', '14-hour clock, live'],
  ['Money', 'Invoices in QuickBooks'],
];
let sx = M;
for (const [big, small] of stats) {
  doc.roundedRect(sx, 428, 150, 62, 8).lineWidth(0.75).strokeColor(INK.edge).stroke();
  doc.font(BOLD).fontSize(11).fillColor(INK.accent).text(big, sx + 14, 444);
  doc.font(BODY).fontSize(8.5).fillColor(INK.muted).text(small, sx + 14, 460, { width: 124 });
  sx += 164;
}

doc.font(BODY).fontSize(8).fillColor(INK.subtle)
  .text('Product overview · Skyway Aviation · flyskyway.com', M, H - 52);

/* ───────────────────── 2. How it works ───────────────────── */
page();
heading('How it works', 'One operating day, one system of record',
  'The schedule drives everything. Each step below writes to the same trip record, so dispatch, crew, brokers and accounting are never looking at different versions of the day.');

const flow = [
  ['1', 'Schedule arrives', 'Trips import from your scheduling feed. Aircraft, route, crew and passengers land on one trip record.'],
  ['2', 'Dispatch readies the leg', 'Trip sheet, FBOs, catering and passenger manifest are completed and checked against a readiness list.'],
  ['3', 'Crew works the trip', 'Pilots go on duty, scan passenger IDs, and tap each milestone from crew on-site through landed.'],
  ['4', 'Everyone sees it live', 'FlightAware positions and status steps update the fleet map, the flight board and the broker tracking link at the same time.'],
  ['5', 'The day settles', 'Duty and flight time are recorded for compliance, expenses match to card charges, and invoices post to QuickBooks.'],
];

let fy = 140;
for (const [num, title, body] of flow) {
  doc.roundedRect(M, fy, W - M * 2, 62, 8).fill(INK.panel);
  doc.circle(M + 30, fy + 31, 15).fill(INK.accent);
  doc.font(BOLD).fontSize(13).fillColor(INK.bg).text(num, M + 25, fy + 24, { width: 12, align: 'center' });
  doc.font(BOLD).fontSize(11.5).fillColor(INK.text).text(title, M + 58, fy + 16);
  doc.font(BODY).fontSize(9).fillColor(INK.muted).text(body, M + 58, fy + 33, { width: W - M * 2 - 80 });
  fy += 70;
}

footer('Roles decide what each person sees: crew get their trips and duty; dispatch gets the fleet; administrators get everything.');
pageNumber(2);

/* ─────────────── 3. Live fleet tracking ─────────────── */
surfacePage({
  n: 3,
  kicker: 'Live fleet tracking',
  title: 'Every aircraft, always on the map',
  subtitle: 'Airborne aircraft show live position, altitude and speed. Aircraft on the ground show where they actually are — so the fleet is never partly invisible.',
  image: 'fleet-map.png',
  points: [
    { title: 'Airborne from ADS-B', body: 'Live FlightAware position, altitude, ground speed and progress, refreshed continuously.' },
    { title: 'On the ground, still shown', body: 'Parked aircraft sit at their last landing airport. If the position feed gaps, the last known point is kept rather than dropping the aircraft off the map.' },
    { title: 'Whole managed fleet', body: 'Tracking follows the fleet you configure in Settings. Add a tail and it appears — no deployment needed.' },
    { title: 'One shared feed', body: 'Positions are polled once for the company rather than once per browser, so tracking cost stays flat as the team grows.' },
  ],
});

/* ─────────── 4. Today's flight board ─────────── */
surfacePage({
  n: 4,
  kicker: 'Dispatch',
  title: "Today's flights, and what actually happened",
  subtitle: 'The whole day in departure order, with live status and scheduled block time compared against real airborne time.',
  image: 'flight-board.png',
  points: [
    { title: 'Status that reflects reality', body: 'Complete, airborne, preflight, delayed or scheduled — derived from crew milestones and live aircraft position together, not from the calendar alone.' },
    { title: 'Scheduled versus actual', body: 'Each leg shows planned block time next to actual airborne time from FlightAware, so padding and schedule creep become visible.' },
    { title: 'Crew on every leg', body: 'PIC and SIC are shown inline, and a leg with no assigned captain is raised as an exception before it becomes a problem.' },
    { title: 'One tap to the trip', body: 'Selecting a row opens the full trip: manifest, trip sheet, FBOs, filed email and status history.' },
  ],
});

/* ─────────── 5. Pilots currently on duty ─────────── */
surfacePage({
  n: 5,
  kicker: 'Crew duty & rest',
  title: 'Who is on duty, and how much clock is left',
  subtitle: 'Part 135 duty tracking sits next to the flight board, so the question "can this crew take the leg" is answered without opening anything.',
  image: 'on-duty.png',
  points: [
    { title: '14-hour duty clock', body: 'Every pilot on duty shows when they went on duty and the time remaining, turning amber as the limit approaches and red once exceeded.' },
    { title: 'Assigned aircraft recorded', body: 'The tail a pilot is flying is captured on the duty record automatically at duty-on and kept for the whole period.' },
    { title: 'Scheduled versus flown', body: 'Planned flight time is compared with actual airborne time, so a duty day that is running long is obvious early.' },
    { title: 'Built for the audit', body: 'Duty, rest, flight time, overrides and who changed what are all retained and exportable for the FAA.' },
  ],
});

/* ─────────────────── 6. Email ─────────────────── */
surfacePage({
  n: 6,
  kicker: 'Company email',
  title: 'The charter inbox, inside the operation',
  subtitle: 'Your Microsoft 365 mail — the shared charter inbox and each employee\'s own mailbox — without leaving the app or losing the trip context.',
  image: 'email-open.png',
  points: [
    { title: 'Shared and personal', body: 'One shared charters@ inbox for the sales desk, plus each employee\'s own work mailbox. Sign in once with Microsoft.' },
    { title: 'File mail to the trip', body: 'Attach a message to a trip and the whole conversation follows it, so the next person sees the history.' },
    { title: 'Full Outlook actions', body: 'Reply, reply-all, forward with attachments, Cc and Bcc, folders, search, flags and recipient autocomplete.' },
    { title: 'Mail stays in Microsoft', body: 'Nothing is copied into a second mail store. Skyway reads and sends through Microsoft Graph as you.' },
  ],
});

/* ─────────────────── 7. Teams ─────────────────── */
surfacePage({
  n: 7,
  kicker: 'Microsoft Teams',
  title: 'Dispatch conversations where the work is',
  subtitle: 'Teams channels, threaded replies and chats alongside the flight they are about — with channel files opening in Microsoft 365.',
  image: 'teams-channel.png',
  points: [
    { title: 'Channels and chats', body: 'The teams and chats you already use, read and answered from inside the operations app.' },
    { title: 'Threaded replies', body: 'Reply in-thread on a channel post so a dispatch decision keeps its context.' },
    { title: 'Channel files', body: 'Browse channel files and open them in the real Microsoft 365 editor, with coauthoring and version history intact.' },
    { title: 'Acts as the signed-in user', body: 'Delegated access only: each person sees exactly the conversations they can already see in Teams.' },
  ],
});

/* ───────────────── 8. Accounting ───────────────── */
surfacePage({
  n: 8,
  kicker: 'Accounting',
  title: 'Invoices and receivables against live books',
  subtitle: 'A/R aging, invoicing, payments and customers driven directly by the connected QuickBooks Online company.',
  image: 'accounting-all.png',
  points: [
    { title: 'Real A/R aging', body: 'Current through 90-plus days late, computed from the invoices actually in QuickBooks.' },
    { title: 'Invoice and collect', body: 'Create an invoice from your products and services, email it through QuickBooks, and record the payment to a deposit account.' },
    { title: 'Expenses that reconcile', body: 'Crew receipts match to posted company-card charges; personal spend becomes a reimbursable bill.' },
    { title: 'No second ledger', body: 'Everything posts through the QuickBooks API to the live company file, with normal audit history.' },
  ],
});

/* ─────────── 9. Platform and security ─────────── */
page();
heading('Platform', 'Built for a company that has to prove things',
  'Charter operations carry compliance and privacy obligations. The platform is designed around who may see what, and around leaving the record intact.');

const cards = [
  ['Microsoft sign-in only', 'Access requires a company Microsoft account. A new identity gets no access until an administrator approves it.'],
  ['Roles, not honour system', 'Crew, dispatch, maintenance, accounting and administrators each see their own scope, enforced on the server as well as the screen.'],
  ['Passenger data handled carefully', 'Broker tracking links are token-gated and time-limited, and never expose passenger names, pricing or crew contact details.'],
  ['Duty and rest on the record', 'Part 135 duty periods, rest, flight time and overrides are captured with an audit trail and exportable for the FAA.'],
  ['Works on the ramp', 'Installs on an iPhone as an app, survives poor signal, and keeps working when a service it depends on is briefly unavailable.'],
  ['Your systems stay yours', 'Mail and Teams remain in Microsoft 365 and the books remain in QuickBooks. Skyway connects to them; it does not replace them.'],
];

let cx = M;
let cy = 132;
const cardW = (W - M * 2 - 24) / 2;
cards.forEach(([title, body], i) => {
  doc.roundedRect(cx, cy, cardW, 96, 8).fill(INK.panel);
  doc.rect(cx, cy, 3, 96).fill(INK.accent);
  doc.font(BOLD).fontSize(11).fillColor(INK.text).text(title, cx + 18, cy + 18, { width: cardW - 34 });
  doc.font(BODY).fontSize(9).fillColor(INK.muted).text(body, cx + 18, cy + 38, { width: cardW - 34, lineGap: 1.5 });
  if (i % 2 === 0) {
    cx += cardW + 24;
  } else {
    cx = M;
    cy += 108;
  }
});

footer('Skyway Ops is an internal operations platform for Skyway Aviation personnel and its approved partners.');
pageNumber(9);

/* ───────────────────── 10. Close ───────────────────── */
page();
doc.rect(0, 0, 6, H).fill(INK.accent);
logo(M, 84, 210);
doc.font(BOLD).fontSize(26).fillColor(INK.text)
  .text('One operation. One workspace.', M, 190, { width: 560 });
doc.font(BODY).fontSize(11).fillColor(INK.muted).text(
  'Every screen in this document is the working product, rendered from the shipping '
  + 'application against a sample operating day. Aircraft registrations, crew names, '
  + 'brokers, passengers and dollar figures are invented for illustration.',
  M, 236, { width: 520, lineGap: 3 },
);

const closing = [
  'Live fleet tracking with ground positions',
  'Dispatch readiness and today\'s flight board',
  'Part 135 duty, rest and flight-time records',
  'Passenger manifests and ID check-in',
  'Maintenance squawks, MEL and AOG recovery',
  'Microsoft 365 email and Teams',
  'QuickBooks invoicing and expense matching',
  'Broker-facing live tracking links',
];
let ly = 320;
closing.forEach((item, i) => {
  const col = i % 2;
  const x = M + col * 340;
  if (col === 0 && i > 0) ly += 22;
  doc.circle(x + 3, ly + 4.5, 2.5).fill(INK.accent);
  doc.font(BODY).fontSize(9.5).fillColor(INK.text).text(item, x + 13, ly, { width: 310 });
});

doc.font(BODY).fontSize(9).fillColor(INK.subtle)
  .text('Skyway Aviation · flyskyway.com · Private jet and helicopter charter services', M, H - 56);

doc.end();
console.log(`wrote ${path.relative(root, outPath)}`);
