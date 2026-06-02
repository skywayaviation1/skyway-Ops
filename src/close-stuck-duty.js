// =====================================================================
// CLOSE-ALL-OPEN-DUTY — browser console one-shot
// =====================================================================
//
// PURPOSE
//   Close every duty-state document currently in status='on'. Use this when
//   pilots have been left stuck "on duty" by the old buggy console and you
//   want a clean slate for the new DutySimple flow without losing historical
//   closed records.
//
// WHAT IT DOES
//   For each open period it writes:
//     status:    'off'                         so subscribeToActiveDuty stops
//                                              returning it
//     dutyOffAt: dutyOnAt                      zero-length close. Does NOT
//                                              invent duty hours that weren't
//                                              really flown.
//     restUntil: null                          no rest window imposed
//     over14:    false                         flag cleared
//     adminEdits[]:                            bulk-close audit entry
//
// WHAT IT DOES NOT DO
//   - Touch any document with status='off' — historical records preserved
//   - Delete any documents — only updates fields
//   - Touch any non-duty collection
//
// HOW TO RUN (two-step, by design)
//
//   STEP 1 — Expose Firestore to the console
//   ─────────────────────────────────────────
//   1. Sign in as admin at skyway-ops.vercel.app
//   2. Navigate to ANY screen where the app is fully loaded (the home
//      screen is fine). This guarantees firebase.js is in the module cache.
//   3. Open DevTools (Cmd+Opt+I on Mac, F12 on Windows), Console tab.
//   4. Paste this exact line and press Enter:
//
//        const m = await import("/src/firebase.js"); window.__db = m.db;
//
//      You should see `undefined` returned (this is normal — the assignment
//      doesn't have a return value). Verify with:    window.__db
//      Should print a FirestoreImpl object, not undefined.
//
//   STEP 2 — Paste the close script (this file)
//   ───────────────────────────────────────────
//   1. Paste this ENTIRE FILE into the console and press Enter.
//   2. Read the PREVIEW table that prints. It lists every open duty period
//      that would be closed.
//   3. If the preview looks correct, run:
//
//        window.__closeAllOpenDuty.run()
//
//      That actually writes the updates. You'll see green ✓ rows for
//      successes and red rows for any failures.
//   4. If the preview looks wrong (unexpected pilots, surprising counts),
//      do NOT call .run(). No data has been changed by the preview alone.
//
// SAFETY
//   - Two-step confirmation: pasting the script only PREVIEWS. You must
//     explicitly call .run() to write.
//   - Idempotent: if you call .run() twice, the second call sees no
//     open periods and exits cleanly.
//   - Failures are isolated: if one write fails, the others continue.
//     A final report lists what succeeded and what didn't.

(async () => {
  const log = (text, color = '#cbd5e1', bold = false) => {
    console.log(`%c${text}`, `color:${color};${bold ? 'font-weight:bold;' : ''}`);
  };
  const header = (text) => {
    console.log(`\n%c━━━ ${text} ━━━`, 'color:#1ec0e9; font-weight:bold; font-size:13px;');
  };

  header('CLOSE-ALL-OPEN-DUTY — preview mode');

  // Verify the preamble ran
  if (!window.__db) {
    log('window.__db is not set.', '#ef4444', true);
    log('Run the STEP 1 preamble first. See header comment at top of this file.', '#fbbf24');
    log('Quick version: paste this single line first, then re-paste this script:', '#cbd5e1');
    log('    const m = await import("/src/firebase.js"); window.__db = m.db;', '#1ec0e9');
    return;
  }
  const db = window.__db;

  // Load the Firestore SDK from the CDN. Version matches the app's Firebase 10.x.
  let getDocs, query, collection, where, doc, getDoc, updateDoc;
  try {
    const sdk = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    ({ getDocs, query, collection, where, doc, getDoc, updateDoc } = sdk);
  } catch (e) {
    log(`Failed to load Firestore SDK: ${e.message}`, '#ef4444', true);
    return;
  }

  // -------- Preview: load every status='on' period --------
  let snap;
  try {
    snap = await getDocs(query(
      collection(db, 'duty-state'),
      where('status', '==', 'on')
    ));
  } catch (e) {
    log(`Query failed: ${e.message}`, '#ef4444', true);
    log('Most common cause: not signed in as admin/ops, or db points to wrong project.', '#94a3b8');
    return;
  }

  const openPeriods = [];
  snap.forEach((d) => openPeriods.push({ id: d.id, ...d.data() }));

  if (openPeriods.length === 0) {
    header('PREVIEW');
    log('No open duty periods. Nothing to close.', '#10b981', true);
    log('Historical (status="off") records are untouched.', '#64748b');
    return;
  }

  header(`PREVIEW — ${openPeriods.length} OPEN duty periods to close`);
  console.table(openPeriods.map((p) => ({
    id: p.id,
    pilot: p.pilotName || '(unknown)',
    role: p.role || '—',
    sic: p.sicName || '—',
    dutyOnAt: p.dutyOnAt ? new Date(p.dutyOnAt).toLocaleString() : '—',
    elapsedH: p.dutyOnAt ? ((Date.now() - p.dutyOnAt) / 3600000).toFixed(1) : '—',
    linked: p.linkedPeriodId ? 'yes' : 'no',
  })));

  log('Each row above will be closed with:', '#fbbf24');
  log('  status="off"   dutyOffAt=dutyOnAt   restUntil=null   over14=false', '#fbbf24');
  log('  + entry appended to adminEdits[] explaining the bulk close.', '#fbbf24');
  log('  Zero elapsed duty time. Does NOT invent FAR 117 hours.', '#fbbf24');
  console.log('');
  log('To proceed, run:    window.__closeAllOpenDuty.run()', '#1ec0e9', true);
  log('To cancel, do nothing. No data has been changed yet.', '#94a3b8');

  // Stash the actual close function on window so the user explicitly
  // invokes it. This is the second-step confirmation gate.
  window.__closeAllOpenDuty = {
    open: openPeriods,
    run: async () => {
      header(`CLOSING ${openPeriods.length} duty periods`);
      const closeAt = Date.now();
      const results = { ok: 0, skipped: 0, failed: [] };

      for (const p of openPeriods) {
        try {
          const ref = doc(db, 'duty-state', p.id);
          // Re-read to confirm doc is still 'on' — defensive in case a
          // pilot signed off between preview and run. Idempotent guard.
          const fresh = await getDoc(ref);
          if (!fresh.exists()) {
            results.skipped++;
            log(`  ${p.pilotName || p.id} — skipped (doc gone)`, '#94a3b8');
            continue;
          }
          const cur = fresh.data();
          if (cur.status !== 'on') {
            results.skipped++;
            log(`  ${p.pilotName || p.id} — skipped (already off)`, '#94a3b8');
            continue;
          }
          const onAt = cur.dutyOnAt || closeAt;
          const edits = Array.isArray(cur.adminEdits) ? cur.adminEdits : [];

          await updateDoc(ref, {
            status: 'off',
            dutyOffAt: onAt,         // zero-length close (see header)
            restUntil: null,         // no rest window imposed
            over14: false,
            adminEdits: [...edits, {
              by: 'bulk-close-script',
              at: closeAt,
              field: 'bulkClose',
              from: { status: 'on', dutyOffAt: cur.dutyOffAt || null },
              to:   { status: 'off', dutyOffAt: onAt },
              note: 'Bulk-closed stuck duty period during DutySimple migration. ' +
                    'Zero elapsed time. Pilot may start a fresh period.',
            }],
            updatedAt: closeAt,
          });
          results.ok++;
          log(`  ✓ ${p.pilotName || p.id} — closed`, '#10b981');
        } catch (err) {
          results.failed.push({ id: p.id, name: p.pilotName, err: err.message });
          log(`  ✗ ${p.pilotName || p.id} — FAILED: ${err.message}`, '#ef4444');
        }
      }

      header('RESULTS');
      log(`  ${results.ok} closed`, '#10b981', true);
      log(`  ${results.skipped} skipped (already off)`, '#94a3b8');
      log(`  ${results.failed.length} failed`,
          results.failed.length ? '#ef4444' : '#10b981',
          results.failed.length > 0);
      if (results.failed.length) {
        console.table(results.failed);
        log('Failures above are usually Firestore security rules. Verify admin role and retry.', '#ef4444');
      }
      log('Done. Pilots should see AVAILABLE state in the new DutySimple UI and can start fresh.', '#cbd5e1');
      // Clean up so a stray refresh doesn't keep the global alive
      delete window.__closeAllOpenDuty;
    },
  };
})();
