// Per-tenant sample operations.
//
// The harness renders the same product for whichever operator is being shown, so
// the fleet, crew, customers and base airport are declared here and everything
// else in sample-data.js is derived from them. Adding an operator to demonstrate
// the platform to is a matter of adding an entry.
//
// Every name, registration, customer and passenger below is invented.

const TENANTS = {
  skyway: {
    id: 'skyway',
    company: 'Skyway Aviation',
    companyLegal: 'Skyway Aviation LLC',
    domain: 'flyskyway.com',
    charterInbox: 'charters@flyskyway.com',
    base: 'IAD',

    fleet: [
      { tail: 'N444AM', type: 'C56X', displayName: 'Citation XLS+', home: 'IAD' },
      { tail: 'N286N', type: 'C25B', displayName: 'Citation CJ3', home: 'TVC' },
      { tail: 'N651TW', type: 'C680', displayName: 'Citation Sovereign', home: 'APF' },
      { tail: 'N20UF', type: 'CL35', displayName: 'Challenger 350', home: 'TEB' },
      { tail: 'N551FP', type: 'E55P', displayName: 'Phenom 300', home: 'PBI' },
      { tail: 'N168ZZ', type: 'H25B', displayName: 'Hawker 900XP', home: 'FXE' },
      { tail: 'N525CR', type: 'C525', displayName: 'Citation CJ1', home: 'FLL' },
      { tail: 'N9021Q', type: 'BE20', displayName: 'King Air 200', home: 'IAD' },
    ],

    // The first pilot is the one whose phone the booklet shows.
    crew: [
      { uid: 'pilot-max', name: 'Maxwell Hagberg', first: 'Maxwell', role: 'crew' },
      { uid: 'pilot-tim', name: 'Timothy Woods', first: 'Timothy', role: 'crew' },
      { uid: 'pilot-mel', name: 'Melissa Rippy', first: 'Melissa', role: 'crew' },
      { uid: 'pilot-dana', name: 'Dana Whitfield', first: 'Dana', role: 'crew' },
      { uid: 'pilot-cade', name: 'Cade Kaftel', first: 'Cade', role: 'crew' },
      { uid: 'pilot-jen', name: 'Jenelle Szelest', first: 'Jenelle', role: 'crew' },
      { uid: 'pilot-grant', name: 'Grant Ellis', first: 'Grant', role: 'crew' },
      { uid: 'pilot-andre', name: 'Andre Cole', first: 'Andre', role: 'crew' },
    ],
    staff: [
      { uid: 'admin-1', name: 'Jim Skyway', first: 'Jim', role: 'admin', title: 'Director of Operations' },
      { uid: 'ops-1', name: 'Jordan Vance', first: 'Jordan', role: 'ops', title: 'Operations Controller' },
      { uid: 'sales-1', name: 'Rosa Delgado', first: 'Rosa', role: 'sales', title: 'Charter Sales' },
      { uid: 'maint-1', name: 'Nina Park', first: 'Nina', role: 'maint', title: 'Director of Maintenance' },
    ],

    customers: [
      'Outlier Jets', 'Monarch Air Group', 'Jet Linx Aviation', 'Private Jet Co',
      'Victor US Flight Management', 'Coastal Air Charter',
    ],
    passengers: ['Alexander Whitmore', 'Caroline Whitmore', 'Renard Delacroix', 'Sylvia Ambrose'],

    // Hours from the day anchor; the schedule is built from these.
    schedule: [
      { uid: 'sky-1003', tail: 'N286N', customer: 'Monarch Air Group', from: 'TVC', to: 'IAD', type: 'Charter', pax: 4, picIdx: 4, sicIdx: 5, startH: 0.2, endH: 2.4 },
      { uid: 'sky-1001', tail: 'N444AM', customer: 'Outlier Jets', from: 'IAD', to: 'HYA', type: 'Charter', pax: 4, picIdx: 0, sicIdx: 1, startH: 2.8, endH: 4.4 },
      { uid: 'sky-1004', tail: 'N651TW', customer: 'Jet Linx Aviation', from: 'APF', to: 'DFW', type: 'Charter', pax: 3, picIdx: 2, sicIdx: 7, startH: 3.2, endH: 6.1 },
      { uid: 'sky-1005', tail: 'N20UF', customer: 'Private Jet Co', from: 'TEB', to: 'PBI', type: 'Charter', pax: 7, picIdx: 3, sicIdx: 6, startH: 4.6, endH: 7.4 },
      { uid: 'sky-1002', tail: 'N444AM', customer: 'Outlier Jets', from: 'HYA', to: 'TEB', type: 'Charter', pax: 4, picIdx: 0, sicIdx: 1, startH: 8, endH: 9.4 },
      { uid: 'sky-1006', tail: 'N551FP', customer: 'Skyway Aviation', from: 'PBI', to: 'OPF', type: 'Positioning', pax: 0, picIdx: 5, sicIdx: 6, startH: 9, endH: 9.9 },
      { uid: 'sky-1007', tail: 'N168ZZ', customer: 'Victor US Flight Management', from: 'FXE', to: 'MDW', type: 'Charter', pax: 5, picIdx: 6, sicIdx: 3, startH: 10.5, endH: 13.4 },
      { uid: 'sky-1008', tail: 'N525CR', customer: 'Coastal Air Charter', from: 'FLL', to: 'CHS', type: 'Charter', pax: 4, picIdx: 7, sicIdx: 2, startH: 12, endH: 13.6 },
    ],
  },

  elite: {
    id: 'elite',
    company: 'Elite Jets',
    companyLegal: 'Elite Jets',
    domain: 'elitejets.com',
    charterInbox: 'charters@elitejets.com',
    base: 'APF',

    fleet: [
      { tail: 'N880EJ', type: 'C680', displayName: 'Citation Sovereign+', home: 'APF' },
      { tail: 'N512EJ', type: 'C56X', displayName: 'Citation XLS+', home: 'APF' },
      { tail: 'N207EJ', type: 'CL35', displayName: 'Challenger 350', home: 'FXE' },
      { tail: 'N955EJ', type: 'E55P', displayName: 'Phenom 300E', home: 'PBI' },
      { tail: 'N418EJ', type: 'H25B', displayName: 'Hawker 900XP', home: 'RSW' },
      { tail: 'N726EJ', type: 'E550', displayName: 'Legacy 500', home: 'APF' },
      { tail: 'N139EJ', type: 'B350', displayName: 'King Air 350i', home: 'SRQ' },
      { tail: 'N604EJ', type: 'C25B', displayName: 'Citation CJ3+', home: 'APF' },
    ],

    crew: [
      { uid: 'pilot-marcus', name: 'Marcus Delaney', first: 'Marcus', role: 'crew' },
      { uid: 'pilot-simone', name: 'Simone Aldridge', first: 'Simone', role: 'crew' },
      { uid: 'pilot-priya', name: 'Priya Raghunathan', first: 'Priya', role: 'crew' },
      { uid: 'pilot-owen', name: 'Owen Castellanos', first: 'Owen', role: 'crew' },
      { uid: 'pilot-blythe', name: 'Blythe Okonkwo', first: 'Blythe', role: 'crew' },
      { uid: 'pilot-devin', name: 'Devin Marchetti', first: 'Devin', role: 'crew' },
      { uid: 'pilot-harriet', name: 'Harriet Nakamura', first: 'Harriet', role: 'crew' },
      { uid: 'pilot-tomas', name: 'Tomas Ferreira', first: 'Tomas', role: 'crew' },
    ],
    staff: [
      { uid: 'admin-1', name: 'Grant Holloway', first: 'Grant', role: 'admin', title: 'Director of Operations' },
      { uid: 'ops-1', name: 'Adelina Vargas', first: 'Adelina', role: 'ops', title: 'Operations Controller' },
      { uid: 'sales-1', name: 'Roland Pike', first: 'Roland', role: 'sales', title: 'Charter Sales' },
      { uid: 'maint-1', name: 'Greer Donnelly', first: 'Greer', role: 'maint', title: 'Director of Maintenance' },
    ],

    customers: [
      'Meridian Air Partners', 'Halcyon Charter Group', 'Vireo Aviation',
      'Southcross Jet Brokers', 'Lantern Bay Aviation', 'Continental Wing',
    ],
    passengers: ['Nathaniel Osgood', 'Priscilla Osgood', 'Emeka Adeyemi', 'Rosalind Fairbanks'],

    // A Gulf-coast day: Naples out to the northeast and back down the peninsula.
    schedule: [
      { uid: 'ej-2201', tail: 'N604EJ', customer: 'Lantern Bay Aviation', from: 'SRQ', to: 'APF', type: 'Charter', pax: 3, picIdx: 4, sicIdx: 5, startH: 0.2, endH: 2.4 },
      { uid: 'ej-2202', tail: 'N880EJ', customer: 'Meridian Air Partners', from: 'APF', to: 'TEB', type: 'Charter', pax: 6, picIdx: 0, sicIdx: 1, startH: 2.8, endH: 4.4 },
      { uid: 'ej-2203', tail: 'N207EJ', customer: 'Halcyon Charter Group', from: 'FXE', to: 'AUS', type: 'Charter', pax: 4, picIdx: 2, sicIdx: 7, startH: 3.2, endH: 6.1 },
      { uid: 'ej-2204', tail: 'N955EJ', customer: 'Vireo Aviation', from: 'PBI', to: 'BNA', type: 'Charter', pax: 5, picIdx: 3, sicIdx: 6, startH: 4.6, endH: 7.4 },
      { uid: 'ej-2205', tail: 'N880EJ', customer: 'Meridian Air Partners', from: 'TEB', to: 'ACK', type: 'Charter', pax: 6, picIdx: 0, sicIdx: 1, startH: 8, endH: 9.4 },
      { uid: 'ej-2206', tail: 'N726EJ', customer: 'Elite Jets', from: 'RSW', to: 'APF', type: 'Positioning', pax: 0, picIdx: 5, sicIdx: 6, startH: 9, endH: 9.9 },
      { uid: 'ej-2207', tail: 'N418EJ', customer: 'Southcross Jet Brokers', from: 'RSW', to: 'IAD', type: 'Charter', pax: 5, picIdx: 6, sicIdx: 3, startH: 10.5, endH: 13.4 },
      { uid: 'ej-2208', tail: 'N139EJ', customer: 'Continental Wing', from: 'APF', to: 'MCO', type: 'Charter', pax: 4, picIdx: 7, sicIdx: 2, startH: 12, endH: 13.6 },
    ],
  },
};

export const DEFAULT_TENANT = 'skyway';

export function activeTenantId() {
  if (typeof window !== 'undefined') {
    const requested = window.__TENANT__ || new URLSearchParams(window.location.search).get('tenant');
    if (requested && TENANTS[requested]) return String(requested);
  }
  return DEFAULT_TENANT;
}

export function tenant(id = activeTenantId()) {
  return TENANTS[id] || TENANTS[DEFAULT_TENANT];
}
