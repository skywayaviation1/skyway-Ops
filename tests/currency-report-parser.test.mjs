import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REPORT_COLUMN_KEYS,
  buildCurrencyPatch,
  parseJetInsightReportItems,
  parseReportCell,
} from '../src/currency-report-parser.js';

/** Build one synthetic 8-column report page using the real PDF geometry. */
function reportPage(page, section, rows) {
  const header = section === 0
    ? ['Medical - 1st class', 'Basic indoctrination']
    : section === 8
      ? ['Ground / oral, aircraft specific', 'Simulator / checkride']
      : ['Instrument proficiency - 135.297', 'Known Crewmember badge'];
  const items = header.map((str, index) => ({
    str, x: 120 + index * 200, y: 40, page,
  }));
  const xs = [125, 210, 300, 390, 480, 560, 640, 715];
  rows.forEach((row, rowIndex) => {
    const y = 100 + rowIndex * 30;
    const nameParts = row.name.split('|');
    items.push({ str: nameParts[0], x: 33, y, page });
    if (nameParts[1]) items.push({ str: nameParts[1], x: 33, y: y + 10, page });
    row.cells.forEach((cell, index) => {
      items.push({ str: cell.primary, x: xs[index], y, page });
      if (cell.grace) items.push({ str: `${cell.grace})`, x: xs[index] + 11, y: y + 10, page });
    });
  });
  return items;
}

const date = (due, grace) => ({ primary: `${due}${grace ? ' (grace:' : ''}`, grace });
const literal = (primary) => ({ primary });

test('cell parser preserves due and grace separately', () => {
  assert.deepEqual(
    parseReportCell('08/31/2026 (grace:', '09/30/2026)'),
    { kind: 'date', dueDate: '2026-08-31', graceDate: '2026-09-30' },
  );
  assert.deepEqual(parseReportCell('n/a'), { kind: 'na' });
  assert.deepEqual(parseReportCell('Missing'), { kind: 'missing' });
  assert.deepEqual(parseReportCell('Never'), { kind: 'never' });
});

test('six-page sections join into one 24-check row per pilot', () => {
  const first = [
    date('10/31/2026'),
    date('10/31/2026'),
    date('10/31/2030'),
    literal('n/a'),
    literal('n/a'),
    literal('n/a'),
    date('07/31/2027', '08/31/2027'),
    date('07/31/2027', '08/31/2027'),
  ];
  const aircraft = [
    date('02/28/2027', '03/31/2027'),
    literal('n/a'),
    date('07/31/2027', '08/31/2027'),
    literal('n/a'),
    date('02/28/2027', '03/31/2027'),
    literal('n/a'),
    date('07/31/2027', '08/31/2027'),
    literal('n/a'),
  ];
  const training = [
    date('01/31/2027', '02/28/2027'),
    date('07/31/2027', '08/31/2027'),
    date('07/31/2027', '08/31/2027'),
    date('07/31/2027', '08/31/2027'),
    literal('Never'),
    date('07/31/2027', '08/31/2027'),
    literal('Missing'),
    literal('Missing'),
  ];

  const items = [
    ...reportPage(1, 0, [{ name: 'Loftin James|Tyson', cells: first }]),
    // Page 2 is the lower half of the same section, different pilot.
    ...reportPage(2, 0, [{ name: 'Other|Pilot', cells: Array(8).fill(literal('n/a')) }]),
    ...reportPage(3, 8, [{ name: 'Loftin James|Tyson', cells: aircraft }]),
    ...reportPage(4, 8, [{ name: 'Other|Pilot', cells: Array(8).fill(literal('n/a')) }]),
    ...reportPage(5, 16, [{ name: 'Loftin James|Tyson', cells: training }]),
    ...reportPage(6, 16, [{ name: 'Other|Pilot', cells: Array(8).fill(literal('n/a')) }]),
  ];

  const parsed = parseJetInsightReportItems(items);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.pilots.length, 2);

  const loftin = parsed.pilots.find((pilot) => pilot.name === 'Loftin James Tyson');
  assert.ok(loftin);
  assert.equal(loftin.rawLen, 24);
  assert.deepEqual(loftin.pages, [1, 3, 5]);
  assert.equal(loftin.cells[6].dueDate, '2027-07-31');
  assert.equal(loftin.cells[6].graceDate, '2027-08-31');
  assert.equal(loftin.cells[8].dueDate, '2027-02-28');
  assert.equal(loftin.cells[16].dueDate, '2027-01-31');
  assert.equal(loftin.cells[20].kind, 'never');
  assert.equal(loftin.cells[22].kind, 'missing');
});

test('patch writes every non-medical report column, including Missing and N/A', () => {
  const cells = Array(24).fill(null).map(() => ({ kind: 'na' }));
  cells[0] = { kind: 'date', dueDate: '2026-10-31', graceDate: null };
  cells[6] = { kind: 'date', dueDate: '2027-07-31', graceDate: '2027-08-31' };
  cells[7] = { kind: 'missing' };
  cells[20] = { kind: 'never' };
  cells[23] = { kind: 'date', dueDate: '2028-01-31', graceDate: null };

  const patch = buildCurrencyPatch({ name: 'Example Pilot', cells, rawLen: 24 });
  assert.equal(Object.keys(patch.updates).length, 18);
  assert.equal(patch.medical.class, 'First');
  assert.equal(patch.medical.expirationDate, '2026-10-31');
  assert.deepEqual(patch.updates.basicIndoctrination, {
    dueDate: '2027-07-31',
    graceDate: '2027-08-31',
    lastDate: '',
    notes: 'Imported from JetInsight crew checks report',
    notApplicable: false,
    missing: false,
  });
  assert.equal(patch.updates.groundOralGeneral293a.missing, true);
  assert.equal(patch.updates.groundOral293a_LR60.notApplicable, true);
  assert.equal(patch.updates.rvsmTraining.noExpiration, true);
  assert.equal(patch.updates.rvsmTraining.present, true);
  assert.equal(patch.updates.kcmBadge.dueDate, '2028-01-31');
  assert.equal(REPORT_COLUMN_KEYS.length, 24);
});

