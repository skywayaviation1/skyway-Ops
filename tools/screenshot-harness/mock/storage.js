/* Stand-in for `firebase/storage`.
 *
 * Uploads resolve to bundled placeholder assets so any screen that renders a
 * stored photo or PDF link still has something to draw.
 */

export function getStorage() { return { __mockStorage: true }; }

export function ref(_storage, path) {
  return { __path: String(path || 'harness/asset'), name: String(path || '').split('/').pop() };
}

export async function uploadBytes(reference) {
  return { ref: reference, metadata: { fullPath: reference.__path } };
}

export async function uploadString(reference) {
  return { ref: reference, metadata: { fullPath: reference.__path } };
}

export async function getDownloadURL(reference) {
  return `/harness-assets/placeholder.png?path=${encodeURIComponent(reference.__path)}`;
}

export async function deleteObject() {}
export function connectStorageEmulator() {}
