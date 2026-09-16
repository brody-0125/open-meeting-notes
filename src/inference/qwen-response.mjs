// Qwen3 can emit this empty envelope even with enable_thinking:false.
// Do not repair arbitrary JSON or discard non-empty reasoning here.
export function normalizeQwenResponse(response) {
  const result = structuredClone(response);
  const message = result?.choices?.[0]?.message;
  if (typeof message?.content === 'string') message.content = message.content.replace(/^\s*<think>\s*<\/think>\s*/, '');
  return result;
}
