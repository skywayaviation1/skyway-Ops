// Thin brand arcs and a small aircraft mark for the trade-show replay.
// One stroke per route, no shadow and no sparkle, so a few thousand settled
// legs can still repaint at 60fps.

const ARC = '#3FA9CC';
const ARC_LIVE = '#E7F3F8';
const INK = '#f4f7fa';
const DOT = 'rgba(216, 228, 236, 0.92)';

export function strokeRoute(ctx, points, from, to, style, width, alpha) {
  if (!points || to - from < 1) return;
  ctx.beginPath();
  let pen = false;
  for (let i = from; i <= to; i += 1) {
    const point = points[i];
    if (!point) continue;
    if (!pen) {
      ctx.moveTo(point.x, point.y);
      pen = true;
      continue;
    }
    const prev = points[i - 1];
    if (prev && Math.hypot(point.x - prev.x, point.y - prev.y) > 320) {
      ctx.moveTo(point.x, point.y);
      continue;
    }
    ctx.lineTo(point.x, point.y);
  }
  ctx.strokeStyle = style;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawSettledRoute(ctx, points) {
  if (!points || points.length < 2) return;
  strokeRoute(ctx, points, 0, points.length - 1, ARC, 1.35, 0.42);
}

export function drawLiveRoute(ctx, points, head, dense = false) {
  if (!points || head < 1) return;
  const from = dense
    ? Math.max(0, head - 5)
    : Math.max(0, head - Math.min(10, points.length - 1));
  strokeRoute(ctx, points, from, head, ARC_LIVE, dense ? 1.5 : 1.75, 0.95);
}

/** Small top-down jet. `bank` leans the wings through a turn, in degrees. */
export function drawPlane(ctx, x, y, heading, bank) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((heading * Math.PI) / 180);
  const lean = Math.max(-1, Math.min(1, bank / 28));
  ctx.transform(1, lean * 0.22, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(1.7, -3.2);
  ctx.lineTo(10, 1.2);
  ctx.lineTo(1.6, 2.2);
  ctx.lineTo(0.9, 7.2);
  ctx.lineTo(0, 5.6);
  ctx.lineTo(-0.9, 7.2);
  ctx.lineTo(-1.6, 2.2);
  ctx.lineTo(-10, 1.2);
  ctx.lineTo(-1.7, -3.2);
  ctx.closePath();
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.restore();
}

export function drawAirports(ctx, airports) {
  for (const airport of airports) {
    const radius = Math.min(3.4, 1.5 + Math.sqrt(airport.n) * 0.22);
    ctx.beginPath();
    ctx.arc(airport.x, airport.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = DOT;
    ctx.fill();
  }
}
