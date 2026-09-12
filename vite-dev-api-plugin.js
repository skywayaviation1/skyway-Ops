// Dev-only Vite middleware that serves a small allowlist of the Vercel
// `api/*` functions the local dev server would otherwise not run.
//
// Plain `vite` serves the SPA but not the serverless `api/` directory, so the
// development auth bypass (POST /api/dev-auth-bypass) is unreachable and the
// only way to sign in locally is Microsoft SSO. When the bypass is enabled
// (DEV_AUTH_BYPASS=true), this plugin mounts the real handler files behind the
// dev server so login works without Microsoft. It is never part of a
// production build — Vercel runs the same files as real functions there.
//
// The handlers follow Vercel's `(req, res)` contract and expect Express-style
// `res.status().json()` helpers plus a parsed JSON `req.body`; Node's bare
// http response does not provide these, so we adapt them here.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Endpoints required for the development auth-bypass sign-in flow. Kept as an
// explicit allowlist so this dev shim never accidentally exposes unrelated
// serverless functions.
const DEV_API_ROUTES = ['/api/dev-auth-bypass', '/api/auth-profile-bootstrap'];

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function decorateResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify(payload));
    return res;
  };
  res.send = (payload) => {
    if (typeof payload === 'object' && payload !== null) return res.json(payload);
    res.end(payload == null ? '' : String(payload));
    return res;
  };
  return res;
}

export function devApiPlugin() {
  return {
    name: 'skyway-dev-api',
    apply: 'serve',
    configureServer(server) {
      if (process.env.DEV_AUTH_BYPASS !== 'true') {
        server.config.logger.info(
          '[dev-api] auth bypass disabled (set DEV_AUTH_BYPASS=true to enable /api/dev-auth-bypass)',
        );
        return;
      }

      server.config.logger.info(
        `[dev-api] serving ${DEV_API_ROUTES.join(', ')} for local auth bypass`,
      );

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (!DEV_API_ROUTES.includes(path)) {
          next();
          return;
        }

        try {
          const handlerFile = resolve(HERE, `api${path.slice('/api'.length)}.js`);
          const { default: handler } = await import(pathToFileURL(handlerFile).href);
          req.body = await readJsonBody(req);
          decorateResponse(res);
          await handler(req, res);
        } catch (err) {
          server.config.logger.error(`[dev-api] ${path} failed: ${err?.stack || err}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Dev API handler failed' }));
          }
        }
      });
    },
  };
}

export default devApiPlugin;
