import assert from 'node:assert/strict';
import test from 'node:test';
import { reportNumber, reportRows, reportSections } from '../src/qbo-report.js';

const report = {
  Rows: {
    Row: [
      {
        Header: { ColData: [{ value: 'Income' }, { value: '' }] },
        Rows: {
          Row: [
            { ColData: [{ value: 'Charter Revenue' }, { value: '125,000.00' }] },
          ],
        },
        Summary: { ColData: [{ value: 'Total Income' }, { value: '125,000.00' }] },
      },
      {
        Header: { ColData: [{ value: 'Expenses' }, { value: '' }] },
        Rows: {
          Row: [
            { ColData: [{ value: 'Fuel' }, { value: '42,000.00' }] },
          ],
        },
        Summary: { ColData: [{ value: 'Total Expenses' }, { value: '42,000.00' }] },
      },
      {
        Summary: { ColData: [{ value: 'Net Income' }, { value: '83,000.00' }] },
      },
    ],
  },
};

test('flattens nested QBO report rows and summaries', () => {
  const rows = reportRows(report);
  assert.equal(rows.find((row) => row.label === 'Charter Revenue').section, 'Income');
  assert.equal(rows.find((row) => row.label === 'Total Income').summary, true);
  assert.equal(rows.find((row) => row.label === 'Fuel').section, 'Expenses');
});

test('extracts numeric report totals despite comma formatting', () => {
  assert.equal(reportNumber(report, 'Total Income'), 125000);
  assert.equal(reportNumber(report, ['Net Operating Income', 'Net Income']), 83000);
  assert.equal(reportNumber(report, 'Missing'), 0);
});

test('groups flattened rows into display sections', () => {
  const sections = reportSections(report);
  assert.ok(sections.some((section) => section.title === 'Income'));
  assert.ok(sections.some((section) => section.title === 'Expenses'));
});
