// Pinned to WebLLM 0.2.85's text-only prefill and the approved Qwen3 template.
// WebLLM tokenizes these three strings separately; joining changes BPE boundaries.
export const QWEN_TEMPLATE = {
  name: 'qwen3', system_template: '<|im_start|>system\n{system_message}<|im_end|>\n',
  system_message: 'You are a helpful assistant.', add_role_after_system_message: true,
  roles: { user: '<|im_start|>user', assistant: '<|im_start|>assistant' },
  role_templates: { user: '{user_message}', assistant: '{assistant_message}', tool: '{tool_message}' },
  messages: [], seps: ['<|im_end|>\n'], role_content_sep: '\n', role_empty_sep: '\n',
  stop_str: ['<|endoftext|>', '<|im_end|>'], stop_token_ids: [151643, 151645],
  strip_reasoning_in_history: true, function_string: '', use_function_calling: false
};

export function qwenPromptParts(request, config) {
  const template = config?.conv_template;
  // Reject unknown fields as well: a new prefix or formatting option affects tokens.
  if (!template || config.conv_config !== undefined ||
      Object.keys(template).length !== Object.keys(QWEN_TEMPLATE).length ||
      Object.entries(QWEN_TEMPLATE).some(([key, value]) => JSON.stringify(template[key]) !== JSON.stringify(value))) {
    throw new Error('unsupported Qwen conversation template');
  }
  if (request.extra_body?.enable_thinking !== false || request.tools !== undefined ||
      request.messages?.length !== 2 || request.messages[0].role !== 'system' || request.messages[1].role !== 'user' ||
      request.messages.some(m => typeof m.content !== 'string' || m.name !== undefined)) {
    throw new Error('unsupported summary request');
  }
  return [
    `<|im_start|>system\n${request.messages[0].content}<|im_end|>\n`,
    `<|im_start|>user\n${request.messages[1].content}<|im_end|>\n`,
    '<|im_start|>assistant\n<think>\n\n</think>\n\n'
  ];
}

export function assertSummaryBudget(request, inputTokens) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new Error('invalid input token count');
  if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens < 1 || request.max_tokens > 4096) throw new Error('invalid output token budget');
  if (inputTokens + request.max_tokens > 4096) {
    throw Object.assign(new Error('summary exceeds context budget; partition transcript first'), { code: 'CONTEXT_LIMIT' });
  }
  return inputTokens;
}

export async function generateMeasuredJson(generate, request, { countTokens, signal, label }) {
  signal?.throwIfAborted();
  const measured = await countTokens(structuredClone(request));
  signal?.throwIfAborted();
  assertSummaryBudget(request, measured);
  const response = await generate(request);
  signal?.throwIfAborted();
  const choice = response?.choices?.[0], content = choice?.message?.content;
  if (choice?.finish_reason !== 'stop') {
    const error = new Error(`incomplete ${label} generation (${String(choice?.finish_reason ?? 'missing').slice(0, 40)})`);
    if (choice?.finish_reason === 'length') error.code = 'OUTPUT_LIMIT';
    throw error;
  }
  if (typeof content !== 'string' || content.length > 100000) throw new Error(`invalid ${label} payload`);
  return JSON.parse(content);
}
