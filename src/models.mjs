// Official model IDs verified against Alibaba Model Studio documentation on 2026-10-12.
export const modelCatalog = [
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', brand: '阿里千问', purpose: '主模型 · 日常调试', provider: 'bailian', contextWindow: 1000000, thinking: false },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', brand: '阿里千问', purpose: '快速试验', provider: 'bailian', contextWindow: 1000000, thinking: false },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', brand: '阿里千问', purpose: '疑难案例对照', provider: 'bailian', contextWindow: 1000000, thinking: false },
  { id: 'glm-5.2', name: 'GLM-5.2', brand: '智谱', purpose: '跨模型对照', provider: 'bailian', contextWindow: 1000000, thinking: false },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', brand: '月之暗面', purpose: '代码实现对照', provider: 'bailian', contextWindow: 256000 },
  { id: 'MiniMax-M3', name: 'MiniMax M3', brand: 'MiniMax', purpose: '跨模型对照', provider: 'bailian', contextWindow: 192000 },
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', brand: 'DeepSeek', purpose: '原有模型 · 对照基线', provider: 'deepseek', contextWindow: 128000 },
];
export function modelConfig(id, env = process.env) {
  const entry = modelCatalog.find(m => m.id === id);
  if (!entry) return undefined;
  const bailian = entry.provider === 'bailian';
  const keyEnv = bailian ? 'DASHSCOPE_API_KEY' : 'DEEPSEEK_API_KEY';
  return { ...entry, keyEnv, apiKey: env[keyEnv]?.trim(), baseUrl: bailian ? (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1') : 'https://api.deepseek.com' };
}
export function defaultModel(env = process.env) {
  return modelCatalog.some(m => m.id === env.DEFAULT_AI_MODEL) ? env.DEFAULT_AI_MODEL : 'qwen3.7-plus';
}
export function publicModels(env = process.env) {
  return modelCatalog.map(m => ({ ...m, configured: Boolean(modelConfig(m.id, env).apiKey), route: m.provider === 'bailian' ? '阿里云百炼' : 'DeepSeek 官方', recommended: m.id === 'qwen3.7-plus' }));
}
