// Routes the app's own /api calls to sample payloads shaped exactly like the
// server responses, so the real mail, Teams and accounting components render
// their genuine loaded state.

import {
  BASE, CHARTER_INBOX, COMPANY, COMPANY_LEGAL, DOMAIN, SCHEDULE, TENANT,
  brokerEmailFor, emailFor, tripStates,
} from './sample-data.js';

const T = TENANT;

/** Field coordinates for the routes the broker payload draws. */
const AIRPORT_COORDS = {
  ACK: [41.2531, -70.0602], APF: [26.1526, -81.7753], AUS: [30.1975, -97.6664],
  BNA: [36.1245, -86.6782], CHS: [32.8986, -80.0405], DFW: [32.8998, -97.0403],
  FLL: [26.0726, -80.1527], FXE: [26.1973, -80.1707], HYA: [41.6693, -70.2804],
  IAD: [38.9531, -77.4565], MCO: [28.4312, -81.3081], MDW: [41.7868, -87.7522],
  OPF: [25.9070, -80.2784], PBI: [26.6832, -80.0956], RSW: [26.5362, -81.7552],
  SRQ: [27.3954, -82.5544], TEB: [40.8501, -74.0608], TVC: [44.7414, -85.5822],
};

const AIRCRAFT_TYPE = Object.fromEntries(TENANT.fleet.map((a) => [a.tail, a.displayName]));
const CREW = T.crew;
const STAFF = T.staff;
const ADMIN = STAFF[0];

// The legs the sample day gives a role to, mirrored from sample-data so the
// mail, chat and broker payloads talk about the same flights the app shows.
const LEAD = SCHEDULE[1];        // airborne now
const EARLIER = SCHEDULE[0];     // already flown
const NEXT_LEG = SCHEDULE[4];    // later leg, same tail as LEAD
const QUOTE_LEG = SCHEDULE[6];   // an inbound quote request

/** A broker-side contact at one of the tenant's customers. */
const brokerContact = (customer, person) => ({
  name: person,
  address: `${person.split(' ')[0].toLowerCase()}@${
    customer.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 18)}.com`,
});

const HOUR = 3600_000;
const MIN = 60_000;
const now = () => Date.now();

const iso = (msAgo) => new Date(now() - msAgo).toISOString();

function message({ id, name, address, subject, preview, msAgo, isRead = true, attachments = false, importance = 'normal', body }) {
  return {
    id,
    conversationId: `conv-${id}`,
    internetMessageId: `<${id}@${DOMAIN}>`,
    subject,
    from: { name, address },
    sender: { name, address },
    to: [{ name: 'Charter Sales', address: CHARTER_INBOX }],
    cc: [],
    bcc: [],
    receivedAt: iso(msAgo),
    sentAt: iso(msAgo),
    createdAt: iso(msAgo),
    modifiedAt: iso(msAgo),
    preview,
    isRead,
    isDraft: false,
    hasAttachments: attachments,
    importance,
    flag: 'notFlagged',
    parentFolderId: 'inbox',
    webLink: 'https://outlook.office.com/mail/',
    ...(body ? {
      body: { type: 'html', content: body },
      uniqueBody: { type: 'html', content: body },
      attachments: attachments ? [{
        id: 'att-1', name: 'trip-itinerary.pdf', contentType: 'application/pdf',
        size: 184_320, isInline: false, contentId: null, type: '#microsoft.graph.fileAttachment',
      }] : [],
    } : {}),
  };
}

const BROKER_A = brokerContact(LEAD.customer, 'Whitney Larsen');
const BROKER_B = brokerContact(EARLIER.customer, 'Desmond Achebe');
const BROKER_C = brokerContact(QUOTE_LEG.customer, 'Talia Brandt');

const SHARED_MESSAGES = [
  message({
    id: 'm1', name: BROKER_B.name, address: BROKER_B.address,
    subject: `Re: ${EARLIER.from} - ${EARLIER.to} - ${EARLIER.pax} pax, catering requested`,
    preview: `Confirmed on the ${EARLIER.pax} pax and the crew car. Client asked for a fruit and cheese tray plus two vegetarian entrees.`,
    msAgo: 22 * MIN, isRead: false, attachments: true,
    body: `<p>Team,</p><p>Confirmed on the ${EARLIER.pax} pax and the crew car at ${EARLIER.to}. Client asked for a fruit and cheese tray plus two vegetarian entrees.</p><p>Quote attached &mdash; please confirm the tail assignment when you have it.</p><p>${BROKER_B.name}<br>VP, Charter Sales<br>${EARLIER.customer}</p>`,
  }),
  message({
    id: 'm2', name: BROKER_A.name, address: BROKER_A.address,
    subject: `Aircraft Ready for Passengers - ${LEAD.tail} ${LEAD.from}-${LEAD.to}`,
    preview: 'The aircraft is now ready for your passengers. We will advise once they have checked in.',
    msAgo: 55 * MIN, isRead: false,
  }),
  message({
    id: 'm3', name: BROKER_C.name, address: BROKER_C.address,
    subject: 'Trip sheet + passenger manifest for tomorrow',
    preview: 'Attaching the signed trip sheet and manifest. Two passengers are new - IDs will be scanned at the FBO.',
    msAgo: 3 * HOUR, attachments: true,
  }),
  message({
    id: 'm4', name: 'Treasury Alerts', address: 'alerts@digital-treasury.example.com',
    subject: 'Wire Payment Confirmed Alert',
    preview: 'A wire transfer of $48,250.00 has been confirmed for charter invoice 1042.',
    msAgo: 5 * HOUR,
  }),
  message({
    id: 'm5', name: QUOTE_LEG.customer, address: `trips@${QUOTE_LEG.customer.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 18)}.com`,
    subject: `${QUOTE_LEG.from} - ${QUOTE_LEG.to} quote request, ${QUOTE_LEG.pax} pax, Thursday`,
    preview: `Looking for a midsize, ${QUOTE_LEG.pax} passengers, departing ${QUOTE_LEG.from} around 14:00 Thursday returning Sunday evening.`,
    msAgo: 7 * HOUR,
  }),
];

const PERSONAL_MESSAGES = [
  message({
    id: 'p1', name: STAFF[1].name, address: emailFor(STAFF[1]),
    subject: 'Duty coverage for Thursday overnight',
    preview: `${CREW[3].first} is at 12:24 on the duty clock. I can cover the ${SCHEDULE[3].to} turn if you want to release them early.`,
    msAgo: 12 * MIN, isRead: false,
  }),
  message({
    id: 'p2', name: 'Microsoft Teams', address: 'noreply@email.teams.microsoft.com',
    subject: 'Missed activity in Dispatch',
    preview: `3 new messages in Dispatch - ${EARLIER.tail} repositioning confirmed for 06:00.`,
    msAgo: 48 * MIN, isRead: false,
  }),
  message({
    id: 'p3', name: 'Intuit QuickBooks', address: 'quickbooks@notification.intuit.com',
    subject: 'Invoice 1042 was paid',
    preview: `${LEAD.customer} paid invoice 1042 for $48,250.00.`,
    msAgo: 4 * HOUR,
  }),
  message({
    id: 'p4', name: STAFF[2].name, address: emailFor(STAFF[2]),
    subject: `Expense receipts uploaded for ${SCHEDULE[5].tail}`,
    preview: `Fuel and catering receipts uploaded for the ${SCHEDULE[5].to} turn. Company card, ready for matching.`,
    msAgo: 9 * HOUR,
  }),
];

const FOLDERS = [
  { id: 'inbox', name: 'Inbox', parentFolderId: null, childCount: 0, total: 128, unread: 2, hidden: false, children: [] },
  { id: 'trips', name: 'Trips', parentFolderId: null, childCount: 2, total: 402, unread: 0, hidden: false, children: [
    { id: 'trips-quotes', name: 'Quotes', parentFolderId: 'trips', childCount: 0, total: 96, unread: 0, hidden: false, children: [] },
    { id: 'trips-confirmed', name: 'Confirmed', parentFolderId: 'trips', childCount: 0, total: 141, unread: 0, hidden: false, children: [] },
  ] },
  { id: 'brokers', name: 'Brokers', parentFolderId: null, childCount: 0, total: 210, unread: 0, hidden: false, children: [] },
  { id: 'sentitems', name: 'Sent Items', parentFolderId: null, childCount: 0, total: 512, unread: 0, hidden: false, children: [] },
  { id: 'deleteditems', name: 'Deleted Items', parentFolderId: null, childCount: 0, total: 74, unread: 0, hidden: false, children: [] },
];

const CONTACTS = [
  BROKER_A, BROKER_B, BROKER_C,
  { name: STAFF[1].name, address: emailFor(STAFF[1]) },
  { name: CREW[0].name, address: emailFor(CREW[0]) },
];

/* ── Teams ─────────────────────────────────────────────────────────────── */

function teamsMessage({ id, name, msAgo, html, replies = [] }) {
  return {
    id,
    createdAt: iso(msAgo),
    editedAt: null,
    deleted: false,
    subject: '',
    importance: 'normal',
    from: { id: `u-${id}`, name },
    body: { type: 'html', content: html },
    preview: html.replace(/<[^>]*>/g, ' ').trim(),
    attachments: [],
    replyCount: replies.length,
    replies,
    webUrl: 'https://teams.microsoft.com/l/message/',
  };
}

const CHANNEL_MESSAGES = [
  teamsMessage({
    id: 't1', name: STAFF[1].name, msAgo: 3 * HOUR,
    html: `<p>${EARLIER.tail} is on the ground at ${EARLIER.to}, block in 09:14. Crew released, aircraft is clean for the 06:00 repo tomorrow.</p>`,
  }),
  teamsMessage({
    id: 't2', name: LEAD.pic, msAgo: 96 * MIN,
    html: `<p>Wheels up ${LEAD.from}&ndash;${LEAD.to} at 12:41. Smooth ride at FL410, ETA 14:07 local.</p>`,
    replies: [
      teamsMessage({ id: 't2r1', name: STAFF[1].name, msAgo: 92 * MIN, html: '<p>Copy &mdash; broker notified, handler is standing by at the FBO.</p>' }),
      teamsMessage({ id: 't2r2', name: STAFF[2].name, msAgo: 80 * MIN, html: '<p>Catering credit posted to the trip, receipts attached in Expenses.</p>' }),
    ],
  }),
  teamsMessage({
    id: 't3', name: STAFF[3].name, msAgo: 40 * MIN,
    html: `<p>Heads up: ${T.fleet[5].tail} left main tire is approaching limits. Squawk open, MEL 49-40-01 still deferred until Friday.</p>`,
  }),
  teamsMessage({
    id: 't4', name: SCHEDULE[2].pic, msAgo: 18 * MIN,
    html: `<p>${SCHEDULE[2].from}&ndash;${SCHEDULE[2].to} airborne, 39,000 ft. ${SCHEDULE[2].pax} passengers, catering aboard, no delays.</p>`,
  }),
];

/* ── QuickBooks ────────────────────────────────────────────────────────── */

const today = () => new Date().toISOString().slice(0, 10);
const dayOffset = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function invoice({ id, docNumber, customerId, customerName, date, dueDate, total, balance, email, status }) {
  return {
    id, docNumber, customerId, customerName, date, dueDate, total, balance,
    email, emailStatus: balance > 0 ? 'NeedToSend' : 'Sent', privateNote: '',
    lines: [{
      description: 'Charter flight services', amount: total, quantity: 1,
      unitPrice: total, itemId: '3', itemName: 'Charter',
    }],
    status,
  };
}

const apAddress = (customer) => `ap@${customer.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 18)}.com`;

const C = T.customers;

const INVOICES = [
  invoice({ id: '1044', docNumber: '1044', customerId: '7', customerName: C[0], date: today(), dueDate: dayOffset(30), total: 52_400, balance: 52_400, email: apAddress(C[0]), status: 'open' }),
  invoice({ id: '1043', docNumber: '1043', customerId: '9', customerName: C[1], date: dayOffset(-6), dueDate: dayOffset(24), total: 38_950, balance: 38_950, email: apAddress(C[1]), status: 'open' }),
  invoice({ id: '1041', docNumber: '1041', customerId: '11', customerName: C[2], date: dayOffset(-38), dueDate: dayOffset(-8), total: 27_600, balance: 27_600, email: apAddress(C[2]), status: 'overdue' }),
  invoice({ id: '1039', docNumber: '1039', customerId: '14', customerName: C[5], date: dayOffset(-71), dueDate: dayOffset(-41), total: 15_250, balance: 15_250, email: apAddress(C[5]), status: 'overdue' }),
  invoice({ id: '1042', docNumber: '1042', customerId: '7', customerName: C[0], date: dayOffset(-14), dueDate: dayOffset(16), total: 48_250, balance: 0, email: apAddress(C[0]), status: 'paid' }),
  invoice({ id: '1040', docNumber: '1040', customerId: '12', customerName: C[3], date: dayOffset(-26), dueDate: dayOffset(4), total: 61_800, balance: 0, email: apAddress(C[3]), status: 'paid' }),
];

const CUSTOMERS = [
  { id: '7', name: C[0], companyName: `${C[0]} LLC`, email: apAddress(C[0]), phone: '(305) 555-0142', balance: 52_400, active: true },
  { id: '9', name: C[1], companyName: C[1], email: apAddress(C[1]), phone: '(954) 555-0188', balance: 38_950, active: true },
  { id: '11', name: C[2], companyName: C[2], email: apAddress(C[2]), phone: '(402) 555-0110', balance: 27_600, active: true },
  { id: '12', name: C[3], companyName: C[3], email: apAddress(C[3]), phone: '(212) 555-0164', balance: 0, active: true },
  { id: '14', name: C[5], companyName: C[5], email: apAddress(C[5]), phone: '(843) 555-0175', balance: 15_250, active: true },
];

const QBO_CONNECTION = {
  connected: true,
  realmId: '9341454801234567',
  companyName: COMPANY_LEGAL,
  environment: 'production',
  serverEnvironment: 'production',
  environmentMismatch: false,
  connectedByName: ADMIN.name,
  connectedAt: Date.now() - 40 * 86_400_000,
  refreshTokenExpiresAt: Date.now() + 80 * 86_400_000,
  expenseAccountMap: {},
  paymentAccountMap: {},
};

function aging(invoices) {
  const buckets = { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0 };
  const todayMs = new Date(today()).getTime();
  for (const inv of invoices) {
    if (inv.balance <= 0.005) continue;
    buckets.total += inv.balance;
    const due = new Date(`${inv.dueDate}T00:00:00`).getTime();
    const late = Math.floor((todayMs - due) / 86_400_000);
    if (late <= 0) buckets.current += inv.balance;
    else if (late <= 30) buckets.d1to30 += inv.balance;
    else if (late <= 60) buckets.d31to60 += inv.balance;
    else if (late <= 90) buckets.d61to90 += inv.balance;
    else buckets.d90plus += inv.balance;
  }
  return buckets;
}

/* ── Router ────────────────────────────────────────────────────────────── */

function mailResponse(action, personal) {
  const list = personal ? PERSONAL_MESSAGES : SHARED_MESSAGES;
  const mailbox = personal ? emailFor(ADMIN) : CHARTER_INBOX;
  switch (action) {
    case 'status':
      return {
        ok: true, connected: true, configured: true, mailbox,
        displayName: personal ? ADMIN.name : `${COMPANY} Charters`,
        teamsEnabled: true,
      };
    case 'folders': return { ok: true, folders: FOLDERS };
    case 'messages': return { ok: true, messages: list, next: null };
    case 'contacts': return { ok: true, contacts: CONTACTS };
    case 'message': {
      const full = list[0];
      return { ok: true, message: { ...full, body: full.body || { type: 'html', content: `<p>${full.preview}</p>` }, attachments: full.attachments || [], filing: null } };
    }
    default: return { ok: true };
  }
}

function teamsResponse(action) {
  switch (action) {
    case 'status':
      return { ok: true, configured: true, connected: true, teamsEnabled: true, account: emailFor(ADMIN), displayName: ADMIN.name };
    case 'overview':
      return {
        ok: true,
        teams: [
          { id: 'team-ops', name: `${COMPANY} Operations`, description: 'Fleet-wide coordination', webUrl: 'https://teams.microsoft.com/l/team/ops' },
          { id: 'team-sales', name: 'Charter Sales', description: 'Quotes and brokers', webUrl: 'https://teams.microsoft.com/l/team/sales' },
          { id: 'team-maint', name: 'Maintenance', description: 'Squawks and MEL', webUrl: 'https://teams.microsoft.com/l/team/maint' },
        ],
        chats: [
          { id: 'chat-1', topic: '', name: STAFF[1].name, chatType: 'oneOnOne', webUrl: '#', lastUpdatedAt: iso(9 * MIN), members: [STAFF[1].name] },
          { id: 'chat-2', topic: `${LEAD.tail} crew`, name: `${LEAD.tail} crew`, chatType: 'group', webUrl: '#', lastUpdatedAt: iso(48 * MIN), members: [LEAD.pic, LEAD.sic] },
          { id: 'chat-3', topic: '', name: STAFF[2].name, chatType: 'oneOnOne', webUrl: '#', lastUpdatedAt: iso(3 * HOUR), members: [STAFF[2].name] },
        ],
      };
    case 'channels':
      return {
        ok: true,
        channels: [
          { id: 'ch-general', name: 'General', description: 'Company-wide', webUrl: '#', membershipType: 'standard' },
          { id: 'ch-dispatch', name: 'Dispatch', description: 'Live movement', webUrl: 'https://teams.microsoft.com/l/channel/dispatch', membershipType: 'standard' },
          { id: 'ch-duty', name: 'Duty & Crewing', description: 'Duty coverage', webUrl: '#', membershipType: 'standard' },
          { id: 'ch-aog', name: 'AOG', description: 'Recovery', webUrl: '#', membershipType: 'private' },
        ],
      };
    case 'channelMessages': return { ok: true, messages: CHANNEL_MESSAGES };
    case 'chatMessages': return { ok: true, messages: CHANNEL_MESSAGES.slice(0, 2) };
    case 'channelFiles':
      return {
        ok: true, driveId: 'drive-1', folderId: 'folder-1',
        files: [
          { id: 'f1', driveId: 'drive-1', name: 'Daily Movement Board.xlsx', size: 48_120, isFolder: false, childCount: 0, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', webUrl: '#', modifiedAt: iso(2 * HOUR), modifiedBy: STAFF[1].name },
          { id: 'f2', driveId: 'drive-1', name: 'Trip Sheets', size: 0, isFolder: true, childCount: 14, mimeType: '', webUrl: '#', modifiedAt: iso(26 * HOUR), modifiedBy: STAFF[2].name },
          { id: 'f3', driveId: 'drive-1', name: `${LEAD.tail} Itinerary ${LEAD.from}-${LEAD.to}.pdf`, size: 184_320, isFolder: false, childCount: 0, mimeType: 'application/pdf', webUrl: '#', modifiedAt: iso(4 * HOUR), modifiedBy: SCHEDULE[2].pic },
        ],
      };
    default: return { ok: true };
  }
}

function quickbooksResponse(action) {
  switch (action) {
    case 'overview':
      return {
        ok: true, ...QBO_CONNECTION,
        invoices: INVOICES,
        customers: CUSTOMERS,
        items: [
          { id: '3', name: 'Charter', type: 'Service', unitPrice: 0, incomeAccountId: '80' },
          { id: '4', name: 'Fuel Surcharge', type: 'Service', unitPrice: 0, incomeAccountId: '80' },
          { id: '5', name: 'Catering', type: 'Service', unitPrice: 0, incomeAccountId: '81' },
        ],
        depositAccounts: [
          { id: '35', name: 'Truist Operating' },
          { id: '36', name: 'Truist Reserve' },
        ],
        aging: aging(INVOICES),
      };
    default: return { ok: true, ...QBO_CONNECTION };
  }
}

/* ── Broker-facing live tracking link ──────────────────────────────────── */

const brokerStep = (msAgo) => ({ at: now() - msAgo });

/** Surname-initial form, which is all the broker page is allowed to show. */
const brokerPax = (full, status, checkedInAt) => {
  const [first, ...rest] = full.split(' ');
  return { name: `${first[0]}. ${rest.join(' ')}`, status, checkedInAt, walkUp: false };
};

function brokerTrip() {
  const paxNames = T.passengers;
  return {
    tripId: LEAD.uid,
    tripCode: `${LEAD.tail.slice(-3)}-1042`,
    tail: LEAD.tail,
    aircraftType: AIRCRAFT_TYPE[LEAD.tail] || '',
    completed: false,
    completedAt: null,
    legs: [
      {
        legNumber: 1,
        from: LEAD.from, to: LEAD.to,
        fromFbo: 'Signature Flight Support', toFbo: 'Atlantic Aviation',
        departure: new Date(now() - 95 * MIN).toISOString(),
        arrival: new Date(now() + 26 * MIN).toISOString(),
        category: 'REVENUE',
        pic: LEAD.pic, sic: LEAD.sic,
        showPax: true,
        hasCatering: true,
        pax: paxNames.map((name, i) => brokerPax(name, 'checked_in', now() - (110 - i * 3) * MIN)),
        status: {
          crew_onsite: brokerStep(3 * HOUR),
          aircraft_ready: brokerStep(2.6 * HOUR),
          catering_aboard: brokerStep(2.4 * HOUR),
          pax_arrived: brokerStep(2.1 * HOUR),
          pax_boarded: brokerStep(1.8 * HOUR),
          taxi_dep: brokerStep(1.4 * HOUR),
          wheels_up: brokerStep(74 * MIN),
        },
      },
      {
        legNumber: 2,
        from: NEXT_LEG.from, to: NEXT_LEG.to,
        fromFbo: 'Atlantic Aviation', toFbo: 'Jet Aviation',
        departure: new Date(now() + 4 * HOUR).toISOString(),
        arrival: new Date(now() + 5.4 * HOUR).toISOString(),
        category: 'REVENUE',
        pic: NEXT_LEG.pic, sic: NEXT_LEG.sic,
        showPax: true,
        // Catering was never ordered for this leg, which is why the broker page
        // omits it rather than showing it as outstanding.
        hasCatering: false,
        pax: paxNames.slice(0, 2).map((name) => brokerPax(name, 'pending', null)),
        status: {},
      },
    ],
    statuses: {},
  };
}

function brokerPayload() {
  const from = AIRPORT_COORDS[LEAD.from];
  const to = AIRPORT_COORDS[LEAD.to];
  const progress = 0.74;
  const lat = from[0] + (to[0] - from[0]) * progress;
  const lon = from[1] + (to[1] - from[1]) * progress;

  // A track behind the aircraft, so the broker page shows where it has been.
  const trail = [0, 0.12, 0.26, 0.4, 0.54, 0.66, progress].map((t, i, all) => ({
    lat: from[0] + (to[0] - from[0]) * t,
    lon: from[1] + (to[1] - from[1]) * t,
    altitude_ft: t < 0.08 ? 1200 : t < 0.2 ? 18000 : 41000,
    groundspeed_kt: t < 0.08 ? 180 : t < 0.2 ? 320 : 452,
    time: now() - Math.round((1 - t / progress) * 74) * MIN,
  }));

  return {
    ok: true,
    trip: brokerTrip(),
    position: {
      ident: LEAD.tail, airborne: true,
      latitude: lat, longitude: lon,
      heading: 62, altitude: 41000, groundspeed: 452,
      origin: `K${LEAD.from}`, destination: `K${LEAD.to}`,
      originLat: from[0], originLon: from[1],
      destinationLat: to[0], destinationLon: to[1],
      actualOff: new Date(now() - 74 * MIN).toISOString(),
      estimatedOn: new Date(now() + 26 * MIN).toISOString(),
      progressPercent: Math.round(progress * 100),
    },
    trail,
    weather: {
      [`K${LEAD.from}`]: { metar: { raw: `K${LEAD.from} 181551Z 31012KT 10SM FEW250 24/09 A3011`, flightCategory: 'VFR' } },
      [`K${LEAD.to}`]: { metar: { raw: `K${LEAD.to} 181553Z 20008KT 10SM SCT035 22/14 A3009`, flightCategory: 'VFR' } },
    },
  };
}

/* ── Schedule feed ─────────────────────────────────────────────────────────
   The application ships a real JetInsight feed URL as its default. Left alone,
   the preview fetches it and live customer trips appear in captured imagery, so
   the harness serves a fictitious feed in JetInsight's own format, and refuses
   any request that would reach the live scheduler. */

export function sampleIcal() {
  const stamp = (hours) => new Date(BASE + hours * HOUR)
    .toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  let out = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OPS//PREVIEW//EN\r\n';
  for (const t of SCHEDULE) {
    out += 'BEGIN:VEVENT\r\n';
    out += `UID:${t.uid}\r\n`;
    out += `DTSTART:${stamp(t.startH)}\r\n`;
    out += `DTEND:${stamp(t.endH)}\r\n`;
    out += `SUMMARY:[${t.tail}] ${t.customer} (${t.from} - ${t.to}) - ${t.type}\r\n`;
    out += `DESCRIPTION:Pax: ${t.pax}\\nPIC: ${t.pic}\\nSIC: ${t.sic}\r\n`;
    out += `LOCATION:${t.from}\r\n`;
    out += 'END:VEVENT\r\n';
  }
  return `${out}END:VCALENDAR\r\n`;
}

const LIVE_SCHEDULE_HOSTS = /jetinsight\.com|corsproxy\.io|allorigins\.win|codetabs\.com/i;

export function installFetchStub() {
  const real = window.fetch ? window.fetch.bind(window) : null;

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const path = (() => {
      try { return new URL(url, window.location.origin).pathname; } catch { return String(url); }
    })();

    // The app's own proxy route carries the upstream feed URL in its query
    // string, so this is handled before the host block below — which matches on
    // hostname only, for the same reason.
    if (path === '/api/ical') {
      return new Response(sampleIcal(), {
        status: 200, headers: { 'Content-Type': 'text/calendar' },
      });
    }

    // Never let a capture reach the live scheduler or a public CORS proxy.
    if (LIVE_SCHEDULE_HOSTS.test(url.hostname)) {
      return new Response('blocked in preview', { status: 403 });
    }

    if (!path.startsWith('/api/')) {
      if (real) return real(input, init);
      throw new Error(`Preview fetch stub has no handler for ${path}`);
    }

    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    const action = body.action || 'status';

    const json = (payload) => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

    // Presence needs a real Stream project. Fail cleanly so the provider logs
    // once and the app renders without a live chat socket.
    if (path === '/api/stream-token') {
      return new Response(JSON.stringify({ error: 'Stream is not connected in preview' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/api/trip-public') return json(brokerPayload());
    if (path === '/api/user-mail') return json(mailResponse(action, true));
    if (path === '/api/charter-mail') return json(mailResponse(action, false));
    if (path === '/api/teams') return json(teamsResponse(action));
    if (path === '/api/quickbooks-workspace') return json(quickbooksResponse(action));
    if (path === '/api/quickbooks-status') return json(QBO_CONNECTION);
    if (path === '/api/fbo-call') {
      if (action === 'preview') {
        const purposes = Array.isArray(body.purposes) ? body.purposes : ['departure', 'arrival'];
        const trip = body.trip || {};
        const state = body.state || {};
        const results = purposes.map((purpose) => {
          const fboName = purpose === 'departure'
            ? state.fromFbo
            : state.toFbo;
          const airport = purpose === 'departure' ? trip.info?.from : trip.info?.to;
          const sheetPhone = purpose === 'departure'
            ? state.tripSheetData?.fromAirportPhone
            : state.tripSheetData?.toAirportPhone;
          const phoneDisplay = state.fboCallDialOverrides?.[purpose] || sheetPhone;
          const phoneE164 = phoneDisplay ? `+1${String(phoneDisplay).replace(/\D/g, '').replace(/^1/, '')}` : '';
          const blockers = [
            ...(!state.tripSheetUrl ? ['No trip sheet uploaded'] : []),
            ...(!fboName ? ['FBO name is missing from the trip sheet'] : []),
            ...(!phoneE164 ? ['No FBO phone number on the trip sheet'] : []),
          ];
          return {
            purpose,
            ok: blockers.length === 0,
            blockers,
            hash: `hash-${purpose}-${fboName}`,
            facts: {
              fboName,
              airport,
              phoneE164,
              phoneDisplay,
              phoneSource: state.fboCallDialOverrides?.[purpose] ? 'override' : 'trip_sheet',
              hours: '',
              hoursKnown: false,
              groundTransport: trip.info?.pax > 0,
              leadPassengerName: trip.info?.pax > 0 ? 'Alexander Whitmore' : null,
            },
          };
        });
        return json({
          ok: true,
          vendor: { ok: true, agent: 'preview' },
          config: { enabled: true },
          results,
        });
      }
      if (action === 'list') {
        return json({
          ok: true,
          vendor: { ok: true },
          calls: [
            {
              id: 'preview-active-call',
              tripId: body.tripId,
              purpose: 'departure',
              callPhase: 'initial',
              status: 'in_progress',
              fboName: 'Signature IAD',
              airport: 'IAD',
              phone: '301-555-0100',
              dialMode: 'immediate',
              dialAt: Date.now() - 60_000,
              listenAvailable: true,
            },
            {
              id: 'preview-follow-up',
              tripId: body.tripId,
              purpose: 'arrival',
              callPhase: 'arrival_reverification',
              status: 'scheduled',
              fboName: 'Atlantic HYA',
              airport: 'HYA',
              phone: '561-555-0199',
              dialMode: 'scheduled',
              dialAt: Date.now() + 90 * 60_000,
              listenAvailable: false,
            },
          ],
        });
      }
      if (action === 'arm') {
        return json({ ok: true, armed: (body.purposes || []).length });
      }
      if (action === 'dialNow') return json({ ok: true, result: { ok: true } });
      if (action === 'listen') {
        return new Response(JSON.stringify({ error: 'Live audio is unavailable in preview mode' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return json({ ok: true });
    }

    return json({ ok: true });
  };
}
