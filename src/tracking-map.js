/* =============================================================================
   SHARED AIRCRAFT TRACKING MAP TOOLKIT
   =============================================================================
   One implementation of the map primitives used by every tracking surface:
   the ops Tracking screen, the TV flight board, and the public broker page.

   Before this module each of those three screens carried its own copy of the
   Leaflet loader, its own basemap choice, and its own plane marker HTML — so
   the broker page and the ops screen disagreed about what a tracked aircraft
   looks like. Everything visual lives here now.

   Leaflet is loaded from a CDN rather than npm on purpose: the broker page is
   a cold-start public route and must not pull a map library into the main
   bundle for users who never open a map.
   ============================================================================= */

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';

let leafletPromise = null;

/** Loads Leaflet once per page and resolves with the global `L`. */
export function loadLeaflet() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;

  leafletPromise = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
    link.integrity = LEAFLET_CSS_SRI;
    link.crossOrigin = '';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
    script.integrity = LEAFLET_JS_SRI;
    script.crossOrigin = '';
    script.async = true;
    script.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet failed to load')));
    script.onerror = () => reject(new Error('Failed to load Leaflet'));
    document.head.appendChild(script);
  });
  return leafletPromise;
}

/* ─── WEATHER RADAR ──────────────────────────────────────────────────────────
   RainViewer publishes a free index of recent composite radar frames. We show
   the most recent *observed* frame (never a nowcast) so what ops sees on the
   map is measured weather, and refresh on the same cadence RainViewer
   publishes new frames.
   ─────────────────────────────────────────────────────────────────────────── */
const RADAR_INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_REFRESH_MS = 5 * 60 * 1000;

/**
 * Attaches a self-refreshing radar layer to a Leaflet map.
 * Returns a controller: `{ destroy() }`. `onFrame` receives the frame's epoch
 * seconds so callers can show the observation time next to the toggle.
 */
export function createRadarLayer(L, map, { opacity = 0.55, onFrame } = {}) {
  let layer = null;
  let timer = null;
  let destroyed = false;

  async function refresh() {
    try {
      const res = await fetch(RADAR_INDEX_URL);
      if (!res.ok) return;
      const index = await res.json();
      const past = Array.isArray(index?.radar?.past) ? index.radar.past : [];
      const frame = past[past.length - 1];
      if (!frame || destroyed) return;

      // size 512 / colour scheme 2 (NWS palette) / smoothed with snow shown.
      const url = `${index.host}${frame.path}/512/{z}/{x}/{y}/2/1_1.png`;
      const next = L.tileLayer(url, {
        tileSize: 512,
        zoomOffset: -1,
        opacity,
        attribution: '<a href="https://www.rainviewer.com">RainViewer</a>',
      });
      next.addTo(map);

      // Swap only after the replacement is attached so the map never flashes
      // an empty radar pane between frames.
      if (layer) {
        try { map.removeLayer(layer); } catch { /* already gone */ }
      }
      layer = next;
      if (onFrame) onFrame(frame.time);
    } catch {
      /* Radar is supplementary — never surface a failure as a map error. */
    }
  }

  refresh();
  timer = setInterval(refresh, RADAR_REFRESH_MS);

  return {
    destroy() {
      destroyed = true;
      if (timer) clearInterval(timer);
      if (layer) {
        try { map.removeLayer(layer); } catch { /* already gone */ }
      }
      layer = null;
    },
  };
}

/* ─── ALTITUDE-CODED TRAIL ───────────────────────────────────────────────────
   Colouring the flown path by altitude is how every serious tracking product
   renders a trail: climb, cruise and descent become readable at a glance
   instead of one flat line.
   ─────────────────────────────────────────────────────────────────────────── */
const ALTITUDE_STOPS = [
  { ft: 0, color: [34, 197, 94] },      // ground / departure
  { ft: 5000, color: [132, 225, 188] },
  { ft: 12000, color: [103, 232, 249] },
  { ft: 20000, color: [34, 211, 238] },
  { ft: 30000, color: [96, 165, 250] },
  { ft: 40000, color: [167, 139, 250] },
  { ft: 51000, color: [244, 114, 182] },
];

export const ALTITUDE_LEGEND = [
  { label: 'GND', ft: 0 },
  { label: '10k', ft: 10000 },
  { label: '20k', ft: 20000 },
  { label: '30k', ft: 30000 },
  { label: 'FL400+', ft: 40000 },
];

/** Interpolated altitude colour. Falls back to the accent cyan when unknown. */
export function altitudeColor(ft) {
  if (!Number.isFinite(ft)) return '#3FA9CC';
  const alt = Math.max(0, ft);
  let lower = ALTITUDE_STOPS[0];
  let upper = ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1];
  for (let i = 0; i < ALTITUDE_STOPS.length - 1; i += 1) {
    if (alt >= ALTITUDE_STOPS[i].ft && alt <= ALTITUDE_STOPS[i + 1].ft) {
      lower = ALTITUDE_STOPS[i];
      upper = ALTITUDE_STOPS[i + 1];
      break;
    }
  }
  const span = upper.ft - lower.ft;
  const t = span > 0 ? (alt - lower.ft) / span : 0;
  const channel = (i) => Math.round(lower.color[i] + (upper.color[i] - lower.color[i]) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/**
 * Normalizes the several trail shapes this codebase produces into one
 * `{ lat, lon, altitude }` list:
 *   - track-log points  `{ lat, lon, altitude_ft }`
 *   - positions API     `[lon, lat]` GeoJSON pairs
 *   - broker payload    `[lat, lon]` tuples
 */
export function normalizeTrail(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      // Ambiguous pair. Latitude is bounded to ±90, so a first value outside
      // that range can only be a longitude — which identifies GeoJSON order.
      const [a, b] = raw;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (Math.abs(a) > 90 && Math.abs(b) <= 90) out.push({ lat: b, lon: a, altitude: null });
      else out.push({ lat: a, lon: b, altitude: null });
      continue;
    }
    const lat = Number.isFinite(raw.lat) ? raw.lat : raw.latitude;
    const lon = Number.isFinite(raw.lon) ? raw.lon : raw.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const alt = Number.isFinite(raw.altitude_ft) ? raw.altitude_ft
      : Number.isFinite(raw.altitude) ? raw.altitude
        : null;
    out.push({ lat, lon, altitude: alt, time: raw.time ?? null, groundspeed: raw.groundspeed_kt ?? null });
  }
  return out;
}

function airportCodesMatch(a, b) {
  const left = String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const right = String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!left || !right) return false;
  if (left === right) return true;
  return (left.length === 4 && left.startsWith('K') && left.slice(1) === right)
    || (right.length === 4 && right.startsWith('K') && right.slice(1) === left);
}

function finitePoint(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { lat: latitude, lon: longitude }
    : null;
}

/**
 * Builds the public broker map's filed-route layer independently from the
 * FlightAware breadcrumb trail. Endpoint coordinates prefer the bundled
 * airport database, then FlightAware's whitelisted origin/destination
 * coordinates for the active flight.
 */
export function buildBrokerRouteScene({
  legs = [],
  lookupCoords,
  position = null,
  trail = [],
  phaseForLeg,
  phaseColors = {},
} = {}) {
  const airports = new Map();
  const routes = [];
  let projected = null;
  const normalizedTrail = normalizeTrail(trail);

  const resolveEndpoint = (code, role) => {
    const bundled = typeof lookupCoords === 'function' ? lookupCoords(code) : null;
    const bundledPoint = finitePoint(bundled?.lat, bundled?.lng ?? bundled?.lon);
    if (bundledPoint) return bundledPoint;
    const expected = role === 'origin' ? position?.origin : position?.destination;
    if (!airportCodesMatch(code, expected)) return null;
    return role === 'origin'
      ? finitePoint(position?.originLat, position?.originLon)
      : finitePoint(position?.destinationLat, position?.destinationLon);
  };

  for (const leg of Array.isArray(legs) ? legs : []) {
    const from = resolveEndpoint(leg.from, 'origin');
    const to = resolveEndpoint(leg.to, 'destination');
    const phase = typeof phaseForLeg === 'function' ? phaseForLeg(leg) : 'pending';
    const fromCode = String(leg.from || '').toUpperCase();
    const toCode = String(leg.to || '').toUpperCase();

    if (from && !airports.has(fromCode)) {
      airports.set(fromCode, {
        code: leg.from, lat: from.lat, lon: from.lon, tone: 'origin', small: true,
      });
    }
    if (to) {
      airports.set(toCode, {
        code: leg.to,
        lat: to.lat,
        lon: to.lon,
        tone: phase === 'landed' || phase === 'completed' ? 'neutral' : 'destination',
        small: true,
      });
    }

    // The filed route remains visible for every phase, including while the
    // actual breadcrumb trail is drawing. It is intentionally dashed so the
    // broker can distinguish planned routing from the flown path.
    if (from && to) {
      routes.push({
        points: [[from.lat, from.lon], [to.lat, to.lon]],
        color: phaseColors[phase] || phaseColors.pending || '#3FA9CC',
        weight: phase === 'airborne' ? 3.5 : 3,
        opacity: phase === 'landed' || phase === 'completed' ? 0.72 : 0.95,
        dashed: true,
        casing: true,
        kind: 'filed',
      });
    }

    if (phase === 'airborne' && to) {
      const havePosition = position?.airborne === true
        && Number.isFinite(position.latitude)
        && Number.isFinite(position.longitude);
      if (normalizedTrail.length >= 2) {
        const last = normalizedTrail[normalizedTrail.length - 1];
        projected = [[last.lat, last.lon], [to.lat, to.lon]];
      } else if (havePosition) {
        projected = [[position.latitude, position.longitude], [to.lat, to.lon]];
      }
    }
  }

  return { airports: Array.from(airports.values()), routes, projected };
}

/**
 * Draws the flown path as altitude-coloured segments into `group`.
 * Returns the `[lat, lon]` points so callers can include the trail when
 * fitting bounds. When no altitude data exists it degrades to a single
 * accent-coloured line rather than rendering nothing.
 */
export function drawAltitudeTrail(L, group, trail, { weight = 4, opacity = 0.95, colored = true } = {}) {
  const pts = normalizeTrail(trail);
  if (pts.length < 2) return pts.map((p) => [p.lat, p.lon]);

  const hasAltitude = colored && pts.some((p) => Number.isFinite(p.altitude));

  if (!hasAltitude) {
    L.polyline(pts.map((p) => [p.lat, p.lon]), {
      color: '#3FA9CC', weight, opacity, lineCap: 'round', lineJoin: 'round',
    }).addTo(group);
    return pts.map((p) => [p.lat, p.lon]);
  }

  // A casing underneath keeps a thin multi-colour path legible over bright
  // satellite tiles without washing out the altitude colours themselves.
  L.polyline(pts.map((p) => [p.lat, p.lon]), {
    color: '#020617', weight: weight + 3, opacity: 0.5, lineCap: 'round', lineJoin: 'round',
  }).addTo(group);

  let lastKnownAlt = null;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (Number.isFinite(a.altitude)) lastKnownAlt = a.altitude;
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
      color: altitudeColor(lastKnownAlt),
      weight,
      opacity,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(group);
  }
  return pts.map((p) => [p.lat, p.lon]);
}

/* ─── MARKERS ────────────────────────────────────────────────────────────── */

/** `FL350` above the transition altitude, plain feet below. */
export function formatAltitude(ft) {
  if (!Number.isFinite(ft)) return '';
  if (ft >= 18000) return `FL${Math.round(ft / 100)}`;
  return `${Math.round(ft).toLocaleString()} ft`;
}

export function formatSpeed(kt) {
  return Number.isFinite(kt) ? `${Math.round(kt)} kt` : '';
}

const PLANE_PATH = 'M12 2 L13.5 10 L22 12 L22 14 L13.5 14 L13 19 L15 21 L15 22 L12 21 L9 22 L9 21 L11 19 L10.5 14 L2 14 L2 12 L10.5 10 Z';

/**
 * Aircraft marker. `heading` rotates the silhouette; the label block carries
 * tail, altitude and speed so the map is readable without a side panel.
 */
export function aircraftIcon(L, {
  tail,
  heading = 0,
  altitude = null,
  groundspeed = null,
  selected = false,
  showLabel = true,
} = {}) {
  const size = selected ? 34 : 26;
  const color = selected ? '#3FA9CC' : '#8FCADF';
  const glow = selected
    ? 'filter: drop-shadow(0 0 6px rgba(34,211,238,0.85));'
    : 'filter: drop-shadow(0 0 3px rgba(14,165,233,0.5));';

  const readout = [formatAltitude(altitude), formatSpeed(groundspeed)].filter(Boolean).join(' · ');
  const label = showLabel ? `
    <div style="position:absolute; left:${size + 6}px; top:50%; transform:translateY(-50%); pointer-events:none; white-space:nowrap;">
      <div style="background:rgba(2,6,23,0.9); border:1px solid ${selected ? 'rgba(34,211,238,0.6)' : 'rgba(125,211,252,0.35)'}; border-radius:4px; padding:2px 6px;">
        <div style="font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700; line-height:1.2; color:${selected ? '#a5f3fc' : '#bae6fd'};">${tail || ''}</div>
        ${readout ? `<div style="font-family:'JetBrains Mono',monospace; font-size:9px; line-height:1.3; color:#67e8f9;">${readout}</div>` : ''}
      </div>
    </div>` : '';

  return L.divIcon({
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `
      <div style="position:relative; width:${size}px; height:${size}px; cursor:pointer;">
        <svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${heading}deg); transform-origin:center; ${glow}">
          <path d="${PLANE_PATH}" fill="${color}" stroke="#082f49" stroke-width="0.6"/>
        </svg>
        ${label}
      </div>`,
  });
}

const AIRPORT_TONES = {
  origin: { dot: '#22c55e', text: '#86efac' },
  destination: { dot: '#f59e0b', text: '#fcd34d' },
  neutral: { dot: '#94a3b8', text: '#cbd5e1' },
};

/** Airport pin with its identifier set beside the dot. */
export function airportIcon(L, { code, tone = 'neutral', small = false } = {}) {
  const t = AIRPORT_TONES[tone] || AIRPORT_TONES.neutral;
  const dot = small ? 8 : 11;
  return L.divIcon({
    className: '',
    iconSize: [dot, dot],
    iconAnchor: [dot / 2, dot / 2],
    html: `
      <div style="position:relative;">
        <div style="width:${dot}px; height:${dot}px; border-radius:50%; background:${t.dot}; border:2px solid #020617; box-shadow:0 0 0 2px ${t.dot}44;"></div>
        ${code ? `<div style="position:absolute; left:${dot + 5}px; top:50%; transform:translateY(-50%); font-family:'JetBrains Mono',monospace; font-size:${small ? 9 : 10}px; font-weight:600; color:${t.text}; background:rgba(2,6,23,0.85); padding:1px 5px; border-radius:3px; white-space:nowrap;">${code}</div>` : ''}
      </div>`,
  });
}

/** Small parked-aircraft dot, used for the rest of the fleet. */
export function groundedIcon(L, { tail, at, selected = false } = {}) {
  const dot = selected ? 13 : 9;
  const border = selected ? '2px solid #94a3b8' : '1.5px solid #475569';
  return L.divIcon({
    className: '',
    iconSize: [dot, dot],
    iconAnchor: [dot / 2, dot / 2],
    html: `
      <div style="position:relative; cursor:pointer;">
        <div style="width:${dot}px; height:${dot}px; border-radius:50%; background:#1e293b; border:${border};"></div>
        <div style="position:absolute; left:${dot + 5}px; top:50%; transform:translateY(-50%); display:flex; gap:4px; align-items:center; pointer-events:none; white-space:nowrap;">
          <span style="font-family:'JetBrains Mono',monospace; font-size:9px; font-weight:${selected ? 700 : 500}; color:${selected ? '#cbd5e1' : '#64748b'}; background:rgba(2,6,23,0.8); padding:1px 5px; border-radius:3px;">${tail || ''}</span>
          ${at ? `<span style="font-family:'JetBrains Mono',monospace; font-size:8px; color:#64748b; background:rgba(2,6,23,0.65); padding:1px 5px; border-radius:3px;">${at}</span>` : ''}
        </div>
      </div>`,
  });
}

/* ─── FLIGHT-RULES COLOURS ───────────────────────────────────────────────────
   Standard aviation flight-category colours, shared by the ops weather strip
   and the broker weather cards so a green station means the same thing on
   both screens.
   ─────────────────────────────────────────────────────────────────────────── */
export const FLIGHT_CATEGORY_COLORS = {
  VFR: { text: 'text-success', dot: '#34d399', label: 'VFR' },
  MVFR: { text: 'text-info', dot: '#60a5fa', label: 'MVFR' },
  IFR: { text: 'text-danger', dot: '#f87171', label: 'IFR' },
  LIFR: { text: 'text-warning', dot: '#c084fc', label: 'LIFR' },
};

export function flightCategoryStyle(category) {
  return FLIGHT_CATEGORY_COLORS[String(category || '').toUpperCase()] || {
    text: 'text-content-muted', dot: '#64748b', label: category || '—',
  };
}

/** Great-circle distance in nautical miles. */
export function distanceNm(a, b) {
  if (!a || !b) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3440.065;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
