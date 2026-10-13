import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalog, publicModels, modelConfig, defaultModel } from '../src/models.mjs';
import { reply } from '../src/ai.mjs';
import { rules } from '../src/prompt.mjs';
import { problems } from '../problems.mjs';

test('模型目录只公开配置状态，不暴露密钥；默认千问，不静默降级', () => {
  const env = { DASHSCOPE_API_KEY: 'secret-bailian', DEEPSEEK_API_KEY: 'secret-deepseek' };
  assert.equal(defaultModel({}), 'qwen3.7-plus');
  assert.equal(defaultModel({ DEFAULT_AI_MODEL: 'invalid' }), 'qwen3.7-plus');
  assert.equal(modelConfig('unknown'), undefined);
  assert.equal(modelConfig('glm-5.2', env).apiKey, 'secret-bailian');
  assert.ok(publicModels(env).every(m => m.configured));
  assert.ok(!JSON.stringify(publicModels(env)).includes('secret-'));
  assert.ok(publicModels({}).every(m => !m.configured));
});

test('PI 将每个选定模型路由到正确接口，保留提示词并解析流式文本', async () => {
  for (const config of modelCatalog) {
    let called = false;
    const result = await reply({ plan: '按学生规划实现', versions: [{}], code: '', chats: [], lastRun: null }, problems[0], '执行', 'test-only-key', config.id, {
      fetch: async (url, options) => {
        called = true;
        assert.ok(String(url).startsWith(config.provider === 'bailian' ? 'https://dashscope.aliyuncs.com/' : 'https://api.deepseek.com/'));
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, config.id);
        assert.equal(payload.messages[0].role, 'system');
        assert.ok(payload.messages[0].content.startsWith(rules));
        assert.match(JSON.stringify(payload.messages), /按学生规划实现/);
        if (config.thinking === false) assert.equal(payload.enable_thinking, false);
        const chunk = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: config.id, choices: [{ index: 0, delta: { role: 'assistant', content: '已按规划实现。' }, finish_reason: null }] };
        const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    assert.ok(called); assert.equal(result, '已按规划实现。');
  }
});
