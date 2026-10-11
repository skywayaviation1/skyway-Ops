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
 * single-code read can open the right shard. A refresh deletes a legacy
 * letter doc only after its shards are in the same commit.
 */

export const AIRPORT_CACHE_COLLECTION = 'airport-cache-ourairports';
export const AIRPORT_CACHE_META_ID = '_meta';

export const FIRESTORE_INDEX_ENTRY_LIMIT = 40_000;
export const FIRESTORE_DOCUMENT_BYTE_LIMIT = 1_048_576;

// 1,000 airports is about 12,002 index entries and well under 1 MiB.
// The byte cap splits a shard earlier if names are unusually long.
export const MAX_AIRPORTS_PER_SHARD = 1000;
export const MAX_SHARD_BYTES = 800_000;

const DOC_OVERHEAD_BYTES = 256;
const ENTRY_OVERHEAD_BYTES = 48;

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
 * Operation order is data docs, then `_meta`, then deletes, so a single
 * batch commit publishes shards and drops the old letter docs together.
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
