// Broker-facing comparison of included 50% and the 100% upgrade.
// CFS mail does not use this module.

import { fmtMoney } from './aog-recovery.js';
import { coverageTierCents, isHundredCoverage } from './aog-reporting.js';

export function moneyUpTo(cents) {
  if (!Number.isInteger(cents) || cents <= 0) return '';
  return `up to ${fmtMoney(cents / 100)}`;
}

export function brokerComparison(record = {}) {
  const tiers = coverageTierCents(record);
  const includedValue = moneyUpTo(tiers.includedCents);
  const upgradeValue = moneyUpTo(tiers.upgradeCents);
  const premium = Number(record.premium) > 0 ? fmtMoney(record.premium) : '';
  const already = isHundredCoverage(record.coverageLevel);
  const offered = !already && Number(record.premium) > 0 && record.upgradeAvailable !== false && Boolean(upgradeValue);
  const includedLine = includedValue ? `Included: 50%, ${includedValue}` : 'Included: 50%, pending trip total';
  let upgradeLine = 'Upgrade: 100% is not offered for this aircraft';
  if (offered && upgradeValue) upgradeLine = `Upgrade: 100%, ${upgradeValue}, premium ${premium}`;
  else if (already && upgradeValue) upgradeLine = `Upgrade: 100%, ${upgradeValue}, premium ${premium}`;
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

function card(title, percent, price, line, tone) {
  const border = tone === 'upgrade' ? '#0b6e6a' : '#d5dee6';
  const wash = tone === 'upgrade' ? '#f3faf9' : '#f7f9fb';
  return `<td class="aog-soft" width="50%" valign="top" style="width:50%;vertical-align:top;background:${wash};border:1px solid ${border};border-radius:12px;padding:16px">`
    + `<p style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5c6b7a">${title}</p>`
    + `<p style="margin:8px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1;color:#14202b">${percent}</p>`
    + `<p style="margin:8px 0 0;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#14202b">${price}</p>`
    + `<p style="margin:10px 0 0;font-family:-apple-system,Segoe UI,sans-serif;font-size:13px;line-height:1.4;color:#243140">${line}</p>`
    + `</td>`;
}

/** Side-by-side block for broker emails. Each fact appears once. */
export function comparisonHtml(record) {
  const view = brokerComparison(record);
  const upgradePrice = view.offered || view.already
    ? (view.premium ? `Premium ${view.premium}` : 'No further charge')
    : 'Not offered yet';
  const gap = `<td width="12" style="width:12px;font-size:0;line-height:0">&nbsp;</td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border-collapse:separate"><tr>`
    + card('Included with the charter', '50%', 'No charge', view.includedLine, 'included')
    + gap
    + card('Upgrade', '100%', upgradePrice, view.upgradeLine, 'upgrade')
    + `</tr></table>`;
}

export function comparisonText(record) {
  const view = brokerComparison(record);
  return [view.includedLine, view.upgradeLine].filter(Boolean).join('\n');
}
