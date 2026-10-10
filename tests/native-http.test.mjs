import assert from 'node:assert/strict';
import test from 'node:test';

import {
  restoreWebViewXmlHttpRequest,
  shouldUseWebViewNetwork,
} from '../src/native-http.js';

test('Firestore and Firebase hosts stay on the WebView network', () => {
  assert.equal(
    shouldUseWebViewNetwork('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=projects%2Fskyway-ops-app%2Fdatabases%2Fappusers'),
    true,
  );
  assert.equal(
    shouldUseWebViewNetwork('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=x'),
    true,
  );
  assert.equal(shouldUseWebViewNetwork('https://securetoken.googleapis.com/v1/token'), true);
  assert.equal(shouldUseWebViewNetwork('https://firebasestorage.googleapis.com/v0/b/x'), true);
  assert.equal(shouldUseWebViewNetwork('https://skyway-ops-app.firebaseio.com/x.json'), true);
  assert.equal(shouldUseWebViewNetwork(new URL('https://firestore.googleapis.com/v1/projects/p/databases/appusers/documents/trips/1')), true);
});

test('Skyway API calls keep using CapacitorHttp', () => {
  assert.equal(shouldUseWebViewNetwork('https://www.skyway.app/api/mobile-auth-token'), false);
  assert.equal(shouldUseWebViewNetwork('/api/mobile-auth-token'), false);
  assert.equal(shouldUseWebViewNetwork('https://cdn.apple-mapkit.com/mk/5.x/mapkit.js'), false);
  assert.equal(shouldUseWebViewNetwork(''), false);
});

test('restores the WebView XMLHttpRequest after CapacitorHttp patches it', () => {
  function OriginalXHR() {}
  function originalOpen() {}
  function originalSend() {}
  function originalAbort() {}
  function originalSetRequestHeader() {}
  function originalGetAllResponseHeaders() {}
  function originalGetResponseHeader() {}
  OriginalXHR.prototype.open = originalOpen;
  OriginalXHR.prototype.send = originalSend;
  OriginalXHR.prototype.abort = originalAbort;
  OriginalXHR.prototype.setRequestHeader = originalSetRequestHeader;
  OriginalXHR.prototype.getAllResponseHeaders = originalGetAllResponseHeaders;
  OriginalXHR.prototype.getResponseHeader = originalGetResponseHeader;

  const saved = {
    fullObject: OriginalXHR,
    prototype: OriginalXHR.prototype,
    open: originalOpen,
    send: originalSend,
    abort: originalAbort,
    setRequestHeader: originalSetRequestHeader,
    getAllResponseHeaders: originalGetAllResponseHeaders,
    getResponseHeader: originalGetResponseHeader,
  };
  function patchedOpen() {}
  OriginalXHR.prototype.open = patchedOpen;
  function PatchedXHR() {}
  const target = {
    XMLHttpRequest: PatchedXHR,
    CapacitorWebXMLHttpRequest: saved,
  };

  assert.equal(restoreWebViewXmlHttpRequest(target), true);
  assert.equal(target.XMLHttpRequest, OriginalXHR);
  assert.equal(OriginalXHR.prototype.open, originalOpen);
  assert.equal(OriginalXHR.prototype.send, originalSend);
  assert.equal(restoreWebViewXmlHttpRequest({}), false);
});
