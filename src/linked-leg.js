// Linked live legs shown to another broker as repositioning.
//
// A leg keeps its owning trip. This module decides what the other broker is
// allowed to see, which neighbor can be offered as a repositioning leg, and
// the manual secondary-notify list. Passenger visibility can be turned off
// for the same broker and the same trip, and cannot be turned on when either
// differs. The server re-runs these functions; a client showPax flag does not
// override them.

export const CHAIN_GAP_MS = 30 * 3600 * 1000;

export const PAX_ONLY_STEPS = new Set(['pax_arrived', 'pax_boarded', 'catering_aboard']);

const MOVEMENT_STATUS = ['taxi_dep', 'wheels_up', 'landed'];
const PAX_STATUS = ['pax_arrived', 'pax_boarded', 'catering_aboard'];

export function normAirport(code) {
  const u = String(code || '').toUpperCase().trim();
  return u.length === 4 && u.startsWith('K') ? u.slice(1) : u;
}

export function airportsChain(a, b) {
  return !!a && !!b && normAirport(a) === normAirport(b);
}

export function normBrokerName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function emailDomain(email) {
  const at = String(email || '').toLowerCase().trim().lastIndexOf('@');
  if (at < 0) return '';
  return String(email).toLowerCase().trim().slice(at + 1);
}

export function brokerDomains(brokerEmail) {
  const out = new Set();
  String(brokerEmail || '')
    .split(/[,;\s]+/)
    .map((part) => emailDomain(part))
    .filter(Boolean)
    .forEach((domain) => out.add(domain));
  return out;
}

function domainsOverlap(a, b) {
  const left = a instanceof Set ? a : brokerDomains(a);
  const right = b instanceof Set ? b : brokerDomains(b);
  for (const domain of left) if (right.has(domain)) return true;
  return false;
}

/**
 * Same broker when the customer names match, or — when those strings differ —
 * when the saved broker-email domains match exactly (Farley vs Outlier Jets
 * at outlierjets.com).
 */
export function sameBroker(viewer, leg) {
  const leftName = normBrokerName(viewer?.customer);
  const rightName = normBrokerName(leg?.customer);
  if (leftName && rightName && leftName === rightName) return true;
  if (domainsOverlap(viewer?.brokerEmail, leg?.brokerEmail)) return true;
  return false;
}

/**
 * Trip id is the JetInsight trip code when a sheet has been uploaded.
 * With no sheet on either side, the iCal uid is the trip id. A code on only
 * one side is a different trip.
 */
export function sameTrip(viewer, leg) {
  const leftCode = String(viewer?.tripCode || '').trim().toUpperCase();
  const rightCode = String(leg?.tripCode || '').trim().toUpperCase();
  if (leftCode || rightCode) return !!leftCode && leftCode === rightCode;
  return !!viewer?.uid && viewer.uid === leg?.uid;
}

export function brokerMaySeePax({ viewer, leg, hidePax }) {
  if (!sameBroker(viewer, leg) || !sameTrip(viewer, leg)) return false;
  if (hidePax === true) return false;
  return true;
}

function identityKnown(viewer, owner) {
  const brokerKnown = !!(normBrokerName(viewer?.customer) || brokerDomains(viewer?.brokerEmail).size)
    && !!(normBrokerName(owner?.customer) || brokerDomains(owner?.brokerEmail).size);
  const tripKnown = !!(viewer?.tripCode || viewer?.uid) && !!(owner?.tripCode || owner?.uid);
  return brokerKnown && tripKnown;
}

function movementStatus(status) {
  const out = {};
  const bag = status && typeof status === 'object' ? status : {};
  for (const key of MOVEMENT_STATUS) {
    const at = bag[key]?.at ?? bag[key]?.timestamp;
    if (typeof at === 'number') out[key] = { at };
  }
  return out;
}

function charterStatus(status, showPax) {
  const bag = status && typeof status === 'object' ? status : {};
  const out = {};
  for (const [key, value] of Object.entries(bag)) {
    if (!showPax && PAX_STATUS.includes(key)) continue;
    const at = value?.at ?? value?.timestamp;
    if (typeof at === 'number') out[key] = { at };
  }
  return out;
}

/** Position and times only. No passengers, count, flight number, client, crew, or FBO. */
export function repositioningProjection(leg) {
  return {
    tripId: leg?.tripId || null,
    legNumber: leg?.legNumber,
    from: leg?.from || null,
    to: leg?.to || null,
    departure: leg?.departure || null,
    arrival: leg?.arrival || null,
    category: 'REPOSITIONING',
    presentAs: 'repositioning',
    showPax: false,
    pax: [],
    hasCatering: false,
    status: movementStatus(leg?.status),
  };
}

function charterProjection(leg, { showPax }) {
  return {
    tripId: leg?.tripId || null,
    legNumber: leg?.legNumber,
    from: leg?.from || null,
    to: leg?.to || null,
    fromFbo: leg?.fromFbo || null,
    toFbo: leg?.toFbo || null,
    departure: leg?.departure || null,
    arrival: leg?.arrival || null,
    category: leg?.category || 'REVENUE',
    pic: leg?.pic || leg?.picName || null,
    sic: leg?.sic || leg?.sicName || null,
    showPax: showPax === true,
    pax: showPax === true && Array.isArray(leg?.pax) ? leg.pax : [],
    hasCatering: leg?.hasCatering !== false,
    status: charterStatus(leg?.status, showPax === true),
  };
}

/**
 * What one broker's tracking page may render for a leg.
 * presentAs "repositioning" plus a failed same-broker/same-trip check is the
 * position-and-times card. A client showPax:true does not open that card.
 */
export function projectSharedLeg(leg, viewer, owner) {
  const identity = {
    uid: owner?.uid || leg?.tripId || null,
    customer: owner?.customer || leg?.ownerCustomer || null,
    tripCode: owner?.tripCode || leg?.ownerTripCode || null,
    brokerEmail: owner?.brokerEmail || leg?.ownerBrokerEmail || '',
  };
  const allowed = brokerMaySeePax({ viewer, leg: identity, hidePax: false });
  const hide = leg?.hidePax === true;

  if (leg?.presentAs === 'repositioning') {
    if (!allowed) return repositioningProjection(leg);
    return charterProjection(leg, { showPax: !hide });
  }

  if (identityKnown(viewer, identity) && !allowed) {
    return charterProjection(leg, { showPax: false });
  }

  const showPax = leg?.showPax === true && !hide;
  return charterProjection(leg, { showPax });
}

function storedOnlyIdentity(uid, stored) {
  return {
    uid: uid || stored?.uid || null,
    customer: stored?.customer || null,
    tripCode: stored?.tripCode || null,
    brokerEmail: stored?.brokerEmail || '',
  };
}

function preferStored(primary, fallback) {
  if (primary === undefined || primary === null || primary === '') return fallback;
  return primary;
}

export function mergeIdentity(snapshot, stored) {
  return {
    uid: preferStored(stored?.uid, snapshot?.uid) || null,
    customer: preferStored(stored?.customer, snapshot?.customer) || null,
    tripCode: preferStored(stored?.tripCode, snapshot?.tripCode) || null,
    brokerEmail: preferStored(stored?.brokerEmail, snapshot?.brokerEmail) || '',
  };
}

/**
 * Snapshot written to the observer's trip-state. Firestore identity wins
 * over the client-supplied one when both exist. Secondary notify is not
 * part of this patch.
 */
export function enforcePublicTrip(incoming, identitiesByUid = {}) {
  const rawViewer = incoming?.viewer || {};
  const viewer = mergeIdentity(rawViewer, identitiesByUid[rawViewer.uid]);
  const legs = (Array.isArray(incoming?.legs) ? incoming.legs : []).map((leg) => {
    const snapOwner = {
      uid: leg?.tripId || null,
      customer: leg?.ownerCustomer || null,
      tripCode: leg?.ownerTripCode || null,
      brokerEmail: leg?.ownerBrokerEmail || '',
    };
    const reposition = leg?.presentAs === 'repositioning';
    const owner = reposition
      ? storedOnlyIdentity(leg?.tripId, identitiesByUid[leg?.tripId])
      : mergeIdentity(snapOwner, identitiesByUid[leg?.tripId]);
    const gateViewer = reposition
      ? storedOnlyIdentity(rawViewer.uid, identitiesByUid[rawViewer.uid])
      : viewer;
    const projected = projectSharedLeg({ ...leg, hidePax: leg?.hidePax === true }, gateViewer, owner);
    return {
      ...projected,
      ownerCustomer: owner.customer,
      ownerTripCode: owner.tripCode,
      ownerBrokerEmail: owner.brokerEmail,
      presentAs: leg?.presentAs === 'repositioning' ? 'repositioning' : projected.presentAs,
      hidePax: leg?.hidePax === true,
    };
  });
  return {
    tail: incoming?.tail || '',
    aircraftType: incoming?.aircraftType || null,
    viewer: {
      uid: viewer.uid,
      customer: viewer.customer,
      tripCode: viewer.tripCode,
      brokerEmail: viewer.brokerEmail,
    },
    legs,
  };
}

export function composeBrokerTrip({ tripId, publicTripData, liveByTripId = {} }) {
  const storedViewer = publicTripData?.viewer || {};
  const liveViewer = liveByTripId[tripId]?.identity || {};
  const viewer = mergeIdentity({ ...storedViewer, uid: tripId }, { ...liveViewer, uid: tripId });
  const legs = (publicTripData?.legs || []).map((leg) => {
    const live = (leg?.tripId && liveByTripId[leg.tripId]) || {};
    const reposition = leg?.presentAs === 'repositioning';
    const owner = reposition
      ? storedOnlyIdentity(leg?.tripId, live.identity)
      : mergeIdentity({
        uid: leg?.tripId || null,
        customer: leg?.ownerCustomer || null,
        tripCode: leg?.ownerTripCode || null,
        brokerEmail: leg?.ownerBrokerEmail || '',
      }, { ...(live.identity || {}), uid: leg?.tripId || null });
    const gateViewer = reposition
      ? storedOnlyIdentity(tripId, liveByTripId[tripId]?.identity)
      : viewer;
    const status = { ...(leg?.status || {}) };
    if (live.statuses) {
      for (const [key, value] of Object.entries(live.statuses)) {
        if (value && typeof value.at === 'number') status[key] = { at: value.at };
      }
    }
    const projected = projectSharedLeg({ ...leg, status }, gateViewer, owner);
    if (projected.showPax && Array.isArray(live.pax)) projected.pax = live.pax;
    return projected;
  });
  return { legs };
}

/** Landing grace uses the observer's own legs. A borrowed repositioning landing does not expire the link. */
export function linkExpiryLandedAt({ anchorStatuses, snapshotLegs, liveByTripId, viewerUid }) {
  let latest = null;
  const consider = (at) => {
    if (typeof at === 'number' && (latest === null || at > latest)) latest = at;
  };
  const flat = anchorStatuses && typeof anchorStatuses === 'object' ? anchorStatuses : {};
  if (flat.landed && typeof flat.landed === 'object') {
    consider(flat.landed.at ?? flat.landed.timestamp);
  }
  for (const leg of snapshotLegs || []) {
    if (leg?.presentAs === 'repositioning') continue;
    if (leg?.tripId && viewerUid && leg.tripId !== viewerUid) continue;
    consider(leg?.status?.landed?.at);
    consider(liveByTripId?.[leg?.tripId]?.statuses?.landed?.at);
  }
  return latest;
}

function legStart(leg) {
  if (!leg?.start) return NaN;
  const ms = leg.start instanceof Date ? leg.start.getTime() : new Date(leg.start).getTime();
  return ms;
}

/**
 * The single previous or next same-tail leg that chains by airport inside
 * 30 hours. A revenue leg is included. The walk does not continue past it.
 */
export function immediateChainedLeg(anchor, trips, direction) {
  if (!anchor?.info || !Array.isArray(trips)) return null;
  const tail = String(anchor.info.tail || '').toUpperCase();
  if (!tail) return null;
  const eligible = trips
    .filter((trip) => trip?.info && trip.uid && String(trip.info.tail || '').toUpperCase() === tail)
    .filter((trip) => trip.info.isFlight !== false)
    .filter((trip) => {
      const cat = String(trip.info.category || '').toUpperCase();
      return !['HOLD', 'MX', 'TRAINING'].includes(cat);
    })
    .filter((trip) => Number.isFinite(legStart(trip)))
    .sort((a, b) => legStart(a) - legStart(b));
  const index = eligible.findIndex((trip) => trip.uid === anchor.uid);
  if (index < 0) return null;
  const neighbor = eligible[index + (direction === 'next' ? 1 : -1)];
  if (!neighbor) return null;
  const anchorEdge = direction === 'next' ? anchor.info.to : anchor.info.from;
  const neighborEdge = direction === 'next' ? neighbor.info.from : neighbor.info.to;
  if (!airportsChain(anchorEdge, neighborEdge)) return null;
  const gap = direction === 'next'
    ? legStart(neighbor) - legStart(anchor)
    : legStart(anchor) - legStart(neighbor);
  if (!Number.isFinite(gap) || gap < 0 || gap > CHAIN_GAP_MS) return null;
  return neighbor;
}

export function parseEmailList(value) {
  const seen = new Set();
  const out = [];
  String(value || '')
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part))
    .forEach((email) => {
      const key = email.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(email);
    });
  return out;
}

/**
 * Opening the field shows the saved list when one exists, otherwise the
 * next trip's broker emails. It never writes. A saved list is kept even
 * when the next trip's broker email later changes. `stored === null` means
 * ops has never saved; an array (including empty) is a saved list.
 */
export function openSecondaryNotifyField({ stored, prefill }) {
  const saved = Array.isArray(stored);
  const draft = saved ? stored.join(', ') : String(prefill || '');
  return {
    draft,
    persisted: saved ? stored.slice() : null,
    shouldWrite: false,
  };
}

export function saveSecondaryNotify({ draft, observerTripUid, updatedBy, now }) {
  const emails = parseEmailList(draft);
  if (emails.length === 0) return { secondaryNotify: [] };
  return {
    secondaryNotify: [{
      emails,
      observerTripUid: observerTripUid || null,
      presentAs: 'repositioning',
      updatedAt: now || Date.now(),
      updatedBy: updatedBy || null,
    }],
  };
}

export function secondaryRecipients(ownerEmails, entry) {
  const owner = new Set((ownerEmails || []).map((email) => String(email || '').toLowerCase()));
  return (entry?.emails || []).filter((email) => email && !owner.has(String(email).toLowerCase()));
}

export function secondaryStepAllowed(stepId) {
  return !PAX_ONLY_STEPS.has(stepId);
}

export function greetingFromEmail(email) {
  if (!email || typeof email !== 'string') return 'there';
  const local = email.split('@')[0] || '';
  const firstPart = local.split(/[._-]/)[0] || '';
  if (!firstPart) return 'there';
  return firstPart.charAt(0).toUpperCase() + firstPart.slice(1).toLowerCase();
}

/**
 * Status email copy. `repo` selects the repositioning wording. Customer and
 * flight number are accepted so callers can prove they are not interpolated.
 */
export function movementEmailText({
  stepId,
  repo,
  tail,
  from,
  to,
  greeting,
  localTimeStr,
  arrTimeStr,
  signature,
  brandName,
}) {
  const route = `${from || ''}-${to || ''}`;
  const sign = signature || '';
  const hi = greeting || 'Hello,';
  if (repo && PAX_ONLY_STEPS.has(stepId)) return null;

  if (stepId === 'crew_onsite') {
    if (repo) {
      return {
        subject: `Crew Preparing Aircraft for Repositioning — ${tail} ${route}`,
        text:
          `${hi}\n\n` +
          `Our crew has arrived at the FBO at ${localTimeStr} and is preparing the aircraft for the repositioning ` +
          `flight from ${from || ''} to ${to || ''}. ` +
          `We will notify you when the aircraft is ready and again when it begins taxi for departure.` +
          sign,
      };
    }
    return {
      subject: `Crew Arrival Notification — ${tail} ${route}`,
      text:
        `${hi}\n\n` +
        `This email is to inform you that our crew has arrived at the FBO at ${localTimeStr} ` +
        `and is preparing the aircraft for your passengers. We will notify you as soon as ` +
        `the aircraft is ready for boarding.` +
        sign,
    };
  }

  if (stepId === 'aircraft_ready') {
    if (repo) {
      return {
        subject: `Aircraft Ready for Repositioning — ${tail} ${route}`,
        text:
          `${hi}\n\n` +
          `${tail} is ready for the repositioning flight from ${from || ''} to ${to || ''} ` +
          `as of ${localTimeStr}. ` +
          `We will send a final notification once the aircraft begins taxi for departure.` +
          sign,
      };
    }
    return {
      subject: `Aircraft Ready for Passengers — ${tail} ${route}`,
      text:
        `${hi}\n\n` +
        `The aircraft is now ready for your passengers as of ${localTimeStr}. ` +
        `We will advise you once they have checked in.\n\n` +
        `If catering has been arranged for this flight, you will receive a separate notification ` +
        `once it has been loaded onboard.` +
        sign,
    };
  }

  if (stepId === 'catering_aboard') {
    return {
      subject: `Catering Loaded — ${tail} ${route}`,
      text: `${hi}\n\nCatering has been loaded onboard the aircraft at ${localTimeStr}.` + sign,
    };
  }

  if (stepId === 'pax_arrived') {
    return {
      subject: `Passengers Arrived — ${tail} ${route}`,
      text:
        `${hi}\n\n` +
        `Passengers have arrived at the FBO at ${localTimeStr}. We will notify you once IDs have been ` +
        `verified and they have boarded the aircraft.` +
        sign,
    };
  }

  if (stepId === 'pax_boarded') {
    return {
      subject: `Passengers Checked In — ${tail} ${route}`,
      text:
        `${hi}\n\n` +
        `Passengers have checked in at ${localTimeStr}, IDs have been verified, and they are now boarding the aircraft.\n\n` +
        `The next update will be our taxi notification.` +
        sign,
    };
  }

  if (stepId === 'taxi_dep') {
    if (repo) {
      return {
        subject: `Aircraft Taxiing for Repositioning — ${tail} ${route}`,
        text:
          `${hi}\n\n` +
          `${tail} began taxiing at ${localTimeStr} for the repositioning flight from ${from || ''} to ${to || ''}. ` +
          `We will provide the aircraft's ETA once it is airborne.` +
          sign,
      };
    }
    return {
      subject: `Aircraft Taxiing for Departure — ${tail} ${route}`,
      text:
        `${hi}\n\n` +
        `The aircraft began taxiing for departure at ${localTimeStr}. We will provide the aircraft's ETA once ` +
        `it is airborne.` +
        sign,
    };
  }

  if (stepId === 'wheels_up') {
    if (repo) {
      return {
        subject: `Wheels Up (Repositioning) — ${tail} ${route}`,
        text:
          `${hi}\n\n` +
          `${tail} is wheels up at ${localTimeStr} from ${from || ''} and en route to ${to || ''} ` +
          `for the repositioning flight. We will notify you upon landing.` +
          sign,
      };
    }
    return {
      subject: `Wheels Up — ${tail} ${route}`,
      text:
        `${hi}\n\n` +
        `${tail} is wheels up at ${localTimeStr} from ${from || ''} and en route to ${to || ''}. ` +
        `We will notify you upon landing.` +
        sign,
    };
  }

  if (stepId === 'landed') {
    if (repo) {
      return {
        subject: `Landed (Repositioning) — ${tail} ${route}`,
        text:
          `${hi}\n\n` +
          `${tail} has landed at ${to || ''} at ${arrTimeStr}. The repositioning flight is complete.` +
          sign,
      };
    }
    return {
      subject: `Landed — ${tail} ${route}`,
      text:
        `${hi}\n\n` +
        `${tail} has landed at ${to || ''} at ${arrTimeStr}. Thank you for choosing ${brandName || 'Skyway Aviation'}. ` +
        `We look forward to serving you again.` +
        sign,
    };
  }

  return null;
}

export function secondaryNotifyPayloads({
  entries,
  ownerEmails,
  stepId,
  tail,
  from,
  to,
  localTimeStr,
  arrTimeStr,
  signature,
  customer,
  flightNumber,
}) {
  if (!secondaryStepAllowed(stepId)) return [];
  const payloads = [];
  for (const entry of entries || []) {
    const toList = secondaryRecipients(ownerEmails, entry);
    if (toList.length === 0) continue;
    const email = movementEmailText({
      stepId,
      repo: true,
      tail,
      from,
      to,
      greeting: `Hi ${greetingFromEmail(toList[0])},`,
      localTimeStr,
      arrTimeStr,
      signature,
      customer,
      flightNumber,
    });
    if (!email) continue;
    payloads.push({
      to: toList,
      subject: email.subject,
      text: email.text,
      trackingForTripId: entry.observerTripUid || null,
    });
  }
  return payloads;
}

export function delayNoticeText({
  repo,
  tail,
  route,
  greeting,
  reason,
  delayDuration,
  newEtd,
  paxArrivalTime,
}) {
  const lines = [
    greeting,
    '',
    repo
      ? `We are writing to inform you of a delay for the repositioning of ${tail} ${route}.`
      : `We are writing to inform you of a delay for ${tail} ${route}.`,
    '',
    `Reason: ${reason}`,
  ];
  if (delayDuration) lines.push(`Estimated delay: ${delayDuration}`);
  if (newEtd) lines.push(`New estimated time of departure: ${newEtd}`);
  if (!repo && paxArrivalTime) lines.push(`Requested passenger arrival time: ${paxArrivalTime}`);
  lines.push('', 'We will keep you informed as the situation develops.');
  return {
    subject: repo ? `Repositioning Delay — ${tail} ${route}` : `Flight Delay — ${tail} ${route}`,
    text: lines.join('\n'),
  };
}

export function secondaryTrackingUrl({ observerTripUid, linkTokenIssuedAt, linkRevoked, sign, origin }) {
  if (!observerTripUid || linkRevoked === true) return null;
  if (typeof linkTokenIssuedAt !== 'number') return null;
  if (typeof sign !== 'function') return null;
  const token = sign(observerTripUid, linkTokenIssuedAt);
  if (!token) return null;
  const base = origin || '';
  return `${base}/trip-track.html?token=${encodeURIComponent(token)}`;
}

/** Share writes linked legs only. Secondary notify stays a separate manual save. */
export function observerSharePatch(linkedLegs) {
  const legs = (Array.isArray(linkedLegs) ? linkedLegs : []).slice(0, 8).map((leg) => ({
    legUid: String(leg?.legUid || '').slice(0, 200),
    role: leg?.role === 'previous' ? 'previous' : 'next',
    presentAs: 'repositioning',
    hidePax: leg?.hidePax === true,
  })).filter((leg) => leg.legUid);
  return { linkedLegs: legs };
}
