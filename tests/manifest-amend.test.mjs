import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ensureCharterCc } from '../api/_email-signature.js';
import {
  MANIFEST_FILING_INBOX,
  MANIFEST_TEST_INBOX,
  composeManifestNotice,
} from '../api/_manifest-notice.js';
import {
  amendmentAccess,
  buildOriginalSubmission,
  buildResubmission,
  diffManifestContents,
  isLegAirborne,
  revisionLabel,
} from '../src/manifest-revisions.js';

const root = path.resolve(import.meta.dirname, '..');

function filing(overrides = {}) {
  return {
    status: 'submitted',
    revision: 1,
    date: '2026-10-09',
    tail: 'N444AM',
    hobbsOut: '100.0',
    hobbsIn: '102.2',
    submittedAt: 1,
    submittedBy: 'Avery Quinn',
    submittedByUid: 'crew-1',
    submittedByEmail: 'avery@flyskyway.com',
    picSig: { name: 'Avery Quinn', email: 'avery@flyskyway.com', signatureImg: 'data:image/png,pic', timestamp: 1 },
    sicSig: { name: 'Blake Nguyen', email: 'blake@flyskyway.com', signatureImg: 'data:image/png,sic', timestamp: 1 },
    legs: [{
      tripUid: 'trip-1',
      from: 'HYA',
      to: 'TEB',
      toWeight: '12840',
      numPax: '2',
      passengers: [
        { name: 'Ada Lovelace', dob: '1/21/68', weight: '140', idNumber: 'D111' },
        'Grace Hopper',
      ],
    }],
    revisions: [],
    ...overrides,
  };
}

const crew = { name: 'Avery Quinn', uid: 'crew-1', email: 'avery@flyskyway.com', role: 'crew' };

test('passenger, weight, DOB, and ID edits are a field-level diff', () => {
  const before = filing();
  const after = filing({
    legs: [{
      ...before.legs[0],
      toWeight: '13110',
      numPax: '3',
      passengers: [
        { name: 'Ada King', dob: '1/21/69', weight: '145', idNumber: 'D222' },
        { name: 'Grace Hopper', dob: '', weight: '150', idNumber: 'DL987654' },
        'Katherine Johnson',
      ],
    }],
  });
  const diff = diffManifestContents(before, after);
  const summaries = diff.map(item => item.summary).join('\n');
  assert.match(summaries, /Leg 1 passenger 1 name: Ada Lovelace → Ada King/);
  assert.match(summaries, /Leg 1 passenger 1 DOB: 1\/21\/68 → 1\/21\/69/);
  assert.match(summaries, /Leg 1 passenger 1 weight: 140 → 145/);
  assert.match(summaries, /Leg 1 passenger 1 ID: D111 → D222/);
  assert.match(summaries, /Leg 1 passenger 2 weight: — → 150/);
  assert.match(summaries, /Leg 1 passenger 2 ID: — → DL987654/);
  assert.match(summaries, /Leg 1 passenger added: Katherine Johnson/);
  assert.match(summaries, /Leg 1 T\/O weight: 12840 → 13110/);
  assert.match(summaries, /Leg 1 # passengers: 2 → 3/);
});

test('removing a passenger and a leg is recorded', () => {
  const before = filing({
    legs: [
      filing().legs[0],
      { tripUid: 'trip-2', from: 'TEB', to: 'PBI', passengers: ['Owen Blake'], toWeight: '91', legType: 'REPO' },
    ],
  });
  const after = filing({
    legs: [{
      ...before.legs[0],
      passengers: ['Ada Lovelace'],
    }],
  });
  const summaries = diffManifestContents(before, after).map(item => item.summary);
  assert.ok(summaries.some(line => line.includes('passenger removed') && line.includes('Grace Hopper')));
  assert.ok(summaries.some(line => line.startsWith('Leg removed') && line.includes('TEB → PBI')));
});

test('resubmit keeps the original snapshot and appends the next revision', () => {
  const original = buildOriginalSubmission(filing({ status: 'draft', revision: 0, revisions: [] }), crew, 1000);
  assert.equal(original.manifest.revision, 1);
  assert.equal(original.manifest.revisions[0].snapshot.legs[0].passengers[0].name, 'Ada Lovelace');

  const edited = {
    ...original.manifest,
    hobbsIn: '103.0',
    legs: [{
      ...original.manifest.legs[0],
      passengers: ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson'],
    }],
  };
  const first = buildResubmission({
    baseline: original.manifest,
    draft: edited,
    note: 'Added a passenger',
    user: crew,
    now: 2000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.manifest.revision, 2);
  assert.equal(first.manifest.amendmentNote, 'Added a passenger');
  assert.equal(first.manifest.submittedAt, 1000);
  assert.equal(first.manifest.revisions.length, 2);
  assert.equal(first.manifest.revisions[0].snapshot.hobbsIn, '102.2');
  assert.equal(first.manifest.revisions[1].snapshot.hobbsIn, '103.0');
  assert.match(first.summary, /Katherine Johnson/);

  const secondEdit = {
    ...first.manifest,
    hobbsIn: '103.4',
  };
  const second = buildResubmission({
    baseline: first.manifest,
    draft: secondEdit,
    note: 'Hobbs correction',
    user: { name: 'Jordan Hale', uid: 'admin-1', email: 'jordan@flyskyway.com' },
    now: 3000,
  });
  assert.equal(second.ok, true);
  assert.equal(second.manifest.revision, 3);
  assert.equal(second.manifest.revisions.length, 3);
  assert.equal(second.manifest.revisions[0].snapshot.hobbsIn, '102.2');
  assert.equal(second.manifest.revisions[1].snapshot.hobbsIn, '103.0');
  assert.equal(second.manifest.revisions[1].note, 'Added a passenger');
  assert.equal(second.manifest.revisions[2].by, 'Jordan Hale');
  assert.match(second.summary, /Hobbs in: 103.0 → 103.4/);
  assert.equal(revisionLabel(second.manifest), 'Amended (Rev 3)');
});

test('a resubmit with no field changes is refused', () => {
  const baseline = filing();
  const result = buildResubmission({
    baseline,
    draft: { ...baseline, amendmentNote: 'note only' },
    note: 'note only',
    user: crew,
    now: 5,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Nothing changed/);
});

test('crew and ops can amend on the flight day, including after landing', () => {
  const manifest = filing({ date: '2026-10-09' });
  const landed = {
    'trip-1': { airborne: false, departed: true, completed: true, date: '2026-10-09' },
  };
  assert.equal(amendmentAccess({ manifest, role: 'crew', today: '2026-10-09', legStatusByUid: landed }).allowed, true);
  assert.equal(amendmentAccess({ manifest, role: 'ops', today: '2026-10-09', legStatusByUid: landed }).allowed, true);
  assert.equal(amendmentAccess({ manifest, role: 'sales', today: '2026-10-09' }).allowed, false);
});

test('a closed flight day or an airborne leg blocks everyone except an admin, who is warned', () => {
  const manifest = filing({ date: '2026-10-08' });
  const crewGate = amendmentAccess({ manifest, role: 'crew', today: '2026-10-09' });
  assert.equal(crewGate.allowed, false);
  assert.match(crewGate.reason, /Only an admin/);
  const opsGate = amendmentAccess({ manifest, role: 'ops', today: '2026-10-09' });
  assert.equal(opsGate.allowed, false);

  const adminGate = amendmentAccess({ manifest, role: 'admin', today: '2026-10-09' });
  assert.equal(adminGate.allowed, true);
  assert.equal(adminGate.closed, true);
  assert.match(adminGate.warning, /AMENDED/);

  const airborne = amendmentAccess({
    manifest: filing({ date: '2026-10-09' }),
    role: 'crew',
    today: '2026-10-09',
    legStatusByUid: { 'trip-1': { airborne: true, departed: true, completed: false, date: '2026-10-09' } },
  });
  assert.equal(airborne.allowed, false);
  assert.match(airborne.reason, /airborne/);
  assert.equal(isLegAirborne({ statuses: { wheels_up: { timestamp: 1 } } }), true);
  assert.equal(isLegAirborne({ statuses: { wheels_up: { timestamp: 1 }, landed: { timestamp: 2 } } }), false);
});

test('an amended notice is labeled and, outside production, goes only to Jake', () => {
  const notice = composeManifestNotice({
    tail: 'N444AM',
    tripDate: '2026-10-09',
    revision: 2,
    amended: true,
    amendedBy: 'Avery Quinn',
    amendmentNote: 'Added a passenger',
    changeSummary: 'Leg 1 passenger added: Katherine Johnson\nLeg 1 T/O weight: 12840 → 13110',
    hobbsOut: '100.0',
    hobbsIn: '103.0',
    hobbsTotal: '3.0',
    legs: [{ from: 'HYA', to: 'TEB' }],
    picSig: { name: 'Avery Quinn', email: 'avery@flyskyway.com' },
    sicSig: { name: 'Blake Nguyen', email: 'blake@flyskyway.com' },
    submittedBy: 'Avery Quinn',
  }, { VERCEL_ENV: 'preview' });

  assert.equal(notice.testing, true);
  assert.deepEqual(notice.to, [MANIFEST_TEST_INBOX]);
  assert.match(notice.subject, /^AMENDED Load Manifest \(Rev 2\)/);
  assert.doesNotMatch(notice.subject, /^Load Manifest —/);
  assert.match(notice.text, /Use this version/);
  assert.match(notice.text, /Katherine Johnson/);
  assert.match(notice.text, /Added a passenger/);
  assert.match(notice.filename, /REV2\.pdf$/);

  const original = composeManifestNotice({
    tail: 'N444AM',
    tripDate: '2026-10-09',
    revision: 1,
    submittedBy: 'Avery Quinn',
    legs: [],
    picSig: { name: 'Avery Quinn', email: 'avery@flyskyway.com' },
    sicSig: { name: 'Blake Nguyen', email: 'blake@flyskyway.com' },
  }, { VERCEL_ENV: 'production' });
  assert.equal(original.testing, false);
  assert.deepEqual(original.to, [MANIFEST_FILING_INBOX]);
  assert.match(original.subject, /^Load Manifest —/);
  assert.doesNotMatch(original.subject, /AMENDED/);
  const copied = ensureCharterCc([], original.to);
  assert.equal(copied.some(address => address.toLowerCase() === 'charters@flyskyway.com'), true);
});

test('the manifest sender sinks non-production mail and still CCs charters in production', async () => {
  const source = await readFile(path.join(root, 'api/generate-manifest.js'), 'utf8');
  assert.match(source, /notice\.testing \? \[\] : ensureCharterCc\(\[\], recipients\)/);
  assert.match(source, /AMENDED — REVISION/);
});
