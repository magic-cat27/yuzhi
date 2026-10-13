import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { buildPrompt } from './prompt.mjs';
import { assessmentPoints } from './assessment-points.mjs';
import { modelCatalog, modelConfig, defaultModel } from './models.mjs';
const models = createModels();
for (const provider of ['bailian', 'deepseek']) {
  const entries = modelCatalog.filter(m => m.provider === provider).map(entry => {
    const config = modelConfig(entry.id);
    return { id: entry.id, name: entry.name, api: 'openai-completions', provider,
      baseUrl: config.baseUrl, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: entry.contextWindow, maxTokens: 6000,
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } };
  });
  models.setProvider(createProvider({ id: provider, name: provider, baseUrl: entries[0].baseUrl, models: entries,
    auth: { apiKey: envApiKeyAuth(`${provider} API key`, [provider === 'bailian' ? 'DASHSCOPE_API_KEY' : 'DEEPSEEK_API_KEY']) }, api: openAICompletionsApi() }));
}
export function checkPi() { for (const m of modelCatalog) if (!models.getModel(m.provider, m.id)) throw new Error('PI 未注册目标模型'); }
export async function reply(session, problem, text, apiKey, modelId = defaultModel(), transport = {}) {
  const { systemPrompt, prompt } = buildPrompt(session, problem, text, assessmentPoints[problem.id]);
  return generateText(systemPrompt, prompt, apiKey, modelId, transport);
}
export async function generateText(systemPrompt, prompt, apiKey, modelId = defaultModel(), transport = {}) {
  const config = modelConfig(modelId);
  if (!config) throw new Error('模型不在允许列表中');
  const model = models.getModel(config.provider, config.id);
  const { signal, maxTokens = 6000, ...options } = transport;
  if (signal?.aborted) throw new Error('请求已取消');
  const agent = new Agent({ initialState: { model, systemPrompt, tools: [], thinkingLevel: 'off' }, streamFn: (m, c, o) => models.streamSimple(m, c, { ...o, ...options, apiKey, maxTokens, onPayload: payload => { if (config.thinking === false) payload.enable_thinking = false; } }) });
  const abort = () => agent.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => agent.abort(), 90000);
  try {
    await agent.prompt(prompt);
    const last = agent.state.messages.filter(m => m.role === 'assistant').at(-1);
    if (!last || last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error('模型请求失败或超时，请检查服务配置后重试');
    const answer = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (!answer) throw new Error('模型未返回文本，请重试');
    return answer;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
