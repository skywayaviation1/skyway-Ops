// Table-based, inline-styled mail that holds up in Apple Mail, Gmail, and Outlook.
// The header uses the white Skyway wordmark on a dark band so it stays readable
// in light and dark clients. Shared chrome never says "premium" — broker letters
// add that themselves, and Charter Flight Support mail must not.

export const SKYWAY_LOGO_URL = 'https://skyway-ops.vercel.app/skyway-logo-nav-reverse.png';
export const SKYWAY_CONTACT_EMAIL = 'charters@flyskyway.com';

// Inline on every text node. Mail clients otherwise paint td, h1, and links in Times.
export const MAIL_FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const TEXT_TAG = /<(td|th|a|h1|h2|h3|p|span|li|summary|strong|div|body)\b([^>]*)>/gi;

/** Give every text element an explicit sans stack. Replaces a serif stack if one was set. */
export function stampMailFonts(html) {
  return String(html).replace(TEXT_TAG, (match, tag, rest) => {
    if (/font-family\s*:/i.test(rest)) {
      return `<${tag}${rest.replace(/font-family\s*:[^;"]*/i, `font-family:${MAIL_FONT}`)}>`;
    }
    if (/style\s*=\s*"/i.test(rest)) {
      return `<${tag}${rest.replace(/style\s*=\s*"/i, `style="font-family:${MAIL_FONT};`)}>`;
    }
    return `<${tag}${rest} style="font-family:${MAIL_FONT}">`;
  });
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function emailButton(href, label) {
  const url = String(href || '').trim();
  if (!url) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px"><tr><td style="border-radius:8px;background:#0b6e6a;font-family:${MAIL_FONT}">`
    + `<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 22px;font-family:${MAIL_FONT};font-size:16px;line-height:1.2;color:#ffffff;text-decoration:none;font-weight:700">${escapeHtml(label)}</a>`
    + `</td></tr></table>`;
}

/** Full-width stacked actions. The first button is the primary choice. */
export function emailButtonStack(buttons) {
  return (buttons || []).map((button) => {
    const url = String(button?.href || '').trim();
    if (!url) return '';
    const secondary = button.tone === 'secondary';
    const background = secondary ? '#ffffff' : '#0b6e6a';
    const color = secondary ? '#0b6e6a' : '#ffffff';
    const border = secondary ? 'border:1px solid #c5d0d8;' : '';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0"><tr><td align="center" style="border-radius:8px;background:${background};${border}font-family:${MAIL_FONT}">`
      + `<a href="${escapeHtml(url)}" style="display:block;padding:14px 18px;font-family:${MAIL_FONT};font-size:16px;line-height:1.2;color:${color};text-decoration:none;font-weight:700">${escapeHtml(button.label)}</a>`
      + `</td></tr></table>`;
  }).join('');
}

export function factTable(rows) {
  const body = (rows || []).filter(([, value]) => value != null && String(value).trim() !== '').map(([label, value]) => (
    `<tr>`
    + `<td style="padding:7px 16px 7px 0;font-family:${MAIL_FONT};font-size:13px;line-height:1.4;color:#5c6b7a;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>`
    + `<td style="padding:7px 0;font-family:${MAIL_FONT};font-size:14px;line-height:1.4;color:#14202b;font-weight:600">${escapeHtml(value)}</td>`
    + `</tr>`
  )).join('');
  if (!body) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;border-collapse:collapse">${body}</table>`;
}

export function tripSummaryRows(record = {}) {
  const rows = [
    ['Trip ID', record.tripId],
    ['Tail', record.tail],
    ['Aircraft', record.aircraftType],
  ];
  const legs = Array.isArray(record.legs) ? record.legs : [];
  if (legs.length > 0) {
    legs.forEach((leg, index) => {
      const when = String(leg.departAt || leg.date || '').slice(0, 32);
      const route = [leg.from, leg.to].filter(Boolean).join(' → ');
      rows.push([`Leg ${index + 1}`, [route, when].filter(Boolean).join(' · ')]);
    });
  } else if (record.route) {
    rows.push(['Route', record.route]);
  }
  const dates = record.datesLabel || [record.departDate, record.returnDate].filter(Boolean).join(' – ');
  rows.push(['Dates', dates]);
  return rows;
}

/**
 * @param {{preheader?: string, kicker?: string, headline: string, lede?: string, body?: string, footer?: string, coBrand?: boolean}} input
 */
export function emailShell({
  preheader = '',
  kicker = 'Skyway Aviation',
  headline,
  lede = '',
  body = '',
  footer = '',
  coBrand = false,
} = {}) {
  const brand = coBrand ? 'Skyway Aviation · Charter Flight Support' : kicker;
  const footerHtml = footer || `Questions: <a href="mailto:${SKYWAY_CONTACT_EMAIL}" style="font-family:${MAIL_FONT};color:#0b6e6a;text-decoration:none">${SKYWAY_CONTACT_EMAIL}</a>`;
  return stampMailFonts(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(headline)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .aog-page, .aog-page > tbody > tr > td { background:#0c1218 !important; }
  .aog-card { background:#151d27 !important; }
  .aog-ink, .aog-card h1, .aog-card p, .aog-card td { color:#f4f7fb !important; }
  .aog-muted { color:#b7c3d0 !important; }
  .aog-rule { border-color:#2a3848 !important; }
  .aog-soft { background:#1c2833 !important; }
  .aog-page, .aog-page td, .aog-page th, .aog-page p, .aog-page a, .aog-page h1, .aog-page h2, .aog-page h3, .aog-page span {
    font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif !important;
  }
}
</style></head>
<body class="aog-page" style="margin:0;padding:0;background:#e7edf2;font-family:${MAIL_FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="aog-page" style="background:#e7edf2">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="aog-card" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#0b1f33;padding:22px 28px">
<img src="${SKYWAY_LOGO_URL}" width="148" height="36" alt="Skyway Aviation" style="display:block;border:0;outline:none;height:36px;width:auto">
${coBrand ? `<p style="margin:10px 0 0;font-family:${MAIL_FONT};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#d5e4ea">Charter Flight Support</p>` : ''}
</td></tr>
<tr><td style="padding:28px 28px 8px;font-family:${MAIL_FONT}">
<p class="aog-muted" style="margin:0;font-family:${MAIL_FONT};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#5c6b7a">${escapeHtml(brand)}</p>
<h1 class="aog-ink" style="margin:10px 0 0;font-family:${MAIL_FONT};font-size:28px;line-height:1.2;font-weight:700;color:#14202b">${escapeHtml(headline)}</h1>
${lede ? `<p class="aog-ink" style="margin:14px 0 0;font-family:${MAIL_FONT};font-size:15px;line-height:1.4;color:#243140">${lede}</p>` : ''}
</td></tr>
<tr><td style="padding:8px 28px 24px;font-family:${MAIL_FONT}">${body}</td></tr>
<tr><td class="aog-rule" style="padding:16px 28px 22px;border-top:1px solid #e4ebf1;font-family:${MAIL_FONT}">
<p class="aog-muted" style="margin:0;font-family:${MAIL_FONT};font-size:12px;line-height:1.4;color:#5c6b7a">${footerHtml}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`);
}
