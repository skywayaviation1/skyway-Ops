// Ops and administrators mint the trade-show link.
// POST /api/showcase-admin  { idToken, action: 'read' | 'generate' | 'regenerate' | 'disable' }
//
// Generate creates a token, or turns a disabled board back on with a new
// token. Regenerate always rotates. Disable keeps the document but the
// public route treats that token as not found.

import {
  adminView,
  authorizeShowcase,
  coverageFor,
  mintShowcaseToken,
  readShowcaseConfig,
  writeShowcaseConfig,
} from './_showcase.js';
import { isShowcaseToken } from '../src/showcase-replay.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

function fail(res, error) {
  const status = error?.status || 500;
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: status === 500 ? 'Showcase settings could not be saved' : error.message });
}

export async function handleShowcaseAdmin(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const actor = await authorizeShowcase(req, deps);
    const action = String(actor.body?.action || 'read');
    const db = actor.db;
    const current = await readShowcaseConfig(db);
    const now = Number.isFinite(deps.now) ? deps.now : Date.now();
    let next = current;

    const mint = deps.mint || mintShowcaseToken;
    const takeToken = () => {
      const avoid = current?.token || '';
      let token = '';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        token = mint();
        if (token && token !== avoid) return token;
      }
      const error = new Error('Could not mint a showcase link');
      error.status = 500;
      throw error;
    };
    if (action === 'generate') {
      const live = current?.enabled === true && isShowcaseToken(current?.token || '');
      if (!live) {
        next = {
          token: takeToken(),
          enabled: true,
          createdAt: current?.createdAt || now,
          updatedAt: now,
          updatedByUid: actor.uid,
          updatedByName: actor.name,
        };
        await writeShowcaseConfig(db, next);
      }
    } else if (action === 'regenerate') {
      next = {
        token: takeToken(),
        enabled: true,
        createdAt: current?.createdAt || now,
        updatedAt: now,
        updatedByUid: actor.uid,
        updatedByName: actor.name,
      };
      await writeShowcaseConfig(db, next);
    } else if (action === 'disable') {
      if (current) {
        next = {
          ...current,
          enabled: false,
          updatedAt: now,
          updatedByUid: actor.uid,
          updatedByName: actor.name,
        };
        await writeShowcaseConfig(db, next);
      }
    } else if (action !== 'read') {
      res.status(400).json({ error: 'Unknown showcase action' });
      return;
    }

    const coverage = await coverageFor(db, deps);
    res.status(200).json(adminView(next, coverage));
  } catch (error) {
    if (!error?.status) console.error('[showcase-admin]', error?.message || error);
    fail(res, error);
  }
}

export default function handler(req, res) {
  return handleShowcaseAdmin(req, res);
}
