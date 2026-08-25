/**
 * JetInsight "Crew checks by crew member" report parser.
 *
 * The report is six pages, arranged as three horizontal sections:
 *   pages 1–2  medical + company general checks       columns 0–7
 *   pages 3–4  aircraft-specific ground/sim checks    columns 8–15
 *   pages 5–6  IPC/line/training/security checks      columns 16–23
 *
 * Each pair splits the pilot roster vertically. This parser reads each page
 * independently from its PDF text coordinates, then joins the three sections
 * by normalized pilot name. The old parser searched for one header/footer and
 * divided a page's cells into 24-column rows; on this actual format every row
 * has eight cells, so it could not import the report correctly.
 */

export const REPORT_COLUMN_KEYS = Object.freeze([
  '__med_1st_under_40',
  '__med_2nd_under_40',
  '__med_3rd_under_40',
  '__med_1st_over_40',
  '__med_2nd_over_40',
  '__med_3rd_over_40',
  'basicIndoctrination',
  'groundOralGeneral293a',
  'groundOral293a_LR60',
  'groundOral293a_CE525',
  'groundOral293a_untyped',
  'groundOral293a_SF50',
  'sim293b_LR60',
  'sim293b_CE525',
  'sim293b_untyped',
  'sim293b_SF50',
  'instrumentCheck297',
  'lineCheck299',
  'emergencyTraining',
  'hazmatTraining',
  'rvsmTraining',
  'tfsspTraining',
  'dasspTraining',
  'kcmBadge',
]);

export const REPORT_COLUMN_LABELS = Object.freeze([
  'Med 1st <40', 'Med 2nd <40', 'Med 3rd <40',
  'Med 1st 40+', 'Med 2nd 40+', 'Med 3rd 40+',
  'Basic Indoc', '293(a) General',
  '293(a) LR-60', '293(a) CE-525', '293(a) Untyped', '293(a) SF-50',
  '293(b) LR-60', '293(b) CE-525', '293(b) Untyped', '293(b) SF-50',
  '135.297 IPC', '135.299 Line Check', 'Emergency', 'HAZMAT',
  'RVSM', 'TFSSP', 'DASSP', 'Known Crewmember',
]);

export const REPORT_COLUMNS = Object.freeze(REPORT_COLUMN_KEYS.map((key, index) => ({
  index,
  key,
  label: REPORT_COLUMN_LABELS[index],
})));

const isoDate = (month, day, year) => (
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
);

function firstDate(text) {
  const match = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return match ? isoDate(match[1], match[2], match[3]) : null;
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isPrimaryCellText(value) {
  const text = String(value || '').trim();
  if (/^(?:n\/a|na|missing|never)$/i.test(text)) return true;
  // Primary dates are either bare or start a "(grace:" suffix. The second
  // line contains just "MM/DD/YYYY)" and must not become a second cell.
  return /^\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\(grace:)?$/i.test(text);
}

function isGraceText(value) {
  return /^\d{1,2}\/\d{1,2}\/\d{4}\)$/i.test(String(value || '').trim());
}

export function parseReportCell(primaryText, graceText = '') {
  const raw = String(primaryText || '').trim();
  const lower = raw.toLowerCase();
  if (['n/a', 'na', '—', '-'].includes(lower)) return { kind: 'na' };
  if (lower === 'missing') return { kind: 'missing' };
  if (lower === 'never') return { kind: 'never' };
  const dueDate = firstDate(raw);
  if (dueDate) {
    return {
      kind: 'date',
      dueDate,
      graceDate: firstDate(graceText) || null,
    };
  }
  return { kind: 'unknown', raw };
}

function pageSection(items) {
  const text = items.map((item) => item.str).join(' ').toLowerCase();
  if (/medical\s*-\s*1st class/.test(text) || text.includes('basic indoctrination')) {
    return 0;
  }
  if (text.includes('ground / oral, aircraft') || text.includes('simulator / checkride')) {
    return 8;
  }
  if (text.includes('instrument proficiency') || text.includes('known crewmember')) {
    return 16;
  }
  return null;
}

function clusterByY(items, tolerance = 3) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const clusters = [];
  for (const item of sorted) {
    let cluster = clusters.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (!cluster) {
      cluster = { y: item.y, items: [] };
      clusters.push(cluster);
    }
    cluster.items.push(item);
    cluster.y = cluster.items.reduce((sum, entry) => sum + entry.y, 0) / cluster.items.length;
  }
  return clusters.sort((a, b) => a.y - b.y);
}

/**
 * Parse positioned text items extracted from all PDF pages.
 *
 * Item shape: { str, x, y, page }, where y increases down the page (the shape
 * produced by CurrencyImporter.extractPdfItems).
 */
export function parseJetInsightReportItems(items) {
  const warnings = [];
  const byPage = new Map();
  for (const item of items || []) {
    if (!item?.str?.trim() || !Number.isFinite(item.page)) continue;
    if (!byPage.has(item.page)) byPage.set(item.page, []);
    byPage.get(item.page).push({
      str: String(item.str).trim(),
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      page: item.page,
    });
  }

  const pilots = new Map();
  const sectionsSeen = new Set();

  for (const [page, pageItems] of [...byPage].sort((a, b) => a[0] - b[0])) {
    const sectionStart = pageSection(pageItems);
    if (sectionStart == null) {
      warnings.push(`Page ${page}: could not identify the report section; skipped.`);
      continue;
    }
    sectionsSeen.add(sectionStart);

    const primary = pageItems.filter((item) => item.x >= 90 && isPrimaryCellText(item.str));
    const rowClusters = clusterByY(primary)
      .filter((cluster) => cluster.items.length >= 6);

    for (const row of rowClusters) {
      const cells = [...row.items].sort((a, b) => a.x - b.x);
      if (cells.length !== 8) {
        warnings.push(
          `Page ${page}, row near y=${Math.round(row.y)}: found ${cells.length} checks; expected 8.`,
        );
      }

      // Name may wrap to a second line. It starts on the primary row and any
      // continuation sits immediately below, before the next pilot row.
      const nameParts = pageItems
        .filter((item) => item.x < 90 && item.y >= row.y - 4 && item.y <= row.y + 16)
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((item) => item.str)
        .filter((text) => !/^(?:--|\d+\s+of\s+\d+)/i.test(text));
      const name = nameParts.join(' ').replace(/\s+/g, ' ').trim();
      if (!name) {
        warnings.push(`Page ${page}, row near y=${Math.round(row.y)}: pilot name not found.`);
        continue;
      }

      const parsedCells = cells.slice(0, 8).map((cell) => {
        // Grace date lives on the next visual line, just to the right of the
        // primary date's x coordinate.
        const grace = pageItems
          .filter((item) => (
            isGraceText(item.str)
            && item.y > row.y + 3
            && item.y <= row.y + 16
            && Math.abs(item.x - cell.x) <= 25
          ))
          .sort((a, b) => Math.abs(a.x - cell.x) - Math.abs(b.x - cell.x))[0];
        return parseReportCell(cell.str, grace?.str || '');
      });
      while (parsedCells.length < 8) parsedCells.push({ kind: 'missing' });

      const key = normalizeName(name);
      if (!key) continue;
      const existing = pilots.get(key) || {
        name,
        cells: Array(24).fill(null),
        sections: new Set(),
        pages: [],
      };
      if (existing.sections.has(sectionStart)) {
        warnings.push(`Duplicate section ${sectionStart / 8 + 1} for ${name}; latest row used.`);
      }
      for (let i = 0; i < 8; i += 1) {
        existing.cells[sectionStart + i] = parsedCells[i];
      }
      existing.sections.add(sectionStart);
      existing.pages.push(page);
      pilots.set(key, existing);
    }
  }

  for (const start of [0, 8, 16]) {
    if (!sectionsSeen.has(start)) warnings.push(`Report section ${start / 8 + 1} is missing.`);
  }

  const result = [...pilots.values()]
    .map((pilot) => {
      const missingSections = [0, 8, 16].filter((start) => !pilot.sections.has(start));
      if (missingSections.length) {
        warnings.push(
          `${pilot.name}: missing report section(s) ${missingSections.map((s) => s / 8 + 1).join(', ')}.`,
        );
      }
      return {
        name: pilot.name,
        cells: pilot.cells.map((cell) => cell || { kind: 'missing' }),
        rawLen: pilot.cells.filter(Boolean).length,
        pages: pilot.pages,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { pilots: result, warnings };
}

/** Parse one tab/pipe/comma row value (used by the paste fallback). */
export function parseReportTableCell(raw) {
  const text = String(raw || '').trim();
  const dueDate = firstDate(text);
  let graceDate = null;
  const graceMatch = text.match(/grace:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (graceMatch) graceDate = isoDate(graceMatch[1], graceMatch[2], graceMatch[3]);
  if (dueDate) return { kind: 'date', dueDate, graceDate };
  return parseReportCell(text);
}

/**
 * Parse the tab/pipe/comma-separated fallback where each line is
 * pilot name + 24 report cells.
 */
export function parseCurrencyReportTable(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);

  let delimiter = '\t';
  const sample = lines.find((line) => /[\t|,]/.test(line)) || '';
  if (sample.includes('\t')) delimiter = '\t';
  else if (sample.includes('|')) delimiter = '|';
  else if (sample.includes(',')) delimiter = ',';

  const rows = [];
  for (const line of lines) {
    let rawCells;
    if (delimiter === '\t') rawCells = line.split('\t');
    else if (delimiter === '|') rawCells = line.split('|');
    else {
      const safe = line.replace(/\(([^)]*)\)/g, (_, inner) => `(${inner.replace(/,/g, ';')})`);
      rawCells = safe.split(',').map((cell) => cell.replace(/;/g, ','));
    }
    const values = rawCells.map((cell) => cell.trim());
    const name = values[0] || '';
    if (!name) continue;
    const cells = values.slice(1, 25).map(parseReportTableCell);
    rows.push({ name, cells, rawLen: cells.length });
  }
  return rows;
}

/**
 * Convert one complete 24-cell row into a Firestore patch.
 *
 * Missing is authoritative in this report: clear stale dates and mark the item
 * missing, rather than silently preserving an old check that JetInsight no
 * longer shows. N/A likewise clears old date values.
 */
export function buildCurrencyPatch(parsed) {
  const warnings = [];
  const updates = {};
  let medical = null;

  if (parsed.rawLen !== 24) {
    warnings.push(`Row has ${parsed.rawLen} cells, expected 24.`);
  }

  const medicalClasses = ['First', 'Second', 'Third', 'First', 'Second', 'Third'];
  const medIndex = parsed.cells.slice(0, 6).findIndex((cell) => cell?.kind === 'date');
  if (medIndex >= 0) {
    const cell = parsed.cells[medIndex];
    medical = {
      class: medicalClasses[medIndex],
      expirationDate: cell.dueDate,
      notes: `Imported from JetInsight · ${medIndex >= 3 ? 'age 40+' : 'under 40'} report column`,
    };
  }

  for (let i = 6; i < REPORT_COLUMN_KEYS.length; i += 1) {
    const key = REPORT_COLUMN_KEYS[i];
    const cell = parsed.cells[i] || { kind: 'missing' };
    if (cell.kind === 'date') {
      updates[key] = {
        dueDate: cell.dueDate,
        graceDate: cell.graceDate || '',
        lastDate: '',
        notes: 'Imported from JetInsight crew checks report',
        notApplicable: false,
        missing: false,
      };
    } else if (cell.kind === 'na') {
      updates[key] = {
        dueDate: '',
        graceDate: '',
        lastDate: '',
        notes: 'N/A in JetInsight crew checks report',
        notApplicable: true,
        missing: false,
        present: false,
      };
    } else if (cell.kind === 'never') {
      updates[key] = {
        dueDate: '',
        graceDate: '',
        lastDate: '',
        notes: 'No expiration in JetInsight crew checks report',
        notApplicable: false,
        missing: false,
        noExpiration: true,
        present: true,
      };
    } else if (cell.kind === 'missing') {
      updates[key] = {
        dueDate: '',
        graceDate: '',
        lastDate: '',
        notes: 'Missing in JetInsight crew checks report',
        notApplicable: false,
        missing: true,
        present: false,
      };
    } else {
      warnings.push(`${REPORT_COLUMN_LABELS[i]}: unrecognized value "${cell.raw || ''}"`);
    }
  }

  return { updates, medical, warnings };
}

