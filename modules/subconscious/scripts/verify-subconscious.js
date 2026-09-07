#!/usr/bin/env node
/**
 * verify-subconscious.js —— 潜意识系统（梦境引擎）验证脚本。
 * stub 环境：确定性向量 embedding + 固定 LLM 队列 + stub evolution/consistency，直接驱动
 * 梦境引擎（凝缩→碰撞→调度）与呓语回放（相关性注入）与 Phi 模型管理。
 * 运行：node modules/subconscious/scripts/verify-subconscious.js
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { apply } from '../lib/index.js';

let passed = 0; let failed = 0;
function assert(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? `  （${extra}）` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor 超时');
    await sleep(20);
  }
}

// ── stub 环境 ──
/** 文本 → 64 维独热向量（同文本同向量；hash 未知文本到唯一维度）。 */
function vecKey(text) {
  const t = String(text ?? '');
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 64;
  return h;
}
function vecOf(k) { const v = new Array(64).fill(0); v[k] = 1; return v; }
const captured = { mems: [], evoRecords: [], imports: [], autoApplied: [], sessionAppends: [], listeners: {} };
let llmQueue = [];
const stubLlm = {
  stream: async function* () {
    const t = llmQueue.shift() ?? '默认';
    yield { type: 'text-delta', text: t };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
const stubMemory = {
  list: () => captured.mems,
  embed: async (input) => {
    if (Array.isArray(input)) return input.map((t) => vecOf(vecKey(t)));
    return vecOf(vecKey(input));
  },
};
const stubEvolution = {
  view: async () => ({ records: captured.evoRecords }),
  importCandidate: (candidate, by) => { captured.imports.push({ candidate, by }); return { candidateId: `dream-${captured.imports.length}` }; },
  autoApply: async (id) => { captured.autoApplied.push(id); return { applied: true, status: 'applied' }; },
};
const stubConsistency = { trajectoryText: () => ['近期对话要点 1', '近期对话要点 2'] };
const fakeSession = {
  id: 'session-main',
  append: (type, data, opts) => { captured.sessionAppends.push({ type, data, opts }); },
};

function makeHarness(dataPath) {
  let provided = null;
  const ctx = {
    memory: stubMemory,
    llm: stubLlm,
    timer: { setTimeout: () => 0, setInterval: () => 0 },
    root: { logger: () => console },
    on: (name, cb) => { (captured.listeners[name] ??= []).push(cb); },
    provide: (name, api) => { if (name === 'subconscious') provided = api; },
    get: (name) => ({ evolution: stubEvolution, consistency: stubConsistency, settings: undefined, notify: undefined })[name],
  };
  const ret = apply(ctx, {
    dataPath, enabled: true, condenseModel: 'deepseek', llmModel: 'deepseek',
    highFreqMin: 3, condenseTopK: 5, collidePairs: 2, clusterSim: 0.75, cosUnrelated: 0.3,
    selfConsistencyHigh: 80, noveltyHigh: 60, selfConsistencyAuto: 95, gradientSim: 0.85,
    autoApply: false, whisperSim: 0.55, ollamaBaseUrl: 'http://stub:11434',
  });
  return { api: provided ?? ret.api };
}

async function main() {
  console.log('\n═══ verify-subconscious.js（潜意识系统·梦境引擎）═══');
  const dir = mkdtempSync(join(tmpdir(), 'subconscious-verify-'));
  const path = join(dir, 'subconscious.json');
  // Phi 模型管理 fetch stub
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url ?? '');
    if (u.includes('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'phi3:mini', size: 2075 * 1048576 }] }) };
    if (u.includes('/api/delete')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const { api } = makeHarness(path);

    // ── ① 记忆脱粒机（凝缩） ──
    const now = Date.now();
    captured.mems = [
      // 高频同主题（第 1 组：压力/咖啡）
      { content: '咖啡苦', accessCount: 5, lastAccessAt: now - 3600e3, forgotten: 0 },
      { content: '今天加班', accessCount: 5, lastAccessAt: now - 7200e3, forgotten: 0 },
      { content: '心跳加速', accessCount: 4, lastAccessAt: now - 10800e3, forgotten: 0 },
      // 高频独立主题（第 2、3 组）
      { content: '被拒绝', accessCount: 4, lastAccessAt: now - 1800e3, forgotten: 0 },
      { content: 'debug成功', accessCount: 6, lastAccessAt: now - 900e3, forgotten: 0 },
      // 应排除：访问次数不足 / 最近 24h 外 / 已遗忘
      { content: '低频记忆', accessCount: 1, lastAccessAt: now - 3600e3, forgotten: 0 },
      { content: '老记忆', accessCount: 9, lastAccessAt: now - 30 * 3600e3, forgotten: 0 },
      { content: '已遗忘', accessCount: 9, lastAccessAt: now - 3600e3, forgotten: 1 },
    ];
    // 凝缩 3 组：组1 压力 → "压力唤醒状态"；组2 → "社交挫败"；组3 → "调试成就感"
    llmQueue = ['压力唤醒状态', '社交挫败', '调试成就感'];
    const r1 = await api.run();
    await waitFor(() => api.state().poolCount >= 3);
    let st = api.state();
    assert('高频筛选+聚类凝缩 3 条原型入池', st.poolCount === 3 && r1?.ok !== false, JSON.stringify({ pool: st.poolCount, runs: st.stats.runs }));
    assert('低频/老记忆/已遗忘不产生凝缩', st.stats.condensed === 3, `condensed=${st.stats.condensed}`);

    // ── ②③ 碰撞 + 置信度调度 ──
    // 池内 3 条两两余弦≈0（不相关）→ 可碰撞；清空高频记忆避免重复凝缩（LLM 队列只供碰撞）
    captured.mems = [];
    // 草案自洽 85 ≥80 且新颖 100 ≥60 → 高优先级导入
    captured.evoRecords = [{ type: 'suggest', candidate: { content: '变得更幽默' } }]; // 已有进化建议（新颖度参照）
    llmQueue = [JSON.stringify({ draft: { type: 'persona-add', section: 'traits', content: '将社交误解视为可调试的逻辑漏洞', rationale: '碰撞灵感' }, selfConsistency: 85 })];
    const r2 = await api.run();
    await waitFor(() => api.state().draftCount >= 1);
    st = api.state();
    assert('碰撞生成草案并调度', st.stats.collisions >= 1 && st.draftCount >= 1, JSON.stringify(st.stats));
    assert('自洽≥80 且新颖≥60 → 待审批队列（高优先级导入 by=dream）', captured.imports.length >= 1 && captured.imports[0].by === 'dream', JSON.stringify(captured.imports[0] ?? null));
    const log1 = api.log(10);
    const draft = log1.drafts[0];
    assert('草案自洽/新颖度记录', draft?.selfConsistency === 85 && draft?.novelty >= 60, JSON.stringify(draft));
    assert('autoApply 默认关 → 不自动执行', captured.autoApplied.length === 0);

    // ── 自动微调（开启 + 自洽>95 + 梯度一致） ──
    api.configure({ autoApply: true });
    // 最近已采纳建议与草案同文本 → 向量一致（梯度方向一致；stub embed 同文本同向量）
    captured.evoRecords = [
      { type: 'suggest', candidate: { content: '将社交误解视为可调试的逻辑漏洞' } },
      { type: 'approve', candidate: { content: '将社交误解视为可调试的逻辑漏洞' } },
    ];
    llmQueue = [JSON.stringify({ draft: { type: 'persona-add', section: 'directives', content: '将社交误解视为可调试的逻辑漏洞', rationale: '碰撞灵感二' }, selfConsistency: 96 })];
    await api.run();
    await waitFor(() => captured.autoApplied.length >= 1);
    assert('自洽>95 且梯度一致且开启 → 自动微调执行', captured.autoApplied.length >= 1 && api.state().stats.autoApplied >= 1, JSON.stringify(captured.autoApplied));
    // 新草案 novelty 应低（与已采纳建议相似 → 1-cos 小）——但仍走高优先级（自洽 85 场景已测）

    // ── ④ 梦境回放 ──
    llmQueue = ['昨夜我梦见将挫折编译成了变量'];
    const w = await api._whisper('woke');
    st = api.state();
    assert('苏醒生成梦境呓语', w.ok === true && st.whisper?.text === '昨夜我梦见将挫折编译成了变量' && st.stats.whispers === 1, JSON.stringify(st.whisper));
    // 不相关话题 → 不注入
    const emit = (name, payload) => { for (const cb of captured.listeners[name] ?? []) cb(fakeSession, payload); };
    const sendUserMsg = (text) => emit('session/event', { type: 'user/message', time: Date.now(), data: { content: [{ type: 'text', text }], source: { kind: 'user' } } });
    const sendTurnStart = () => emit('session/event', { type: 'turn/start', time: Date.now(), data: {} });
    sendUserMsg('今天天气不错');
    sendTurnStart();
    await sleep(50);
    assert('话题不相关 → 不注入呓语', api.state().stats.injects === 0 && !captured.sessionAppends.some((a) => a.data?.content?.[0]?.text?.includes('潜意识呓语')));
    // 相关话题（与呓语同主题向量；stub embed 同文本同向量）→ 注入一次
    sendUserMsg('昨夜我梦见将挫折编译成了变量');
    sendTurnStart();
    await waitFor(() => api.state().stats.injects >= 1);
    assert('话题相关 → 隐式注入呓语（不上屏前缀）', captured.sessionAppends.some((a) => String(a.data?.content?.[0]?.text ?? '').startsWith('Current runtime context（潜意识呓语）')));
    assert('呓语注入后标记已消费（不再重复注入）', api.state().whisper?.consumed === true);
    const injectsBefore = api.state().stats.injects;
    sendUserMsg('又聊挫折');
    sendTurnStart();
    await sleep(50);
    assert('已消费呓语不再注入', api.state().stats.injects === injectsBefore);

    // ── Phi 模型管理（stub fetch） ──
    const md = await api.model();
    assert('Phi-3:mini 模型状态检测', md.installed === true && md.name === 'phi3:mini' && md.sizeMb > 0, JSON.stringify(md));
    const mr = await api.modelRemove();
    assert('Phi-3:mini 删除', mr.removed === true, JSON.stringify(mr));

    // ── 睡眠期事件触发（archive/sleep-phase asleep → 梦境引擎） ──
    const runsBefore = api.state().stats.runs;
    for (const cb of captured.listeners['archive/sleep-phase'] ?? []) cb({ phase: 'asleep', at: Date.now() });
    await waitFor(() => api.state().stats.runs > runsBefore);
    assert('睡眠期进入事件自动触发梦境引擎', api.state().stats.runs > runsBefore);

    // ── 持久化 ──
    api.close();
    assert('状态文件已写入', existsSync(path));
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert('持久化含潜记忆池/草案/呓语', saved.pool.length >= 3 && saved.drafts.length >= 2 && saved.whisper?.text.length > 0);
    const h2 = makeHarness(path);
    const st2 = h2.api.state();
    assert('重启恢复状态', st2.poolCount >= 3 && st2.whisper?.text === '昨夜我梦见将挫折编译成了变量', JSON.stringify({ pool: st2.poolCount, whisper: st2.whisper?.text }));

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
    if (failed > 0) process.exit(1);
    console.log('verify-subconscious ALL PASS ✅');
  } finally {
    globalThis.fetch = origFetch;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => { console.error('verify-subconscious 异常终止：', error); process.exit(1); });
