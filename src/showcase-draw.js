// Canvas marks for the trade-show replay. No DOM nodes per aircraft.
// Strokes stay on the main thread: wide translucent passes stand in for
// shadowBlur so a few hundred legs can still repaint at 60fps.

import { showcaseColorKey, showcaseTailPalette } from './showcase-replay.js';

const SPARKLE = ['#fff', '#fef9c3', '#e0f2fe'];

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

export function routeGradient(ctx, points, core, edge) {
  const start = points?.[0];
  const end = points?.[points.length - 1];
  if (!start || !end) return core;
  const gradient = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
  gradient.addColorStop(0, core);
  gradient.addColorStop(0.5, edge);
  gradient.addColorStop(1, core);
  return gradient;
}

export function drawSettledRoute(ctx, points, tail) {
  if (!points || points.length < 2) return;
  const { core, edge } = showcaseTailPalette(tail);
  const last = points.length - 1;
  strokeRoute(ctx, points, 0, last, core, 7, 0.13);
  strokeRoute(ctx, points, 0, last, routeGradient(ctx, points, core, edge), 2.5, 0.62);
}

export function drawLiveRoute(ctx, points, head, tail, dense = false) {
  if (!points || head < 1) return;
  const { core, edge } = showcaseTailPalette(tail);
  if (dense) {
    strokeRoute(ctx, points, Math.max(0, head - 5), head, core, 3.2, 0.92);
    return;
  }
  const glowFrom = Math.max(0, head - Math.ceil(points.length * 0.24));
  strokeRoute(ctx, points, 0, head, core, 2.2, 0.28);
  strokeRoute(ctx, points, glowFrom, head, routeGradient(ctx, points, edge, '#ffffff'), 7, 0.22);
  strokeRoute(ctx, points, glowFrom, head, '#f8fffe', 2.2, 0.92);
}

export function drawSparkles(ctx, points, head, time) {
  if (!points || head < 1) return;
  const start = Math.max(0, head - 7);
  for (let i = start; i <= head; i += 1) {
    const point = points[i];
    if (!point) continue;
    const fade = (i - start) / Math.max(1, head - start);
    const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time / 120 + i * 1.7));
    const wobble = Math.sin(time / 180 + i) * 3.5;
    ctx.globalAlpha = fade * twinkle * 0.42;
    ctx.fillStyle = SPARKLE[i % SPARKLE.length];
    ctx.beginPath();
    ctx.arc(point.x + wobble, point.y, 1 + fade * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Top-down jet. `bank` leans the wings through a turn, in degrees. */
export function drawPlane(ctx, x, y, heading, bank, color, dense = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((heading * Math.PI) / 180);
  const lean = Math.max(-1, Math.min(1, bank / 32));
  ctx.transform(1, lean * 0.42, 0, 1, 0, 0);
  if (!dense) {
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.quadraticCurveTo(4, -8, 5, -2);
  ctx.lineTo(16, 3);
  ctx.quadraticCurveTo(16, 7, 5, 5);
  ctx.lineTo(3.2, 12);
  ctx.lineTo(8, 15);
  ctx.lineTo(0, 12.5);
  ctx.lineTo(-8, 15);
  ctx.lineTo(-3.2, 12);
  ctx.lineTo(-5, 5);
  ctx.quadraticCurveTo(-16, 7, -16, 3);
  ctx.lineTo(-5, -2);
  ctx.quadraticCurveTo(-4, -8, 0, -18);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(6, 10, 16, 0.88)';
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, -8, 2.1, 3.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  ctx.restore();
}

const STARS = Array.from({ length: 64 }, (_, index) => ({
  x: ((index * 97) % 1000) / 1000,
  y: ((index * 53) % 1000) / 1000,
  r: 0.8 + (index % 3) * 0.7,
  phase: index * 1.3,
}));

export function drawStars(ctx, width, height, time) {
  ctx.fillStyle = '#f8fbff';
  for (const star of STARS) {
    const twinkle = 0.12 + 0.28 * (0.5 + 0.5 * Math.sin(time / 880 + star.phase));
    ctx.globalAlpha = twinkle;
    ctx.fillRect(star.x * width, star.y * height * 0.42, star.r, star.r);
  }
  ctx.globalAlpha = 1;
}

export function drawAirports(ctx, airports, time, pops, dense = false) {
  const now = time;
  for (const airport of airports) {
    const pop = pops.get(airport.code);
    const age = pop ? Math.min(1, (now - pop) / 700) : 1;
    const bounce = age < 1 ? 1 + 0.7 * (1 - age) : 1;
    const pulse = 1 + 0.1 * Math.sin(now / 380 + airport.x);
    const radius = Math.min(15, (4.5 + Math.sqrt(airport.n) * 1.7) * pulse * bounce);
    if (!dense) {
      ctx.beginPath();
      ctx.arc(airport.x, airport.y, radius * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#5eead4';
      ctx.globalAlpha = 0.08;
      ctx.fill();
    }
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(airport.x, airport.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = age < 1 ? '#fef9c3' : '#ecfeff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#5eead4';
    ctx.globalAlpha = 0.9;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function drawRipples(ctx, ripples, now) {
  for (let i = ripples.length - 1; i >= 0; i -= 1) {
    const ripple = ripples[i];
    const age = (now - ripple.born) / 1400;
    if (age >= 1) {
      ripples.splice(i, 1);
      continue;
    }
    ctx.strokeStyle = ripple.color;
    ctx.lineWidth = 1.25;
    ctx.globalAlpha = (1 - age) * 0.38;
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, 5 + age * 28, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function drawWave(ctx, projected, scheduled, holdT, holdMs) {
  const travel = Math.max(0, Math.min(1, holdT / (holdMs * 0.52)));
  for (let i = 0; i < scheduled.length; i += 1) {
    const points = projected[i];
    if (!points || points.length < 2) continue;
    const delay = (i % 19) / 19 * 0.16;
    const local = Math.max(0, Math.min(1, (travel - delay) / 0.84));
    if (local <= 0) continue;
    const head = Math.max(1, Math.round(local * (points.length - 1)));
    const { core, edge } = showcaseTailPalette(showcaseColorKey(scheduled[i]));
    const bright = local > 0.92;
    strokeRoute(ctx, points, 0, head, core, bright ? 3.2 : 2.4, bright ? 0.9 : 0.62);
    if (!bright) strokeRoute(ctx, points, Math.max(0, head - 3), head, edge, 6, 0.35);
  }
}

