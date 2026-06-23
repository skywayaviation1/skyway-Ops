// src/CurrencyImporter.jsx
//
// Bulk-import pilot currency data from a JetInsight "Crew checks by crew
// member" grid. Two input modes:
//
//   1. Upload PDF — drop the JetInsight PDF export, we extract text
//      with pdfjs-dist and parse it.
//   2. Paste text — paste a tab/pipe/comma-separated table.
//
// Both feed the same preview → commit pipeline. The PDF path is the
// happy path; the paste path is a fallback if JetInsight changes its
// PDF format or admin only has partial data.
//
// JetInsight column order (left-to-right in their compliance grid):
//   1. Medical 1st class (under 40)
//   2. Medical 2nd class (under 40)
//   3. Medical 3rd class (under 40)
//   4. Medical 1st class (over 40)
//   5. Medical 2nd class (over 40)
//   6. Medical 3rd class (over 40)
//   7. Basic indoctrination (company specific)
//   8. Ground/oral general - 135.293(a)(1,4-8)
//   9. Ground/oral aircraft specific 135.293(a)(2-3) (LR-60)
//   10. Ground/oral aircraft specific 135.293(a)(2-3) (CE-525)
//   11. Ground/oral aircraft specific 135.293(a)(2-3) (untyped)
//   12. Ground/oral aircraft specific 135.293(a)(2-3) (SF-50)
//   13. Simulator/checkride 135.293(b) (LR-60)
//   14. Simulator/checkride 135.293(b) (CE-525)
//   15. Simulator/checkride 135.293(b) (untyped)
//   16. Simulator/checkride 135.293(b) (SF-50)
//   17. Instrument proficiency 135.297
//   18. Line check 135.299
//   19. Emergency training (company specific)
//   20. HAZMAT training
//   21. RVSM training
//   22. TFSSP training
//   23. DASSP training
//   24. Known Crewmember badge
//
// Schema mapping for each non-medical column writes
//   doc[key] = { dueDate: 'YYYY-MM-DD', notes: '' }
// (or notApplicable: true for "n/a").
//
// For the 6 medical columns, only ONE should have a date per pilot.
// We pick the leftmost dated column to infer class + under/over 40;
// store as doc.medical = { class, expirationDate, notes }.

import React, { useMemo, useState } from 'react';
import { X, Upload, Check, Loader2, AlertTriangle, Search, ChevronDown, FileText } from 'lucide-react';
import { savePilotCurrency, CURRENCY_TYPES } from './firebase-currency.js';

/* ═══════════════════════════════════════════════════════════════════
   COLUMN MAP — JetInsight order → currency-schema key
   ═══════════════════════════════════════════════════════════════════ */

// Index 0-23 maps to the 24 JetInsight columns in left-to-right order.
// Medical columns (0-5) are special-cased in the parser; the rest map
// directly to CURRENCY_TYPES keys.
const COLUMN_KEYS = [
  '__med_1st_under_40', // 0
  '__med_2nd_under_40', // 1
  '__med_3rd_under_40', // 2
  '__med_1st_over_40',  // 3
  '__med_2nd_over_40',  // 4
  '__med_3rd_over_40',  // 5
  'basicIndoctrination',          // 7. Basic indoc
  'groundOralGeneral293a',        // 8. Ground/oral general
  'groundOral293a_LR60',          // 9. 293(a) LR-60
  'groundOral293a_CE525',         // 10. 293(a) CE-525
  'groundOral293a_untyped',       // 11. 293(a) untyped
  'groundOral293a_SF50',          // 12. 293(a) SF-50
  'sim293b_LR60',                 // 13. 293(b) LR-60
  'sim293b_CE525',                // 14. 293(b) CE-525
  'sim293b_untyped',              // 15. 293(b) untyped
  'sim293b_SF50',                 // 16. 293(b) SF-50
  'instrumentCheck297',           // 17. IPC
  'lineCheck299',                 // 18. Line check
  'emergencyTraining',            // 19. Emergency
  'hazmatTraining',               // 20. HAZMAT
  'rvsmTraining',                 // 21. RVSM
  'tfsspTraining',                // 22. TFSSP
  'dasspTraining',                // 23. DASSP
  'kcmBadge',                     // 24. KCM
];

// Display label for each column in the preview, in the same order.
const COLUMN_LABELS = [
  'Med 1st <40', 'Med 2nd <40', 'Med 3rd <40',
  'Med 1st 40+', 'Med 2nd 40+', 'Med 3rd 40+',
  'Basic Indoc', '293(a) Gen',
  '293(a) LR-60', '293(a) CE-525', '293(a) Untyped', '293(a) SF-50',
  '293(b) LR-60', '293(b) CE-525', '293(b) Untyped', '293(b) SF-50',
  'IPC', 'Line Check', 'Emergency', 'HAZMAT',
  'RVSM', 'TFSSP', 'DASSP', 'KCM',
];

/* ═══════════════════════════════════════════════════════════════════
   PDF EXTRACTION — pdfjs-dist
   ═══════════════════════════════════════════════════════════════════ */

// Lazy-load pdfjs only when we actually use it. Configures the worker
// from the same package so Vite bundles it.
async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    // Vite-friendly worker URL. pdfjs-dist 4.x ships .mjs.
    try {
      const workerUrl = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).href;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    } catch {
      // Fallback to CDN matching our installed version.
      pdfjs.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';
    }
  }
  return pdfjs;
}

// Extract all text from a PDF as a single concatenated string. Each
// item gets a trailing space so words don't run together. Reading order
// follows the PDF's text stream, which for JetInsight's report comes
// out as headers → data cells (left-to-right, top-to-bottom) → pilot
// name column at the end (since name column sits leftmost visually but
// pdfjs streams it last because the names are vertically tall blocks).
async function extractPdfText(file) {
  const pdfjs = await loadPdfjs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (item.str && item.str.trim()) parts.push(item.str);
    }
    // Page break marker (safe — our tokenizer ignores it)
    parts.push(' ');
  }
  return parts.join(' ');
}

/* ═══════════════════════════════════════════════════════════════════
   TEXT TOKENIZER — used by PDF path
   ═══════════════════════════════════════════════════════════════════ */

// Walk through extracted text and emit typed tokens. Cells are dates,
// "n/a", "Missing", or "Never". Anything wrapped in (grace: …) is its
// own token type so we can discard it. Everything else becomes either
// a "word" (alphabetic, candidate for pilot name) or skipped.
function tokenizeJetInsightText(text) {
  // Normalize whitespace and collapse newlines.
  const t = text.replace(/\s+/g, ' ').trim();
  const tokens = [];
  let i = 0;
  while (i < t.length) {
    while (i < t.length && t[i] === ' ') i++;
    if (i >= t.length) break;

    // Date M/D/YYYY or MM/DD/YYYY
    const dm = t.slice(i).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dm) {
      const mm = String(dm[1]).padStart(2, '0');
      const dd = String(dm[2]).padStart(2, '0');
      tokens.push({ type: 'date', value: `${dm[3]}-${mm}-${dd}` });
      i += dm[0].length;
      continue;
    }

    // (grace: M/D/YYYY) — entire block, skip
    if (t.slice(i, i + 7).toLowerCase() === '(grace:') {
      const close = t.indexOf(')', i);
      if (close > i) {
        tokens.push({ type: 'grace' });
        i = close + 1;
        continue;
      }
    }

    // "n/a"
    if (t.slice(i, i + 3).toLowerCase() === 'n/a') {
      tokens.push({ type: 'na' });
      i += 3;
      continue;
    }

    // Word: alphabetic, can include /, ., -, '
    const wm = t.slice(i).match(/^[A-Za-z][A-Za-z0-9'.\-/]*/);
    if (wm) {
      const w = wm[0];
      const lower = w.toLowerCase();
      if (lower === 'missing') tokens.push({ type: 'missing' });
      else if (lower === 'never') tokens.push({ type: 'never' });
      else tokens.push({ type: 'word', value: w });
      i += w.length;
      continue;
    }

    // Skip punctuation / other
    i++;
  }
  return tokens;
}

/* ═══════════════════════════════════════════════════════════════════
   PARSE — token stream → pilot rows
   ═══════════════════════════════════════════════════════════════════ */

// JetInsight PDF text streams in this order:
//   [headers]  [24 cells × N pilots]  [N pilot names]
// The data cells come first as one long contiguous run; pilot names
// stream after all data because pdfjs reads the table left-to-right
// per row, but the name column (with its multi-line wrapping) gets
// pushed to the end of each page's reading.
//
// Strategy:
//   1. Find the LAST cell token (date/na/missing/never).
//   2. Everything before+including it = cells. Everything after = name
//      tokens, which we group into multi-word names.
//   3. Slice cells into 24-token chunks; each chunk pairs with the
//      next name by order.
function parsePdfTokens(tokens) {
  // Find the last index of a cell-like token.
  let lastCellIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const k = tokens[i].type;
    if (k === 'date' || k === 'na' || k === 'missing' || k === 'never') {
      lastCellIdx = i;
      break;
    }
  }

  if (lastCellIdx < 0) return { pilots: [], warnings: ['No cell data found in PDF text.'] };

  // Pull only cell tokens up to lastCellIdx; ignore words mixed in
  // (those would be header text like "Medical" or "Ground / oral").
  const cells = [];
  for (let i = 0; i <= lastCellIdx; i++) {
    const t = tokens[i];
    if (t.type === 'date') cells.push({ kind: 'date', dueDate: t.value });
    else if (t.type === 'na') cells.push({ kind: 'na' });
    else if (t.type === 'missing') cells.push({ kind: 'missing' });
    else if (t.type === 'never') cells.push({ kind: 'never' });
    // grace and word tokens skipped
  }

  // After lastCellIdx, group consecutive Capitalized words into names.
  // A name is at least 2 capitalized words. Numbers, lowercase tokens,
  // or punctuation between word runs break the name.
  const names = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length >= 2) names.push(buffer.join(' '));
    buffer = [];
  };
  for (let i = lastCellIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'word' && /^[A-Z][A-Za-z'.\-]*$/.test(t.value)) {
      buffer.push(t.value);
    } else {
      flush();
    }
  }
  flush();

  // Filter obvious non-names. JetInsight footer has things like
  // "Copyright JetInsight" "Contact Us" "Crewmember badge". The 24
  // column headers like "Medical 1st class" don't survive the
  // post-lastCellIdx filter because they precede data, not follow it.
  // But the footer copyright might. Drop anything containing forbidden
  // substrings.
  const FORBIDDEN = /copyright|contact|jetinsight|crewmember|crew checks/i;
  const cleanNames = names.filter(n => !FORBIDDEN.test(n));

  // Group cells into 24-cell chunks, one per pilot in order.
  const pilots = [];
  const warnings = [];
  const expectedTotal = cleanNames.length * 24;
  if (cells.length < expectedTotal) {
    warnings.push(
      `PDF gave ${cells.length} cells but expected ${expectedTotal} for ` +
      `${cleanNames.length} pilots — some rows may be truncated.`
    );
  } else if (cells.length > expectedTotal) {
    warnings.push(
      `PDF gave ${cells.length} cells, ${cells.length - expectedTotal} more than ` +
      `expected for ${cleanNames.length} pilots — extra cells will be ignored.`
    );
  }
  for (let i = 0; i < cleanNames.length; i++) {
    const start = i * 24;
    const chunk = cells.slice(start, start + 24);
    pilots.push({
      name: cleanNames[i],
      cells: chunk,
      rawLen: chunk.length,
    });
  }
  return { pilots, warnings };
}

// One JetInsight cell can be:
//   - "n/a"                            → notApplicable
//   - "Missing"                        → no record (skip, don't overwrite)
//   - "Never"                          → KCM-style no-expiration mark
//   - "MM/DD/YYYY"                     → expiration date
//   - "MM/DD/YYYY (grace: MM/DD/YYYY)" → expiration with grace; we keep
//                                         the primary date and ignore grace
function parseCell(raw) {
  if (raw == null) return { kind: 'empty' };
  const s = String(raw).trim();
  if (!s) return { kind: 'empty' };
  const lower = s.toLowerCase();
  if (lower === 'n/a' || lower === 'na' || lower === '—' || lower === '-') {
    return { kind: 'na' };
  }
  if (lower === 'missing') return { kind: 'missing' };
  if (lower === 'never') return { kind: 'never' };

  // Date — MM/DD/YYYY, optionally followed by "(grace: MM/DD/YYYY)".
  // We accept M/D/YYYY too.
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mm = String(m[1]).padStart(2, '0');
    const dd = String(m[2]).padStart(2, '0');
    const yyyy = m[3];
    return { kind: 'date', dueDate: `${yyyy}-${mm}-${dd}` };
  }
  return { kind: 'unknown', raw: s };
}

/* ═══════════════════════════════════════════════════════════════════
   TABLE PARSER
   ═══════════════════════════════════════════════════════════════════ */

// Split a pasted blob into row arrays. We support:
//   - Tab-separated lines (the format browsers give when copying an
//     HTML table)
//   - Pipe-separated lines (manual structured paste)
//   - Comma-separated lines (CSV — careful with grace periods which
//     contain commas; we strip them first via the cell parser, but
//     prefer tab/pipe to avoid edge cases)
//
// Each row is expected to be: [pilotName, ...24 cells]. Rows that don't
// have at least 24 cells after the name are returned as-is — admin sees
// them in the preview as "incomplete row" and can fix.
function parseTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.replace(/\s+$/, ''))     // trim right
    .filter(l => l.trim().length > 0);

  // Detect delimiter by inspecting the first non-header line. Tabs win
  // over pipes which win over commas.
  let delim = '\t';
  const sample = lines.find(l => /[\t|,]/.test(l)) || '';
  if (sample.includes('\t')) delim = '\t';
  else if (sample.includes('|')) delim = '|';
  else if (sample.includes(',')) delim = ',';

  const rows = lines.map(line => {
    // Special handling for tab delimiter: split simply. For pipe/comma,
    // we strip any cell content that contains parens (grace periods
    // mid-cell — they may have commas).
    if (delim === '\t') return line.split('\t').map(c => c.trim());
    if (delim === '|') return line.split('|').map(c => c.trim());
    // CSV — naive split; cells with commas inside parens would break it.
    // We pre-process to swap parens commas with semicolons before splitting,
    // then revert. Rough but good enough for this dataset.
    const safe = line.replace(/\(([^)]*)\)/g, (_, inner) => `(${inner.replace(/,/g, ';')})`);
    return safe.split(',').map(c => c.trim().replace(/;/g, ','));
  });

  return rows;
}

// Build one parsed pilot record from a row.
// row[0] = name; row[1..24] = JetInsight cells.
function parsePilotRow(row) {
  const name = (row[0] || '').trim();
  if (!name) return null;

  const cells = row.slice(1, 25); // 24 cells expected
  const parsed = cells.map(parseCell);
  return { name, cells: parsed, rawLen: cells.length };
}

// Build the Firestore patch from a parsed pilot row. Returns:
//   {
//     updates: { [currencyKey]: { dueDate, notes? } | notApplicable: true | noExpiration: true },
//     medical: { class, expirationDate, notes? } | null,
//     warnings: [string],
//   }
//
// Only items with a recognized cell get written; missing/empty cells
// are not included in the patch (so existing data isn't blown away).
function buildPatchFromParsedRow(parsed) {
  const warnings = [];
  const updates = {};
  let medical = null;

  if (parsed.rawLen !== 24) {
    warnings.push(
      `Row has ${parsed.rawLen} cells, expected 24 — check that the paste includes all columns.`
    );
  }

  // Medical — leftmost dated of the 6 medical columns wins. Class
  // derived from column index (0,3=First; 1,4=Second; 2,5=Third).
  const medSchema = ['First', 'Second', 'Third', 'First', 'Second', 'Third'];
  let firstMed = -1;
  for (let i = 0; i < 6; i++) {
    if (parsed.cells[i]?.kind === 'date') { firstMed = i; break; }
  }
  if (firstMed >= 0) {
    medical = {
      class: medSchema[firstMed],
      expirationDate: parsed.cells[firstMed].dueDate,
      notes: 'Imported from JetInsight',
    };
  }

  // Items 6-23 in COLUMN_KEYS map to currency schema keys.
  for (let i = 6; i < COLUMN_KEYS.length; i++) {
    const key = COLUMN_KEYS[i];
    const cell = parsed.cells[i];
    if (!cell) continue;

    if (cell.kind === 'date') {
      updates[key] = { dueDate: cell.dueDate, notes: '' };
    } else if (cell.kind === 'na') {
      updates[key] = { notApplicable: true };
    } else if (cell.kind === 'never') {
      // For KCM-style items, "Never" means no expiration / badge issued.
      // The schema marks these with noExpiration: true on a per-item basis;
      // we also stamp issuedDate so the UI shows "issued" vs "not issued".
      updates[key] = { noExpiration: true, issued: true };
    } else if (cell.kind === 'missing') {
      // Don't overwrite — JetInsight has nothing to record. The pilot
      // currency UI will show this item as missing/unknown until admin
      // enters real data.
    } else if (cell.kind === 'unknown') {
      warnings.push(`${COLUMN_LABELS[i]}: unrecognized value "${cell.raw}"`);
    }
  }

  return { updates, medical, warnings };
}

/* ═══════════════════════════════════════════════════════════════════
   NAME MATCHING — JetInsight name → Firestore user
   ═══════════════════════════════════════════════════════════════════ */

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Score how well two names match. Higher = better. Returns 0 for no
// reasonable match. Uses token overlap so middle names don't matter.
function nameScore(parsedName, user) {
  const candidates = [user.name, user.jetinsightName, user.email];
  let best = 0;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const a = normalize(parsedName);
    const b = normalize(candidate);
    if (!a || !b) continue;
    if (a === b) return 100;

    // Token overlap (first + last especially)
    const tokensA = new Set(a.split(' '));
    const tokensB = new Set(b.split(' '));
    let shared = 0;
    for (const t of tokensA) if (tokensB.has(t)) shared++;
    const max = Math.max(tokensA.size, tokensB.size);
    const overlap = max > 0 ? (shared / max) * 100 : 0;

    // Bonus: first AND last tokens both match — strong signal.
    const firstA = [...tokensA][0];
    const firstB = [...tokensB][0];
    const lastA = [...tokensA].pop();
    const lastB = [...tokensB].pop();
    const firstMatch = firstA && firstA === firstB;
    const lastMatch = lastA && lastA === lastB;
    const bonus = (firstMatch && lastMatch) ? 25 : (firstMatch || lastMatch) ? 10 : 0;

    best = Math.max(best, overlap + bonus);
  }
  return best;
}

function pickBestMatch(parsedName, users) {
  let best = { user: null, score: 0 };
  for (const u of users) {
    if (!u.uid || u.approved === false) continue;
    const s = nameScore(parsedName, u);
    if (s > best.score) best = { user: u, score: s };
  }
  return best.score >= 60 ? best.user : null;
}

/* ═══════════════════════════════════════════════════════════════════
   UI BITS
   ═══════════════════════════════════════════════════════════════════ */

function PilotMatchPicker({ users, value, onChange, parsedName }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = useMemo(() => users.find(u => u.uid === value) || null, [users, value]);

  const candidates = useMemo(() => {
    const qn = q.trim().toLowerCase();
    return users
      .filter(u => u.uid && u.approved !== false)
      .filter(u => !qn
        || (u.name || '').toLowerCase().includes(qn)
        || (u.jetinsightName || '').toLowerCase().includes(qn)
        || (u.email || '').toLowerCase().includes(qn))
      .sort((a, b) => nameScore(parsedName, b) - nameScore(parsedName, a));
  }, [users, q, parsedName]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 bg-slate-950 border border-slate-700 hover:border-cyan-500/40 px-2 py-1 text-xs text-slate-100"
      >
        <span className={selected ? 'text-slate-100' : 'text-amber-300'}>
          {selected ? (selected.name || selected.email) : 'NO MATCH — pick…'}
        </span>
        <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-slate-900 border border-slate-700 max-h-72 overflow-y-auto">
          <div className="p-2 border-b border-slate-800 sticky top-0 bg-slate-900">
            <input
              autoFocus
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search…"
              className="w-full bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-100"
            />
          </div>
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false); }}
            className="w-full text-left p-2 border-b border-slate-800 text-xs text-amber-300 hover:bg-slate-800"
          >
            — Skip this pilot —
          </button>
          {candidates.map(u => (
            <button
              key={u.uid}
              type="button"
              onClick={() => { onChange(u.uid); setOpen(false); setQ(''); }}
              className={`w-full text-left p-2 border-b border-slate-800 last:border-b-0 hover:bg-slate-800 ${
                u.uid === value ? 'bg-cyan-500/10' : ''
              }`}
            >
              <div className="text-xs text-slate-100">{u.name || u.email}</div>
              <div className="text-[9px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {(u.role || 'crew').toUpperCase()}
                {u.jetinsightName && u.jetinsightName !== u.name ? ` · JI: ${u.jetinsightName}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PatchSummary({ patch }) {
  const fieldCount = Object.keys(patch.updates).length + (patch.medical ? 1 : 0);
  if (fieldCount === 0 && patch.warnings.length === 0) {
    return <div className="text-[10px] text-slate-500 italic">No fields to update.</div>;
  }
  return (
    <div className="space-y-0.5">
      {patch.medical && (
        <div className="text-[10px] text-slate-300">
          <span className="text-slate-500">Medical:</span>{' '}
          <span className="text-cyan-300">{patch.medical.class}</span>
          {' · '}
          <span className="text-cyan-300">{patch.medical.expirationDate}</span>
        </div>
      )}
      {Object.entries(patch.updates).map(([key, val]) => {
        const ct = CURRENCY_TYPES.find(t => t.key === key);
        const label = ct?.abbrev || key;
        if (val.notApplicable) {
          return <div key={key} className="text-[10px] text-slate-500">{label}: <span className="text-slate-600">n/a</span></div>;
        }
        if (val.noExpiration) {
          return <div key={key} className="text-[10px] text-slate-300">{label}: <span className="text-cyan-300">issued</span></div>;
        }
        return (
          <div key={key} className="text-[10px] text-slate-300">
            {label}: <span className="text-cyan-300">{val.dueDate}</span>
          </div>
        );
      })}
      {patch.warnings.map((w, i) => (
        <div key={i} className="text-[10px] text-amber-400 flex items-start gap-1">
          <AlertTriangle className="w-2.5 h-2.5 shrink-0 mt-0.5" />{w}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN MODAL
   ═══════════════════════════════════════════════════════════════════ */

export default function CurrencyImporter({ users, currentUserUid, onClose, onImported }) {
  const [step, setStep] = useState('paste'); // 'paste' | 'preview' | 'committing' | 'done'
  const [pasteText, setPasteText] = useState('');
  const [rows, setRows] = useState([]); // [{parsed, patch, match, include}]
  const [err, setErr] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [doneSummary, setDoneSummary] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfWarnings, setPdfWarnings] = useState([]);

  // Build the preview-row array from any parsed pilot list. Shared by
  // both the PDF and paste paths so name matching, patch building, and
  // checkbox state work identically downstream.
  const buildRowsFromParsed = (parsedList) => {
    const built = [];
    for (const parsed of parsedList) {
      // Filter out header-like rows the PDF parser might emit if the
      // page header text leaked through.
      const looksLikeHeader =
        /pilot|name|medical|ground|simulator|instrument/i.test(parsed.name)
        && !parsed.cells.some(c => c.kind === 'date');
      if (looksLikeHeader) continue;

      const patch = buildPatchFromParsedRow(parsed);
      const match = pickBestMatch(parsed.name, users);
      built.push({
        parsed,
        patch,
        matchUid: match?.uid || null,
        include: !!match,
      });
    }
    return built;
  };

  const handlePdfUpload = async (file) => {
    setErr(null);
    setPdfWarnings([]);
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      setErr('Please upload a PDF file.');
      return;
    }
    setPdfLoading(true);
    try {
      const text = await extractPdfText(file);
      const tokens = tokenizeJetInsightText(text);
      const { pilots, warnings } = parsePdfTokens(tokens);
      if (pilots.length === 0) {
        setErr(
          'Couldn\'t extract any pilot rows from this PDF. Either the format ' +
          'doesn\'t match JetInsight\'s "Crew checks by crew member" report, ' +
          'or the PDF is image-scanned (not text). Try copy/paste instead.'
        );
        return;
      }
      const built = buildRowsFromParsed(pilots);
      if (built.length === 0) {
        setErr('Parser ran but every row looked like a header — check the PDF.');
        return;
      }
      setRows(built);
      setPdfWarnings(warnings);
      setStep('preview');
    } catch (e) {
      console.error('PDF parse failed:', e);
      setErr(`PDF parse failed: ${e?.message || e}`);
    } finally {
      setPdfLoading(false);
    }
  };

  const handleParse = () => {
    setErr(null);
    if (!pasteText.trim()) {
      setErr('Paste some data first, or upload a PDF.');
      return;
    }
    try {
      const tableRows = parseTable(pasteText);
      const parsedList = tableRows
        .map(parsePilotRow)
        .filter(Boolean);
      const built = buildRowsFromParsed(parsedList);
      if (built.length === 0) {
        setErr('No pilot rows recognized. Make sure each line starts with the pilot name and is followed by 24 tab- or pipe-separated cells.');
        return;
      }
      setRows(built);
      setStep('preview');
    } catch (e) {
      setErr(e?.message || 'Parse failed');
    }
  };

  const handleCommit = async () => {
    setErr(null);
    const toWrite = rows.filter(r => r.include && r.matchUid);
    if (toWrite.length === 0) {
      setErr('Select at least one pilot to import.');
      return;
    }
    setStep('committing');
    setProgress({ done: 0, total: toWrite.length });
    let written = 0;
    let errors = 0;
    for (const row of toWrite) {
      try {
        // savePilotCurrency expects (uid, updates, currentUserUid, pilotName)
        // where updates is a partial doc. We pass our updates plus medical.
        const updates = { ...row.patch.updates };
        if (row.patch.medical) updates.medical = row.patch.medical;
        const userObj = users.find(u => u.uid === row.matchUid);
        await savePilotCurrency(
          row.matchUid,
          updates,
          currentUserUid,
          userObj?.name || userObj?.email || row.parsed.name
        );
        written++;
      } catch (e) {
        console.error('Import failed for', row.parsed.name, e);
        errors++;
      } finally {
        setProgress(p => ({ ...p, done: p.done + 1 }));
      }
    }
    setDoneSummary({ written, errors, total: toWrite.length });
    setStep('done');
    if (onImported) onImported({ written, errors });
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-3">
      <div className="w-full max-w-5xl bg-slate-900 border border-slate-700 flex flex-col max-h-[95vh]">
        <div className="flex items-center justify-between p-3 border-b border-slate-800 shrink-0">
          <h2 className="text-sm tracking-widest text-slate-200 flex items-center gap-2"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <Upload className="w-4 h-4" /> IMPORT FROM JETINSIGHT
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* STEP: PASTE */}
        {step === 'paste' && (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">

            {/* PRIMARY PATH — PDF UPLOAD */}
            <div className="border border-cyan-500/40 bg-cyan-500/5 p-4">
              <h3 className="text-xs tracking-widest text-cyan-300 mb-2 flex items-center gap-2"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <FileText className="w-4 h-4" /> UPLOAD JETINSIGHT PDF (RECOMMENDED)
              </h3>
              <ol className="text-xs text-slate-400 space-y-1 list-decimal pl-5 mb-3">
                <li>JetInsight → Compliance → Reports → Crew checks by crew member</li>
                <li>Click the print/export icon → save as PDF</li>
                <li>Drop the PDF below — we'll parse all pilots in one shot</li>
              </ol>
              <label
                className={`flex items-center justify-center gap-3 border-2 border-dashed border-cyan-500/40 hover:border-cyan-400 bg-slate-950/40 hover:bg-cyan-500/5 p-6 cursor-pointer transition-colors ${
                  pdfLoading ? 'opacity-50 pointer-events-none' : ''
                }`}
              >
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  disabled={pdfLoading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handlePdfUpload(file);
                    // reset input so same file can be re-picked after fix
                    e.target.value = '';
                  }}
                />
                {pdfLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin text-cyan-300" />
                    <span className="text-sm text-slate-300">Reading PDF…</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-5 h-5 text-cyan-300" />
                    <span className="text-sm text-cyan-100">
                      Click to choose PDF, or drag and drop
                    </span>
                  </>
                )}
              </label>
            </div>

            {/* SECONDARY PATH — PASTE */}
            <details className="border border-slate-800 bg-slate-950/40">
              <summary className="cursor-pointer p-3 text-xs tracking-widest text-slate-400 hover:text-slate-200 select-none"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                ALTERNATE: PASTE TABLE TEXT (TAB/PIPE/COMMA-SEPARATED)
              </summary>
              <div className="p-3 pt-0 space-y-3">
                <div className="text-xs text-slate-400 leading-relaxed">
                  Cmd+A in the JetInsight table → Cmd+C → paste here. Each row should
                  start with the pilot name followed by 24 cells (6 medical + 18
                  training/checks). Header row is auto-skipped.
                </div>
                <textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  rows={10}
                  placeholder={
                    "Daniel Sarkis\tn/a\tn/a\tn/a\t10/31/2026\t04/30/2027\t04/30/2028\t02/28/2027\t...\n" +
                    "Olivia Caldwell\t12/31/2026\t12/31/2026\t12/31/2030\tn/a\tn/a\tn/a\t06/30/2027\t..."
                  }
                  className="w-full bg-slate-950 border border-slate-700 p-2 text-xs text-slate-100 font-mono focus:border-cyan-500/60 outline-none"
                />
                <button
                  type="button"
                  onClick={handleParse}
                  className="px-4 py-2 text-[11px] tracking-widest border border-cyan-500/40 hover:border-cyan-400 text-cyan-300 hover:text-cyan-200 inline-flex items-center gap-2"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  <Search className="w-3 h-3" /> PARSE PASTED TEXT
                </button>
              </div>
            </details>

            {err && (
              <div className="border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>{err}</div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 text-[11px] tracking-widest text-slate-400 hover:text-slate-200"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >CANCEL</button>
            </div>
          </div>
        )}

        {/* STEP: PREVIEW */}
        {step === 'preview' && (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
              {pdfWarnings.length > 0 && (
                <div className="border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200 space-y-1">
                  {pdfWarnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <div>{w}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-xs text-slate-400">
                  {rows.length} row{rows.length === 1 ? '' : 's'} parsed ·{' '}
                  <span className="text-cyan-300">{rows.filter(r => r.include && r.matchUid).length} selected</span> ·{' '}
                  <span className="text-amber-300">{rows.filter(r => !r.matchUid).length} unmatched</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRows(R => R.map(r => ({ ...r, include: !!r.matchUid })))}
                    className="text-[10px] tracking-widest text-slate-400 hover:text-cyan-300"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >SELECT ALL MATCHED</button>
                  <span className="text-slate-700">|</span>
                  <button
                    type="button"
                    onClick={() => setRows(R => R.map(r => ({ ...r, include: false })))}
                    className="text-[10px] tracking-widest text-slate-400 hover:text-cyan-300"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >DESELECT ALL</button>
                </div>
              </div>

              <div className="border border-slate-800 divide-y divide-slate-800">
                {rows.map((row, i) => (
                  <div
                    key={i}
                    className={`p-3 grid grid-cols-12 gap-3 ${
                      row.include && row.matchUid ? 'bg-cyan-500/5' : ''
                    }`}
                  >
                    {/* Include checkbox */}
                    <div className="col-span-1 flex items-start pt-1">
                      <input
                        type="checkbox"
                        disabled={!row.matchUid}
                        checked={row.include && !!row.matchUid}
                        onChange={e => setRows(R => R.map((r, idx) => idx === i ? { ...r, include: e.target.checked } : r))}
                        className="w-4 h-4 accent-cyan-500 disabled:opacity-30"
                      />
                    </div>
                    {/* JetInsight name + match picker */}
                    <div className="col-span-4 min-w-0">
                      <div className="text-sm text-slate-100 truncate">{row.parsed.name}</div>
                      <div className="text-[10px] text-slate-500 mb-1"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        FROM JETINSIGHT
                      </div>
                      <PilotMatchPicker
                        users={users}
                        value={row.matchUid}
                        parsedName={row.parsed.name}
                        onChange={(uid) => setRows(R => R.map((r, idx) =>
                          idx === i ? { ...r, matchUid: uid, include: !!uid && r.include } : r
                        ))}
                      />
                    </div>
                    {/* Patch summary */}
                    <div className="col-span-7 min-w-0">
                      <div className="text-[10px] text-slate-500 mb-1"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        FIELDS TO WRITE
                      </div>
                      <PatchSummary patch={row.patch} />
                    </div>
                  </div>
                ))}
              </div>

              {err && (
                <div className="border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>{err}</div>
                </div>
              )}
            </div>

            <div className="p-3 border-t border-slate-800 flex items-center justify-between gap-2 shrink-0">
              <button
                type="button"
                onClick={() => { setStep('paste'); setRows([]); }}
                className="px-3 py-2 text-[11px] tracking-widest text-slate-400 hover:text-slate-200"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >← BACK</button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-2 text-[11px] tracking-widest text-slate-400 hover:text-slate-200"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >CANCEL</button>
                <button
                  type="button"
                  onClick={handleCommit}
                  className="px-4 py-2 text-[11px] tracking-widest bg-cyan-500 hover:bg-cyan-400 text-slate-950 inline-flex items-center gap-2"
                  style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}
                >
                  <Check className="w-3 h-3" />
                  IMPORT {rows.filter(r => r.include && r.matchUid).length} PILOT{rows.filter(r => r.include && r.matchUid).length === 1 ? '' : 'S'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* STEP: COMMITTING */}
        {step === 'committing' && (
          <div className="flex-1 flex items-center justify-center p-10">
            <div className="text-center space-y-3">
              <Loader2 className="w-8 h-8 animate-spin text-cyan-400 mx-auto" />
              <div className="text-slate-300">
                Writing {progress.done} of {progress.total}…
              </div>
              <div className="w-64 h-1 bg-slate-800 mx-auto">
                <div
                  className="h-full bg-cyan-400 transition-all"
                  style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* STEP: DONE */}
        {step === 'done' && doneSummary && (
          <>
            <div className="flex-1 flex items-center justify-center p-10">
              <div className="text-center space-y-4">
                <div className="w-12 h-12 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center mx-auto">
                  <Check className="w-6 h-6 text-cyan-300" />
                </div>
                <div className="text-slate-100 text-lg">Import complete</div>
                <div className="text-slate-400 text-sm space-y-1">
                  <div>{doneSummary.written} pilot record{doneSummary.written === 1 ? '' : 's'} updated</div>
                  {doneSummary.errors > 0 && (
                    <div className="text-red-300">{doneSummary.errors} error{doneSummary.errors === 1 ? '' : 's'} — check console</div>
                  )}
                </div>
              </div>
            </div>
            <div className="p-3 border-t border-slate-800 flex items-center justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-[11px] tracking-widest bg-cyan-500 hover:bg-cyan-400 text-slate-950"
                style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}
              >DONE</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
