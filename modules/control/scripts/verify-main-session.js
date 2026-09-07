// 总会话注入验证：notify 事件 → control 把 assistant/message 追加进 session-main
// （总会话为异步恢复/创建，stub 提供 sessionPersistence 并等待就绪）
// stub 传 dataRoot 为项目结构：dsh/data 位于 tmp 下，避免写入真实项目目录。
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const tmp = mkdtempSync(join(tmpdir(), 'verify-main-'));
mkdirSync(join(tmp, 'dsh', 'data'), { recursive: true });
const mod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-control/lib/index.js');

const appended = [];
const flushCalls = [];
const capturedTimeouts = []; // 捕获挂起队列的自再挂 setTimeout，供测试驱动排空
let handler = null;
let createdSession = null;
// loop 会话态可切换——对话中(conversing) chat 级记录须挂起，回合结束(idle)再按序送达
let loopMode = 'idle';
let loopQuietLeftMs = 0;
const persistenceStub = {
  prepare: async () => { throw new Error('not persisted (stub)'); },
  list: async () => [],
};
const ctx = {
  root: { logger: () => ({ info: () => {}, warn: console.log }) },
  on: (name, fn) => { if (name === 'archive/notify-sent') handler = fn; },
  provide: () => {},
  timer: { setInterval: () => 1, setTimeout: (fn) => { capturedTimeouts.push(fn); return capturedTimeouts.length; } },
  // stub 提供 parallel：control 的 inject 回调经 ctx.parallel 切回主 ctx，缺失会抛 TypeError 致断言全部不跑
  parallel: (events, fn) => { fn(); return Promise.resolve(); },
  inject: (services, cb) => cb({
    sessionPersistence: persistenceStub,
    // control 还 inject settings/connection/workspaceRegistry/sessionTitle —— stub 补齐避免启动噪音
    settings: { register: () => ({}), get: () => ({}), update: async () => {} },
    connection: { rpc: { handle: () => {} } },
    workspaceRegistry: { list: async () => [], detachSession: async () => {}, attachSession: async () => {} },
    sessionTitle: { rename: async () => {} },
  }),
  get: (name) => (name === 'sessionPersistence' ? persistenceStub : undefined),
  sessions: {
    get: () => undefined,
    create: (id, opts) => { createdSession = { id, opts, append: (type, data, surface) => appended.push({ type, data, surface }), header: { cwd: opts?.meta?.cwd } }; return createdSession; },
    flush: async (s) => { flushCalls.push(s.id); return true; },
    enter: () => () => {},
    announce: () => {},
  },
  persona: { get: () => ({}), stats: () => ({}), history: () => [], set: () => ({}), update: () => ({}), rollback: () => true },
  loop: { state: () => ({ mode: loopMode, quietLeftMs: loopQuietLeftMs }), stats: () => ({}), configure: () => ({}), trigger: () => ({}) },
  memory: { forgetStats: () => ({}), list: () => [], recall: async () => ({ results: [] }), update: () => ({}), forgetRun: () => ({}), restore: () => ({}), forgottenList: () => [], profile: { list: () => [] }, state: { snapshot: () => ({}) }, stats: () => ({}) },
  evolution: { view: () => ({}), stats: () => ({}), suggest: async () => ({}), approve: async () => ({}), reject: () => ({}), rollback: async () => ({}) },
  schedule: { list: () => [], create: () => ({}), cancel: () => ({}), stats: () => ({}) },
  notify: { view: () => ({}), markRead: () => ({}), stats: () => ({}) },
  virtualClock: { format: () => 't' },
};
mod.apply(ctx, { dataRoot: join(tmp, 'dsh', 'data') });

const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模拟 notify 发送事件（总会话为异步初始化，需等待微任务完成）
// 分级：仅 scope='chat' 记录注入对话流；scope='panel'（默认）只进通知流水，绝不注入
await sleep(20);
handler({ record: { id: 'n1', content: '⏰ 测试：主动消息注入总会话', source: 'schedule', at: 12345, scope: 'chat' } });
await sleep(20);

// MAIN_CWD=resolve(dataRoot,'..')（=tmp/dsh，主会话工作目录=profile 目录，
// 与持久化主会话 cwd 语义一致）；resolve() 在 Windows 返回反斜杠，断言前归一化为正斜杠比较
check('总会话创建（session-main + cwd=profile 目录）', createdSession?.id === 'session-main' && String(createdSession?.opts?.meta?.cwd ?? '').replace(/\\/g, '/') === join(tmp, 'dsh').replace(/\\/g, '/'));
check('assistant/message 事件追加', appended.length === 1 && appended[0].type === 'assistant/message');
check('消息内容与角色正确', appended[0]?.data?.message?.role === 'assistant' && appended[0].data.message.content?.[0]?.text?.includes('主动消息'));
check('surfaceOp=append', appended[0]?.surface?.surfaceOp === 'append');
check('flush 被调用（持久化）', flushCalls.includes('session-main'));
// panel 级记录（系统状态/操作流水）绝不注入对话流
handler({ record: { id: 'p1', content: '🧬 系统状态提示：进化候选生成', source: 'evolution', at: 12346, scope: 'panel' } });
handler({ record: { id: 'p2', content: '🤖 主动行动：已执行：schedule_create（后果评估：x）', source: 'loop', at: 12347, scope: 'panel' } });
handler({ record: { id: 'p3', content: '⚠️ 停机期间有任务错过', source: 'schedule', at: 12348, scope: 'panel' } });
await sleep(20);
check('panel 级记录不注入对话流', appended.length === 1, `appended=${appended.length}`);
// 空 content 不追加（无论 scope）
handler({ record: { id: 'x', content: '', source: 's', scope: 'chat' } });
await sleep(10);
check('空 content 不追加', appended.length === 1);
// 旧记录无 scope 字段（历史数据/向后兼容）→ 按 panel 处理，不注入
handler({ record: { id: 'old', content: '旧格式无 scope 记录', source: 'loop', at: 12349 } });
await sleep(10);
check('无 scope 记录按 panel 处理（不注入）', appended.length === 1);

// 送达时机门控：对话回合进行中（conversing）到达的 chat 级记录先挂起，回合结束(idle)后按序送达
// （防定时提醒/主动消息插进 AI 正在回复的对话中间 → 割裂）
const appendedBeforeHold = appended.length;
const timeoutsBeforeHold = capturedTimeouts.length;
loopMode = 'conversing';
handler({ record: { id: 'q1', content: '对话进行中到达的定时提醒', source: 'schedule', at: 12350, scope: 'chat' } });
handler({ record: { id: 'q2', content: '对话进行中到达的主动发言', source: 'loop', at: 12351, scope: 'chat' } });
await sleep(30);
check('对话进行中 chat 记录挂起不注入', appended.length === appendedBeforeHold, `appended=${appended.length} base=${appendedBeforeHold}`);
// 回合结束：loop 回 idle → 挂起链排空，按序送达（只跑挂起链产生的定时器，跳过 apply 期注册的其他定时器）
loopMode = 'idle';
for (const fn of capturedTimeouts.slice(timeoutsBeforeHold)) fn();
await sleep(20);
const heldMsgs = appended.slice(appendedBeforeHold).map((a) => a?.data?.message?.content?.[0]?.text ?? '');
check('回合结束挂起记录按序送达', heldMsgs.length === 2 && heldMsgs[0] === '对话进行中到达的定时提醒' && heldMsgs[1] === '对话进行中到达的主动发言', JSON.stringify(heldMsgs));

console.log(failures.length === 0 ? '\nMAIN-SESSION INJECT: ALL PASS' : `\nINJECT: ${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
