// Broker-facing comparison of included 50% and the 100% upgrade.
// CFS mail does not use this module.

import { fmtMoney } from './aog-recovery.js';
import { coverageTierCents, isHundredCoverage } from './aog-reporting.js';

export function moneyUpTo(cents) {
  if (!Number.isInteger(cents)) return '';
  return `up to ${fmtMoney(cents / 100)}`;
}

export function brokerComparison(record = {}) {
  const tiers = coverageTierCents(record);
  const includedValue = moneyUpTo(tiers.includedCents);
  const upgradeValue = moneyUpTo(tiers.upgradeCents);
  const premium = fmtMoney(record.premium);
  const already = isHundredCoverage(record.coverageLevel);
  const offered = !already && Number(record.premium) > 0 && record.upgradeAvailable !== false;
  const includedLine = includedValue ? `Included: 50%, ${includedValue}` : 'Included: 50%';
  let upgradeLine = 'Upgrade: 100% is not offered for this aircraft';
  if (offered && upgradeValue) upgradeLine = `Upgrade: 100%, ${upgradeValue}, premium ${premium}`;
  else if (already && upgradeValue) upgradeLine = `Upgrade: 100%, ${upgradeValue}, premium ${premium}`;
  else if (upgradeValue && offered) upgradeLine = `Upgrade: 100%, ${upgradeValue}, premium ${premium}`;
  return {
    includedLine,
    upgradeLine,
    includedValue,
    upgradeValue,
    premium,
    offered,
    already,
  };
}

function cell(title, body) {
  return `<td style="width:50%;vertical-align:top;padding:16px;border:1px solid #e7e5e4;background:#ffffff">`
    + `<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#57534e">${title}</div>`
    + body
    + `</td>`;
}

/** Side-by-side block for broker emails. The summary lines are the phrases ops asked for. */
export function comparisonHtml(record) {
  const view = brokerComparison(record);
  const upgradeNote = view.offered
    ? `Premium ${view.premium}. The trip total is not charged.`
    : (view.already ? 'This trip is already at 100%. There is no further premium to pay.' : '100% is not offered for this aircraft until a premium rate is published.');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:16px 0"><tr>`
    + cell('Included with the charter', `<div style="font-size:22px;font-weight:600;margin:6px 0;color:#1c1917">50%</div><div style="color:#1c1917">No charge</div><div style="margin-top:8px;color:#1c1917">Coverage value: ${view.includedValue || '—'}</div><div style="margin-top:8px;font-size:13px;color:#44403c">${view.includedLine}</div>`)
    + cell('Upgrade', `<div style="font-size:22px;font-weight:600;margin:6px 0;color:#1c1917">100%</div><div style="color:#1c1917">${upgradeNote}</div><div style="margin-top:8px;color:#1c1917">Coverage value: ${view.upgradeValue || '—'}</div><div style="margin-top:8px;font-size:13px;color:#44403c">${view.upgradeLine}</div>`)
    + `</tr></table>`;
}

export function comparisonText(record) {
  const view = brokerComparison(record);
  return [
    view.includedLine,
    view.upgradeLine,
    view.upgradeValue ? `Coverage value: ${view.upgradeValue}` : '',
  ].filter(Boolean).join('\n');
}
