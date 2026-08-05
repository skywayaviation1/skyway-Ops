// QuickBooks report response helpers. QBO nests report rows recursively.

export function reportRows(report) {
  const output = [];
  function visit(rows, section = '') {
    for (const row of rows || []) {
      const header = row?.Header?.ColData || [];
      const nextSection = header[0]?.value || section;
      if (row?.ColData?.length) {
        output.push({
          section,
          label: row.ColData[0]?.value || '',
          value: row.ColData[1]?.value || '',
          raw: row,
        });
      }
      if (row?.Rows?.Row) visit(row.Rows.Row, nextSection);
      const summary = row?.Summary?.ColData || [];
      if (summary.length) {
        output.push({
          section: nextSection || section,
          label: summary[0]?.value || '',
          value: summary[1]?.value || '',
          summary: true,
          raw: row,
        });
      }
    }
  }
  visit(report?.Rows?.Row || []);
  return output;
}

export function reportNumber(report, labels) {
  const wanted = (Array.isArray(labels) ? labels : [labels]).map((label) => String(label).toLowerCase());
  const rows = reportRows(report);
  for (const label of wanted) {
    const row = rows.find((item) => item.label.toLowerCase() === label);
    if (row) {
      const value = Number(String(row.value || '').replace(/[$,\s]/g, ''));
      if (Number.isFinite(value)) return value;
    }
  }
  return 0;
}

export function reportSections(report) {
  const grouped = new Map();
  for (const row of reportRows(report)) {
    if (!row.label || (!row.value && row.value !== 0)) continue;
    const key = row.section || 'Report';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.entries()].map(([title, rows]) => ({ title, rows }));
}
