/**
 * Feature catalog for the control plane.
 *
 * Keys match the navigation in src/App.jsx plus modules that live inside a
 * screen. The SQL seed inserts these same rows. A child is on only when it
 * resolves on and every ancestor resolves on. Force-on on a child does not
 * turn a parent back on.
 *
 * This module is data. Live routes do not import it.
 */

export const FEATURES = [
  { key: 'core.home', parentKey: null, label: 'Home', alwaysOn: true, navSection: 'home', sort: 10 },
  { key: 'core.users', parentKey: null, label: 'Users', alwaysOn: true, navSection: 'users', sort: 20 },
  { key: 'core.settings', parentKey: null, label: 'Settings', alwaysOn: true, navSection: 'settings', sort: 30 },

  // Archive shares this key. It is the same schedule module, not its own switch.
  { key: 'flights.schedule', parentKey: null, label: 'Schedule', alwaysOn: false, navSection: 'schedule', sort: 100 },
  { key: 'flights.availability', parentKey: null, label: 'Availability', alwaysOn: false, navSection: 'availability', sort: 110 },
  { key: 'flights.airport_data', parentKey: null, label: 'Airport & Fuel', alwaysOn: false, navSection: 'airport-data', sort: 120 },

  { key: 'dispatch', parentKey: null, label: 'Dispatch', alwaysOn: false, navSection: 'ops', sort: 200 },
  { key: 'dispatch.tracking', parentKey: null, label: 'Tracking', alwaysOn: false, navSection: 'tracking', sort: 210 },
  { key: 'dispatch.manifests', parentKey: null, label: 'Manifests', alwaysOn: false, navSection: 'manifests', sort: 220 },
  { key: 'dispatch.lodging', parentKey: null, label: 'Lodging', alwaysOn: false, navSection: 'lodging', sort: 230 },
  { key: 'dispatch.broker_share', parentKey: null, label: 'Share with broker', alwaysOn: false, navSection: null, sort: 240 },
  { key: 'dispatch.broker_report', parentKey: 'dispatch', label: 'Broker pilot report', alwaysOn: false, navSection: null, sort: 250 },

  { key: 'crew.duty', parentKey: null, label: 'Duty', alwaysOn: false, navSection: 'duty', sort: 300 },
  { key: 'crew.currency', parentKey: null, label: 'Currency', alwaysOn: false, navSection: 'currency', sort: 310 },
  { key: 'crew.safety_rating', parentKey: 'crew.currency', label: 'Pilot safety rating', alwaysOn: false, navSection: null, sort: 320 },
  { key: 'crew.pilot_docs', parentKey: null, label: 'Pilot documents', alwaysOn: false, navSection: null, sort: 330 },
  { key: 'crew.reports', parentKey: null, label: 'Reports', alwaysOn: false, navSection: 'reports', sort: 340 },
  { key: 'crew.wear', parentKey: null, label: 'Wear', alwaysOn: false, navSection: 'wear', sort: 350 },

  { key: 'maintenance', parentKey: null, label: 'Maintenance', alwaysOn: false, navSection: 'maint', sort: 400 },
  { key: 'maintenance.aog', parentKey: null, label: 'AOG', alwaysOn: false, navSection: 'aog', sort: 410 },

  { key: 'comms', parentKey: null, label: 'Comms', alwaysOn: false, navSection: 'comms', sort: 500 },
  { key: 'comms.teams', parentKey: null, label: 'Teams', alwaysOn: false, navSection: 'teams', sort: 510 },

  { key: 'email.mailbox', parentKey: null, label: 'Mailbox', alwaysOn: false, navSection: 'mailbox', sort: 600 },
  { key: 'email.charter_inbox', parentKey: null, label: 'Shared inbox', alwaysOn: false, navSection: 'inbox', sort: 610 },

  { key: 'finance.expenses', parentKey: null, label: 'Expenses', alwaysOn: false, navSection: 'expenses', sort: 700 },
  { key: 'finance.wallet', parentKey: null, label: 'Wallet', alwaysOn: false, navSection: 'wallet', sort: 710 },
  { key: 'finance.accounting', parentKey: null, label: 'Accounting', alwaysOn: false, navSection: 'accounting', sort: 720 },

  { key: 'integrations.foreflight', parentKey: 'dispatch', label: 'ForeFlight', alwaysOn: false, navSection: null, sort: 800 },

  { key: 'platform.custom_domain', parentKey: null, label: 'Custom domain', alwaysOn: false, navSection: null, sort: 900 },
  { key: 'platform.saml', parentKey: null, label: 'SAML', alwaysOn: false, navSection: null, sort: 910 },
  { key: 'platform.audit_export', parentKey: null, label: 'Audit export', alwaysOn: false, navSection: null, sort: 920 },
];

export const ALWAYS_ON_KEYS = FEATURES.filter((feature) => feature.alwaysOn).map((feature) => feature.key);

export const FEATURE_KEYS = FEATURES.map((feature) => feature.key);
