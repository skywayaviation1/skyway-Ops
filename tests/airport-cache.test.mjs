import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  FIRESTORE_DOCUMENT_BYTE_LIMIT,
  FIRESTORE_INDEX_ENTRY_LIMIT,
  MAX_AIRPORTS_PER_SHARD,
  buildAirportCachePlan,
  cacheDocIdForCode,
  estimateEntriesBytes,
  indexEntryCount,
  mergeCacheDocuments,
} from '../api/_airport-cache.js';
import { createAviowikiRuntime } from '../api/_aviowiki.js';

const root = path.resolve(import.meta.dirname, '..');

// Counts from the OurAirports operational extract (large/medium/small
// airports and seaplane bases, plus IATA aliases). "M" is the document
// named in the production INDEX_ENTRIES_COUNT_LIMIT_EXCEEDED error.
const OURAIRPORTS_PREFIX_COUNTS = {
  0: 682, 1: 651, 2: 672, 3: 634, 4: 587, 5: 555, 6: 545, 7: 501, 8: 487, 9: 480,
  A: 2539, B: 3018, C: 3333, D: 1060, E: 1951, F: 2494, G: 1567, H: 840, I: 1704,
  J: 370, K: 4616, L: 2045, M: 3377, N: 1472, O: 1061, P: 1547, Q: 37, R: 1294,
  S: 7090, T: 1142, U: 4406, V: 1000, W: 976, X: 205, Y: 2181, Z: 840,
};

function entry(code, name) {
  return {
    lat: 10,
    lng: -10,
    name: name || code,
    iata: null,
    iso: 'US',
  };
}

function mapFromCounts(counts) {
  const map = new Map();
  for (const [prefix, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) {
      const code = `${prefix}${String(i).padStart(4, '0')}`;
      map.set(code, entry(code));
    }
  }
  return map;
}

function fakeDb(docs) {
  return {
    collection() {
      return {
        doc(id) {
          return {
            async get() {
              if (!Object.prototype.hasOwnProperty.call(docs, id)) {
                return { exists: false, data() { return undefined; } };
              }
              return { exists: true, data() { return docs[id]; } };
            },
          };
        },
      };
    },
  };
}

test('a single M document exceeds the Firestore index-entry cap', () => {
  assert.equal(indexEntryCount(3377), 40_526);
  assert.ok(indexEntryCount(3377) > FIRESTORE_INDEX_ENTRY_LIMIT);
  // The next-smaller crowded letter still fits, which is why a one-letter
  // layout fails on M and not on every letter.
  assert.equal(indexEntryCount(3333), 39_998);
  assert.ok(indexEntryCount(3333) <= FIRESTORE_INDEX_ENTRY_LIMIT);
  assert.ok(indexEntryCount(MAX_AIRPORTS_PER_SHARD) < FIRESTORE_INDEX_ENTRY_LIMIT / 2);
});

test('today\'s OurAirports letters shard under the index and document caps', () => {
  const codes = mapFromCounts(OURAIRPORTS_PREFIX_COUNTS);
  const previousMeta = {
    chunkPrefixes: Object.keys(OURAIRPORTS_PREFIX_COUNTS),
    refreshedAt: 1,
    totalCodes: codes.size,
    source: 'ourairports.com',
  };
  const plan = buildAirportCachePlan(codes, previousMeta, { now: 1_700_000_000_000 });

  assert.equal(plan.docs.M, undefined);
  assert.equal(plan.docs.S, undefined);
  assert.equal(plan.docs.K, undefined);
  assert.equal(plan.docs.U, undefined);
  assert.ok(plan.deleteIds.includes('M'));
  assert.ok(plan.deleteIds.includes('S'));
  assert.ok(plan.deleteIds.includes('K'));
  assert.ok(plan.deleteIds.includes('U'));
  // V is exactly the shard size, so it stays the legacy letter doc.
  assert.ok(plan.docs.V);
  assert.equal(plan.deleteIds.includes('V'), false);
  assert.equal(plan.meta.shardRangesByPrefix.V, undefined);
  assert.equal(cacheDocIdForCode('V0000', plan.meta.shardRangesByPrefix), 'V');

  let maxAirports = 0;
  for (const [id, doc] of Object.entries(plan.docs)) {
    const count = Object.keys(doc.entries).length;
    maxAirports = Math.max(maxAirports, count);
    assert.ok(count <= MAX_AIRPORTS_PER_SHARD, id);
    assert.ok(indexEntryCount(count) <= FIRESTORE_INDEX_ENTRY_LIMIT, id);
    assert.ok(estimateEntriesBytes(doc.entries) <= FIRESTORE_DOCUMENT_BYTE_LIMIT, id);
  }
  assert.ok(maxAirports <= MAX_AIRPORTS_PER_SHARD);

  for (const code of codes.keys()) {
    const id = cacheDocIdForCode(code, plan.meta.shardRangesByPrefix);
    assert.equal(plan.docs[id]?.entries?.[code]?.name, code);
  }

  const sets = plan.operations.filter((op) => op.type === 'set');
  const deletes = plan.operations.filter((op) => op.type === 'delete');
  assert.equal(sets.at(-1).id, '_meta');
  assert.deepEqual(deletes.map((op) => op.id), plan.deleteIds);
  assert.ok(plan.operations.length < 450, 'production refresh still fits in one batch');
  assert.equal(plan.meta.layout, 'prefix-shards');
  assert.equal(plan.meta.refreshedAt, 1_700_000_000_000);
});

test('small prefixes stay on the legacy letter doc', () => {
  const plan = buildAirportCachePlan(new Map([
    ['KTEB', entry('KTEB', 'Teterboro')],
    ['TEB', entry('TEB', 'Teterboro')],
  ]), null, { now: 5 });
  assert.deepEqual(Object.keys(plan.docs).sort(), ['K', 'T']);
  assert.equal(plan.docs.K.entries.KTEB.name, 'Teterboro');
  assert.deepEqual(plan.deleteIds, []);
  assert.equal(cacheDocIdForCode('KTEB', plan.meta.shardRangesByPrefix), 'K');
  assert.equal(cacheDocIdForCode('teb', null), 'T');
});

test('lookup merge lets a shard overwrite a stale letter doc', () => {
  const merged = mergeCacheDocuments([
    ['_meta', { refreshedAt: 1, entries: { NOPE: { name: 'meta' } } }],
    ['M~000', { entries: { MMMX: { name: 'Mexico City', lat: 19.4, lng: -99.1 } } }],
    ['M', { entries: { MMMX: { name: 'STALE' }, ONLYOLD: { name: 'legacy' } } }],
  ]);
  assert.equal(merged.get('MMMX').name, 'Mexico City');
  assert.equal(merged.get('ONLYOLD').name, 'legacy');
  assert.equal(merged.has('NOPE'), false);
});

test('long names split a prefix before the 1 MiB document cap', () => {
  const codes = new Map();
  for (let i = 0; i < 40; i += 1) {
    const code = `Z${String(i).padStart(3, '0')}`;
    codes.set(code, entry(code, 'X'.repeat(20_000)));
  }
  const plan = buildAirportCachePlan(codes, { chunkPrefixes: ['Z'], chunkDocIds: ['Z'] }, { now: 9 });
  assert.equal(plan.docs.Z, undefined);
  assert.deepEqual(plan.deleteIds, ['Z']);
  assert.ok(Object.keys(plan.docs).length > 1);
  for (const doc of Object.values(plan.docs)) {
    assert.ok(estimateEntriesBytes(doc.entries) <= 800_000);
  }
  for (const code of codes.keys()) {
    const id = cacheDocIdForCode(code, plan.meta.shardRangesByPrefix);
    assert.equal(plan.docs[id].entries[code].name.length, 20_000);
  }
});

test('aviowiki fallback reads shards and still reads a legacy letter doc', async () => {
  const runtime = createAviowikiRuntime({
    env: {},
    fetchImpl: async () => {
      throw new Error('offline');
    },
    runwayCache: { csv: '', expiresAt: 0 },
  });

  const legacy = await runtime.ourAirportsFallback('KTEB', fakeDb({
    K: { entries: { KTEB: { lat: 40.85, lng: -74.06, name: 'Teterboro', iata: 'TEB', iso: 'US' } } },
  }));
  assert.equal(legacy.airport.name, 'Teterboro');
  assert.equal(legacy.airport.iata, 'TEB');
  assert.equal(legacy.source, 'ourairports');

  const codes = new Map();
  for (let i = 0; i < 1500; i += 1) {
    codes.set(`M${String(i).padStart(4, '0')}`, entry(`M${String(i).padStart(4, '0')}`));
  }
  codes.set('MMMX', { lat: 19.43, lng: -99.07, name: 'Mexico City', iata: 'MEX', iso: 'MX' });
  const plan = buildAirportCachePlan(codes, { chunkPrefixes: ['M'] }, { now: 11 });
  const db = fakeDb({
    ...plan.docs,
    _meta: plan.meta,
    M: { entries: { MMMX: { lat: 0, lng: 0, name: 'STALE', iata: null, iso: 'MX' } } },
  });
  const sharded = await runtime.ourAirportsFallback('MMMX', db);
  assert.equal(sharded.airport.name, 'Mexico City');
  assert.equal(sharded.airport.latitude, 19.43);
  assert.equal(sharded.airport.country, 'MX');

  const missed = await runtime.ourAirportsFallback('M9999', db);
  assert.equal(missed, null);
});

test('refresh and lookup are wired to the shared cache plan', async () => {
  const refresh = await readFile(path.join(root, 'api/airport-coords-refresh.js'), 'utf8');
  const lookup = await readFile(path.join(root, 'api/airport-coords-lookup.js'), 'utf8');
  assert.match(refresh, /buildAirportCachePlan\(map, previousMeta\)/);
  assert.match(refresh, /commitCacheOperations\(db, plan\.operations\)/);
  assert.doesNotMatch(refresh, /chunks\[prefix\]/);
  assert.match(lookup, /mergeCacheDocuments\(docs\)/);
});
