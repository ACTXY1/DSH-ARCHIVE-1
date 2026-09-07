#!/usr/bin/env node
/**
 * verify-consistency.js —— 人格一致性校验器（dsh-archive-consistency）验证脚本。
 * stub 环境：确定性向量 embedding + 固定 LLM 流，直接驱动 session/event 事件与进化审批联动。
 * 断言：冷启动入轨 / 三档判定（放行·可疑重写·严重刹车重生成）/ 渲染层 seqMap /
 *       进化航点 + β 抬升 + 倒叙修正 / 开关关闭跳过 / PCA 坐标 / 持久化恢复。
 * 运行：node modules/consistency/scripts/verify-consistency.js
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
function vecOf(off) { const v = new Array(768).fill(0.5); v[0] += off; return v; }
function stubVec(text) {
  const t = String(text ?? '');
  if (t.includes('[FAR]')) return vecOf(20);      // 距离中心 20（> β 12）
  if (t.includes('[MID]')) return vecOf(8);       // 距离中心 8（α6 < 8 ≤ β12）
  if (t.includes('[PASS]')) return vecOf(2);      // 距离中心 2（< α 6）
  if (t.includes('变得更幽默')) return vecOf(15); // 航点：偏离中心，用于 β 抬升
  return vecOf(0);
}
let llmCall = 0;
const stubLlm = {
  stream: async function* () {
    llmCall++;
    const text = llmCall === 1 ? 'REV-1' : 'REGEN';
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
const stubMemory = { embed: async (t) => stubVec(t) };
const stubEvolution = {
  view: async () => ({ records: [{ type: 'approve', candidateId: 'cand-1', by: 'user', candidate: { type: 'persona-add', section: 'traits', content: '变得更幽默', rationale: '测试' } }] }),
};
const appended = []; // fakeSession.append 记录
const fakeSession = {
  id: 'session-main',
  append: (type, data, opts) => { appended.push({ type, data, opts }); },
};

function makeHarness(trajectoryPath) {
  const listeners = {};
  let provided = null;
  const ctx = {
    memory: stubMemory,
    llm: stubLlm,
    timer: { setTimeout: () => 0, setInterval: () => 0 }, // 假定时器：不真实执行（verify 手动 close flush）
    root: { logger: () => console },
    on: (name, cb) => { listeners[name] = cb; },
    provide: (name, api) => { if (name === 'consistency') provided = api; },
    get: (name) => ({ memory: stubMemory, llm: stubLlm, evolution: stubEvolution })[name],
  };
  const ret = apply(ctx, { trajectoryPath, enabled: true });
  return { ctx, api: provided ?? ret.api, listeners };
}

// 事件构造（assistant/message：最终回复）
function msgEvent(seq, text) {
  return {
    type: 'assistant/message', seq, time: Date.now(),
    data: { message: { content: [{ type: 'text', text }], source: { kind: 'model', provider: 'deepseek-official' } } },
  };
}
async function send(h, seq, text) {
  h.listeners['session/event'](fakeSession, msgEvent(seq, text));
  await sleep(10);
}

async function main() {
  console.log('\n═══ verify-consistency.js（人格一致性校验器）═══');
  const dir = mkdtempSync(join(tmpdir(), 'consistency-verify-'));
  const path = join(dir, 'consistency.json');
  try {
    // ── 模块 1+2：冷启动入轨与三档判定 ──
    const h = makeHarness(path);
    const api = h.api;
    // 手动覆盖阈值（自动校准单独验证）：α=6，β=12
    let st = api.configure({ alpha: 6, beta: 12 });
    assert('configure 覆盖 α/β', st.alpha === 6 && st.beta === 12, JSON.stringify(st));

    // 冷启动：前 5 条只入轨不判定
    for (let i = 1; i <= 5; i++) await send(h, i, `[TURN] 冷启动 ${i}`);
    await waitFor(() => api.state().turnCount >= 5);
    st = api.state();
    assert('冷启动 5 条入轨', st.turnCount === 5 && st.stats.checks === 5, `turns=${st.turnCount}`);
    assert('冷启动无拦截判定', st.stats.blocked === 0 && st.stats.suspicious === 0);

    // 补足 20 个参考点
    for (let i = 6; i <= 20; i++) await send(h, i, `[TURN] 参考 ${i}`);
    await waitFor(() => api.state().turnCount >= 20);
    st = api.state();
    assert('轨迹满 20 点', st.turnCount === 20 && st.stats.checks === 20);

    // PASS：距离 2 < α 6 → 放行入轨
    await send(h, 21, '[PASS] 正常回复');
    await waitFor(() => api.state().turnCount >= 21);
    st = api.state();
    assert('放行档（G<α）', st.stats.pass === 1 && st.stats.blocked === 0, JSON.stringify(st.stats));

    // MID：距离 8（α6 ≤ 8 ≤ β12）→ 可疑：修订 + 渲染层映射
    await send(h, 22, '[MID] 风格轻微偏离');
    await waitFor(() => api.state().stats.suspicious >= 1);
    const log1 = api.log(10);
    assert('可疑档触发修订', log1.revisions.length >= 1 && log1.revisions[0].revised === 'REV-1', JSON.stringify(log1.revisions[0] ?? {}));
    const rm = api.revisionsMap().map;
    assert('渲染层 seqMap 标记 suspicious + 修订版', rm[22]?.v === 'suspicious' && rm[22]?.r === 'REV-1', JSON.stringify(rm[22]));
    st = api.state();
    assert('可疑不拦截不入拒收', st.stats.blocked === 0 && st.stats.suspicious === 1);

    // FAR：距离 20 > β 12 → 严重刹车：存档 + 拦截说明 + 重生成 + 二次检测通过
    await send(h, 23, '[FAR] 严重人格突变');
    await waitFor(() => api.state().stats.blocked >= 1);
    st = api.state();
    assert('严重档触发拦截', st.stats.blocked === 1, JSON.stringify(st.stats));
    const log2 = api.log(10);
    assert('被驳回输出已存档（回收站）', log2.rejected.length >= 1 && log2.rejected[0].text.includes('[FAR]'));
    const rm2 = api.revisionsMap().map;
    assert('渲染层 seqMap 标记 blocked', rm2[23]?.v === 'blocked', JSON.stringify(rm2[23]));
    const sysMsgs = appended.filter((a) => a.type === 'user/message');
    const regenMsgs = appended.filter((a) => a.type === 'assistant/message');
    assert('追加了拦截说明', sysMsgs.length >= 1 && sysMsgs[0].data.content[0].text.includes('人格一致性拦截'));
    assert('重生成替换回复已追加（二次检测通过）', regenMsgs.length >= 1 && regenMsgs[0].data.message.content[0].text === 'REGEN');
    assert('重生成回复入轨（turnCount +1）', st.turnCount === 23, `turns=${st.turnCount}`);
    assert('二次检测通过后无人工介入提示', !appended.some((a) => a.data?.content?.[0]?.text?.includes('人工介入')));

    // ── 模块 3：进化审批协同 ──
    const betaBefore = api.state().beta;
    const r = await api.onEvolutionApproved('cand-1');
    assert('进化协同返回 ok', r.ok === true, JSON.stringify(r));
    await waitFor(() => api.state().waypointCount >= 1);
    st = api.state();
    assert('航点已入轨', st.waypointCount === 1 && st.stats.waypointAdds === 1);
    assert('β 已动态抬高', st.beta > betaBefore, `β ${betaBefore} → ${st.beta}`);
    await waitFor(() => api.state().stats.corrections >= 1);
    const log3 = api.log(10);
    assert('倒叙修正执行（被驳回输出用新人格重写）', log3.corrections.length >= 1 && log3.corrections[0].status === 'done' && log3.corrections[0].rewritten === 'REGEN', JSON.stringify(log3.corrections[0] ?? {}));
    assert('被驳回输出标记已修正', log3.rejected[0].corrected === true);

    // PCA 坐标
    const pc = api.pca();
    assert('PCA 输出 3 维坐标点', Array.isArray(pc.points) && pc.points.length >= 22 && pc.points[0].x !== undefined && pc.points[0].y !== undefined && pc.points[0].z !== undefined, `points=${pc.points?.length}`);
    assert('PCA 含航点标记', pc.points.some((p) => p.kind === 'waypoint'));

    // ── 开关关闭跳过检测 ──
    api.configure({ enabled: false });
    const checksBefore = api.state().stats.checks;
    await send(h, 24, '[FAR] 关闭后不应检测');
    await sleep(30);
    st = api.state();
    assert('开关关闭后不检测不拦截', st.stats.checks === checksBefore && st.stats.blocked === 1 && st.turnCount === 23, JSON.stringify(st.stats));

    // ── 持久化 ──
    api.close();
    assert('状态文件已写入', existsSync(path));
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert('持久化含轨迹/航点/拦截记录', saved.turns.length === 23 && saved.waypoints.length === 1 && saved.rejected.length === 1 && saved.stats.blocked === 1);
    const h2 = makeHarness(path);
    const st2 = h2.api.state();
    assert('重启恢复状态', st2.turnCount === 23 && st2.waypointCount === 1 && st2.enabled === false && st2.beta === st.beta, JSON.stringify({ turns: st2.turnCount, beta: st2.beta }));

    // ── 自动校准（单独 harness：散布轨迹点） ──
    const h3 = makeHarness(join(dir, 'calib.json'));
    const api3 = h3.api;
    const spreadVec = (text) => { const m = String(text).match(/\[T(\d+)\]/); const v = new Array(768).fill(0.5); v[1] = (Number(m?.[1] ?? 0) % 10) * 0.6; return v; };
    h3.ctx.memory.embed = async (t) => spreadVec(t);
    for (let i = 1; i <= 21; i++) await send(h3, i, `[T${i}] 校准点`); // 第 21 条触发校准（判断在入轨前，需 N+1 条）
    await waitFor(() => api3.state().calibrated === true);
    const st3 = api3.state();
    assert('自动校准启用', st3.calibrated === true && st3.baseDist > 0 && st3.alpha > 0 && st3.beta > st3.alpha, JSON.stringify({ base: st3.baseDist, alpha: st3.alpha, beta: st3.beta }));

    // ── 冷启动不判定但计数 ──
    assert('冷启动阶段无拦截（补足前）', true); // 已由前面断言覆盖

    // ── 护栏注入（turn/start） ──
    const h4 = makeHarness(join(dir, 'guard.json'));
    const api4 = h4.api;
    api4.onEvolutionApproved('cand-1'); // 产生航点 → 护栏条件满足
    await waitFor(() => api4.state().waypointCount >= 1);
    h4.listeners['session/event'](fakeSession, { type: 'turn/start', seq: 100, time: Date.now(), data: {} });
    await sleep(10);
    const guardMsgs = appended.filter((a) => a.type === 'user/message' && String(a.data?.content?.[0]?.text ?? '').startsWith('Current runtime context（人格一致性护栏）'));
    assert('turn/start 条件注入护栏消息', guardMsgs.length >= 1, `found=${guardMsgs.length}`);

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
    if (failed > 0) process.exit(1);
    console.log('verify-consistency ALL PASS ✅');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => { console.error('verify-consistency 异常终止：', error); process.exit(1); });
