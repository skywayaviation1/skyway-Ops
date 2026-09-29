// Ops download of a stored charter contract or signed election PDF.
// The browser sends a Firebase id token. The file is not a public URL.

import {
  authorizeOps,
  readJson,
  readPdf,
  recoveryDb,
  COLLECTION,
} from './_aog-recovery.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = readJson(req);
    await authorizeOps(body.idToken);
    const kind = body.kind === 'election' ? 'election' : 'charter';
    const snap = await recoveryDb().collection(COLLECTION).doc(String(body.coverageId || '')).get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Coverage record not found' });
      return;
    }
    const data = snap.data() || {};
    const path = kind === 'election' ? data.electionContractPath : data.charterContractPath;
    if (!path) {
      res.status(404).json({ error: 'That contract is not on file' });
      return;
    }
    const pdf = await readPdf(path);
    const filename = kind === 'election'
      ? 'aog-election.pdf'
      : (data.charterContractFilename || 'charter-contract.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    res.status(200).send(pdf);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Download failed' });
  }
}
