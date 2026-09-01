const clean = (value) => String(value ?? '').trim();

/**
 * Deepgram accepts only `word` or `word:boost` keywords. Multi-word phrases are
 * rejected outright, which fails the whole call, so split phrases into tokens
 * and carry the phrase's boost onto each one.
 */
export function normalizeTranscriberKeywords(keywords) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(keywords) ? keywords : []) {
    const raw = clean(entry);
    if (!raw) continue;
    const [phrase, boost] = raw.split(':');
    const suffix = /^\d+$/.test(clean(boost)) ? `:${clean(boost)}` : '';
    for (const token of clean(phrase).split(/\s+/)) {
      const word = token.replace(/[^A-Za-z0-9']/g, '');
      if (!word) continue;
      const value = `${word}${suffix}`;
      if (seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      out.push(value);
    }
  }
  return out;
}

function contentText(content) {
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
    .map(clean)
    .filter(Boolean)
    .join(' ');
}

function messagesTranscript(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((row) => {
      const text = clean(row?.message || row?.text) || contentText(row?.content);
      if (!text) return '';
      const role = clean(row?.role || row?.speaker || 'unknown')
        .replace(/^bot$/i, 'assistant')
        .replace(/^user$/i, 'contact');
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function extractVapiTranscript(payload) {
  const message = payload?.message || payload || {};
  const artifacts = [
    message.artifact,
    message.call?.artifact,
    payload?.artifact,
    payload?.call?.artifact,
  ].filter(Boolean);
  const direct = [
    message.transcript,
    ...artifacts.map((artifact) => artifact?.transcript),
  ].find((value) => typeof value === 'string' && value.trim());
  if (direct) return clean(direct);

  const messageSets = [
    ...artifacts.flatMap((artifact) => [
      artifact?.messages,
      artifact?.messagesOpenAIFormatted,
    ]),
    message.messages,
    message.messagesOpenAIFormatted,
    payload?.messages,
  ];
  for (const messages of messageSets) {
    const transcript = messagesTranscript(messages);
    if (transcript) return transcript;
  }
  return '';
}

export function extractVapiRecording(payload) {
  const message = payload?.message || payload || {};
  const artifacts = [
    message.artifact,
    message.call?.artifact,
    payload?.artifact,
    payload?.call?.artifact,
  ].filter(Boolean);
  for (const artifact of artifacts) {
    const recording = artifact?.recording || {};
    const url = recording.monoUrl
      || recording.stereoUrl
      || artifact.recordingUrl
      || artifact.stereoRecordingUrl;
    if (url) return String(url);
  }
  return message.recordingUrl || message.stereoRecordingUrl || '';
}

export function extractVapiAnalysis(payload) {
  const message = payload?.message || payload || {};
  return message.analysis
    || message.artifact?.analysis
    || message.call?.artifact?.analysis
    || payload?.artifact?.analysis
    || payload?.call?.artifact?.analysis
    || {};
}

export function mergeTranscript(existing, incoming) {
  const before = clean(existing);
  const next = clean(incoming);
  if (!next) return before;
  if (!before) return next;
  if (before === next || before.includes(next)) return before;
  if (next.includes(before)) return next;
  return `${before}\n${next}`;
}

export function transcriptEventSegment(payload) {
  const message = payload?.message || payload || {};
  const type = String(message.type || payload?.type || '');
  if (!/^transcript(?:\[|$)/i.test(type)) return '';
  const transcriptType = String(message.transcriptType || '').toLowerCase();
  if (transcriptType && transcriptType !== 'final' && !/final/i.test(type)) return '';
  const text = clean(message.transcript || message.text || message.content);
  if (!text) return '';
  const role = clean(message.role || 'unknown')
    .replace(/^bot$/i, 'assistant')
    .replace(/^user$/i, 'contact');
  return `${role}: ${text}`;
}

