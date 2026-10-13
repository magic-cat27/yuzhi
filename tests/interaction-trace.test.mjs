import test from 'node:test';
import assert from 'node:assert/strict';
import { interactionTrace } from '../public/interaction-trace.js';
const event = (type, timestamp, payload = {}) => ({ type, timestamp, payload });
test('interaction trace uses send time, removes duplicate input and successful review', () => {
  const events = [event('doc_save', 1), event('chat_request', 2, { requestId: 'a', text: '我的问题', input: { private: true } }), event('input_review', 3, { requestId: 'a', status: 'allowed' }), event('chat_user', 3, { requestId: 'a', text: '我的问题' }), event('chat_ai', 4, { requestId: 'a', text: '回复' })];
  const trace = interactionTrace(events);
  assert.deepEqual(trace.map(e => [e.type, e.timestamp]), [['doc_save', 1], ['chat_user', 2], ['chat_ai', 4]]);
  assert.equal(trace[1].payload.text, '我的问题');
  assert.equal(trace[1].payload.input, undefined);
  assert.equal(events.length, 5);
});
test('blocked turn shows a single blocked outcome, with no review details', () => {
  const trace = interactionTrace([event('chat_request', 1, { requestId: 'a' }), event('input_review', 2, { requestId: 'a', status: 'blocked', decision: 'private' }), event('chat_user', 2, { requestId: 'a' }), event('chat_ai', 2, { requestId: 'a', blocked: true, text: '警告' })]);
  assert.deepEqual(trace.map(e => e.type), ['chat_user', 'chat_blocked']);
  assert.equal(trace[1].payload.text, '警告');
  assert.ok(!JSON.stringify(trace).includes('private'));
});
test('legacy turns survive and failed or interrupted requests retain their input and outcome', () => {
  const legacy = [event('chat_user', 1, { text: '旧问题' }), event('chat_ai', 2, { text: '旧回答' })];
  assert.deepEqual(interactionTrace(legacy), legacy);
  for (const status of ['review_error', 'generation_error', 'blocked']) {
    const trace = interactionTrace([event('chat_request', 3, { requestId: 'b', text: '新问题' }), event('input_review', 4, { requestId: 'b', status })]);
    assert.deepEqual(trace.map(e => e.type), ['chat_user', status === 'blocked' ? 'chat_blocked' : 'chat_failed']);
  }
  assert.equal(interactionTrace([event('chat_request', 3, {requestId: 'c'})]).length, 1);
});
