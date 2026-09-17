#!/usr/bin/env node
const chunks = [];
process.stdin.on('data', part => chunks.push(part));
process.stdin.on('end', () => {
  const buffer = Buffer.concat(chunks);
  const newline = buffer.indexOf(10);
  if (newline < 0) process.exit(1);
  const message = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
  const body = buffer.subarray(newline + 1);
  if (message.op === 'probe') {
    process.stdout.write(`${JSON.stringify({ ok: true, available: true, installed: true })}\n`);
    return;
  }
  if (message.op !== 'transcribe') process.exit(1);
  const expected = message.bytes ?? 0;
  if (body.length !== expected) process.exit(1);
  const duration = expected / 4 / (message.sampleRate ?? 16000);
  const chunksOut = body.some(b => b !== 0) ? [{ text: 'mock transcript', start: 0, end: Math.min(1, duration) }] : [];
  process.stdout.write(`${JSON.stringify({ id: message.id ?? 1, ok: true, chunks: chunksOut })}\n`);
});
