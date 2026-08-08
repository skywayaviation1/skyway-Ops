/* Demo flight department: people and aircraft.
 *
 * Names, tails and customers here are fictional stand-ins used only for
 * marketing screenshots. Tails match the fleet list the app ships with so the
 * maintenance and wear modules resolve aircraft types correctly.
 */

/* Types match the fleet map the app ships with (OpsCommandCenter), so every
 * screen labels the same tail the same way. */
export const FLEET = [
  { tail: 'N444AM', type: 'King Air 350', base: 'TPA' },
  { tail: 'N525CR', type: 'CJ2+', base: 'OPF' },
  { tail: 'N286N', type: 'Citation Excel', base: 'TPA' },
  { tail: 'N20UF', type: 'Citation V', base: 'SDL' },
  { tail: 'N651TW', type: 'Falcon 50', base: 'TEB' },
  { tail: 'N551FP', type: 'CJ3', base: 'PBI' },
  { tail: 'N85AH', type: 'Hawker 800', base: 'TPA' },
  { tail: 'N168ZZ', type: 'Learjet 60', base: 'DAL' },
];

export const CURRENT_USER_UID = 'demo-ops-dana';

export const USERS = [
  {
    uid: CURRENT_USER_UID,
    name: 'Dana Whitfield',
    email: 'd.whitfield@flyskyway.com',
    role: 'admin',
    title: 'Director of Operations',
  },
  {
    uid: 'demo-ops-marco',
    name: 'Marco Ruiz',
    email: 'm.ruiz@flyskyway.com',
    role: 'ops',
    title: 'Lead Dispatcher',
  },
  {
    uid: 'demo-crew-alvarez',
    name: 'Ken Alvarez',
    email: 'k.alvarez@flyskyway.com',
    role: 'crew',
    title: 'Captain',
    certificateNumber: '3184472',
  },
  {
    uid: 'demo-crew-boyd',
    name: 'Sarah Boyd',
    email: 's.boyd@flyskyway.com',
    role: 'crew',
    title: 'Captain',
    certificateNumber: '4021866',
  },
  {
    uid: 'demo-crew-cross',
    name: 'Devin Cross',
    email: 'd.cross@flyskyway.com',
    role: 'crew',
    title: 'Captain',
    certificateNumber: '3776510',
  },
  {
    uid: 'demo-crew-nakamura',
    name: 'Rachel Nakamura',
    email: 'r.nakamura@flyskyway.com',
    role: 'crew',
    title: 'First Officer',
    certificateNumber: '4488201',
  },
  {
    uid: 'demo-crew-pruitt',
    name: 'Anthony Pruitt',
    email: 'a.pruitt@flyskyway.com',
    role: 'crew',
    title: 'Captain',
    certificateNumber: '2996134',
  },
  {
    uid: 'demo-crew-lindstrom',
    name: 'Grace Lindstrom',
    email: 'g.lindstrom@flyskyway.com',
    role: 'crew',
    title: 'First Officer',
    certificateNumber: '4610977',
  },
  {
    uid: 'demo-crew-turner',
    name: 'Miles Turner',
    email: 'm.turner@flyskyway.com',
    role: 'crew',
    title: 'Captain',
    certificateNumber: '3502988',
  },
  {
    uid: 'demo-crew-wexler',
    name: 'Owen Wexler',
    email: 'o.wexler@flyskyway.com',
    role: 'crew',
    title: 'First Officer',
    certificateNumber: '4733120',
  },
  {
    uid: 'demo-maint-boyle',
    name: 'Hank Boyle',
    email: 'h.boyle@flyskyway.com',
    role: 'maint',
    title: 'Director of Maintenance',
  },
  {
    uid: 'demo-maint-ferrer',
    name: 'Luis Ferrer',
    email: 'l.ferrer@flyskyway.com',
    role: 'maint',
    title: 'Lead Technician',
  },
  {
    uid: 'demo-sales-nolan',
    name: 'Cara Nolan',
    email: 'c.nolan@flyskyway.com',
    role: 'sales',
    title: 'Charter Sales',
  },
  {
    uid: 'demo-acct-traynor',
    name: 'Bill Traynor',
    email: 'b.traynor@flyskyway.com',
    role: 'accounting',
    title: 'Controller',
  },
];

export const PILOTS = USERS.filter((user) => user.role === 'crew');

export function userByName(name) {
  return USERS.find((user) => user.name === name) || null;
}

export function fleetType(tail) {
  return FLEET.find((aircraft) => aircraft.tail === tail)?.type || 'Citation CJ3';
}
