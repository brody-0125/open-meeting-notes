const sources = ['microphone', 'remote'];
const fields = ['version', 'sessionId', 'epoch', 'source', 'seq', 'startFrame', 'frames', 'sampleRate', 'channels'];
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function exact(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  requireValue(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'unexpected fields');
}
const integer = n => Number.isSafeInteger(n) && n >= 0;

export function validateChunk(meta, pcm) {
  exact(meta, fields);
  requireValue(meta.version === 1, 'unsupported chunk version');
  requireValue(typeof meta.sessionId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(meta.sessionId), 'invalid session ID');
  requireValue(sources.includes(meta.source), 'invalid source');
  for (const key of ['epoch', 'seq', 'startFrame', 'frames']) requireValue(integer(meta[key]), `invalid ${key}`);
  requireValue([16000, 44100, 48000].includes(meta.sampleRate), 'unsupported sample rate');
  requireValue([1, 2].includes(meta.channels), 'unsupported channel count');
  requireValue(meta.frames > 0 && meta.frames <= meta.sampleRate * 5, 'chunk must contain at most 5 seconds');
  requireValue(integer(meta.startFrame + meta.frames), 'frame overflow');
  requireValue(pcm instanceof Uint8Array && pcm.byteLength === meta.frames * meta.channels * 2, 'PCM16 byte length mismatch');
  return meta;
}

// Validates capture boundaries; storage ACK is a separate obligation of the caller.
export class Session {
  constructor(id) { this.id = id; this.state = 'idle'; }
  start(consent) {
    requireValue(this.state === 'idle' && consent === true, 'fresh consent required');
    this.state = 'recording';
  }
  stop(cutoffs) {
    requireValue(this.state === 'recording', 'not recording');
    exact(cutoffs, sources);
    requireValue(sources.every(s => integer(cutoffs[s])), 'invalid cutoff');
    this.cutoffs = { ...cutoffs };
    this.state = 'draining';
  }
  accept(meta, pcm) {
    validateChunk(meta, pcm);
    requireValue(meta.sessionId === this.id, 'wrong session');
    requireValue(['recording', 'draining'].includes(this.state), 'capture is closed');
    if (this.state === 'draining') requireValue(meta.startFrame + meta.frames <= this.cutoffs[meta.source], 'past stop cutoff');
  }
  finish() {
    requireValue(this.state === 'draining', 'not draining');
    this.state = 'stopped';
  }
}

export function acceptResult(job, result) {
  return job?.status === 'running' && result != null &&
    ['id', 'generation', 'revision', 'modelHash', 'inputHash', 'settingsHash']
      .every(k => job[k] !== undefined && job[k] === result[k]);
}

export function validateSummary(summary, segments, revision) {
  exact(summary, ['version', 'revision', 'items']);
  requireValue(summary.version === 1 && summary.revision === revision && integer(revision), 'stale or unsupported summary');
  requireValue(Array.isArray(summary.items) && summary.items.length <= 200, 'invalid summary items');
  const byId = new Map(segments.map(s => [s.id, s.text]));
  for (const item of summary.items) {
    exact(item, ['kind', 'text', 'status', 'evidence']);
    requireValue(['decision', 'action', 'topic'].includes(item.kind), 'invalid kind');
    requireValue(item.status === 'candidate', 'generated claims require review');
    requireValue(typeof item.text === 'string' && item.text.trim().length > 0 && item.text.length <= 4000, 'invalid text');
    requireValue(Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.length <= 20, 'evidence required');
    for (const evidence of item.evidence) {
      exact(evidence, ['segmentId', 'quote']);
      requireValue(typeof evidence.quote === 'string' && evidence.quote.trim().length > 0, 'invalid evidence: empty quote');
      requireValue(byId.has(evidence.segmentId), 'invalid evidence: unknown segment');
      requireValue(byId.get(evidence.segmentId).includes(evidence.quote), 'invalid evidence: quote mismatch');
    }
  }
  // Exact quotation is not proof that the quotation supports the generated claim.
}
