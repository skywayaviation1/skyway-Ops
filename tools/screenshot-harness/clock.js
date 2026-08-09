/* Pins the harness clock to a fixed wall-clock time so screenshots are
 * reproducible: the schedule always reads mid-afternoon on the operating day
 * regardless of when the capture runs. Only the "what time is it now" surface
 * is shifted — date arithmetic elsewhere is untouched.
 */

const TARGET_HOUR = 14;
const TARGET_MINUTE = 22;

/* The instant every harness process treats as "now": today at 14:22 local
 * time. The Vite server builds the schedule feed from it and the browser pins
 * its clock to it, so server-rendered times and client-seeded records agree.
 * Both processes must run with the same TZ (America/New_York). */
export function harnessAnchor() {
  const target = new Date();
  target.setHours(TARGET_HOUR, TARGET_MINUTE, 0, 0);
  return target.getTime();
}

export function installFixedClock() {
  const shift = harnessAnchor() - Date.now();
  if (!shift) return 0;

  const RealDate = Date;
  const realNow = RealDate.now;

  function ShiftedDate(...args) {
    if (!(this instanceof ShiftedDate)) return new ShiftedDate(...args).toString();
    if (args.length === 0) return new RealDate(realNow() + shift);
    return new RealDate(...args);
  }

  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = () => realNow() + shift;
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;

  // eslint-disable-next-line no-global-assign
  window.Date = ShiftedDate;
  return shift;
}

export function harnessNow() {
  return Date.now();
}
