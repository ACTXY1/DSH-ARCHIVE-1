// 自循环集成验证（stub ctx）：触发循环 → LLM(假) → 决策解析 → 防护 → 循环日志 → 事件
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `loop-verify-${process.pid}.db`);
const mod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-loop/lib/index.js');

const captured = { writes: [], emits: [], contexts: [], tools: [], bootLines: [], stateSetCalls: [], notifySends: [], scheduleTasks: [], timeoutFns: [], intervalFns: [] };
let stdout = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { stdout += String(chunk); return true; };

// 假 LLM：返回固定决策 JSON（含内部动作与外部动作）；EMPTY_NEXT=true 时模拟一次空返回（finish completed 无文本）
let DECISION_TEXT = '{"analysis":"用户睡眠中，不宜打扰","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"user_state_set","args":{"state":"睡眠中","evidence":"循环决策"},"reason":"确认状态"},{"name":"web_search","args":{"queries":["天气"]},"reason":"需要外部信息"}],"consequenceAssessment":"内部动作安全；外部动作待用户确认","notifyUser":true}';
let EMPTY_NEXT = false;
let SLOW_LLM = false; //：慢 LLM，让循环停留在 thinking（测试用户消息中止）
let LLM_THROW = ''; //：非空时 LLM 流首帧即抛该错误（模拟 MISSING_CREDENTIAL 等）
let lastBrief = ''; //：捕获传给 LLM 的场景简报（断言含 recent-user-messages 证据块）
let lastSystem = ''; //：捕获决策协议（断言含用户状态感知步骤）
let lastDecisionBrief = ''; //：捕获"决策"调用的简报（审查调用会覆盖 lastBrief，故单独留存）
let lastReviewUser = ''; //：捕获"输出审查员"调用的材料（断言含用户指令）
//：双 Agent 测试支撑——调用分类、记忆概括固定输出、审查响应可编程
let streamTags = []; // 每次 LLM 调用按 system 归类（decision/memory-analyzer/reviewer）
const SUM_XML = '<memory-summary source="recent"><flow>最近：用户熬夜点外卖</flow><situation>当前：用户在选餐</situation><mood>用户有点纠结（推断）</mood></memory-summary>\n<memory-summary source="semantic"><key>用户偏好日常干饭、不列选项</key></memory-summary>';
let REVIEW_RESP = '{"verdict":"ok","correctedSpeak":"","blockedActions":[],"reason":""}';
async function* fakeStream(opts) {
  if (opts?.messages?.[0]?.content?.[0]?.text) lastBrief = String(opts.messages[0].content[0].text);
  if (typeof opts?.system === 'string') lastSystem = opts.system;
  const sys = String(opts?.system ?? '');
  if (sys.includes('记忆分析师')) streamTags.push('memory-analyzer');
  else if (sys.includes('输出审查员')) streamTags.push('reviewer');
  else streamTags.push('decision');
  //：按调用类别留存简报/审查材料（决策调用可能随后被审查调用覆盖 lastBrief）
  const userText = String(opts?.messages?.[0]?.content?.[0]?.text ?? '');
  if (sys.includes('记忆分析师')) { /* 概括材料不用于指令断言 */ }
  else if (sys.includes('输出审查员')) lastReviewUser = userText;
  else lastDecisionBrief = userText;
  if (LLM_THROW) throw new Error(LLM_THROW);
  if (sys.includes('记忆分析师')) {
    yield { type: 'text-delta', index: 0, text: SUM_XML };
    yield { type: 'finish', reason: { kind: 'completed' } };
    return;
  }
  if (sys.includes('输出审查员')) {
    yield { type: 'text-delta', index: 0, text: REVIEW_RESP };
    yield { type: 'finish', reason: { kind: 'completed' } };
    return;
  }
  if (EMPTY_NEXT) {
    EMPTY_NEXT = false;
    yield { type: 'finish', reason: { kind: 'completed' } };
    return;
  }
  if (SLOW_LLM) await new Promise((r) => setTimeout(r, 500)); //：模拟 LLM 挂起
  if (opts?.signal?.aborted) throw new Error('ABORTED: 用户消息打断');
  for (const piece of [DECISION_TEXT.slice(0, 40), DECISION_TEXT.slice(40)]) {
    yield { type: 'text-delta', index: 0, text: piece };
  }
  yield { type: 'finish', reason: { kind: 'completed' } };
}

const memoryApi = {
  //  实机修复回归：模拟真实分布——循环决策记忆（loop/manual）每 5 分钟写 2 条，
  // 会把用户消息挤出前 20 条；窗口须扩大到 200 才能在数小时后仍找到对话记忆。
  list: () => [
    ...Array.from({ length: 30 }, (_, i) => ({ content: `循环记忆${i}` })),
    //：带真实 createdAt，供 <recent-user-messages> 时间戳断言
    { content: '用户：我有点困了，先睡一会儿', source: 'conversation', createdAt: Date.now() - 30000 },
  ],
  recall: async () => ({ results: [{ content: '相关记忆A' }, { content: '相关记忆B' }] }),
  // 与真实 memory 服务一致：用户状态在 state 命名空间（ 修复 stub 与真实接口不一致的盲区）
  state: {
    snapshot: () => ({ rendered: '<user-context>\n<user-state name="睡眠中">…</user-state>\n</user-context>' }),
    get: () => [{ state: '睡眠中', detail: '用户去睡觉了', evidence: '用户说：我去睡觉了' }],
    set: (input) => { captured.stateSetCalls.push(input); return input; },
    clear: (state) => ({ removed: true }),
  },
  write: async (input) => { captured.writes.push(input); return { id: 'x' }; },
  forget: (id) => ({ removed: true }), //：被中止循环清理记录用
};

const ctx = {
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  provide: () => {},
  //  stub 同步：loop 现经 ctx.inject(['settings']) 注册 archive-loop 命名空间并回填降频开关
  // （settings 在 verify 中不可用 → 回调不执行，降频用默认值；注册动作被吞掉即可）
  inject: () => {},
  on: (name, fn) => { captured.handlers = { ...(captured.handlers ?? {}), [name]: fn }; },
  emit: (name, payload) => captured.emits.push({ name, payload }),
  get: (name) => {
    if (name === 'tools') return { register: (t) => captured.tools.push(t.name) };
    //  stub 同步：loop 主动告知经 ctx.get('notify') 可选访问（ 修复后
    // 真实代码用 ctx.get 而非 ctx.notify 属性——旧 stub 只挂属性 → 告知分支恒不执行 → 断言失败）
    if (name === 'notify') return { send: (input) => { captured.notifySends.push(input); return { sent: true }; } };
    //  睡眠期：读 schedule 判"有工作任务"（list 动态返回 captured.scheduleTasks）
    if (name === 'schedule') return { create: (input) => ({ id: 's', ...input }), list: () => captured.scheduleTasks };
    return undefined;
  },
  systemPrompt: { context: (c) => captured.contexts.push(c) },
  timer: {
    //：捕获回调，供测试驱动 boot/tick（验证静默窗口抑制与用户消息中止）
    setTimeout: (fn) => { captured.timeoutFns.push(fn); return 1; },
    setInterval: (fn) => { captured.intervalFns.push(fn); return 1; },
  },
};
// 模拟 Cordis 注入：服务以 ctx 属性可用
ctx.llm = { stream: (opts) => fakeStream(opts) };
ctx.virtualClock = { format: () => '2026-08-28 10:00:00' };
ctx.memory = memoryApi;
ctx.persona = { render: () => '<persona version="1">…</persona>' };
ctx.notify = { send: (input) => { captured.notifySends.push(input); return { sent: true }; } };
ctx.schedule = { create: (input) => ({ id: 's', ...input }) };
ctx.loop = undefined; // 自我 configure 不需 loop 服务（用自身 api）

const api = mod.apply(ctx, {
  fallbackIntervalMs: 300000, tickMs: 30000, initialDelayMs: 0, thinkTimeoutMs: 5000,
  maxActionsPerCycle: 2, maxActionsPerDay: 20, minSpeakIntervalMs: 0,
});

await new Promise((resolve) => setTimeout(resolve, 50)); // 让触发后的异步循环跑完
process.stdout.write = origWrite; // 恢复 stdout：此后 console.log 走真实输出

// 先触发一次完整循环（beforeTurn：对话前置协议；reason 恒 pre-turn，无需 trigger——trigger 只
// 会堆积 dirtyReasons； 起 pre-turn 不再清空 dirty（防吞 state-changed），无效 trigger
// 会让后续 tick 驱动块先触发最旧残留 reason，故此处及以下 beforeTurn 驱动的块均不再 trigger）
const preTurn = await api.beforeTurn();

console.log('--- 断言 ---');
const checks = [
  ['loop 服务提供', typeof api.trigger === 'function' && typeof api.beforeTurn === 'function' && typeof api.stats === 'function'],
  ['循环日志以 thought 类型写回记忆', captured.writes.some((w) => w.kind === 'thought' && w.source === 'loop' && w.content.includes('<loop-decision'))],
  ['事件 archive/loop-cycle 发出', captured.emits.some((e) => e.name === 'archive/loop-cycle')],
  ['决策含分析', captured.emits.some((e) => e.name === 'archive/loop-cycle' && e.payload.decision.analysis.includes('睡眠中'))],
  ['loop 状态已更新(cycleCount≥1)', api.stats().cycleCount >= 1],
  ['systemPrompt context 注册', captured.contexts.some((c) => c.name === 'loop-latest-analysis')],
  ['3 个工具注册', captured.tools.join(',') === 'loop_trigger,loop_config,loop_view'],
  ['状态变化事件监听', typeof captured.handlers?.['archive/state-changed'] === 'function'],
  ['beforeTurn 返回决策', preTurn?.decision?.analysis.includes('睡眠中')],
  ['beforeTurn 进入对话占位', preTurn?.mode === 'conversing'],
  ['endConversation 恢复 idle', api.endConversation()?.mode === 'idle'],
  ['beginConversation 互斥生效', (api.beginConversation()?.mode === 'conversing') && (api.endConversation()?.mode === 'idle')],
  ['内部动作已直接执行(user_state_set)', captured.stateSetCalls.some((s) => s.state === '睡眠中' && s.evidence === '循环决策')],
  ['外部动作标记待确认(web_search)', preTurn?.decision?.actionResults?.some((r) => r.name === 'web_search' && r.status === 'deferred')],
  ['执行结果写入循环日志', captured.writes.some((w) => w.content.includes('[executed]') && w.content.includes('[deferred]'))],
  ['pre-turn 循环行动告知不投递（2026-09-03 泄露回归）', captured.notifySends.length === 0],
  ['简报含近期用户消息证据块(recent-user-messages)', lastBrief.includes('<recent-user-messages>') && lastBrief.includes('我有点困了，先睡一会儿')],
  ['简报用户消息带真实时间(at=)', lastBrief.includes('<message at="')], // 2026-09-03-2 时间线修复
  ['决策协议含用户状态感知步骤', lastSystem.includes('感知用户状态变化') && lastSystem.includes('user_state_set')],
];

// 后果门：无后果评估 → 全部动作不执行（deferred）
api.endConversation();
DECISION_TEXT = '{"analysis":"x","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"user_state_set","args":{"state":"x"},"reason":"r"}],"consequenceAssessment":"","notifyUser":false}';
const gateTurn = await api.beforeTurn();
const gateResults = gateTurn?.decision?.actionResults ?? [];
checks.push(['后果门：缺评估不执行', gateResults.some((r) => r.status === 'deferred' && r.detail.includes('缺少后果评估'))]);
checks.push(['后果门：未调用 stateSet', captured.stateSetCalls.filter((s) => s.state === 'x').length === 0]);

// 静默行动：有后果评估但 notifyUser=false → 动作执行但**不告知**
api.endConversation();
const notifyCountBefore = captured.notifySends.length;
DECISION_TEXT = '{"analysis":"y","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"user_state_set","args":{"state":"静默状态"},"reason":"小事"}],"consequenceAssessment":"无关紧要的小事","notifyUser":false}';
const silentTurn = await api.beforeTurn();
checks.push(['静默行动：动作已执行', captured.stateSetCalls.some((s) => s.state === '静默状态')]);
checks.push(['静默行动：未发送告知', captured.notifySends.length === notifyCountBefore]);

// 空文本自动重试（llm 流偶发空返回时自愈）
api.endConversation();
EMPTY_NEXT = true;
DECISION_TEXT = '{"analysis":"重试测试通过","shouldSpeak":false,"shouldAct":false,"actions":[],"consequenceAssessment":"","notifyUser":false}';
const retryTurn = await api.beforeTurn();
checks.push(['空文本自动重试后成功', retryTurn?.decision?.analysis === '重试测试通过']);

// 降频开关（configure 支持 reducedMode，stats 反映生效间隔）
const cfgOn = api.configure({ reducedMode: true });
const statsOn = api.stats();
checks.push(['降频开关开启生效', cfgOn.reducedMode === true && cfgOn.effectiveFallbackMs === 1800000 && statsOn.config.reducedMode === true]);
api.configure({ reducedMode: false });
checks.push(['降频开关关闭恢复', api.stats().config.effectiveFallbackMs === 300000]);

// ── 睡眠/清醒期（ 用户设计）──
// 缩短参数便于测试：1s 进入延迟 / 60s 上限 / 1s 冷却 / 60s 任务窗口
api.configure({ sleepEnterDelayMs: 1000, sleepMaxMs: 60000, sleepCooldownMs: 1000, sleepCheckWindowMs: 60000 });
const origStateGet = memoryApi.state.get;
const setUserAsleep = (msAgo) => { memoryApi.state.get = () => [{ state: '睡眠中', detail: '测试睡眠', setAt: Date.now() - msAgo }]; };
const setUserAwake = () => { memoryApi.state.get = () => []; };
const sCheck = (name, cond, extra = '') => { checks.push([name, cond]); if (!cond && extra) console.log(`  ↳ ${extra}`); };

// 1) 有 pending 任务（窗口内：30s 后到期 < 60s 窗口）→ 不进入睡眠期
captured.scheduleTasks = [{ status: 'pending', dueAt: Date.now() + 30000 }];
setUserAsleep(40 * 60000);
api.endConversation();
await api.beforeTurn('睡眠测试-有任务');
sCheck('有 pending 任务时不进入睡眠期', api.state().sleep.phase === 'awake');

// 2) 无任务 + 用户睡眠 ≥30 分钟 → 进入睡眠期，循环暂停
captured.scheduleTasks = [];
api.endConversation();
await api.beforeTurn('睡眠测试-无任务');
const s1 = api.state().sleep;
sCheck('无任务且用户睡眠≥30分钟 → 进入睡眠期', s1.phase === 'asleep', JSON.stringify(s1));
sCheck('睡眠期循环被暂停（skips 计数）', s1.skips >= 1);
const cycleBeforeSleep = api.stats().cycleCount;

// 3) 睡眠期中事件触发也跳过（cycleCount 不变）
api.endConversation();
await api.beforeTurn('睡眠测试-仍在睡');
sCheck('睡眠期循环完全暂停（cycleCount 不变）', api.stats().cycleCount === cycleBeforeSleep);

// 4) 定时任务打断 → 冷却期（wake）
const wk = api.wake('task');
sCheck('任务打断 → 强制清醒间隔', wk.woke === true && api.state().sleep.phase === 'cooldown' && api.state().sleep.wakeReason === 'task');

// 5) 冷却中即使条件满足也不进入睡眠
setUserAsleep(40 * 60000);
api.endConversation();
await api.beforeTurn('睡眠测试-冷却中');
sCheck('冷却期无法再睡眠', api.state().sleep.phase === 'cooldown');

// 6) 冷却到期 → 恢复清醒（先清除用户状态，避免到期即重入睡眠）
setUserAwake();
await new Promise((r) => setTimeout(r, 1200));
api.endConversation();
await api.beforeTurn('冷却到期检查');
sCheck('冷却到期恢复清醒', api.state().sleep.phase === 'awake');

// 7) 用户再次睡眠 → 重入睡眠期；用户醒来（状态清除）→ 自动解除并进入冷却
setUserAsleep(40 * 60000);
api.endConversation();
await api.beforeTurn('睡眠测试-再进入');
sCheck('再次进入睡眠期', api.state().sleep.phase === 'asleep');
setUserAwake();
api.endConversation();
await api.beforeTurn('睡眠测试-醒来');
const s7 = api.state().sleep;
sCheck('用户醒来自动解除 → 冷却', s7.phase === 'cooldown' && s7.wakeReason === 'woke', JSON.stringify(s7));

// 恢复现场：睡眠参数还原、状态 stub 还原、任务清空
api.configure({ sleepEnterDelayMs: 1800000, sleepMaxMs: 28800000, sleepCooldownMs: 10800000, sleepCheckWindowMs: 28800000 });
setUserAwake();
memoryApi.state.get = origStateGet;
captured.scheduleTasks = [];
checks.push(['睡眠参数恢复默认', api.stats().config.sleepEnterDelayMs === 1800000]);

// ──  用户消息 → 暂停时间驱动循环 30s + 中止运行中的时间驱动循环 ──
// 需求：防止兜底思维循环与对话思维循环并行运行并同时输出对话 → 割裂感。
// 本质：并行的两个循环用同一时刻记忆 → 行为并列而非延续 → 须中止并清理记录/回退行为。
const userMsgHandler = captured.handlers?.['session/event'];
api.configure({ quietAfterUserMs: 150 }); // 缩短静默窗口便于测试
api.endConversation();

// A) 用户消息 → 设置静默窗口；窗口内对话循环（pre-turn）仍运行
userMsgHandler({ id: 'session-main' }, { type: 'user/message', data: { source: { kind: 'user' }, content: '静默窗口测试' } });
const q = api.state();
sCheck('用户消息 → 设置静默窗口(≤150ms)', q.quietUntil > Date.now() && q.quietLeftMs > 0 && q.quietLeftMs <= 150, JSON.stringify({ quietUntil: q.quietUntil, quietLeftMs: q.quietLeftMs }));
const quietTurn = await api.beforeTurn('静默窗口测试');
sCheck('静默窗口内对话循环(pre-turn)仍运行', quietTurn?.mode === 'conversing' && quietTurn?.decision !== null);
api.endConversation();
await new Promise((r) => setTimeout(r, 250)); // 等窗口过期

// B) 静默窗口内时间驱动循环被抑制（startup 为时间驱动 → 跳过，不写记录/不增 cycleCount）
const cycleCountBeforeQuiet = api.stats().cycleCount;
const writesBeforeQuiet = captured.writes.length;
userMsgHandler({ id: 'session-main' }, { type: 'user/message', data: { source: { kind: 'user' }, content: '静默抑制测试' } });
captured.timeoutFns[0](); // 执行启动回调：注册 interval + void cycle('startup')
await new Promise((r) => setTimeout(r, 100));
sCheck('静默窗口内时间驱动循环被抑制(cycleCount 不变)', api.stats().cycleCount === cycleCountBeforeQuiet);
sCheck('静默窗口内时间驱动循环未写记录', captured.writes.length === writesBeforeQuiet);
await new Promise((r) => setTimeout(r, 250)); // 等窗口过期
api.endConversation();

// C) 运行中的时间驱动循环被用户消息立即中止：不留记录/不发事件/不更新 lastDecision（行为回退）
SLOW_LLM = true;
const writesBefore = captured.writes.length;
const emitsBefore = captured.emits.length;
const lastDecisionAtBefore = api.state().lastDecisionAt;
const cancelledBefore = api.stats().cancelledCount ?? 0;
api.trigger('fallback');
captured.intervalFns[0](); // tick → cycle('fallback')（慢 LLM 使其停留在 thinking）
await new Promise((r) => setTimeout(r, 80));
sCheck('fallback 循环运行中(thinking)', api.state().mode === 'thinking', `mode=${api.state().mode}`);
userMsgHandler({ id: 'session-main' }, { type: 'user/message', data: { source: { kind: 'user' }, content: '打断测试' } });
await new Promise((r) => setTimeout(r, 900)); // 等待中止与收尾
sCheck('用户消息后循环中止并恢复 idle', api.state().mode === 'idle', `mode=${api.state().mode}`);
sCheck('中止计数 +1', (api.stats().cancelledCount ?? 0) === cancelledBefore + 1, `cancelledCount=${api.stats().cancelledCount}`);
sCheck('被中止循环未写记忆记录', captured.writes.length === writesBefore, `writes=${captured.writes.length} before=${writesBefore}`);
sCheck('被中止循环未发事件', captured.emits.length === emitsBefore, `emits=${captured.emits.length} before=${emitsBefore}`);
sCheck('被中止循环未更新 lastDecision', api.state().lastDecisionAt === lastDecisionAtBefore, `at=${api.state().lastDecisionAt} before=${lastDecisionAtBefore}`);
SLOW_LLM = false;
api.configure({ quietAfterUserMs: 180000 });
checks.push(['静默窗口参数恢复默认(180s)', api.stats().config.quietAfterUserMs === 180000]);

// ──  复现修复：6:48 事件 = pre-turn 循环在对话回合结束后投递主动发言 ──
// D) pre-turn 按 reason 无条件禁言：即使经 trigger('pre-turn') 绕过 beforeTurn 的 suppressSpeak，
//    也不投递发言（不 notify、不写 <loop-speak>，仅决策留档）
api.endConversation();
const notifyBeforeD = captured.notifySends.length;
const writesBeforeD = captured.writes.length;
DECISION_TEXT = '{"analysis":"pre-turn禁言测试","shouldSpeak":true,"speakContent":"不应被投递的发言","shouldAct":false,"actions":[],"consequenceAssessment":"无","notifyUser":false}';
api.trigger('pre-turn');
captured.intervalFns[0](); // tick → cycle('pre-turn', {})（无 suppressSpeak）
await new Promise((r) => setTimeout(r, 150));
sCheck('pre-turn 经 trigger 触发也不投递发言(notify 无新增)', captured.notifySends.length === notifyBeforeD, `notifySends=${captured.notifySends.length} before=${notifyBeforeD}`);
sCheck('pre-turn 经 trigger 触发也不写 loop-speak 留档', !captured.writes.slice(writesBeforeD).some((w) => w.source === 'loop-speak'));
sCheck('pre-turn 决策仍写回循环日志(留档)', captured.writes.slice(writesBeforeD).some((w) => w.kind === 'thought' && w.source === 'loop'));

// E) 运行中的 pre-turn 循环被新用户消息立即中止（与时间驱动循环同逻辑）：不留记录/不发事件/不更新 lastDecision
SLOW_LLM = true;
const writesBeforeE = captured.writes.length;
const emitsBeforeE = captured.emits.length;
const lastDecisionAtBeforeE = api.state().lastDecisionAt;
const cancelledBeforeE = api.stats().cancelledCount ?? 0;
DECISION_TEXT = '{"analysis":"pre-turn中止测试","shouldSpeak":true,"speakContent":"不应投递","shouldAct":false,"actions":[],"consequenceAssessment":"","notifyUser":false}';
api.trigger('pre-turn');
captured.intervalFns[0](); // tick → cycle('pre-turn')（慢 LLM 停留 thinking）
await new Promise((r) => setTimeout(r, 80));
sCheck('pre-turn 循环运行中(thinking)', api.state().mode === 'thinking', `mode=${api.state().mode}`);
userMsgHandler({ id: 'session-main' }, { type: 'user/message', data: { source: { kind: 'user' }, content: '新消息打断' } });
await new Promise((r) => setTimeout(r, 900));
sCheck('用户消息中止 pre-turn 并恢复 idle', api.state().mode === 'idle', `mode=${api.state().mode}`);
sCheck('pre-turn 中止计数 +1', (api.stats().cancelledCount ?? 0) === cancelledBeforeE + 1, `cancelledCount=${api.stats().cancelledCount}`);
sCheck('被中止 pre-turn 未写记忆记录', captured.writes.length === writesBeforeE, `writes=${captured.writes.length} before=${writesBeforeE}`);
sCheck('被中止 pre-turn 未发事件', captured.emits.length === emitsBeforeE, `emits=${captured.emits.length} before=${emitsBeforeE}`);
sCheck('被中止 pre-turn 未更新 lastDecision', api.state().lastDecisionAt === lastDecisionAtBeforeE, `at=${api.state().lastDecisionAt} before=${lastDecisionAtBeforeE}`);
SLOW_LLM = false;
api.endConversation();

// ──  记忆错乱修复回归：睡眠期跟随真实唤醒信号，TTL 到期≠醒来 ──
// 实机事故链：08:57 置"睡眠中"(TTL 12h→20:57)；09:41 进入睡眠期；20:57 TTL 到期后旧逻辑
// 把"行消失"当"用户醒来" → cooldown → 18:16-22:40 睡眠中被连环主动消息打扰、旧问答串线。
api.configure({ sleepEnterDelayMs: 1000, sleepMaxMs: 60000, sleepCooldownMs: 1000, sleepCheckWindowMs: 60000 });
const origGet2 = memoryApi.state.get;

// F) 睡眠行带短 TTL：进入睡眠期后 TTL 到期（行不再返回）→ 睡眠期保持静默（不解除）
memoryApi.state.get = () => [{ state: '睡眠中', detail: '长睡眠', setAt: Date.now() - 40 * 60000, expiresAt: Date.now() + 1500 }];
api.endConversation();
await api.beforeTurn('TTL测试-进入');
sCheck('TTL 测试：带 TTL 睡眠行正常进入睡眠期', api.state().sleep.phase === 'asleep');
await new Promise((r) => setTimeout(r, 1800)); // 等 TTL 到期（sleepExpirySeen 已记录到期点）
memoryApi.state.get = () => []; // 模拟 TTL 到期：stateGet 只返回未过期行
const cyclesBeforeTtl = api.stats().cycleCount;
api.endConversation();
await api.beforeTurn('TTL测试-到期后');
sCheck('TTL 到期≠醒来：睡眠期保持(cycleCount 不变)', api.state().sleep.phase === 'asleep' && api.stats().cycleCount === cyclesBeforeTtl, JSON.stringify(api.state().sleep));
// G) TTL 到期后用户主动发消息 → 真实唤醒（wakeReason=user），恢复对话/主动能力
userMsgHandler({ id: 'session-main' }, { type: 'user/message', data: { source: { kind: 'user' }, content: '我睡醒了' } });
await new Promise((r) => setTimeout(r, 50));
sCheck('TTL 到期后用户消息 → 真实唤醒(cooldown/user)', api.state().sleep.phase === 'cooldown' && api.state().sleep.wakeReason === 'user', JSON.stringify(api.state().sleep));
// H) 睡眠期中状态被改标为其他状态（在线）→ 视为醒来（woke）
await new Promise((r) => setTimeout(r, 1300)); // 等 1s 冷却期结束，回到 awake 以便再次进入睡眠
memoryApi.state.get = () => [{ state: '睡眠中', detail: '再睡', setAt: Date.now() - 40 * 60000, expiresAt: null }];
api.endConversation();
await api.beforeTurn('改标测试-进入');
sCheck('改标测试：无 TTL 行进入睡眠期', api.state().sleep.phase === 'asleep');
memoryApi.state.get = () => [{ state: '在线', detail: '醒了', setAt: Date.now(), expiresAt: Date.now() + 3600000 }];
api.endConversation();
await api.beforeTurn('改标测试-改标');
sCheck('睡眠期状态改标(在线) → 解除(woke)', api.state().sleep.phase === 'cooldown' && api.state().sleep.wakeReason === 'woke', JSON.stringify(api.state().sleep));
memoryApi.state.get = origGet2;
api.configure({ sleepEnterDelayMs: 1800000, sleepMaxMs: 28800000, sleepCooldownMs: 10800000, sleepCheckWindowMs: 28800000 });
setUserAwake();
checks.push(['睡眠参数恢复默认(回归块后)', api.stats().config.sleepEnterDelayMs === 1800000]);

// ──  时间线/重复推送修复回归：静默窗对**一切**主动发言生效（含事件驱动 state-changed）──
// 实机：00:00:30"当然关心啊"串线推送的 trigger=state-changed（事件驱动，旧逻辑不受 30s 静默窗约束）
api.configure({ quietAfterUserMs: 150, sleepEnterDelayMs: 1800000 });
const notifyBeforeI = captured.notifySends.length;
DECISION_TEXT = '{"analysis":"静默窗发言测试","shouldSpeak":true,"speakContent":"不应在静默窗内投递","shouldAct":false,"actions":[],"consequenceAssessment":"无","notifyUser":false}';
api.endConversation();
userMsgHandler({ id: 'session-main' }, { type: 'user/message', data: { source: { kind: 'user' }, content: '静默窗发言测试' } });
api.trigger('state-changed'); // 事件驱动触发（非时间驱动，检验发言门而非循环门）
captured.intervalFns[0](); // tick → cycle('state-changed')
await new Promise((r) => setTimeout(r, 200));
sCheck('静默窗内事件驱动循环的主动发言被抑制(notify 无新增)', captured.notifySends.length === notifyBeforeI, `notifySends=${captured.notifySends.length}`);
await new Promise((r) => setTimeout(r, 300)); // 等静默窗过期(150ms)
api.endConversation();
api.trigger('state-changed');
captured.intervalFns[0]();
await new Promise((r) => setTimeout(r, 200));
sCheck('静默窗过期后主动发言可投递(notify +1)', captured.notifySends.length === notifyBeforeI + 1, `notify=${captured.notifySends.length} base=${notifyBeforeI} mode=${api.state().mode} quietLeft=${api.state().quietLeftMs} cycleCount=${api.stats().cycleCount}`);
api.configure({ quietAfterUserMs: 180000 });
checks.push(['静默窗参数恢复默认(180s, I 块后)', api.stats().config.quietAfterUserMs === 180000]);

// ──  凭证缺失冷却回归：MISSING_CREDENTIAL 不再 30s 风暴，配置事件唤醒 ──
// 手机端实测：无 API key 时 loop 失败置 dirty → 每 30s tick 重试（error#1..#14 刷屏），
// 每次重试先做 SQLite 召回/简报构造 → 周期性拖慢同机网页打开。修复后进入 5 分钟冷却。
{
  api.configure({ credentialRetryMs: 300000 });
  const cycBefore = api.stats().cycleCount;
  // J) MISSING_CREDENTIAL 失败 → 进入冷却、不置 dirty（风暴停止）
  LLM_THROW = 'MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"';
  api.endConversation(); // 确保 mode=idle，tick 能触发 cycle
  api.trigger('startup');
  captured.intervalFns[0](); // tick → cycle('startup') → LLM 抛凭证缺失
  await new Promise((r) => setTimeout(r, 1200)); // callLlm 内部重试间隔 800ms
  sCheck('凭证缺失进入冷却(cooldownLeftMs>0)', (api.stats().credentialCooldownLeftMs ?? 0) > 0, `left=${api.stats().credentialCooldownLeftMs}`);
  sCheck('凭证缺失未新增循环计数(风暴停止)', api.stats().cycleCount === cycBefore, `cycleCount=${api.stats().cycleCount} before=${cycBefore}`);
  // K) 冷却期内再次 tick → cycle 被冷却跳过（不再重试）
  const errBeforeK = api.stats().errorCount;
  api.trigger('fallback');
  captured.intervalFns[0]();
  await new Promise((r) => setTimeout(r, 120));
  sCheck('冷却期内 tick 不触发循环(errorCount 不变)', api.stats().errorCount === errBeforeK, `errorCount=${api.stats().errorCount} before=${errBeforeK}`);
  // L) 配置写入事件 → 清冷却并恢复（下个 tick 正常跑循环）
  LLM_THROW = '';
  const credHandler = captured.handlers?.['archive/credentials-changed'];
  if (typeof credHandler === 'function') credHandler();
  sCheck('配置事件清除冷却(cooldownLeftMs=0)', (api.stats().credentialCooldownLeftMs ?? 0) === 0, `left=${api.stats().credentialCooldownLeftMs}`);
  api.trigger('credentials-ready');
  captured.intervalFns[0]();
  await new Promise((r) => setTimeout(r, 250));
  sCheck('配置后循环恢复(cycleCount+1)', api.stats().cycleCount === cycBefore + 1, `cycleCount=${api.stats().cycleCount} before=${cycBefore} mode=${api.state().mode} err=${api.stats().errorCount}`);
  checks.push(['凭证冷却参数默认(5 分钟)', api.stats().config.credentialRetryMs === 300000]);
  api.configure({ credentialRetryMs: 300000 });
}

// ──  告知分级/割裂修复回归（实机 03:49"🤖 主动行动：已执行 memory_write"泄露进用户对话）──
// 语义：
//  1) pre-turn（对话前置，用户正在对话）→ 行动照常执行但**零告知**（发言已禁，状态串/notify_send 同禁）；
//  2) user_state_set/user_state_clear/memory_write 为静默内部动作 → 即使 notifyUser=true 也代码强制压制
//     （LLM 语义误用兜底），且不进入"主动行动"流水文案；
//  3) 非对话循环中"主动行动"告知为 panel 级（只进通知栏，绝不进对话）；
//  4) notify_send（AI 撰写的 chat 级消息）在 pre-turn/静默窗内被门控不投递。
// 清理残留静默窗：确保时间驱动触发不被 quiet 拦截（本段触发全部要求窗口已过期）
if ((api.state().quietLeftMs ?? 0) > 0) await new Promise((r) => setTimeout(r, (api.state().quietLeftMs ?? 0) + 200));

// 1) pre-turn + notifyUser=true + memory_write → 动作执行但零告知（03:49 泄露直接回归）
api.endConversation();
const nPreTurnAct = captured.notifySends.length;
DECISION_TEXT = '{"analysis":"对话内动作","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"memory_write","args":{"content":"对话内衔接记忆"},"reason":"衔接上下文"}],"consequenceAssessment":"零打扰完全可逆","notifyUser":true}';
api.trigger('pre-turn');
captured.intervalFns[0](); // tick → cycle('pre-turn')
await new Promise((r) => setTimeout(r, 200));
sCheck('pre-turn 内部动作不产生告知（03:49 泄露回归）', captured.notifySends.length === nPreTurnAct, `notify=${captured.notifySends.length} base=${nPreTurnAct}`);
sCheck('pre-turn 内部动作仍执行(memory_write)', captured.writes.some((w) => w.content === '对话内衔接记忆'));

// 2) 非对话循环 + 纯静默内部动作 + notifyUser=true → 代码强制压制（LLM 语义误用兜底）
api.endConversation();
const nSilent = captured.notifySends.length;
DECISION_TEXT = '{"analysis":"静默内部动作","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"memory_write","args":{"content":"静默记忆B"},"reason":"记录"}],"consequenceAssessment":"可逆无副作用","notifyUser":true}';
api.trigger('fallback');
captured.intervalFns[0]();
await new Promise((r) => setTimeout(r, 200));
sCheck('非对话循环+纯静默内部动作也不告知', captured.notifySends.length === nSilent, `notify=${captured.notifySends.length} base=${nSilent}`);

// 3) 非对话循环 + 非静默动作（外部 deferred）→ panel 级告知：只列非静默动作
api.endConversation();
const nMixed = captured.notifySends.length;
DECISION_TEXT = '{"analysis":"外部动作测试","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"web_search","args":{"queries":["天气"]},"reason":"查天气"},{"name":"user_state_set","args":{"state":"在线"},"reason":"状态"}],"consequenceAssessment":"需要外部信息","notifyUser":true}';
api.trigger('fallback');
captured.intervalFns[0]();
await new Promise((r) => setTimeout(r, 200));
const panelSends = captured.notifySends.slice(nMixed);
sCheck('外部动作经非对话循环 → panel 告知发出', panelSends.length === 1 && panelSends[0].scope === 'panel' && panelSends[0].content.includes('主动行动') && panelSends[0].content.includes('将执行') && panelSends[0].content.includes('web_search'), JSON.stringify(panelSends));
sCheck('panel 告知不含静默内部动作(user_state_set)', panelSends.length === 1 && !panelSends[0].content.includes('user_state_set'));

// 4) notify_send（chat 级）门控：idle 且窗口外 → 投递；pre-turn → 不投递
api.endConversation();
const nNs = captured.notifySends.length;
DECISION_TEXT = '{"analysis":"主动推送","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"notify_send","args":{"content":"主动推送内容"},"reason":"推送"}],"consequenceAssessment":"用户值得看到","notifyUser":false}';
api.trigger('state-changed');
captured.intervalFns[0]();
await new Promise((r) => setTimeout(r, 200));
const nsSends = captured.notifySends.slice(nNs);
sCheck('notify_send idle 窗口外投递(scope=chat)', nsSends.length === 1 && nsSends[0].scope === 'chat' && nsSends[0].content === '主动推送内容', JSON.stringify(nsSends));
api.endConversation();
const nNs2 = captured.notifySends.length;
DECISION_TEXT = '{"analysis":"对话中推送","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"notify_send","args":{"content":"对话中不该投"},"reason":"推送"}],"consequenceAssessment":"x","notifyUser":false}';
api.trigger('pre-turn');
captured.intervalFns[0]();
await new Promise((r) => setTimeout(r, 200));
sCheck('notify_send 在 pre-turn 被门控(不投递)', captured.notifySends.length === nNs2, `notify=${captured.notifySends.length} base=${nNs2}`);

// ──  双 Agent（记忆加工 + 输出审查）回归 ──
{
  api.configure({ dualAgent: true, quietAfterUserMs: 60 });
  api.endConversation();
  streamTags.length = 0;
  DECISION_TEXT = '{"analysis":"双Agent测试","shouldSpeak":false,"shouldAct":false,"actions":[],"consequenceAssessment":"无","notifyUser":false}';
  const daTurn = await api.beforeTurn('双Agent测试输入');
  checks.push(['双Agent 开启：记忆概括+决策均被调用', streamTags.includes('memory-analyzer') && streamTags.includes('decision'), `tags=${streamTags.join(',')}`]);
  checks.push(['双Agent 开启：简报含概括块且无原始 <memories>', lastBrief.includes('<memory-summary-block>') && !lastBrief.includes('<memories>'), `hasBlock=${lastBrief.includes('<memory-summary-block>')}`]);
  checks.push(['双Agent 开启：决策仍正常产出', daTurn?.decision?.analysis === '双Agent测试']);
  checks.push(['双Agent 开启：正文输出自检已注入', captured.contexts.some((c) => c.name === 'output-selfcheck' && typeof c.text === 'function' && String(c.text() ?? '').length > 0)]);
  // 审查 revise：主动发言被更正后投递
  api.endConversation();
  streamTags.length = 0;
  REVIEW_RESP = '{"verdict":"revise","correctedSpeak":"更正后的发言","blockedActions":[],"reason":"修正语气"}';
  DECISION_TEXT = '{"analysis":"审查测试","shouldSpeak":true,"speakContent":"原发言","shouldAct":false,"actions":[],"consequenceAssessment":"无","notifyUser":false}';
  const ns0 = captured.notifySends.length;
  api.trigger('fallback');
  captured.intervalFns[0]();
  await new Promise((r) => setTimeout(r, 300));
  checks.push(['双Agent 审查：revise 后投递更正内容', streamTags.includes('reviewer') && captured.notifySends.slice(ns0).some((n) => n.content === '更正后的发言'), `notify=${JSON.stringify(captured.notifySends.slice(ns0).map((n) => n.content))}`]);
  // 审查 cancel：发言被取消不投递
  api.endConversation();
  streamTags.length = 0;
  REVIEW_RESP = '{"verdict":"cancel","correctedSpeak":"","blockedActions":[],"reason":"与对话重复"}';
  DECISION_TEXT = '{"analysis":"审查取消测试","shouldSpeak":true,"speakContent":"将被取消的发言","shouldAct":false,"actions":[],"consequenceAssessment":"无","notifyUser":false}';
  const ns1 = captured.notifySends.length;
  api.trigger('fallback');
  captured.intervalFns[0]();
  await new Promise((r) => setTimeout(r, 300));
  checks.push(['双Agent 审查：cancel 不投递', captured.notifySends.length === ns1, `notify=${captured.notifySends.length} base=${ns1}`]);
  REVIEW_RESP = '{"verdict":"ok","correctedSpeak":"","blockedActions":[],"reason":""}';
  // 关：恢复单 Agent（不再出现记忆分析师调用）
  api.configure({ dualAgent: false, quietAfterUserMs: 150 });
  api.endConversation();
  streamTags.length = 0;
  await api.beforeTurn('关闭后测试');
  checks.push(['双Agent 关闭：仅单次决策调用', !streamTags.includes('memory-analyzer') && streamTags.includes('decision'), `tags=${streamTags.join(',')}`]);
  checks.push(['双Agent 关闭：正文自检不注入', !captured.contexts.some((c) => c.name === 'output-selfcheck' && typeof c.text === 'function' && String(c.text() ?? '').length > 0)]);
  checks.push(['双Agent 关闭参数生效', api.stats().config.dualAgent === false]);
}

// ──  思维预设（用户指令注入；决策+审查+对话自检；适配双 Agent）回归 ──
{
  api.configure({ quietAfterUserMs: 120, dualAgent: false });
  // 1) 零配置 = 零注入（默认无预设/无条目 → 简报不含 <user-instructions>）
  api.instructions.save({ presets: [], activePresetId: '', entries: [], injectCapChars: 1200 });
  api.endConversation();
  await api.beforeTurn('零配置测试输入');
  checks.push(['思维预设：零配置简报不含注入块', !lastDecisionBrief.includes('<user-instructions>')]);
  // 2) 常驻 + 关键词命中（userInput 命中）
  api.endConversation();
  api.instructions.save({
    presets: [{ id: 'p1', name: '测试预设' }], activePresetId: 'p1', injectCapChars: 1200,
    entries: [
      { id: 'e1', presetId: 'p1', name: '简洁', mode: 'always', scope: 'loop', text: '主动发言必须简洁有力', enabled: true, order: 1 },
      { id: 'e2', presetId: 'p1', name: '外卖话题', mode: 'keys', keys: ['外卖'], scope: 'loop', text: '涉及外卖话题时给出具体建议', enabled: true, order: 2 },
    ],
  });
  api.endConversation();
  await api.beforeTurn('今天点什么外卖好');
  checks.push(['思维预设：简报注入 <user-instructions>', lastDecisionBrief.includes('<user-instructions>')]);
  checks.push(['思维预设：常驻指令注入', lastDecisionBrief.includes('主动发言必须简洁有力')]);
  checks.push(['思维预设：关键词命中注入', lastDecisionBrief.includes('涉及外卖话题时给出具体建议')]);
  // 3) 关键词不命中 → 不注入该条（常驻仍在）
  api.endConversation();
  await api.beforeTurn('今天天气怎么样');
  checks.push(['思维预设：关键词不命中不注入', lastDecisionBrief.includes('主动发言必须简洁有力') && !lastDecisionBrief.includes('涉及外卖话题时给出具体建议')]);
  // 4) 预算截断：预算极小 → 首条仍注入、超限停止
  api.endConversation();
  api.instructions.save({
    presets: [{ id: 'p1', name: '测试预设' }], activePresetId: 'p1', injectCapChars: 200,
    entries: [
      { id: 'c1', presetId: 'p1', name: '长指令一', mode: 'always', scope: 'loop', text: '这是一条很长的常驻指令内容，用于验证预算护栏下首条仍注入的语义是否成立', enabled: true, order: 1 },
      { id: 'c2', presetId: 'p1', name: '长指令二', mode: 'always', scope: 'loop', text: '这是第二条同样很长的常驻指令内容，故意写得足够长以超出剩余预算，从而验证预算满时停止注入的行为正确，多余文字继续补足以保证长度超出护栏，仅当预算不足时该条被截断不注入。此处继续补充更多的文字，把本条总长进一步拉开，确保它与首条之和必然超过两百字符的预算上限，从而验证超限即停止的护栏语义。', enabled: true, order: 2 },
    ],
  });
  api.endConversation();
  await api.beforeTurn('预算截断测试');
  checks.push(['思维预设：预算护栏首条注入', lastDecisionBrief.includes('这是一条很长的常驻指令')]);
  checks.push(['思维预设：预算护栏超限停止', !lastDecisionBrief.includes('这是第二条同样很长')]);
  // 5) 双 Agent + 预设：决策简报含概括块与指令块；审查材料附用户指令（约束力）
  api.configure({ dualAgent: true });
  api.endConversation();
  if ((api.state().quietLeftMs ?? 0) > 0) await new Promise((r) => setTimeout(r, (api.state().quietLeftMs ?? 0) + 60));
  api.instructions.save({
    presets: [{ id: 'p1', name: '测试预设' }], activePresetId: 'p1', injectCapChars: 1200,
    entries: [{ id: 'd1', presetId: 'p1', name: '禁外部动作', mode: 'always', scope: 'loop', text: '禁止执行 web_search 类外部动作', enabled: true, order: 1 }],
  });
  streamTags.length = 0; lastReviewUser = ''; lastDecisionBrief = '';
  REVIEW_RESP = '{"verdict":"ok","correctedSpeak":"","blockedActions":[],"reason":""}';
  DECISION_TEXT = '{"analysis":"双Agent预设","shouldSpeak":false,"shouldAct":true,"actions":[{"name":"memory_write","args":{"content":"预设测试记忆"},"reason":"测试"}],"consequenceAssessment":"可逆内部记录","notifyUser":false}';
  api.trigger('fallback');
  captured.intervalFns[0]();
  await new Promise((r) => setTimeout(r, 400));
  checks.push(['双Agent+预设：决策简报含概括块与指令块', lastDecisionBrief.includes('<memory-summary-block>') && lastDecisionBrief.includes('<user-instructions>') && lastDecisionBrief.includes('禁止执行 web_search 类外部动作')]);
  checks.push(['双Agent+预设：审查材料附用户指令', lastReviewUser.includes('禁止执行 web_search 类外部动作'), `review=${String(lastReviewUser).slice(0, 140)}`]);
  // 6) dialogue 作用域：dualAgent 开启时对话自检附加 dialogue 指令；dialogue 专用条目不进决策简报
  api.instructions.save({
    presets: [{ id: 'p1', name: '测试预设' }], activePresetId: 'p1', injectCapChars: 1200,
    entries: [{ id: 'g1', presetId: 'p1', name: '温柔', mode: 'always', scope: 'dialogue', text: '对话回复保持温柔自然的语气', enabled: true, order: 1 }],
  });
  const selfCheckCtx = captured.contexts.find((c) => c.name === 'output-selfcheck');
  checks.push(['思维预设：对话自检含 dialogue 指令（双 Agent 开）', typeof selfCheckCtx?.text === 'function' && String(selfCheckCtx.text() ?? '').includes('对话回复保持温柔自然的语气')]);
  api.endConversation();
  await api.beforeTurn('对话专用测试');
  checks.push(['思维预设：dialogue 专用条目不进决策简报', !lastDecisionBrief.includes('对话回复保持温柔自然的语气')]);
  // 清理：恢复单 Agent、空预设、静默窗参数
  api.configure({ dualAgent: false, quietAfterUserMs: 150 });
  api.instructions.save({ presets: [], activePresetId: '', entries: [], injectCapChars: 1200 });
  api.endConversation();
  await api.beforeTurn('清理验证');
  checks.push(['思维预设：清理后零注入', !lastDecisionBrief.includes('<user-instructions>')]);
  // 7)  守卫：dialogue 自检注入须按 activePresetId 过滤——
  //    ①未启用任何预设（activePresetId=''）时历史保存过的 dialogue 指令不得注入对话自检（零注入承诺）；
  //    ②激活 A 预设时 B 预设的 dialogue 指令不得注入（单活跃预设语义）。
  api.configure({ dualAgent: true });
  api.instructions.save({
    presets: [{ id: 'pa', name: '预设A' }, { id: 'pb', name: '预设B' }], activePresetId: '', injectCapChars: 1200,
    entries: [{ id: 'xb', presetId: 'pb', name: 'B的文言文', mode: 'always', scope: 'dialogue', text: 'B要求文言文回复', enabled: true, order: 1 }],
  });
  const ctxOff = captured.contexts.find((c) => c.name === 'output-selfcheck');
  checks.push(['思维预设：未启用预设时 dialogue 不入自检', typeof ctxOff?.text === 'function' && !String(ctxOff.text() ?? '').includes('B要求文言文回复')]);
  api.instructions.save({
    presets: [{ id: 'pa', name: '预设A' }, { id: 'pb', name: '预设B' }], activePresetId: 'pa', injectCapChars: 1200,
    entries: [
      { id: 'xa', presetId: 'pa', name: 'A的简洁', mode: 'always', scope: 'dialogue', text: 'A要求简洁回复', enabled: true, order: 1 },
      { id: 'xb', presetId: 'pb', name: 'B的文言文', mode: 'always', scope: 'dialogue', text: 'B要求文言文回复', enabled: true, order: 2 },
    ],
  });
  const ctxA = captured.contexts.find((c) => c.name === 'output-selfcheck');
  const ctxAText = (typeof ctxA?.text === 'function' ? String(ctxA.text() ?? '') : '');
  checks.push(['思维预设：激活A时仅A的 dialogue 入自检', ctxAText.includes('A要求简洁回复') && !ctxAText.includes('B要求文言文回复')]);
  // 还原：单 Agent + 空预设
  api.configure({ dualAgent: false });
  api.instructions.save({ presets: [], activePresetId: '', entries: [], injectCapChars: 1200 });
}

for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
console.log('--- 启动行 ---');
console.log(stdout.split('\n').filter((l) => l.includes('[archive-loop]')).join('\n'));
rmSync(dbPath, { force: true });
for (const s of ['-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
