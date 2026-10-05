/**
 * Broker white-label branding.
 *
 * Ops attaches a logo (and an optional name and accent) to a broker email.
 * The public tracking page uses that record only when a logo is actually
 * stored. A name or color on its own keeps the operator brand, so a
 * half-finished record never hides the operator behind an empty header.
 *
 * This module is pure: the API and the page both call it, and the tests
 * cover the resolution rules without Firebase.
 */

export const BROKER_LOGO_MAX_BYTES = 1_500_000;

/** Same ceiling the validator enforces, written once so the UI cannot drift. */
export const BROKER_LOGO_LIMIT_LABEL = '1.5 MB';

export const DISPLAY_NAME_MAX = 80;

/** MIME types ops may upload, and the storage extension each one uses. */
export const BROKER_LOGO_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/svg+xml': 'svg',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Firestore document id for a broker. The email is the identity the rest of
 * the product already stores on a trip, so the same address always resolves
 * to the same brand.
 */
export function brokerDocId(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normalized) || normalized.length > 200) return null;
  return normalized;
}

/** Split the free-form broker email field into unique, normalized addresses. */
export function parseBrokerEmails(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[,;\s]+/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const id = brokerDocId(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 20) break;
  }
  return out;
}

export function cleanDisplayName(input) {
  const name = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.slice(0, DISPLAY_NAME_MAX);
}

/** Accepts `#1F6B4A` or `1F6B4A`. Anything else is dropped, not guessed. */
export function normalizeAccentColor(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) return null;
  return `#${match[1].toUpperCase()}`;
}

export function contentTypeForFile({ type, name } = {}) {
  const raw = String(type || '').toLowerCase().split(';')[0].trim();
  if (BROKER_LOGO_TYPES[raw]) return raw === 'image/jpg' ? 'image/jpeg' : raw;
  const fileName = String(name || '').toLowerCase();
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
  if (fileName.endsWith('.svg')) return 'image/svg+xml';
  return '';
}

export function validateLogoMeta({ contentType, byteLength }) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  const canonical = type === 'image/jpg' ? 'image/jpeg' : type;
  const ext = BROKER_LOGO_TYPES[type];
  if (!ext) return { ok: false, error: 'Use a PNG, JPG, or SVG logo.' };
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return { ok: false, error: 'Logo file is empty.' };
  }
  if (byteLength > BROKER_LOGO_MAX_BYTES) {
    return { ok: false, error: `Logo must be ${BROKER_LOGO_LIMIT_LABEL} or smaller.` };
  }
  return { ok: true, ext, contentType: canonical };
}

export function brokerLogoPath(brokerId, ext) {
  return `broker-logos/${brokerId}/logo.${ext}`;
}

function srgbChannel(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r, g, b) {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

function contrastRatio(rgb, surface) {
  const a = relativeLuminance(rgb[0], rgb[1], rgb[2]);
  const b = relativeLuminance(surface[0], surface[1], surface[2]);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl(r, g, b) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function toHex(rgb) {
  return `#${rgb.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function rgba(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** Header graphite and a white card. Text has to clear 4.5:1 on both. */
const DARK_SURFACE = [30, 33, 38];
const LIGHT_SURFACE = [255, 255, 255];

/**
 * Keep the chosen hue, and only move lightness when the raw color would
 * disappear. A deep green stays deep on white and is lifted on graphite.
 */
function readableInk(rgb, surface) {
  if (contrastRatio(rgb, surface) >= 4.5) return rgb;
  const [h, s] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const sat = Math.min(0.62, Math.max(0.28, s || 0.45));
  const dark = relativeLuminance(surface[0], surface[1], surface[2]) < 0.4;
  if (dark) {
    for (let L = 0.28; L <= 0.84; L += 0.01) {
      const next = hslToRgb(h, sat, L);
      if (contrastRatio(next, surface) >= 4.5) return next;
    }
    return [255, 255, 255];
  }
  for (let L = 0.46; L >= 0.12; L -= 0.01) {
    const next = hslToRgb(h, sat, L);
    if (contrastRatio(next, surface) >= 4.5) return next;
  }
  return [10, 11, 13];
}

/**
 * Ink derived from a single hex accent. Soft and border tints are the same
 * hue at low opacity so the public page can use the color without repainting
 * status chips. `onDark` / `onLight` are the same hue shifted only as far as
 * readable text needs.
 */
export function accentPalette(hex) {
  const color = normalizeAccentColor(hex);
  if (!color) return null;
  const n = parseInt(color.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const [r, g, b] = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const onDark = readableInk(rgb, DARK_SURFACE);
  const onLight = readableInk(rgb, LIGHT_SURFACE);
  return {
    base: color,
    soft: `rgba(${r}, ${g}, ${b}, 0.16)`,
    border: `rgba(${r}, ${g}, ${b}, 0.45)`,
    contrast: luminance > 0.62 ? '#0A0B0D' : '#FFFFFF',
    onDark: toHex(onDark),
    onLight: toHex(onLight),
    softDark: rgba(onDark, 0.18),
    softLight: rgba(onLight, 0.12),
    lineDark: rgba(onDark, 0.72),
    lineLight: rgba(onLight, 0.55),
    glowDark: rgba(onDark, 0.35),
    glowLight: rgba(onLight, 0.2),
  };
}

const SVG_FORBIDDEN = /<script|<\/script|javascript\s*:|<foreignObject|<iframe|<embed|<object|<link[\s>]|data\s*:\s*text\/html|on[a-z]+\s*=/i;

/** Strip active content from an uploaded SVG. Logos are rendered as images. */
export function sanitizeSvg(source) {
  let text = String(source || '');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\0/g, '').trim();
  if (!/<svg[\s>]/i.test(text)) {
    return { ok: false, error: 'SVG markup is missing an <svg> root.' };
  }
  if (SVG_FORBIDDEN.test(text)) {
    return { ok: false, error: 'SVG contains unsupported content.' };
  }
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<embed\b[^>]*\/?>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<link\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '');
  if (SVG_FORBIDDEN.test(text)) {
    return { ok: false, error: 'SVG contains unsupported content.' };
  }
  if (text.length > BROKER_LOGO_MAX_BYTES) {
    return { ok: false, error: `Logo must be ${BROKER_LOGO_LIMIT_LABEL} or smaller.` };
  }
  return { ok: true, svg: withSvgIntrinsicSize(text) };
}

/**
 * An `<img>` with no intrinsic size collapses inside a shrink-wrapped plate.
 * Width and height from the viewBox give the browser a real aspect ratio.
 */
function withSvgIntrinsicSize(svg) {
  return svg.replace(/<svg\b([^>]*)>/i, (match, attrs) => {
    const hasW = /(?:^|\s)width\s*=/i.test(attrs);
    const hasH = /(?:^|\s)height\s*=/i.test(attrs);
    if (hasW && hasH) return match;
    const vb = attrs.match(/viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)\s*["']/i);
    const w = vb ? vb[1] : '240';
    const h = vb ? vb[2] : '80';
    const extra = `${hasW ? '' : ` width="${w}"`}${hasH ? '' : ` height="${h}"`}`;
    return `<svg${attrs}${extra}>`;
  });
}

/**
 * Confirm the bytes match the declared type. A renamed PDF or HTML file
 * must not be stored as a logo.
 */
export function inspectLogoBytes(buffer, contentType) {
  const meta = validateLogoMeta({ contentType, byteLength: buffer?.length || 0 });
  if (!meta.ok) return meta;
  const bytes = buffer;
  const isPng = bytes.length > 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  const isJpeg = bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (meta.contentType === 'image/png') {
    return isPng ? meta : { ok: false, error: 'File is not a PNG.' };
  }
  if (meta.contentType === 'image/jpeg') {
    return isJpeg ? meta : { ok: false, error: 'File is not a JPEG.' };
  }
  const cleaned = sanitizeSvg(Buffer.from(bytes).toString('utf8'));
  if (!cleaned.ok) return cleaned;
  return { ...meta, svg: cleaned.svg };
}

/**
 * What the public tracking page is allowed to see.
 *
 * Returns null when the broker has no stored logo. The page then keeps the
 * operator wordmark, contact line, and accent. `showPoweredBy` is off unless
 * the record says so explicitly.
 */
export function resolvePublicBranding(record, { logoUrl } = {}) {
  if (!record || typeof record !== 'object') return null;
  const hasLogo = typeof record.logoPath === 'string' && record.logoPath.startsWith('broker-logos/');
  if (!hasLogo) return null;
  const url = String(logoUrl || '').trim();
  if (!url || url.length > 2000) return null;
  const declared = String(record.logoContentType || '').toLowerCase().split(';')[0].trim();
  const canonical = declared === 'image/jpg' ? 'image/jpeg' : declared;
  const logoContentType = BROKER_LOGO_TYPES[declared] ? canonical : null;
  return {
    whiteLabel: true,
    displayName: cleanDisplayName(record.displayName),
    accentColor: normalizeAccentColor(record.accentColor),
    logoUrl: url,
    logoContentType,
    showPoweredBy: record.showPoweredBy === true,
  };
}

/**
 * Document title, description, and social image for a tracking link.
 * White-label copy names the broker. The fallback names the operator.
 */
export function trackingPageMeta({ branding, operator, origin } = {}) {
  const op = operator || {};
  const operatorName = op.name || op.shortName || 'Flight tracking';
  if (branding?.whiteLabel === true && branding.logoUrl) {
    const name = branding.displayName || null;
    const title = name ? `${name} · Flight tracking` : 'Flight tracking';
    const base = String(origin || '').replace(/\/$/, '');
    const image = /^https?:\/\//i.test(branding.logoUrl)
      ? branding.logoUrl
      : (base ? `${base}${branding.logoUrl.startsWith('/') ? '' : '/'}${branding.logoUrl}` : null);
    return {
      whiteLabel: true,
      title,
      description: name
        ? `Live flight tracking shared by ${name}.`
        : 'Live flight tracking.',
      image,
      themeColor: branding.accentColor || null,
      showPoweredBy: branding.showPoweredBy === true,
    };
  }
  return {
    whiteLabel: false,
    title: `${operatorName} · Flight tracking`,
    description: op.tagline || 'Live flight tracking.',
    image: null,
    themeColor: null,
    showPoweredBy: false,
  };
}

/** Fields ops see on the broker record. Storage paths stay on the server. */
export function brokerRecordForOps(id, data = {}) {
  return {
    email: brokerDocId(id) || brokerDocId(data.email) || id,
    displayName: cleanDisplayName(data.displayName),
    accentColor: normalizeAccentColor(data.accentColor),
    showPoweredBy: data.showPoweredBy === true,
    hasLogo: typeof data.logoPath === 'string' && data.logoPath.startsWith('broker-logos/'),
    logoContentType: data.logoContentType || null,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null,
  };
}
