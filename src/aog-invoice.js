// Broker request to put the 100% AOG premium on the charter invoice.
// Pure helpers: no Firebase and no mail transport. Card checkout stays
// the other path. CFS never reads this module.

import { emailDomain, fmtMoney } from './aog-recovery.js';
import { emailButtonStack, emailShell, factTable, tripSummaryRows } from './aog-mail-layout.js';
import { isHundredCoverage } from './aog-reporting.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function invoiceLineLabel(tripId) {
  const id = String(tripId || '').trim() || 'this trip';
  return `AOG Recovery Coverage, 100% (trip ${id})`;
}

export function cleanPersonName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

export function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 160);
}

export function coverageChoiceUrl(url, choice) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const join = raw.includes('?') ? '&' : '?';
  return `${raw}${join}choice=${encodeURIComponent(choice)}`;
}

function personOk(name) {
  return name.length >= 5 && name.includes(' ');
}

export function planInvoiceRequest(record = {}, input = {}) {
  if (record.coverageLevel !== 'included_50' || record.upgradeAvailable !== true) {
    return { ok: false, status: 400, error: '100% coverage is not available for this trip' };
  }
  if (!Number.isInteger(record.premiumCents) || record.premiumCents <= 0) {
    return { ok: false, status: 400, error: 'This trip does not have a premium to invoice' };
  }
  if (record.paymentStatus === 'paid' || record.paymentStatus === 'invoice_unpaid' || record.paymentStatus === 'invoice_paid' || isHundredCoverage(record.coverageLevel)) {
    return { ok: false, status: 409, error: 'This coverage is already elected' };
  }
  const status = record.invoiceRequestStatus || '';
  if (status === 'pending' || status === 'approved') {
    return {
      ok: true,
      kind: 'duplicate',
      generation: Number(record.invoiceRequestGeneration) || 1,
    };
  }
  if (!record.signedAt) {
    return { ok: false, status: 400, error: 'Sign the election before requesting an invoice' };
  }
  const name = cleanPersonName(input.name || record.signedName || record.invoiceRequestedByName);
  const email = cleanEmail(input.email || record.checkoutEmail || record.brokerEmail);
  if (!personOk(name)) return { ok: false, status: 400, error: 'Type your first and last name' };
  if (!EMAIL_RE.test(email)) return { ok: false, status: 400, error: 'Enter a valid email address' };
  const generation = (Number(record.invoiceRequestGeneration) || 0) + 1;
  const atUtc = input.atUtc || new Date().toISOString();
  return {
    ok: true,
    kind: 'create',
    generation,
    request: {
      paymentMethod: 'invoice',
      paymentStatus: 'invoice_pending',
      invoiceRequestStatus: 'pending',
      invoiceRequestedByName: name,
      invoiceRequestedByEmail: email,
      invoiceRequestedAt: atUtc,
      invoicePremiumCents: record.premiumCents,
      invoiceTripId: record.tripId || '',
      invoiceLineItem: invoiceLineLabel(record.tripId),
      invoiceRequestGeneration: generation,
      invoiceDeclineMailAt: '',
    },
  };
}

export function invoiceAutoApproves(settings = {}, email = '') {
  if (settings.invoiceAutoApprove === true) return true;
  const domain = emailDomain(email);
  const allowed = Array.isArray(settings.invoiceAutoApproveDomains) ? settings.invoiceAutoApproveDomains : [];
  return Boolean(domain) && allowed.some((item) => String(item || '').trim().toLowerCase() === domain);
}

export function planInvoiceDecision(record = {}, decision) {
  if (decision !== 'approve' && decision !== 'decline') {
    return { ok: false, status: 400, error: 'Unknown decision' };
  }
  if (record.paymentStatus === 'paid') {
    return { ok: false, status: 409, error: 'This premium was already paid by card' };
  }
  if (decision === 'approve' && (record.invoiceRequestStatus === 'approved' || record.paymentStatus === 'invoice_unpaid' || record.paymentStatus === 'invoice_paid')) {
    return { ok: true, kind: 'duplicate', decision: 'approve', generation: Number(record.invoiceRequestGeneration) || 1 };
  }
  if (decision === 'decline' && record.invoiceRequestStatus === 'declined') {
    return { ok: true, kind: 'duplicate', decision: 'decline', generation: Number(record.invoiceRequestGeneration) || 1 };
  }
  if (record.invoiceRequestStatus !== 'pending') {
    return { ok: false, status: 409, error: 'There is no invoice request waiting for a decision' };
  }
  return { ok: true, kind: decision, decision, generation: Number(record.invoiceRequestGeneration) || 1 };
}

export function invoiceApprovalPatch(record = {}, { atUtc, actor, autoApproved = false } = {}) {
  const name = record.invoiceRequestedByName || record.signedName || 'Broker';
  const email = record.invoiceRequestedByEmail || record.checkoutEmail || '';
  return {
    coverageLevel: 'purchased_100',
    electionSource: 'purchased',
    paymentMethod: 'invoice',
    paymentStatus: 'invoice_unpaid',
    invoiceRequestStatus: 'approved',
    invoiceApprovedAt: atUtc,
    invoiceApprovedBy: actor || (autoApproved ? 'auto' : ''),
    invoiceAutoApproved: autoApproved === true,
    invoiceLineItem: record.invoiceLineItem || invoiceLineLabel(record.tripId),
    electedBy: email ? `${name} <${email}>` : name,
    emailsToSend: ['cfs_bind', 'broker_invoice'],
  };
}

export function invoiceDeclinePatch(record = {}, { atUtc, actor } = {}) {
  return {
    invoiceRequestStatus: 'declined',
    invoiceDeclinedAt: atUtc,
    invoiceDeclinedBy: actor || '',
    paymentMethod: '',
    paymentStatus: record.offerSentAt ? 'offer_pending' : 'not_required',
    emailsToSend: ['broker_invoice_declined'],
  };
}

export function invoicePaidPatch({ atUtc, actor } = {}) {
  return {
    paymentMethod: 'invoice',
    paymentStatus: 'invoice_paid',
    invoicePaidAt: atUtc,
    invoicePaidBy: actor || '',
  };
}

export function invoiceDecisionView(record = {}) {
  return {
    coverageId: record.id || '',
    tripId: record.tripId || record.invoiceTripId || '',
    brokerCompany: record.brokerCompany || '',
    tail: record.tail || '',
    aircraftType: record.aircraftType || '',
    route: record.route || '',
    datesLabel: record.datesLabel || '',
    premium: record.premium ?? (Number.isInteger(record.invoicePremiumCents) ? record.invoicePremiumCents / 100 : null),
    premiumCents: Number.isInteger(record.invoicePremiumCents) ? record.invoicePremiumCents : (Number.isInteger(record.premiumCents) ? record.premiumCents : null),
    requestedByName: record.invoiceRequestedByName || '',
    requestedByEmail: record.invoiceRequestedByEmail || '',
    invoiceRequestStatus: record.invoiceRequestStatus || '',
    paymentStatus: record.paymentStatus || '',
    paymentMethod: record.paymentMethod || '',
    lineItem: record.invoiceLineItem || (record.invoiceRequestStatus ? invoiceLineLabel(record.tripId) : ''),
  };
}

function money(record) {
  const cents = Number.isInteger(record.invoicePremiumCents) ? record.invoicePremiumCents : record.premiumCents;
  if (Number.isInteger(cents)) return fmtMoney(cents / 100);
  return fmtMoney(record.premium);
}

export function opsInvoiceLetter(record = {}, { approveUrl, declineUrl, autoApproved = false } = {}) {
  const tripId = record.tripId || 'trip';
  const subject = autoApproved
    ? `Invoice request auto-approved — trip ${tripId}`
    : `Invoice request for AOG premium — trip ${tripId}`;
  const lede = autoApproved
    ? 'A broker asked to add the AOG premium to the charter invoice. Auto-approve is on, so 100% coverage is already bound. The premium is on the invoice and unpaid.'
    : 'A broker asked to add the AOG premium to the charter invoice instead of paying by card. Approve to bind 100% coverage. Decline and they can still pay by card.';
  const facts = [
    ...tripSummaryRows(record),
    ['Broker', record.brokerCompany],
    ['Requested by', [record.invoiceRequestedByName, record.invoiceRequestedByEmail].filter(Boolean).join(' · ')],
    ['Premium', money(record)],
    ['Invoice line', record.invoiceLineItem || invoiceLineLabel(record.tripId)],
  ];
  const actions = autoApproved
    ? ''
    : emailButtonStack([
      { href: approveUrl, label: 'Approve invoice', tone: 'primary' },
      { href: declineUrl, label: 'Decline invoice', tone: 'secondary' },
    ]);
  const html = emailShell({
    preheader: autoApproved ? 'Invoice request auto-approved.' : 'Approve or decline an AOG invoice request.',
    headline: autoApproved ? 'Invoice request auto-approved' : 'Add this premium to the charter invoice?',
    lede,
    body: `${factTable(facts)}${actions}`,
  });
  const text = [
    lede,
    `Trip ${tripId}`,
    `Broker: ${record.brokerCompany || '—'}`,
    `Requested by: ${record.invoiceRequestedByName || '—'} <${record.invoiceRequestedByEmail || ''}>`,
    `Premium: ${money(record)}`,
    `Invoice line: ${record.invoiceLineItem || invoiceLineLabel(record.tripId)}`,
    autoApproved ? '' : `Approve: ${approveUrl || ''}`,
    autoApproved ? '' : `Decline: ${declineUrl || ''}`,
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}

export function brokerInvoiceLetter(record = {}) {
  const tripId = record.tripId || '';
  const amount = money(record);
  const lede = `100% AOG recovery coverage is confirmed for trip ${tripId}. The premium of ${amount} will appear on your charter invoice. You do not need to pay by card.`;
  const html = emailShell({
    preheader: 'The AOG premium will appear on your charter invoice.',
    headline: 'Premium added to your charter invoice',
    lede,
    body: factTable([
      ...tripSummaryRows(record),
      ['Premium', amount],
      ['Payment', 'On invoice, unpaid'],
    ]),
  });
  const text = [lede, `Trip ${tripId}`, `Premium: ${amount}`, 'Payment: On invoice, unpaid'].join('\n');
  return { subject: `AOG premium on your charter invoice — trip ${tripId}`.trim(), html, text };
}

export function brokerInvoiceDeclinedLetter(record = {}) {
  const tripId = record.tripId || '';
  const amount = money(record);
  const lede = `We are not able to add the ${amount} AOG premium to the charter invoice for trip ${tripId}. You can still pay that premium by card from the coverage link in your offer email. 50% coverage stays in place until you do.`;
  const html = emailShell({
    preheader: 'The invoice request was declined. Card payment is still open.',
    headline: 'Invoice request was not approved',
    lede,
    body: factTable([
      ...tripSummaryRows(record),
      ['Premium', amount],
    ]),
  });
  const text = [lede, `Trip ${tripId}`, `Premium: ${amount}`].join('\n');
  return { subject: `AOG invoice request — trip ${tripId}`.trim(), html, text };
}
