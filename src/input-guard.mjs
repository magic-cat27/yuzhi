import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const guardPrompt = await readFile(new URL('../docs/输入门控系统提示词.txt', import.meta.url), 'utf8');
export const guardVersion = 'v0.3';
export const guardPromptHash = createHash('sha256').update(guardPrompt).digest('hex');
export const blockedReply = '检测到恶意诱导行为，请规范自身行为';
export const reviewError = '本次检查未完成，回复暂未展示。请稍后重试。';

// Blocked turns remain visible in the record, but never become accepted model history.
export function guardSnapshot(session, text) {
  const snapshot = structuredClone({
    plan: session.plan, code: session.code, lastRun: session.lastRun,
    chats: session.chats.filter(c => !c.blocked).map(c => ({ role: c.role, text: c.text })),
  });
  return { session: snapshot, input: {
    current_request: text, saved_plan: snapshot.plan, current_code: snapshot.code,
    run_result: snapshot.lastRun,
    history: snapshot.chats.map(c => ({ role: c.role, content: c.text })),
  } };
}

const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const size = value => [...value].length;
function evidenceValue(input, path) {
  if (['current_request', 'saved_plan', 'current_code'].includes(path)) return input[path];
  const run = /^run_result\.(stdout|stderr|stdin|warnings|code|stage|timestamp)$/.exec(path);
  if (run) return input.run_result?.[run[1]];
  const history = /^history\[(0|[1-9]\d*)\]\.content$/.exec(path);
  if (history) return input.history[Number(history[1])]?.content;
}
export function parseReview(raw, input) {
  if (typeof raw !== 'string' || raw.length > 10000) throw new Error('Invalid review');
  const value = JSON.parse(raw);
  if (!exactKeys(value, ['decision', 'category', 'reason', 'evidence'])
    || !['allow', 'block'].includes(value.decision)
    || typeof value.reason !== 'string' || !value.reason.trim() || size(value.reason) > 100
    || !Array.isArray(value.evidence)) throw new Error('Invalid review');
  if (value.decision === 'allow') {
    if (value.category !== 'none' || value.evidence.length) throw new Error('Invalid allow');
  } else {
    if (!['instruction_override', 'authority_spoofing', 'guard_tampering'].includes(value.category)
      || !value.evidence.length || value.evidence.length > 3) throw new Error('Invalid block');
    for (const e of value.evidence) {
      if (!exactKeys(e, ['path', 'quote']) || typeof e.path !== 'string'
        || typeof e.quote !== 'string' || !e.quote.trim() || size(e.quote) > 160) throw new Error('Invalid evidence');
      const source = evidenceValue(input, e.path);
      if (typeof source !== 'string' || !source.includes(e.quote)) throw new Error('Unmatched evidence');
    }
  }
  return value;
}

// Both jobs start together. Only this release barrier returns publishable text.
export async function guardedReply({ input, generate, review, reviewTimeoutMs = 30000, generationTimeoutMs = 90000 }) {
  const generationController = new AbortController(), reviewController = new AbortController();
  const start = Date.now();
  const job = (fn, controller, timeoutMs) => {
    let timer, onAbort;
    const task = Promise.resolve().then(() => fn(controller.signal));
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Timeout')); }, timeoutMs); });
    const cancelled = new Promise((_, reject) => { onAbort = () => reject(new Error('Cancelled')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    // Attach rejection handlers immediately, including when cancellation wins the race.
    return Promise.race([task, timeout, cancelled]).then(value => ({ ok: true, value }), () => ({ ok: false }))
      .finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); });
  };
  const generated = job(generate, generationController, generationTimeoutMs);
  const inspected = job(review, reviewController, reviewTimeoutMs);
  let decision;
  try {
    const result = await inspected;
    if (!result.ok) throw new Error('Review unavailable');
    decision = parseReview(result.value, input);
  } catch {
    generationController.abort();
    return { status: 'review_error', reviewDurationMs: Date.now() - start };
  }
  const reviewDurationMs = Date.now() - start;
  if (decision.decision === 'block') {
    generationController.abort();
    return { status: 'blocked', answer: blockedReply, review: decision, reviewDurationMs };
  }
  const result = await generated;
  if (!result.ok || typeof result.value !== 'string' || !result.value.trim()) {
    return { status: 'generation_error', review: decision, reviewDurationMs };
  }
  return { status: 'allowed', answer: result.value, review: decision, reviewDurationMs };
}
