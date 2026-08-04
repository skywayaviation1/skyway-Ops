#!/usr/bin/env node
// Verifies a deployed Skyway Ops site against every Microsoft sign-in setting
// that can be observed from outside the app.
//
// Sign-in spans four consoles — Entra, Firebase Auth, Vercel environment
// variables, and Vercel routing — and a mistake in any one of them surfaces as
// the same opaque browser error. This walks the real request chain against a
// live deployment and names the stage that is wrong.
//
//   node scripts/verify-microsoft-sso.mjs https://www.skyway.app
//
// Exits non-zero when a check fails, so it can gate a deploy.

const DEFAULT_ORIGIN = 'https://www.skyway.app';
const origin = (process.argv[2] || DEFAULT_ORIGIN).replace(/\/+$/, '');
const host = new URL(origin).hostname;

const results = [];
function record(status, name, detail) {
  results.push({ status, name, detail });
  const mark = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: '····' }[status];
  console.log(`${mark}  ${name}`);
  if (detail) console.log(`      ${String(detail).replace(/\n/g, '\n      ')}`);
}

async function get(url, init) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Entra serves a different (and less parseable) page to unknown clients.
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
        + ' AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1',
    },
    ...init,
  });
  return { response, body: await response.text() };
}

/** The built bundle is the only place the compiled-in settings can be read. */
async function readDeployedBundle() {
  const { response, body } = await get(`${origin}/`);
  if (!response.ok) throw new Error(`${origin} returned HTTP ${response.status}`);
  const entry = [...body.matchAll(/assets\/index-[A-Za-z0-9_-]+\.js/g)].pop()?.[0];
  if (!entry) throw new Error('No built entry bundle found in the served HTML');
  const { body: js } = await get(`${origin}/${entry}`);
  const chunk = js.match(/firebase-auth-[A-Za-z0-9_-]+\.js/)?.[0];
  const authJs = chunk ? (await get(`${origin}/assets/${chunk}`)).body : '';
  return {
    entry,
    apiKey: js.match(/AIza[0-9A-Za-z_-]{30,}/)?.[0] || null,
    // Vite inlines the tenant as a literal, so a missing one means the build
    // ran without VITE_MICROSOFT_TENANT_ID rather than a runtime problem.
    tenant: authJs.match(/"([0-9a-f-]{36})"\s*\.trim\(\)/)?.[1] || null,
    authDomain: authJs.match(/"([a-z0-9.-]+)"\.trim\(\)\|\|"[a-z0-9-]+\.firebaseapp\.com"/)?.[1]
      || js.match(/"([a-z0-9.-]+)"\.trim\(\)\|\|"[a-z0-9-]+\.firebaseapp\.com"/)?.[1]
      || null,
  };
}

/**
 * Firebase's sign-in helper must answer on the app's own origin. When the proxy
 * is missing, the single-page fallback answers instead: the browser gets the
 * app's HTML where the helper should be, and sign-in silently never returns.
 */
async function checkAuthHelperProxy() {
  for (const path of ['/__/auth/handler', '/__/auth/iframe', '/__/auth/handler.js']) {
    const { response, body } = await get(`${origin}${path}`);
    const isFirebaseHelper = /fireauth|firebase/i.test(body);
    const isAppShell = /<div id="root"|assets\/index-/.test(body);
    if (!response.ok || !isFirebaseHelper || isAppShell) {
      record('fail', `Sign-in helper served at ${path}`,
        isAppShell
          ? 'The app itself answered here. Add the /__/auth/:path* rewrite to vercel.json.'
          : `HTTP ${response.status} and no Firebase helper content.`);
      return false;
    }
  }
  record('pass', 'Sign-in helper proxied on the app origin', `${origin}/__/auth/*`);
  return true;
}

async function checkAuthorizedDomains(apiKey) {
  const { body } = await get(
    `https://identitytoolkit.googleapis.com/v1/projects?key=${apiKey}`,
  );
  let domains = [];
  try { domains = JSON.parse(body).authorizedDomains || []; } catch { /* reported below */ }
  if (!domains.length) {
    record('fail', 'Firebase authorized domains readable', body.slice(0, 200));
    return;
  }
  if (domains.includes(host)) {
    record('pass', `${host} is a Firebase authorized domain`);
  } else {
    record('fail', `${host} is a Firebase authorized domain`,
      `Add it under Firebase Authentication → Settings → Authorized domains.\n`
      + `Currently: ${domains.join(', ')}`);
  }
}

/**
 * Asks Firebase to build the real Microsoft authorization request. This is the
 * only way to see the redirect URI and directory Firebase will actually use,
 * as opposed to the ones the consoles claim are configured.
 */
async function checkAuthorizationRequest(apiKey, tenant) {
  const continueUri = `${origin}/__/auth/handler`;
  const { body } = await get(
    `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${apiKey}`,
    {
      method: 'POST',
      body: JSON.stringify({
        providerId: 'microsoft.com',
        continueUri,
        customParameter: tenant ? { tenant } : {},
      }),
    },
  );
  let payload = {};
  try { payload = JSON.parse(body); } catch { /* reported below */ }
  if (!payload.authUri) {
    record('fail', 'Firebase builds a Microsoft sign-in request',
      payload.error?.message || body.slice(0, 300));
    return null;
  }
  const authUri = new URL(payload.authUri);
  const directory = authUri.pathname.split('/')[1];
  if (directory === 'common' || directory === 'organizations') {
    record('fail', 'Sign-in targets the Skyway directory',
      `Using Microsoft's shared /${directory} endpoint, which a single-tenant app`
      + ' registration refuses with AADSTS50194. Set VITE_MICROSOFT_TENANT_ID and rebuild.');
  } else {
    record('pass', 'Sign-in targets the Skyway directory', directory);
  }
  const redirectUri = authUri.searchParams.get('redirect_uri');
  if (redirectUri === continueUri) {
    record('pass', 'Redirect URI Firebase will send', redirectUri);
  } else {
    record('warn', 'Redirect URI Firebase will send',
      `${redirectUri} (expected ${continueUri})`);
  }
  record('info', 'Entra application (client) ID', authUri.searchParams.get('client_id'));
  return authUri;
}

/**
 * Entra rejects an unregistered redirect URI or unknown client before showing
 * anyone a password box, so a rendered sign-in page proves those two settings.
 */
async function checkDirectoryAccepts(authUri) {
  let body;
  try {
    ({ body } = await get(authUri.toString()));
  } catch (err) {
    record('warn', 'Microsoft accepts the sign-in request', `Could not reach Microsoft: ${err.message}`);
    return;
  }
  const codes = [...new Set([...body.matchAll(/AADSTS\d+/g)].map((m) => m[0]))];
  if (codes.length) {
    record('fail', 'Microsoft accepts the sign-in request', codes.join(', '));
    return;
  }
  if (/ConvergedSignIn|loginfmt/.test(body)) {
    record('pass', 'Microsoft accepts the sign-in request',
      'Redirect URI and application ID are registered; the sign-in page renders.');
  } else {
    record('warn', 'Microsoft accepts the sign-in request',
      'No error code, but the response did not look like a sign-in page.');
  }
}

async function main() {
  console.log(`Verifying Microsoft sign-in for ${origin}\n`);
  const bundle = await readDeployedBundle();
  record('info', 'Deployed bundle', bundle.entry);

  if (bundle.authDomain === host) {
    record('pass', 'App uses same-origin sign-in', bundle.authDomain);
  } else {
    record('warn', 'App uses same-origin sign-in',
      `Sign-in runs through ${bundle.authDomain || 'an unknown host'}. Installed iPhone`
      + ` apps block cross-origin sign-in storage; set VITE_FIREBASE_AUTH_DOMAIN=${host}.`);
  }
  if (bundle.tenant) record('info', 'Directory compiled into the build', bundle.tenant);

  if (!bundle.apiKey) {
    record('fail', 'Firebase web API key found in bundle');
  } else {
    await checkAuthorizedDomains(bundle.apiKey);
    if (await checkAuthHelperProxy()) {
      const authUri = await checkAuthorizationRequest(bundle.apiKey, bundle.tenant);
      if (authUri) await checkDirectoryAccepts(authUri);
    }
  }

  // Stated plainly because every remaining failure lands here: the client
  // secret is server-side, so no external check can confirm it.
  console.log('\nNot checkable from outside: the Entra client secret stored in Firebase');
  console.log('Authentication → Sign-in method → Microsoft, and whether the redirect URI');
  console.log('is registered under the "Web" platform rather than "Single-page application".');
  console.log('If every check above passes and sign-in still fails after the Microsoft');
  console.log('prompt, it is one of those two.');

  const failed = results.filter((r) => r.status === 'fail');
  console.log(`\n${failed.length ? `${failed.length} check(s) failed.` : 'All observable checks passed.'}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nVerification could not run: ${err.message}`);
  process.exitCode = 2;
});
