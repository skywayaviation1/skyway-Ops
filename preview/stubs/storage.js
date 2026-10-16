// Preview stand-in for firebase/storage. AOG coverage calls getStorage()
// while the module loads. The harness has no Firebase app, and this file
// is never used by `npm run build`.

export function getStorage() {
  return {};
}

export function ref() {
  return {};
}

export function uploadBytes() {
  return Promise.resolve({ ref: {} });
}

export function getDownloadURL() {
  return Promise.resolve('');
}

export function deleteObject() {
  return Promise.resolve();
}
