/**
 * OurAirports coordinate cache layout for Firestore collection
 * `airport-cache-ourairports` in the named `appusers` database.
 *
 * One document per first letter (doc id "M" holding every M* airport under
 * `entries`) exceeds Firestore's 40,000 index entries per document.
 * Automatic single-field indexes write an ascending and a descending entry
 * for `entries`, for each `entries.{code}` map, and for lat, lng, name,
 * iata, and iso: 2 + 12 per airport. 3,333 airports is 39,998 entries.
 * The current OurAirports extract puts about 3,377 airports in "M"
 * (40,526 entries). "S", "K", and "U" are larger and miss the same cap.
 * Production commits fail with INDEX_ENTRIES_COUNT_LIMIT_EXCEEDED on
 * `/airport-cache-ourairports/M`.
 *
 * Prefixes that fit stay in the legacy one-character doc so existing
 * readers keep working. Prefixes that do not fit are stored as sorted
 * slices `{prefix}~000`, `{prefix}~001`, ... Ranges live on `_meta` so a
 * single-code read can open the right shard.
 *
 * A refresh writes every shard before `_meta`, then deletes replaced docs.
 * The bulk lookup merges the whole collection and lets a shard id override
 * the legacy letter doc, so coordinates stay readable if a later commit
 * fails. Single-code reads follow `_meta` only after the shards it names
 * exist, and replaced docs are removed only after `_meta` no longer
 * addresses them.
 */

export const AIRPORT_CACHE_COLLECTION = 'airport-cache-ourairports';
export const AIRPORT_CACHE_META_ID = '_meta';

export const FIRESTORE_INDEX_ENTRY_LIMIT = 40_000;
export const FIRESTORE_DOCUMENT_BYTE_LIMIT = 1_048_576;

// 1,000 airports is about 12,002 index entries and well under 1 MiB.
// The byte cap splits a shard earlier if names are unusually long.
export const MAX_AIRPORTS_PER_SHARD = 1000;
export const MAX_SHARD_BYTES = 800_000;

// Commit RPC budget. Firestore rejects a batch once the documents and the
// index entries they add or remove exceed 10 MiB
// ("Transaction too big. Decrease transaction size."), independent of the
// 500-write cap. A set that overwrites a shard removes the previous index
// entries and adds new ones, so the pack budget is under half of 10 MiB.
export const FIRESTORE_TRANSACTION_BYTE_LIMIT = 10 * 1024 * 1024;
export const MAX_COMMIT_BYTES = 4 * 1024 * 1024;
export const MAX_BATCH_OPS = 450;

// A legacy letter doc cannot be stored past the 40,000 index-entry cap
// (3,333 airports of this shape, about 5.5 MiB of document + index bytes).
// Deletes we could not read are charged this much so two of them cannot
// share a commit.
export const UNKNOWN_DELETE_TRANSACTION_BYTES = 6 * 1024 * 1024;

const DOC_OVERHEAD_BYTES = 256;
const ENTRY_OVERHEAD_BYTES = 48;
const INDEX_VALUE_TRUNCATE_BYTES = 1500;
const ROOT_PARENT_NAME_BYTES = 16;

export function indexEntryCount(airportCount) {
  const count = Number(airportCount) || 0;
  return 2 + count * 12;
}

export function estimateEntryBytes(code, entry) {
  const name = entry?.name ? String(entry.name) : '';
  const iata = entry?.iata ? String(entry.iata) : '';
  const iso = entry?.iso ? String(entry.iso) : '';
  return ENTRY_OVERHEAD_BYTES + String(code).length + name.length + iata.length + iso.length;
}

export function estimateEntriesBytes(entries) {
  let bytes = DOC_OVERHEAD_BYTES;
  const pairs = entries instanceof Map ? entries.entries() : Object.entries(entries || {});
  for (const [code, entry] of pairs) bytes += estimateEntryBytes(code, entry);
  return bytes;
}

function stringSize(value) {
  return Buffer.byteLength(String(value), 'utf8') + 1;
}

function scalarSize(value) {
  if (value == null) return 1;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return stringSize(value);
  return 1;
}

function valueSize(value) {
  if (Array.isArray(value)) {
    let size = 0;
    for (const item of value) size += valueSize(item);
    return size;
  }
  if (value && typeof value === 'object') return mapValueSize(value);
  return scalarSize(value);
}

function mapValueSize(obj) {
  let size = 32;
  for (const [key, child] of Object.entries(obj)) {
    size += stringSize(key) + valueSize(child);
  }
  return size;
}

function documentNameSize(docId) {
  return stringSize(AIRPORT_CACHE_COLLECTION) + stringSize(docId) + 16;
}

// One collection-scope single-field index entry, ascending or descending.
function indexEntrySize(docName, fieldPath, indexedValueSize) {
  return docName
    + ROOT_PARENT_NAME_BYTES
    + stringSize(fieldPath)
    + Math.min(indexedValueSize, INDEX_VALUE_TRUNCATE_BYTES)
    + 32;
}

/**
 * Bytes Firestore counts toward the commit transaction limit for one
 * document: stored document size plus ascending and descending single-field
 * index entries. Map fields count once for the whole map (truncated at
 * 1,500 bytes) and again for each nested field. This is the cost that makes
 * a ~100-op refresh exceed 10 MiB even though the document bodies are ~6 MiB.
 */
export function estimateTransactionBytes(docId, data) {
  const body = data && typeof data === 'object' ? data : {};
  const docName = documentNameSize(docId);
  let indexBytes = 0;
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      indexBytes += indexEntrySize(docName, path, valueSize(value)) * 2;
      for (const item of value) {
        indexBytes += indexEntrySize(docName, path, valueSize(item));
      }
      return;
    }
    if (value && typeof value === 'object') {
      indexBytes += indexEntrySize(docName, path, mapValueSize(value)) * 2;
      for (const [key, child] of Object.entries(value)) {
        walk(child, `${path}.${key}`);
      }
      return;
    }
    indexBytes += indexEntrySize(docName, path, scalarSize(value)) * 2;
  };
  for (const [key, child] of Object.entries(body)) walk(child, key);
  return docName + mapValueSize(body) + indexBytes;
}

export function estimateOperationBytes(op, deleteBytes) {
  if (Number.isFinite(op?.bytes)) return op.bytes;
  if (op?.type === 'delete') {
    if (deleteBytes && deleteBytes.has(op.id)) return deleteBytes.get(op.id);
    return UNKNOWN_DELETE_TRANSACTION_BYTES;
  }
  return estimateTransactionBytes(op.id, op.data);
}

function operationPhase(op) {
  if (op.type === 'delete') return 2;
  if (op.id === AIRPORT_CACHE_META_ID) return 1;
  return 0;
}

/**
 * Split a cache plan into commits that stay under the write cap and the
 * transaction byte budget.
 *
 * Phases, in order: shard and letter sets, then `_meta`, then deletes.
 * `_meta` is the last set, after every shard it names. Deletes come after
 * `_meta`, so a failed delete cannot remove a document the previous `_meta`
 * still addresses, and a failed `_meta` write cannot drop the letter docs
 * the bulk lookup is still merging.
 */
export function chunkCacheOperations(operations, options = {}) {
  const maxOps = options.maxOps ?? MAX_BATCH_OPS;
  const maxBytes = options.maxBytes ?? MAX_COMMIT_BYTES;
  const deleteBytes = options.deleteBytes;
  const ordered = operations.map((op, index) => ({ op, index }));
  ordered.sort((a, b) => operationPhase(a.op) - operationPhase(b.op) || a.index - b.index);

  const chunks = [];
  let current = [];
  let bytes = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push(current);
    current = [];
    bytes = 0;
  };
  for (const { op } of ordered) {
    const opBytes = estimateOperationBytes(op, deleteBytes);
    if (current.length > 0 && (current.length >= maxOps || bytes + opBytes > maxBytes)) {
      flush();
    }
    current.push(op);
    bytes += opBytes;
  }
  flush();
  return chunks;
}

export function cachePrefix(code) {
  const key = String(code || '').trim().toUpperCase();
  return key[0] || '_';
}

export function shardDocId(prefix, shardIndex) {
  return `${prefix}~${String(shardIndex).padStart(3, '0')}`;
}

/**
 * Document id for one airport.
 * No shard list (or an empty one) means the legacy single-letter doc.
 * A list with no range covering `code` means the prefix is sharded and
 * this code is not in the cache — callers must not fall back to the
 * legacy letter doc, which may still hold a stale copy.
 */
export function cacheDocIdForCode(code, shardRangesByPrefix) {
  const key = String(code || '').trim().toUpperCase();
  if (!key) return null;
  const ranges = shardRangesByPrefix?.[cachePrefix(key)];
  if (!Array.isArray(ranges) || ranges.length === 0) return cachePrefix(key);
  for (const range of ranges) {
    if (range && key >= range.start && key <= range.end) return range.id;
  }
  return null;
}

/**
 * Merge cache documents into code -> entry.
 * Ids sort ascending, so shard `M~000` overwrites legacy `M` when both
 * still exist. `_meta` is not airport data.
 */
export function mergeCacheDocuments(docPairs) {
  const ordered = [...docPairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const map = new Map();
  for (const [id, data] of ordered) {
    if (id === AIRPORT_CACHE_META_ID) continue;
    if (!data?.entries || typeof data.entries !== 'object') continue;
    for (const [code, entry] of Object.entries(data.entries)) {
      map.set(code, entry);
    }
  }
  return map;
}

function entriesOf(codeMap) {
  if (codeMap instanceof Map) return codeMap.entries();
  if (Array.isArray(codeMap)) return codeMap;
  return Object.entries(codeMap || {});
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === 'string' && id && id !== AIRPORT_CACHE_META_ID);
}

function partitionPrefix(list, maxPerShard, maxBytes) {
  const shards = [];
  let current = [];
  let bytes = DOC_OVERHEAD_BYTES;
  const flush = () => {
    if (!current.length) return;
    shards.push(current);
    current = [];
    bytes = DOC_OVERHEAD_BYTES;
  };
  for (const item of list) {
    const itemBytes = estimateEntryBytes(item[0], item[1]);
    const overCount = current.length >= maxPerShard;
    const overBytes = current.length > 0 && bytes + itemBytes > maxBytes;
    if (overCount || overBytes) flush();
    current.push(item);
    bytes += itemBytes;
  }
  flush();
  return shards;
}

function assertShardSafe(id, entries) {
  const count = Object.keys(entries).length;
  const indexEntries = indexEntryCount(count);
  if (indexEntries > FIRESTORE_INDEX_ENTRY_LIMIT) {
    throw new Error(
      `Airport cache shard ${id} has ${count} airports (${indexEntries} index entries, limit ${FIRESTORE_INDEX_ENTRY_LIMIT})`,
    );
  }
  const bytes = estimateEntriesBytes(entries);
  if (bytes > FIRESTORE_DOCUMENT_BYTE_LIMIT) {
    throw new Error(
      `Airport cache shard ${id} is about ${bytes} bytes (limit ${FIRESTORE_DOCUMENT_BYTE_LIMIT})`,
    );
  }
}

/**
 * Build the Firestore writes for one refresh.
 * `previousMeta` is the existing `_meta` doc, used to delete letter docs
 * and shard docs this plan no longer writes. Pass null on a first fill.
 *
 * Operation order is data docs, then `_meta`, then deletes. Commits follow
 * that order across multiple batches so a partial refresh stays readable.
 */
export function buildAirportCachePlan(codeMap, previousMeta, options = {}) {
  const maxPerShard = options.maxPerShard ?? MAX_AIRPORTS_PER_SHARD;
  const maxBytes = options.maxShardBytes ?? MAX_SHARD_BYTES;
  const now = options.now ?? Date.now();

  const groups = new Map();
  let totalCodes = 0;
  for (const [rawCode, entry] of entriesOf(codeMap)) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) continue;
    const prefix = code[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push([code, entry]);
    totalCodes += 1;
  }

  const docs = {};
  const shardRangesByPrefix = {};
  for (const prefix of [...groups.keys()].sort()) {
    const list = groups.get(prefix);
    list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const shards = partitionPrefix(list, maxPerShard, maxBytes);
    if (shards.length <= 1) {
      const entries = Object.fromEntries(shards[0] || []);
      assertShardSafe(prefix, entries);
      docs[prefix] = { entries };
      continue;
    }
    const ranges = [];
    shards.forEach((shard, index) => {
      const id = shardDocId(prefix, index);
      const entries = Object.fromEntries(shard);
      assertShardSafe(id, entries);
      docs[id] = { entries };
      ranges.push({
        id,
        start: shard[0][0],
        end: shard[shard.length - 1][0],
      });
    });
    shardRangesByPrefix[prefix] = ranges;
  }

  const chunkDocIds = Object.keys(docs).sort();
  const chunkPrefixes = [...groups.keys()].sort();
  const previousIds = new Set([
    ...stringList(previousMeta?.chunkDocIds),
    ...stringList(previousMeta?.chunkPrefixes),
  ]);
  const deleteIds = [...previousIds].filter((id) => !docs[id]).sort();

  const meta = {
    refreshedAt: now,
    totalCodes,
    chunkPrefixes,
    chunkDocIds,
    shardRangesByPrefix,
    maxAirportsPerShard: maxPerShard,
    layout: 'prefix-shards',
    source: 'ourairports.com',
  };

  const operations = [
    ...chunkDocIds.map((id) => ({ type: 'set', id, data: docs[id] })),
    { type: 'set', id: AIRPORT_CACHE_META_ID, data: meta },
    ...deleteIds.map((id) => ({ type: 'delete', id })),
  ];

  return { docs, meta, deleteIds, operations };
}
