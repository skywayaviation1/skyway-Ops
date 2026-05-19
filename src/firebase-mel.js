// MEL (Minimum Equipment List) library data layer.
//
// COMPLIANCE BOUNDARY (read before extending):
//   The approved MEL is a regulatory document. This module STORES and
//   SEARCHES a verbatim copy of the operator's own FAA-approved MEL and
//   helps a qualified person FIND the relevant item faster. It does NOT
//   determine deferrability. Whether a discrepancy may be deferred — under
//   which item, with which (M)/(O) procedures, what number must be
//   operative — is an airworthiness determination made by a qualified
//   person reading the actual approved MEL. Remarks/provisos are stored
//   and shown VERBATIM; nothing here paraphrases or decides.
//
//   Revision model: one document per (tail, revision) in `mel-revisions`.
//   status: 'draft'      — ingested, awaiting qualified-person review
//           'active'     — the in-effect MEL for that tail (exactly one)
//           'superseded' — a former active revision, retained for history
//   Activating a revision supersedes the prior active one for that tail.
//
//   Firestore: named DB `appusers` (db from ./firebase.js). Timestamps are
//   epoch ms. Queries use a single where() + client-side sort so NO
//   composite index is ever required.

import { db } from './firebase.js';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';

export const MEL_STATUS = { DRAFT: 'draft', ACTIVE: 'active', SUPERSEDED: 'superseded' };

// Firestore single-doc hard limit is ~1 MiB. A full LR-60 MEL with verbatim
// (M)/(O) procedures is well under that, but fail LOUD rather than silently
// truncate if a future/larger MEL approaches the limit.
const DOC_SIZE_SOFT_LIMIT = 900 * 1024;

function safeTail(t) {
  return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
function rid(tail, label) {
  const t = safeTail(tail);
  const l = String(label || 'rev').replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'rev';
  return `${t}_${l}_${Date.now()}`;
}

/* ============================================================
   WRITE — ingest produces a DRAFT revision (server-side
   api/mel-ingest.js calls this after extraction).
   ============================================================ */

export async function saveDraftRevision(input) {
  const tail = safeTail(input.tail);
  if (!tail) throw new Error('saveDraftRevision: tail required');
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('saveDraftRevision: items[] required and non-empty');
  }
  const now = Date.now();
  const id = input.id || rid(tail, input.revisionLabel);
  const rec = {
    id,
    tail,
    revisionLabel: String(input.revisionLabel || 'ORIGINAL'),
    revisionDate: String(input.revisionDate || ''),
    basedOn: input.basedOn ? String(input.basedOn) : null,
    sourceFile: input.sourceFile ? String(input.sourceFile) : null,
    status: MEL_STATUS.DRAFT,
    items: input.items,
    itemCount: input.items.length,
    sectionCounts: input.sectionCounts || {},
    ingestReport: input.ingestReport || {},     // anomalies / per-section flags
    createdAt: now,
    createdByUid: input.byUid || null,
    createdByName: input.byName || 'Unknown',
    activatedAt: null,
    activatedByName: null,
    supersededAt: null,
  };
  const approxBytes = (() => { try { return JSON.stringify(rec).length; } catch (e) { return 0; } })();
  if (approxBytes > DOC_SIZE_SOFT_LIMIT) {
    throw new Error(
      `saveDraftRevision: revision ~${Math.round(approxBytes / 1024)}KB exceeds the ` +
      `single-document soft limit (${Math.round(DOC_SIZE_SOFT_LIMIT / 1024)}KB). ` +
      `This MEL must be sharded into chunk docs before storing — do not truncate.`
    );
  }
  await setDoc(doc(db, 'mel-revisions', id), rec);
  return id;
}

/* ============================================================
   READ
   ============================================================ */

export function subscribeRevisions(tail, onUpdate) {
  const qy = query(collection(db, 'mel-revisions'), where('tail', '==', safeTail(tail)));
  return onSnapshot(
    qy,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      onUpdate(list);
    },
    (err) => { console.error('[mel] subscribeRevisions:', err); onUpdate([]); }
  );
}

// The in-effect MEL for a tail (exactly one 'active', or null). Single
// where() + client filter — no composite index.
export async function getActiveRevision(tail) {
  const t = safeTail(tail);
  return await new Promise((resolve) => {
    const qy = query(collection(db, 'mel-revisions'), where('tail', '==', t));
    const unsub = onSnapshot(
      qy,
      (snap) => {
        let active = null;
        snap.forEach((d) => {
          const v = d.data();
          if (v.status === MEL_STATUS.ACTIVE) active = { ...v, id: d.id };
        });
        try { unsub(); } catch (e) {}
        resolve(active);
      },
      (err) => { console.error('[mel] getActiveRevision:', err); try { unsub(); } catch (e) {} resolve(null); }
    );
  });
}

export function subscribeActiveRevision(tail, onUpdate) {
  const t = safeTail(tail);
  const qy = query(collection(db, 'mel-revisions'), where('tail', '==', t));
  return onSnapshot(
    qy,
    (snap) => {
      let active = null;
      snap.forEach((d) => {
        const v = d.data();
        if (v.status === MEL_STATUS.ACTIVE) active = { ...v, id: d.id };
      });
      onUpdate(active);
    },
    (err) => { console.error('[mel] subscribeActiveRevision:', err); onUpdate(null); }
  );
}

/* ============================================================
   ACTIVATE — qualified-person action. Supersedes the prior
   active revision for the same tail, then marks this one
   in-effect. Audit-stamped. (The human review of the draft
   against the source PDF is the compliance gate.)
   ============================================================ */

export async function activateRevision(revId, opts = {}) {
  const ref = doc(db, 'mel-revisions', revId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('activateRevision: not found');
  const rev = snap.data();
  if (rev.status === MEL_STATUS.ACTIVE) return { ok: true, already: true };
  const tail = safeTail(rev.tail);
  const now = Date.now();

  // Supersede any currently-active revision for this tail.
  await new Promise((resolve) => {
    const qy = query(collection(db, 'mel-revisions'), where('tail', '==', tail));
    const unsub = onSnapshot(qy, async (s) => {
      try { unsub(); } catch (e) {}
      const tasks = [];
      s.forEach((d) => {
        if (d.id !== revId && d.data().status === MEL_STATUS.ACTIVE) {
          tasks.push(updateDoc(doc(db, 'mel-revisions', d.id), {
            status: MEL_STATUS.SUPERSEDED, supersededAt: now,
          }));
        }
      });
      await Promise.all(tasks);
      resolve();
    }, () => { try { unsub(); } catch (e) {} resolve(); });
  });

  await updateDoc(ref, {
    status: MEL_STATUS.ACTIVE,
    activatedAt: now,
    activatedByUid: opts.byUid || null,
    activatedByName: opts.byName || 'Unknown',
  });
  return { ok: true };
}

export async function deleteDraftRevision(revId) {
  const ref = doc(db, 'mel-revisions', revId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  if (snap.data().status !== MEL_STATUS.DRAFT) {
    throw new Error('deleteDraftRevision: only DRAFT revisions may be deleted');
  }
  await deleteDoc(ref);
}

/* ============================================================
   SEARCH  (pure — exact/keyword over the active revision's
   verbatim items; slice-2 backbone, also used to resolve the
   AI finder's suggested references in slice 3)
   ============================================================ */

function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}

// Returns items scored by token overlap across ref / system / item /
// subitem / remarks. Higher score = better match. Verbatim text unchanged.
export function searchMelItems(items, queryStr, limit = 25) {
  const q = tokenize(queryStr);
  if (!Array.isArray(items) || q.length === 0) return [];
  const scored = [];
  for (const it of items) {
    const hayName = `${it.system_name || ''} ${it.item || ''} ${it.subitem_name || ''} ${it.ref || ''}`.toLowerCase();
    const hayRem = String(it.remarks || '').toLowerCase();
    let score = 0;
    for (const tk of q) {
      if (hayName.includes(tk)) score += 5;          // name/system match weighs most
      if (hayRem.includes(tk)) score += 1;           // proviso text match
      if (String(it.ref || '').toLowerCase().includes(tk)) score += 4; // ATA ref
    }
    // require at least one strong (name/ref) hit OR all tokens somewhere
    const allSomewhere = q.every((tk) => hayName.includes(tk) || hayRem.includes(tk));
    if (score >= 5 || (allSomewhere && score > 0)) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.it);
}

// Resolve AI-suggested refs (e.g. "ATA 21-1 A") back to the verbatim stored
// items — the model only points; the app shows the real text.
export function resolveRefs(items, refs) {
  if (!Array.isArray(items) || !Array.isArray(refs)) return [];
  const norm = (r) => String(r || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const want = new Set(refs.map(norm));
  return items.filter((it) => want.has(norm(it.ref)));
}

/* ============================================================
   ASSIGN-TO-DEFERRAL BRIDGE  (pure mapper)
   ------------------------------------------------------------
   Builds the input object for firebase-maint.createMelDeferral
   from a MEL item. The qualified user reviews & submits — the
   existing deferral form is the confirm point. Remarks are
   carried VERBATIM into the deferral record.
   ============================================================ */

export function melItemToDeferralInput(item, tail) {
  if (!item) throw new Error('melItemToDeferralInput: item required');
  const cat = ['A', 'B', 'C', 'D'].includes(item.category) ? item.category : null;
  const name = item.subitem
    ? `${item.item} — ${item.subitem}. ${item.subitem_name || ''}`.trim()
    : item.item;
  return {
    tail: safeTail(tail || ''),
    category: cat,                                  // null => not relievable by category alone
    description: `${item.ref}: ${name}`.trim(),
    remarks: String(item.remarks || ''),            // VERBATIM provisos
    melRef: item.ref,
    melSystem: `${item.system} ${item.system_name}`,
    melMaintRequired: item.maint_required === true,
    melOpsRequired: item.ops_required === true,
    nonRelief: item.non_relief === true,
  };
}
