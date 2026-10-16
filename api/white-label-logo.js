// Public logo bytes for one white-label board.
//
// GET /api/white-label-logo?token=...
//
// Storage rules deny client reads. The token is checked against the board
// record first, and a disabled or unknown token gets the same empty 404.

import { BOARD_COLLECTION, isPublicToken, logoObjectPath } from '../src/white-label-board.js';
import { whiteLabelBucket, whiteLabelDb } from './_white-label.js';

export const config = { runtime: 'nodejs' };

async function findLogoBoard(db, token) {
  if (!isPublicToken(token)) return null;
  const snap = await db.collection(BOARD_COLLECTION).where('publicToken', '==', token).limit(2).get();
  if (!snap || snap.empty || snap.size !== 1) return null;
  const doc = snap.docs[0];
  const data = doc.data() || {};
  if (data.enabled === false || !data.logoContentType) return null;
  return { id: doc.id, contentType: data.logoContentType };
}

export async function serveBoardLogo({ db, bucket, token }) {
  const board = await findLogoBoard(db, token);
  if (!board) return { status: 404, body: null, contentType: null };
  try {
    const [bytes] = await bucket.file(logoObjectPath(board.id)).download();
    if (!bytes || !bytes.length) return { status: 404, body: null, contentType: null };
    return { status: 200, body: bytes, contentType: board.contentType };
  } catch (error) {
    if (error?.code === 404) return { status: 404, body: null, contentType: null };
    console.error('[white-label] logo read failed', board.id, error?.message || error);
    return { status: 404, body: null, contentType: null };
  }
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).end();
    return;
  }
  try {
    const token = String(req.query?.token || '');
    const result = await serveBoardLogo({ db: whiteLabelDb(), bucket: whiteLabelBucket(), token });
    if (result.status !== 200 || !result.body) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).end(result.body);
  } catch (error) {
    console.error('[white-label] logo failed', error?.message || error);
    res.status(404).end();
  }
}
