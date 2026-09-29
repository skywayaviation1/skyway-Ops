// When a trip sheet or charter contract arrives, copy broker details
// onto the trip only where the trip does not already have them.
// Existing values stay. A different parsed value is a mismatch.

import { emailDomain } from './aog-recovery.js';

export function normalizeBrokerEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeBrokerCompany(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeBrokerPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return '';
  return raw.replace(/\s+/g, ' ');
}

export function brokerIncoming(source = {}) {
  const email = normalizeBrokerEmail(source.brokerEmail || source.checkoutEmail);
  const company = normalizeBrokerCompany(source.brokerCompany || source.customer || source.client);
  const phone = normalizeBrokerPhone(source.brokerPhone);
  const domain = String(source.brokerDomain || emailDomain(email) || '').trim().toLowerCase();
  return {
    brokerCompany: company,
    brokerEmail: email,
    brokerPhone: phone,
    brokerDomain: domain,
  };
}

function storedView(source = {}) {
  const email = normalizeBrokerEmail(source.brokerEmail || source.checkoutEmail);
  const company = normalizeBrokerCompany(source.brokerCompany || source.customer || source.client);
  const phone = normalizeBrokerPhone(source.brokerPhone);
  const domain = String(source.brokerDomain || (email ? emailDomain(email) : '') || '').trim().toLowerCase();
  return { brokerCompany: company, brokerEmail: email, brokerPhone: phone, brokerDomain: domain };
}

/**
 * @returns {{ patch: object, filled: string[], mismatches: {field: string, existing: string, parsed: string}[] }}
 */
export function planBrokerBackfill(existing = {}, incoming = {}) {
  const have = storedView(existing);
  const next = brokerIncoming(incoming);
  const patch = {};
  const filled = [];
  const mismatches = [];
  for (const field of ['brokerCompany', 'brokerEmail', 'brokerPhone', 'brokerDomain']) {
    const want = next[field];
    if (!want) continue;
    const current = have[field];
    const same = field === 'brokerCompany'
      ? current.toLowerCase() === want.toLowerCase()
      : current === want;
    if (!current) {
      patch[field] = want;
      filled.push(field);
    } else if (!same) {
      mismatches.push({ field, existing: current, parsed: want });
    }
  }
  return { patch, filled, mismatches };
}

export function brokerDetailsFromText(text) {
  const body = String(text || '');
  const email = (body.match(/(?:checkout|broker|billing|contact)\s*e-?mail\s*[:#-]\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i) || [])[1] || '';
  const company = (body.match(/(?:broker(?:\s*\/\s*company)?|company|client)\s*[:#-]\s*([^\n]{2,80})/i) || [])[1] || '';
  const phone = (body.match(/(?:broker\s*)?phone\s*[:#-]\s*(\+?[0-9][0-9().\-\s]{6,20}[0-9])/i) || [])[1] || '';
  return brokerIncoming({ brokerCompany: company, brokerEmail: email, brokerPhone: phone });
}

export function brokerBackfillDetail(plan) {
  if (!plan?.filled?.length) return '';
  return `Wrote ${plan.filled.join(', ')} onto the trip`;
}

export function brokerMismatchDetail(mismatches) {
  return (mismatches || [])
    .map((row) => `${row.field}: trip has ${row.existing}; contract has ${row.parsed}`)
    .join('; ')
    .slice(0, 500);
}
