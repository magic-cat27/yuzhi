// Present student actions and their outcomes without exposing internal review steps.
export function interactionTrace(events = []) {
  const requests = new Set(events.filter(e => e.type === 'chat_request').map(e => e.payload?.requestId).filter(Boolean));
  const answers = new Set(events.filter(e => e.type === 'chat_ai').map(e => e.payload?.requestId).filter(Boolean));
  return events.flatMap(e => {
    const p = e.payload || {};
    if (e.type === 'chat_user' && p.requestId && requests.has(p.requestId)) return [];
    if (e.type === 'chat_request') {
      return [{ ...e, type: 'chat_user', payload: { text: p.text, requestId: p.requestId, model: p.model, modelName: p.modelName, planVersion: p.planVersion } }];
    }
    if (e.type === 'input_review') {
      if (answers.has(p.requestId)) return [];
      if (p.status === 'blocked') return [{ ...e, type: 'chat_blocked', payload: { requestId: p.requestId, text: '检测到恶意诱导行为，请规范自身行为' } }];
      if (['review_error', 'generation_error'].includes(p.status)) return [{ ...e, type: 'chat_failed', payload: { requestId: p.requestId, text: '本次回复未能完成，请重试。' } }];
      return [];
    }
    if (e.type === 'chat_ai' && (p.blocked || p.source === 'input_guard')) {
      return [{ ...e, type: 'chat_blocked', payload: { requestId: p.requestId, text: p.text } }];
    }
    return [e];
  });
}
