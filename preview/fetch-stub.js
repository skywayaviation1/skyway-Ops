// Routes the app's own /api calls to sample payloads shaped exactly like the
// server responses, so the real mail, Teams and accounting components render
// their genuine loaded state.

import { BASE, SCHEDULE } from './sample-data.js';

const HOUR = 3600_000;
const MIN = 60_000;
const now = () => Date.now();

const iso = (msAgo) => new Date(now() - msAgo).toISOString();

function message({ id, name, address, subject, preview, msAgo, isRead = true, attachments = false, importance = 'normal', body }) {
  return {
    id,
    conversationId: `conv-${id}`,
    internetMessageId: `<${id}@flyskyway.com>`,
    subject,
    from: { name, address },
    sender: { name, address },
    to: [{ name: 'Charter Sales', address: 'charters@flyskyway.com' }],
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

const SHARED_MESSAGES = [
  message({
    id: 'm1', name: 'Cade Kaftel', address: 'cade@monarchair.com',
    subject: 'Re: AVL – DFW on 08/12 – 4 pax, catering requested',
    preview: 'Confirmed on the 4 pax and the crew car. Client asked for a fruit and cheese tray plus two vegetarian entrees.',
    msAgo: 22 * MIN, isRead: false, attachments: true,
    body: '<p>Team,</p><p>Confirmed on the 4 pax and the crew car at DFW. Client asked for a fruit and cheese tray plus two vegetarian entrees.</p><p>Quote attached — please confirm the tail assignment when you have it.</p><p>Cade Kaftel<br>VP, Charter Sales<br>Monarch Air Group</p>',
  }),
  message({
    id: 'm2', name: 'Melissa Rippy', address: 'melissa@outlierjets.com',
    subject: 'Aircraft Ready for Passengers — N444AM IAD-HYA',
    preview: 'The aircraft is now ready for your passengers as of 12:24 PM EDT. We will advise once they have checked in.',
    msAgo: 55 * MIN, isRead: false,
  }),
  message({
    id: 'm3', name: 'Jenelle Szelest', address: 'jenelle@outlierjets.com',
    subject: 'Trip sheet + passenger manifest for tomorrow',
    preview: 'Attaching the signed trip sheet and manifest. Two passengers are new — IDs will be scanned at the FBO.',
    msAgo: 3 * HOUR, attachments: true,
  }),
  message({
    id: 'm4', name: 'Truist Treasury Alerts', address: 'alerts@digital-treasury.truist.com',
    subject: 'Wire Payment Confirmed Alert',
    preview: 'A wire transfer of $48,250.00 has been confirmed for charter invoice 1042.',
    msAgo: 5 * HOUR,
  }),
  message({
    id: 'm5', name: 'Victor US Flight Management', address: 'trips@victorusfm.com',
    subject: 'FXE – MDW quote request, 5 pax, Thursday',
    preview: 'Looking for a light jet, 5 passengers, departing FXE around 14:00 Thursday returning Sunday evening.',
    msAgo: 7 * HOUR,
  }),
];

const PERSONAL_MESSAGES = [
  message({
    id: 'p1', name: 'Jordan Vance', address: 'jordan@flyskyway.com',
    subject: 'Duty coverage for Thursday overnight',
    preview: 'Dana is at 12:24 on the duty clock. I can cover the TEB turn if you want to release her early.',
    msAgo: 12 * MIN, isRead: false,
  }),
  message({
    id: 'p2', name: 'Microsoft Teams', address: 'noreply@email.teams.microsoft.com',
    subject: 'Missed activity in Dispatch',
    preview: '3 new messages in Dispatch — N286N repositioning confirmed for 06:00.',
    msAgo: 48 * MIN, isRead: false,
  }),
  message({
    id: 'p3', name: 'Intuit QuickBooks', address: 'quickbooks@notification.intuit.com',
    subject: 'Invoice 1042 was paid',
    preview: 'Outlier Jets paid invoice 1042 for $48,250.00.',
    msAgo: 4 * HOUR,
  }),
  message({
    id: 'p4', name: 'Rosa Delgado', address: 'rosa@flyskyway.com',
    subject: 'Expense receipts uploaded for N551FP',
    preview: 'Fuel and catering receipts uploaded for the PBI turn. Company card, ready for matching.',
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
  { name: 'Cade Kaftel', address: 'cade@monarchair.com' },
  { name: 'Melissa Rippy', address: 'melissa@outlierjets.com' },
  { name: 'Jenelle Szelest', address: 'jenelle@outlierjets.com' },
  { name: 'Victor US Flight Management', address: 'trips@victorusfm.com' },
  { name: 'Jordan Vance', address: 'jordan@flyskyway.com' },
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
    id: 't1', name: 'Jordan Vance', msAgo: 3 * HOUR,
    html: '<p>N286N is on the ground at IAD, block in 09:14. Crew released, aircraft is clean for the 06:00 repo tomorrow.</p>',
  }),
  teamsMessage({
    id: 't2', name: 'Maxwell Hagberg', msAgo: 96 * MIN,
    html: '<p>Wheels up IAD–HYA at 12:41. Smooth ride at FL410, ETA 14:07 local.</p>',
    replies: [
      teamsMessage({ id: 't2r1', name: 'Jordan Vance', msAgo: 92 * MIN, html: '<p>Copy — broker notified, handler is standing by at Rectrix.</p>' }),
      teamsMessage({ id: 't2r2', name: 'Rosa Delgado', msAgo: 80 * MIN, html: '<p>Catering credit posted to the trip, receipts attached in Expenses.</p>' }),
    ],
  }),
  teamsMessage({
    id: 't3', name: 'Nina Park', msAgo: 40 * MIN,
    html: '<p>Heads up: N168ZZ left main tire is approaching limits. Squawk open, MEL 49-40-01 still deferred until Friday.</p>',
  }),
  teamsMessage({
    id: 't4', name: 'Melissa Rippy', msAgo: 18 * MIN,
    html: '<p>APF–DFW airborne, 39,000 ft. Three passengers, catering aboard, no delays.</p>',
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

const INVOICES = [
  invoice({ id: '1044', docNumber: '1044', customerId: '7', customerName: 'Outlier Jets', date: today(), dueDate: dayOffset(30), total: 52_400, balance: 52_400, email: 'ap@outlierjets.com', status: 'open' }),
  invoice({ id: '1043', docNumber: '1043', customerId: '9', customerName: 'Monarch Air Group', date: dayOffset(-6), dueDate: dayOffset(24), total: 38_950, balance: 38_950, email: 'ap@monarchair.com', status: 'open' }),
  invoice({ id: '1041', docNumber: '1041', customerId: '11', customerName: 'Jet Linx Aviation', date: dayOffset(-38), dueDate: dayOffset(-8), total: 27_600, balance: 27_600, email: 'ap@jetlinx.com', status: 'overdue' }),
  invoice({ id: '1039', docNumber: '1039', customerId: '14', customerName: 'Coastal Air Charter', date: dayOffset(-71), dueDate: dayOffset(-41), total: 15_250, balance: 15_250, email: 'ap@coastalair.com', status: 'overdue' }),
  invoice({ id: '1042', docNumber: '1042', customerId: '7', customerName: 'Outlier Jets', date: dayOffset(-14), dueDate: dayOffset(16), total: 48_250, balance: 0, email: 'ap@outlierjets.com', status: 'paid' }),
  invoice({ id: '1040', docNumber: '1040', customerId: '12', customerName: 'Private Jet Co', date: dayOffset(-26), dueDate: dayOffset(4), total: 61_800, balance: 0, email: 'ap@privatejet.co', status: 'paid' }),
];

const CUSTOMERS = [
  { id: '7', name: 'Outlier Jets', companyName: 'Outlier Jets LLC', email: 'ap@outlierjets.com', phone: '(305) 555-0142', balance: 52_400, active: true },
  { id: '9', name: 'Monarch Air Group', companyName: 'Monarch Air Group', email: 'ap@monarchair.com', phone: '(954) 555-0188', balance: 38_950, active: true },
  { id: '11', name: 'Jet Linx Aviation', companyName: 'Jet Linx', email: 'ap@jetlinx.com', phone: '(402) 555-0110', balance: 27_600, active: true },
  { id: '12', name: 'Private Jet Co', companyName: 'Private Jet Co', email: 'ap@privatejet.co', phone: '(212) 555-0164', balance: 0, active: true },
  { id: '14', name: 'Coastal Air Charter', companyName: 'Coastal Air', email: 'ap@coastalair.com', phone: '(843) 555-0175', balance: 15_250, active: true },
];

const QBO_CONNECTION = {
  connected: true,
  realmId: '9341454801234567',
  companyName: 'Skyway Aviation LLC',
  environment: 'production',
  serverEnvironment: 'production',
  environmentMismatch: false,
  connectedByName: 'Jim Skyway',
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
  const mailbox = personal ? 'jim@flyskyway.com' : 'charters@flyskyway.com';
  switch (action) {
    case 'status':
      return {
        ok: true, connected: true, configured: true, mailbox,
        displayName: personal ? 'Jim Skyway' : 'Skyway Charters',
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
      return { ok: true, configured: true, connected: true, teamsEnabled: true, account: 'jim@flyskyway.com', displayName: 'Jim Skyway' };
    case 'overview':
      return {
        ok: true,
        teams: [
          { id: 'team-ops', name: 'Skyway Operations', description: 'Fleet-wide coordination', webUrl: 'https://teams.microsoft.com/l/team/ops' },
          { id: 'team-sales', name: 'Charter Sales', description: 'Quotes and brokers', webUrl: 'https://teams.microsoft.com/l/team/sales' },
          { id: 'team-maint', name: 'Maintenance', description: 'Squawks and MEL', webUrl: 'https://teams.microsoft.com/l/team/maint' },
        ],
        chats: [
          { id: 'chat-1', topic: '', name: 'Jordan Vance', chatType: 'oneOnOne', webUrl: '#', lastUpdatedAt: iso(9 * MIN), members: ['Jordan Vance'] },
          { id: 'chat-2', topic: 'N444AM crew', name: 'N444AM crew', chatType: 'group', webUrl: '#', lastUpdatedAt: iso(48 * MIN), members: ['Maxwell Hagberg', 'Timothy Woods'] },
          { id: 'chat-3', topic: '', name: 'Rosa Delgado', chatType: 'oneOnOne', webUrl: '#', lastUpdatedAt: iso(3 * HOUR), members: ['Rosa Delgado'] },
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
          { id: 'f1', driveId: 'drive-1', name: 'Daily Movement Board.xlsx', size: 48_120, isFolder: false, childCount: 0, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', webUrl: '#', modifiedAt: iso(2 * HOUR), modifiedBy: 'Jordan Vance' },
          { id: 'f2', driveId: 'drive-1', name: 'Trip Sheets', size: 0, isFolder: true, childCount: 14, mimeType: '', webUrl: '#', modifiedAt: iso(26 * HOUR), modifiedBy: 'Rosa Delgado' },
          { id: 'f3', driveId: 'drive-1', name: 'N444AM Itinerary IAD-HYA.pdf', size: 184_320, isFolder: false, childCount: 0, mimeType: 'application/pdf', webUrl: '#', modifiedAt: iso(4 * HOUR), modifiedBy: 'Melissa Rippy' },
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

function brokerTrip() {
  return {
    tripId: 'sky-1001',
    tripCode: 'SKY-1042',
    tail: 'N444AM',
    aircraftType: 'Citation XLS+',
    completed: false,
    completedAt: null,
    legs: [
      {
        legNumber: 1,
        from: 'IAD', to: 'HYA',
        fromFbo: 'Signature Flight Support', toFbo: 'Rectrix Aviation',
        departure: new Date(now() - 95 * MIN).toISOString(),
        arrival: new Date(now() + 26 * MIN).toISOString(),
        category: 'REVENUE',
        pic: 'Maxwell Hagberg', sic: 'Timothy Woods',
        showPax: true,
        hasCatering: true,
        pax: [
          { name: 'A. Whitmore', status: 'checked_in', checkedInAt: now() - 110 * MIN, walkUp: false },
          { name: 'C. Whitmore', status: 'checked_in', checkedInAt: now() - 108 * MIN, walkUp: false },
          { name: 'R. Delacroix', status: 'checked_in', checkedInAt: now() - 104 * MIN, walkUp: false },
          { name: 'S. Ambrose', status: 'checked_in', checkedInAt: now() - 101 * MIN, walkUp: false },
        ],
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
        from: 'HYA', to: 'TEB',
        fromFbo: 'Rectrix Aviation', toFbo: 'Jet Aviation',
        departure: new Date(now() + 4 * HOUR).toISOString(),
        arrival: new Date(now() + 5.4 * HOUR).toISOString(),
        category: 'REVENUE',
        pic: 'Maxwell Hagberg', sic: 'Timothy Woods',
        showPax: true,
        hasCatering: false,
        pax: [
          { name: 'A. Whitmore', status: 'pending', checkedInAt: null, walkUp: false },
          { name: 'C. Whitmore', status: 'pending', checkedInAt: null, walkUp: false },
        ],
        status: {},
      },
    ],
    statuses: {},
  };
}

function brokerPayload() {
  return {
    ok: true,
    trip: brokerTrip(),
    position: {
      ident: 'N444AM', airborne: true,
      latitude: 40.6431, longitude: -73.1259,
      heading: 62, altitude: 41000, groundspeed: 452,
      origin: 'KIAD', destination: 'KHYA',
      originLat: 38.9531, originLon: -77.4565,
      destinationLat: 41.6693, destinationLon: -70.2804,
      actualOff: new Date(now() - 74 * MIN).toISOString(),
      estimatedOn: new Date(now() + 26 * MIN).toISOString(),
      progressPercent: 74,
    },
    trail: [
      { lat: 38.95, lon: -77.45, altitude_ft: 1200, groundspeed_kt: 180, time: now() - 73 * MIN },
      { lat: 39.15, lon: -76.9, altitude_ft: 12000, groundspeed_kt: 300, time: now() - 66 * MIN },
      { lat: 39.45, lon: -76.1, altitude_ft: 27000, groundspeed_kt: 410, time: now() - 56 * MIN },
      { lat: 39.8, lon: -75.2, altitude_ft: 37000, groundspeed_kt: 442, time: now() - 44 * MIN },
      { lat: 40.15, lon: -74.4, altitude_ft: 41000, groundspeed_kt: 452, time: now() - 32 * MIN },
      { lat: 40.45, lon: -73.7, altitude_ft: 41000, groundspeed_kt: 452, time: now() - 18 * MIN },
      { lat: 40.6431, lon: -73.1259, altitude_ft: 41000, groundspeed_kt: 452, time: now() - 2 * MIN },
    ],
    weather: {
      KIAD: { metar: { raw: 'KIAD 181551Z 31012KT 10SM FEW250 24/09 A3011', flightCategory: 'VFR' } },
      KHYA: { metar: { raw: 'KHYA 181553Z 20008KT 10SM SCT035 22/14 A3009', flightCategory: 'VFR' } },
    },
  };
}

/* ── Schedule feed ─────────────────────────────────────────────────────────
   The application ships a real JetInsight feed URL as its default. Left alone,
   the preview fetches it and live customer trips appear in captured imagery, so
   the harness serves a fictitious feed in JetInsight's own format and refuses
   any request that would reach the live scheduler. */

export function sampleIcal() {
  const stamp = (hours) => new Date(BASE + hours * HOUR)
    .toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  let out = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SKYWAY//PREVIEW//EN\r\n';
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
    if (path === '/api/faa-notams') return json({ ok: true, notams: [] });
    if (path.startsWith('/api/airport-weather')) return json({ ok: true, parsed: null });

    return json({ ok: true });
  };
}
