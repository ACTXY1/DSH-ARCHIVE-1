/**
 * dsh-archive-consistency —— 人格一致性校验器（动态轨迹校验器）。
 *
 * 需求（用户 ）：对比"人格发展轨迹"，防止 AI 角色偏离过大；满足功能前提下
 * 尽量减少额外消耗的时间；总控界面必须有开关。三个串行模块：
 *
 *  1. 轨迹编码器（离线维护）：维护滑动窗口人格矩阵——最近 100 轮交互 + 最近 5 条已审批
 *     进化建议的 768 维向量；每轮对话后经 ollama（复用 ctx.memory.embed，与记忆同源）
 *     提取该轮"人格状态"向量入环形缓冲区；用 PCA 压缩为 3 维主成分坐标点（按需计算）。
 *  2. 突变梯度检测器（实时拦截）：回复落库后取该回复向量 V_new，与轨迹最近 20 个点
 *     的平均欧氏距离 = 突变梯度 G：G<α 放行 / α≤G≤β 局部重写（修订版经 UI 渲染层替换
 *     显示）/ G>β 强制刹车（存档 + 追加拦截说明 + 按近期待办进化方向重生成 + 二次检测，
 *     仍超标则停止并通知人工介入）。
 *  3. 进化溯源验证器（审批协同）：审批通过 → 建议向量作"航点"入轨 + 动态抬高阈值 β +
 *     把最近 3 条被驳回输出用新人格重写（人格倒叙修正，异步低优先级）。
 *
 * 拦截时机说明（ 查证 dsh-agent-loop 源码）：DSH 原生流程无"输出前"钩子，
 * 回复由 session.append("assistant/message") 流式结束后直接落库（dsh-session 亦无消息
 * 替换/删除 API）。故检测点在落库事件上异步执行（本地 ollama embed ~100ms），严重档以
 * "存档 + 追加拦截说明 + 重生成替换回复"实现拒绝语义。
 *
 * 性能（需求"减少额外消耗的时间"）：
 *  - 每回合仅 1 次本地 ollama embed，检测/入轨共用同一向量，异步不阻塞对话与流式；
 *  - PCA 用 N×N 样本 Gram 矩阵（N≤105）特征分解，复杂度与 768 维无关（毫秒级），
 *    仅在 UI 查询时计算并缓存；
 *  - 润色/重生成/倒叙修正只在可疑/严重/审批通过等低频事件触发；
 *  - 预防性护栏为条件注入（有航点或近期可疑才注入一句提示），零额外 LLM 调用；
 *  - 持久化 30s 节流写盘 + 定时兜底 + 关闭 flush。
 */
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';

export const name = 'dsh-archive-consistency';

/** 依赖注入：memory（embed 复用同源 ollama 向量）、llm（润色/重生成/倒叙修正）、timer（节流写盘）。 */
export const inject = ['memory', 'llm', 'timer'];

const DEFAULTS = {
  trajectoryPath: join(process.cwd(), 'data', 'consistency.json'),
  enabled: true,
  windowSize: 100,       // 滑动窗口：最多保留多少轮交互向量
  waypointMax: 5,        // 航点上限：最近多少条已审批进化建议
  lastN: 20,             // 突变梯度参考点数（轨迹最近 N 个点）
  embedMaxChars: 500,    // 回复文本截断（embed 成本控制）
  embedTimeoutMs: 8000,  // embed 超时（防 ollama 挂起阻塞队列，超时静默跳过）
  llmTimeoutMs: 25000,   // 润色/重生成/倒叙修正 LLM 超时
  rewriteMaxTokens: 700,
  alphaRatio: 1.2,       // α = 校准基准（轨迹点对距离中位数）× ratio
  betaRatio: 2.2,        // β = 基准 × ratio
  betaBoostFactor: 1.2,  // 审批通过 β 抬升 = max(β, 航点到轨迹中心距离 × factor)
  betaMaxRatio: 4,       // β 上限 = 基准 × ratio（防无限抬升）
  flushDebounceMs: 30000,
  scopedSessions: ['session-main'], // 参与轨迹/检测的会话（默认仅主会话，防临时会话污染人格轨迹）
  guardMaxChars: 220,
};

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.trajectoryPath !== undefined) {
    if (typeof raw.trajectoryPath !== 'string' || raw.trajectoryPath === '') throw new Error('archive-consistency 配置错误：trajectoryPath 必须是非空字符串');
    cfg.trajectoryPath = raw.trajectoryPath;
  }
  if (raw.enabled !== undefined) cfg.enabled = raw.enabled === true;
  for (const key of ['windowSize', 'waypointMax', 'lastN', 'embedMaxChars', 'embedTimeoutMs', 'llmTimeoutMs', 'rewriteMaxTokens', 'guardMaxChars', 'flushDebounceMs']) {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] <= 0) throw new Error(`archive-consistency 配置错误：${key} 必须是正数`);
      cfg[key] = Math.floor(raw[key]);
    }
  }
  for (const key of ['alphaRatio', 'betaRatio', 'betaBoostFactor', 'betaMaxRatio']) {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] <= 0) throw new Error(`archive-consistency 配置错误：${key} 必须是正数`);
      cfg[key] = raw[key];
    }
  }
  if (raw.scopedSessions !== undefined) {
    if (!Array.isArray(raw.scopedSessions) || raw.scopedSessions.some((s) => typeof s !== 'string')) throw new Error('archive-consistency 配置错误：scopedSessions 必须是字符串数组');
    cfg.scopedSessions = raw.scopedSessions;
  }
  return cfg;
}

const round3 = (x) => Math.round(Number(x ?? 0) * 1000) / 1000;

function bootLine(line) {
  try { process.stdout.write(line + '\n'); } catch { /* 非 CLI 环境忽略 */ }
}

/** 欧氏距离（768 维，微秒级）。 */
function euclid(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

/**
 * PCA 前 3 主成分（kernel trick）：N 个 768 维样本的 PCA 等价于 N×N 样本 Gram 矩阵
 * 的特征分解（N ≤ 105），复杂度与维度无关。幂迭代 + deflation 取前 3 特征对，
 * 得分 = sqrt(λ) × 特征向量分量。返回 { scores: [[x,y,z],...], eigenvalues }。
 */
function pca3(points) {
  const N = points.length;
  if (N < 3) return { scores: null, eigenvalues: [] };
  const D = points[0].length;
  const mean = new Float64Array(D);
  for (let j = 0; j < D; j++) {
    let s = 0;
    for (let i = 0; i < N; i++) s += points[i][j];
    mean[j] = s / N;
  }
  const cen = points.map((p) => {
    const c = new Float64Array(D);
    for (let j = 0; j < D; j++) c[j] = p[j] - mean[j];
    return c;
  });
  const G = Array.from({ length: N }, () => new Float64Array(N));
  for (let i = 0; i < N; i++) {
    for (let k = i; k < N; k++) {
      let s = 0;
      const ci = cen[i]; const ck = cen[k];
      for (let j = 0; j < D; j++) s += ci[j] * ck[j];
      G[i][k] = G[k][i] = s;
    }
  }
  const K = Math.min(3, N);
  const eig = [];
  for (let t = 0; t < K; t++) {
    let v = new Float64Array(N); v[t % N] = 1;
    let lambda = 0;
    for (let iter = 0; iter < 60; iter++) {
      const w = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let j = 0; j < N; j++) s += G[i][j] * v[j];
        w[i] = s;
      }
      let norm = 0;
      for (let i = 0; i < N; i++) norm += w[i] * w[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < N; i++) v[i] = w[i] / norm;
      lambda = norm;
    }
    eig.push({ v, lambda });
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) G[i][j] -= lambda * v[i] * v[j];
  }
  const scores = points.map((_, idx) => eig.map((ev) => Math.sqrt(Math.max(ev.lambda, 0)) * ev.v[idx]));
  return { scores, eigenvalues: eig.map((e) => e.lambda) };
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.root?.logger?.('archive-consistency') ?? console;
  const DATA_FILE = config.trajectoryPath;
  const scoped = new Set(config.scopedSessions);

  // ── 状态（内存权威 + JSON 持久化） ──
  const baseState = () => ({
    version: 1,
    enabled: config.enabled,
    alpha: null, beta: null, baseDist: null, calibrated: false,
    turns: [], waypoints: [], rejected: [], revisions: [], corrections: [],
    seqMap: {},
    stats: { checks: 0, pass: 0, suspicious: 0, blocked: 0, waypointAdds: 0, corrections: 0 },
    lastCheckAt: 0, suspiciousSince: 0,
  });
  let st = loadState();
  let dirty = false;
  let flushTimer = null;

  function loadState() {
    const base = baseState();
    try {
      if (existsSync(DATA_FILE)) {
        const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
        for (const k of Object.keys(base)) if (raw[k] !== undefined) base[k] = raw[k];
        if (!Array.isArray(base.turns)) base.turns = [];
        if (!Array.isArray(base.waypoints)) base.waypoints = [];
        if (!Array.isArray(base.rejected)) base.rejected = [];
        if (!Array.isArray(base.revisions)) base.revisions = [];
        if (!Array.isArray(base.corrections)) base.corrections = [];
        if (typeof base.seqMap !== 'object' || base.seqMap === null) base.seqMap = {};
        //  stats 与默认逐键合并（文件里 stats 为 {} 时不再产生 NaN 计数）
        if (typeof base.stats !== 'object' || base.stats === null) base.stats = {};
        for (const k of Object.keys(baseState().stats)) if (typeof base.stats[k] !== 'number') base.stats[k] = 0;
        // 丢弃 vec 非数组的轨迹/航点条目（形状损坏防 euclid TypeError 致检测静默失败）
        base.turns = base.turns.filter((t) => Array.isArray(t?.vec) && t.vec.length > 0);
        base.waypoints = base.waypoints.filter((w) => Array.isArray(w?.vec) && w.vec.length > 0);
      }
    } catch (error) {
      logger.warn(`archive-consistency: 状态文件损坏，使用空状态：${error?.message ?? error}`);
      try { renameSync(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`); } catch { /* 降级启动 */ }
    }
    return base;
  }

  function markDirty() { dirty = true; scheduleFlush(); }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = ctx.timer.setTimeout(() => { flushTimer = null; flush(); }, config.flushDebounceMs);
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(st), 'utf8');
      renameSync(tmp, DATA_FILE);
    } catch (error) {
      dirty = true; // 写盘失败保留脏标记，下次兜底重试
      logger.warn(`archive-consistency: 持久化失败：${error?.message ?? error}`);
    }
  }

  // ── 基础工具 ──
  function isScoped(session) {
    const id = String(session?.id ?? session?.sessionId ?? '');
    return scoped.has('*') || scoped.has(id);
  }

  /** 从 assistant/message 事件提取"最终回复"文本（无工具调用的 text 块；跳过注入/主动消息/自生成）。 */
  function replyTextOf(event) {
    const d = event?.data;
    if (!d) return '';
    if (d.message?.source?.provider === 'consistency' || d.message?.source?.provider === 'proactive') return '';
    const content = Array.isArray(d.message?.content) ? d.message.content : (Array.isArray(d.content) ? d.content : []);
    if (content.some((b) => b?.type === 'tool-call' || b?.type === 'tool_call')) return '';
    const text = content.filter((b) => b?.type === 'text' && b.text).map((b) => String(b.text)).join('\n').trim();
    if (!text || text.startsWith('Current runtime context')) return '';
    return text.length > config.embedMaxChars ? `${text.slice(0, config.embedMaxChars)}…` : text;
  }

  /** embed 复用 ctx.memory（同源 ollama），超时兜底（memory.embed 不接受 signal，用 race）。 */
  async function embedText(text) {
    const res = await Promise.race([
      ctx.memory.embed(text).then((v) => Array.from(v ?? [])),
      new Promise((_, rej) => setTimeout(() => rej(new Error('embed 超时（ollama 无响应）')), config.embedTimeoutMs)),
    ]);
    return res;
  }

  function gradientOf(vec, turns) {
    if (turns.length === 0) return 0;
    let s = 0;
    for (const t of turns) s += euclid(vec, t.vec);
    return s / turns.length;
  }

  function turnCenter() {
    const vecs = st.turns.map((t) => t.vec).filter((v) => v && v.length > 0);
    if (vecs.length === 0) return null;
    const n = vecs[0].length;
    const c = new Array(n).fill(0);
    for (const v of vecs) for (let i = 0; i < n; i++) c[i] += v[i];
    for (let i = 0; i < n; i++) c[i] /= vecs.length;
    return c;
  }

  /** 自动校准：轨迹点对欧氏距离中位数作基准，α/β = 基准 × ratio。 */
  function calibrate() {
    const vecs = st.turns.map((t) => t.vec).filter((v) => v && v.length > 0);
    const N = vecs.length;
    if (N < config.lastN) return false;
    const MAX_PAIRS = 300;
    const pairs = [];
    let guard = 0;
    while (pairs.length < MAX_PAIRS && guard++ < 10000) {
      const i = Math.floor(Math.random() * N);
      const j = Math.floor(Math.random() * N);
      if (i !== j) pairs.push(euclid(vecs[i], vecs[j]));
    }
    if (pairs.length === 0) return false;
    pairs.sort((a, b) => a - b);
    const median = pairs[Math.floor(pairs.length / 2)];
    st.baseDist = median;
    st.alpha = median * config.alphaRatio;
    st.beta = median * config.betaRatio;
    st.calibrated = true;
    markDirty();
    bootLine(`[archive-consistency] 自动校准：baseDist=${round3(median)} α=${round3(st.alpha)} β=${round3(st.beta)}`);
    return true;
  }

  function pushTurn(text, vec) {
    st.turns.push({ t: Date.now(), text: String(text).slice(0, 120), vec });
    if (st.turns.length > config.windowSize) st.turns.splice(0, st.turns.length - config.windowSize);
    markDirty();
  }

  function pushWaypoint(content, vec) {
    st.waypoints.push({ t: Date.now(), content: String(content).slice(0, 200), vec });
    if (st.waypoints.length > config.waypointMax) st.waypoints.splice(0, st.waypoints.length - config.waypointMax);
    st.stats.waypointAdds++;
    markDirty();
  }

  //  性能修复：seqMap 修订号。渲染层每 15s 拉一次 revisionsMap，原实现拿到就无条件
  // 替换 map 并触发整段聊天重渲染；实际 seqMap 变动远低于此频率。加 rev 后"没变就不重渲染"。
  let seqRev = 0;

  function trimSeqMap() {
    const keys = Object.keys(st.seqMap).map(Number).sort((a, b) => a - b);
    let changed = false;
    while (keys.length > 200) { const k = keys.shift(); delete st.seqMap[k]; changed = true; }
    if (changed) seqRev += 1;
  }

  // ── LLM 调用（自定义 provider 优先，失败回退官方；与 loop/evolution 同款） ──
  function customLlmProvider() {
    try {
      const settings = ctx.get('settings');
      // 命名空间 key 与 control/loop 一致（settingsNamespace('archive-models') 原样返回 'archive-models'）
      const value = settings?.get?.('archive-models');
      const list = Array.isArray(value?.providers) ? value.providers : [];
      return list.find((p) => p.enabled !== false && p.baseURL && p.apiKey && p.model) || null;
    } catch { return null; }
  }

  async function callLlm(system, user, signal) {
    const custom = customLlmProvider();
    if (custom) {
      try {
        const url = `${String(custom.baseURL).replace(/\/+$/, '')}/chat/completions`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${custom.apiKey}` },
          body: JSON.stringify({ model: custom.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: config.rewriteMaxTokens }),
          signal,
        });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error?.message ? `API: ${j.error.message}` : `HTTP ${res.status}`);
        const text = String(j.choices?.[0]?.message?.content ?? '').trim();
        if (text) return text;
        throw new Error('LLM 未返回文本');
      } catch (error) {
        logger.warn(`archive-consistency: 自定义提供商调用失败，回退官方：${error?.message ?? error}`);
      }
    }
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new Error('LLM 调用中止');
      let text = '';
      try {
        const stream = ctx.llm.stream({
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          signal,
          maxTokens: config.rewriteMaxTokens,
        });
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text;
          if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            const failure = chunk.reason.failure;
            throw new Error(`${failure?.code ?? chunk.reason.kind}: ${failure?.message ?? '调用失败'}`);
          }
        }
        if (text.trim() !== '') return text;
        lastError = new Error('LLM 未返回文本');
      } catch (error) {
        lastError = error;
        if (signal?.aborted || String(error?.code ?? error?.message ?? '').includes('ABORTED')) throw error;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    throw lastError ?? new Error('LLM 未返回文本');
  }

  async function callLlmWithTimeout(system, user) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.llmTimeoutMs);
    try { return await callLlm(system, user, ac.signal); } finally { clearTimeout(timer); }
  }

  // ── 模块 2：突变梯度检测 ──
  const REWRITE_PROMPT = `你是人格一致性平滑助手。下面是一段 AI 的回复，它与该 AI 近期的人格轨迹出现了轻微偏离。
请以"基于最近的变化，我认为…"作为思考（reasoning）的开头，审视该偏离并给出一个平滑过渡的修订版回复：
- 修订版保持原回复的意图与信息，但表达与近期人格保持一致；
- 只输出修订后的回复正文（不要输出思考内容、不要解释、不要任何前缀）。`;

  const regenPrompt = (direction, original) => `你是 DSH-ARCHIVE 的 AI 人格。上一条回复因人格一致性严重突变（偏离近期人格轨迹）被拦截。
近期待办进化方向：${direction}
请重新生成一份更符合该方向、且与近期人格轨迹一致的回复：
- 保持对用户问题的回应意图；
- 只输出重新生成的回复正文（不要解释、不要任何前缀）。
被拦截的回复：\n---\n${original}\n---`;

  function appendSystem(session, text) {
    try {
      session.append('user/message', {
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', provider: 'consistency' },
      }, { surfaceOp: 'append' });
    } catch (error) { logger.warn(`archive-consistency: 追加拦截说明失败：${error?.message ?? error}`); }
  }

  function appendAssistant(session, text) {
    try {
      session.append('assistant/message', {
        turn: 0, step: 0,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'consistency', model: 'consistency-regen' },
          id: `consistency-${Date.now()}`,
          time: Date.now(),
        },
      }, { surfaceOp: 'append' });
    } catch (error) { logger.warn(`archive-consistency: 追加重生成回复失败：${error?.message ?? error}`); }
  }

  function notifyUser(content) {
    try {
      const notify = ctx.get('notify');
      const p = notify?.send?.({ content, source: 'consistency', scope: 'panel' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* 通知失败不阻断 */ }
  }

  /** 可疑档：局部重写（一次轻量 LLM），修订版经渲染层替换显示；失败静默保留原文。 */
  async function doRewrite(seq, original, g) {
    let revised = '';
    try { revised = await callLlmWithTimeout(REWRITE_PROMPT, original); } catch (error) {
      logger.warn(`archive-consistency: 修订失败（保留原文）：${error?.message ?? error}`);
    }
    st.revisions.push({ t: Date.now(), seq, original: original.slice(0, 400), revised: revised.slice(0, 400) || '', g: round3(g) });
    if (st.revisions.length > 50) st.revisions.splice(0, st.revisions.length - 50);
    st.seqMap[seq] = { v: 'suspicious', r: revised || undefined };
    seqRev += 1;
    trimSeqMap();
    markDirty();
  }

  /** 严重档：存档 + 拦截说明 + 按进化方向重生成 + 二次检测；仍超标 → 人工介入。 */
  async function doBlock(session, seq, original, g) {
    st.rejected.push({ t: Date.now(), seq, text: original.slice(0, 400), g: round3(g), corrected: false });
    if (st.rejected.length > 50) st.rejected.splice(0, st.rejected.length - 50);
    st.seqMap[seq] = { v: 'blocked' };
    seqRev += 1;
    trimSeqMap();
    markDirty();
    appendSystem(session, `⛔ 人格一致性拦截：上一条回复被检测到人格严重突变（梯度 ${round3(g)} > 阈值 β ${round3(st.beta)}），已存档拒绝采用。正在按近期待办进化方向重新生成…`);
    try {
      const direction = st.waypoints.length > 0 ? st.waypoints[st.waypoints.length - 1].content : '保持与近期人格轨迹一致的稳定风格';
      const rewritten = await callLlmWithTimeout(regenPrompt(direction, original), original);
      if (!rewritten) throw new Error('重生成返回空');
      //  二次检测 embed 失败（ollama 瞬时超时）不应丢弃已生成的重写回复——
      // 独立容错：embed 失败按"跳过二次检测"处理，直接追加重生成回复
      let g2 = null;
      try {
        const vec2 = await embedText(rewritten);
        if (vec2 && vec2.length > 0 && st.beta != null) {
          g2 = gradientOf(vec2, st.turns.slice(-config.lastN));
          if (g2 > st.beta) {
            appendSystem(session, `⚠️ 人格一致性：重新生成的回复仍超标（梯度 ${round3(g2)}），已停止自动重试，请到「一致性」页人工介入。`);
            notifyUser('人格一致性拦截：重新生成仍超标，需人工介入（见「一致性」页拦截记录）');
            return;
          }
        }
        appendAssistant(session, rewritten);
        pushTurn(rewritten, vec2 ?? []);
      } catch (embedError) {
        logger.warn(`archive-consistency: 二次检测 embed 失败，跳过检测直接采用重写回复：${embedError?.message ?? embedError}`);
        appendAssistant(session, rewritten);
      }
    } catch (error) {
      logger.warn(`archive-consistency: 重生成失败：${error?.message ?? error}`);
      appendSystem(session, '⚠️ 人格一致性：重新生成失败（模型调用异常），该回复已存档拦截，请到「一致性」页人工介入。');
    }
  }

  // 串行队列：保证检测/入轨按事件顺序执行（多轮回复并发时不乱序）
  let queue = Promise.resolve();
  function enqueue(fn) {
    queue = queue.then(fn).catch((error) => logger.warn(`archive-consistency: 检测任务失败：${error?.message ?? error}`));
  }

  function handleAssistantMessage(session, event) {
    if (!st.enabled) return;
    const text = replyTextOf(event);
    if (!text) return;
    const seq = Number(event.seq ?? 0);
    enqueue(async () => {
      // 未校准且轨迹达到参考点数 → 自动校准一次
      if (!st.calibrated && st.turns.length >= config.lastN) calibrate();
      const lastTurns = st.turns.slice(-config.lastN);
      if (lastTurns.length < config.lastN) {
        // 冷启动：不判定，仅入轨（累计参考点）
        const vec = await embedText(text);
        if (vec && vec.length > 0) { pushTurn(text, vec); st.stats.checks++; st.lastCheckAt = Date.now(); }
        return;
      }
      const vec = await embedText(text);
      if (!vec || vec.length === 0) return;
      const g = gradientOf(vec, lastTurns);
      st.stats.checks++; st.lastCheckAt = Date.now();
      if (st.alpha == null || st.beta == null) { pushTurn(text, vec); return; }
      if (g < st.alpha) {
        st.stats.pass++;
        pushTurn(text, vec);
      } else if (g <= st.beta) {
        st.stats.suspicious++;
        st.suspiciousSince = Date.now();
        pushTurn(text, vec);
        await doRewrite(seq, text, g);
      } else {
        st.stats.blocked++;
        st.suspiciousSince = Date.now();
        await doBlock(session, seq, text, g);
      }
      markDirty();
    });
  }

  // ── 预防性护栏（条件注入，零额外 LLM 调用） ──
  function guardNeeded() {
    if (st.waypoints.length > 0) return true;
    return st.suspiciousSince > 0 && Date.now() - st.suspiciousSince < 3600 * 1000;
  }

  function guardText() {
    const parts = [];
    if (st.waypoints.length > 0) {
      const wp = st.waypoints[st.waypoints.length - 1];
      parts.push(`近期人格进化方向（已获用户批准）：${wp.content}`);
    }
    if (st.suspiciousSince > 0 && Date.now() - st.suspiciousSince < 3600 * 1000) {
      parts.push('近期回复出现人格风格波动，请保持与近期人格轨迹一致；若风格确有转变，请在思考（reasoning）中以"基于最近的变化，我认为…"开头说明后再作答，不要把这句话写进回复正文');
    }
    if (parts.length === 0) return '';
    const text = `Current runtime context（人格一致性护栏）：${parts.join('；')}`;
    return text.length > config.guardMaxChars ? `${text.slice(0, config.guardMaxChars)}…` : text;
  }

  // ── 模块 3：进化溯源验证器（审批协同） ──
  const correctPrompt = (direction, text) => `你是 DSH-ARCHIVE 的 AI 人格。人格刚刚更新（新方向：${direction}）。以下是更新前被拦截的一段回复，请用新人格重新生成（保持原意、符合新方向）：\n---\n${text}\n---\n只输出重新生成的正文。`;

  /** 审批通过后：航点入轨 + β 动态抬高 + 前 3 条被驳回输出用新人格重写（倒叙修正）。 */
  async function onEvolutionApproved(candidateId) {
    try {
      const evolution = ctx.get('evolution');
      if (!evolution || typeof evolution.view !== 'function') return { skipped: true, reason: 'evolution 服务不可用' };
      const view = await evolution.view(50);
      const records = Array.isArray(view?.records) ? view.records : [];
      //  ①匹配 approve 与 auto-apply（潜意识自动微调采纳）；②去掉 reverse()
      // ——records 为 new→old，find 直接取最新匹配记录
      const rec = records.find((r) => (r?.type === 'approve' || r?.type === 'auto-apply') && (r?.candidateId === candidateId || !candidateId));
      const candidate = rec?.candidate;
      if (!candidate?.content) return { skipped: true, reason: '未找到已采纳候选' };
      const content = String(candidate.content);
      const vec = await embedText(content);
      if (!vec || vec.length === 0) return { skipped: true, reason: 'embed 失败' };
      pushWaypoint(content, vec);
      // β 动态抬高：为沿进化方向的漂移留出空间（带上限保护）
      if (st.beta != null) {
        const center = turnCenter();
        const d = center ? euclid(vec, center) : null;
        let nb = Math.max(st.beta, (d ?? st.beta) * config.betaBoostFactor);
        const cap = st.baseDist != null ? st.baseDist * config.betaMaxRatio : st.beta * 4;
        if (nb > cap) nb = cap;
        st.beta = nb;
        markDirty();
      }
      // 人格倒叙修正：最近 3 条未修正的被驳回输出，用新人格重写（异步低优先级）
      void runCorrections(content);
      bootLine(`[archive-consistency] 进化航点已入轨：${content.slice(0, 60)} β=${round3(st.beta)}`);
      return { ok: true, waypoint: content.slice(0, 80), beta: st.beta };
    } catch (error) {
      logger.warn(`archive-consistency: 进化协同失败：${error?.message ?? error}`);
      return { skipped: true, reason: error.message };
    }
  }

  async function runCorrections(direction) {
    const targets = st.rejected.filter((r) => !r.corrected).slice(-3);
    if (targets.length === 0) return;
    for (const t of targets) {
      let rewritten = '';
      let status = 'done';
      try { rewritten = await callLlmWithTimeout(correctPrompt(direction, t.text), t.text); } catch (error) {
        status = 'failed';
        logger.warn(`archive-consistency: 倒叙修正失败：${error?.message ?? error}`);
      }
      t.corrected = true;
      st.corrections.push({ t: Date.now(), direction: String(direction).slice(0, 80), content: t.text.slice(0, 200), rewritten: rewritten.slice(0, 400), status });
      if (st.corrections.length > 50) st.corrections.splice(0, st.corrections.length - 50);
      if (status === 'done') st.stats.corrections++;
      markDirty();
    }
  }

  // ── 服务 API ──
  const api = {
    state: () => ({
      enabled: st.enabled,
      alpha: st.alpha, beta: st.beta, baseDist: st.baseDist, calibrated: st.calibrated,
      windowSize: config.windowSize, waypointMax: config.waypointMax, lastN: config.lastN,
      turnCount: st.turns.length, waypointCount: st.waypoints.length,
      rejectedCount: st.rejected.length, revisionCount: st.revisions.length, correctionCount: st.corrections.length,
      lastCheckAt: st.lastCheckAt, guardActive: guardNeeded(),
      stats: { ...st.stats },
    }),
    stats: () => ({ ...st.stats, turnCount: st.turns.length, waypointCount: st.waypoints.length, rejectedCount: st.rejected.length, revisionCount: st.revisions.length, correctionCount: st.corrections.length, calibrated: st.calibrated, lastCheckAt: st.lastCheckAt }),
    /** 人格轨迹 PCA 坐标点（按需计算；turn 点 + 航点）。 */
    pca: () => {
      const pts = [
        ...st.turns.map((t) => ({ kind: 'turn', t: t.t, vec: t.vec })),
        ...st.waypoints.map((w) => ({ kind: 'waypoint', t: w.t, vec: w.vec })),
      ].filter((p) => p.vec && p.vec.length > 0);
      if (pts.length < 3) return { points: [], base: st.baseDist };
      const { scores } = pca3(pts.map((p) => p.vec));
      return {
        points: pts.map((p, i) => (scores?.[i] ? { x: round3(scores[i][0]), y: round3(scores[i][1]), z: round3(scores[i][2] ?? 0), kind: p.kind, t: p.t } : null)).filter(Boolean),
        base: st.baseDist,
      };
    },
    log: (limit = 20) => {
      const n = Math.max(1, Math.min(50, Number(limit) || 20));
      return {
        rejected: st.rejected.slice(-n).map((r) => ({ t: r.t, seq: r.seq, text: r.text, g: r.g, corrected: r.corrected })),
        revisions: st.revisions.slice(-n).map((r) => ({ t: r.t, seq: r.seq, original: r.original, revised: r.revised, g: r.g })),
        corrections: st.corrections.slice(-n).map((c) => ({ t: c.t, direction: c.direction, content: c.content, rewritten: c.rewritten, status: c.status })),
      };
    },
    /** 渲染层用：会话消息 seq → 判定结果（suspicious 附修订版全文，blocked 标记）。 */
    revisionsMap: () => ({ map: { ...st.seqMap }, alpha: st.alpha, beta: st.beta, rev: seqRev }),
    /**  潜意识系统：最近 N 个轨迹点的文本摘要（供"自洽置信度"评估注入提示词）。 */
    trajectoryText: (n = 5) => {
      const k = Math.max(1, Math.min(30, Number(n) || 5));
      return st.turns.slice(-k).map((t) => t.text).filter(Boolean);
    },
    configure: (patch = {}) => {
      if (typeof patch.enabled === 'boolean') { st.enabled = patch.enabled; markDirty(); }
      //  与 normalizeConfig 一致用 Number.isFinite（此前 Infinity 可永久禁用拦截）
      if (typeof patch.alpha === 'number' && Number.isFinite(patch.alpha) && patch.alpha > 0) { st.alpha = patch.alpha; st.calibrated = true; markDirty(); }
      if (typeof patch.beta === 'number' && Number.isFinite(patch.beta) && patch.beta > 0) { st.beta = patch.beta; st.calibrated = true; markDirty(); }
      if (patch.resetCalibration === true) {
        st.calibrated = false; st.baseDist = null; st.alpha = null; st.beta = null; markDirty();
      }
      return api.state();
    },
    onEvolutionApproved,
    close: () => { try { flush(); } catch { /* 关闭兜底 */ } },
  };
  ctx.provide('consistency', api);

  // ── 事件接线 ──
  ctx.on('session/event', (session, event) => {
    try {
      if (!event) return;
      // 回合开始：条件注入人格一致性护栏（turn/start 先于 LLM 请求 append，进入上下文）
      if (event.type === 'turn/start' && st.enabled && isScoped(session) && guardNeeded()) {
        const text = guardText();
        if (text) session.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'plugin', provider: 'consistency-guard' } }, { surfaceOp: 'append' });
        return;
      }
      // 回复落库：异步突变检测 + 轨迹入轨
      if (event.type === 'assistant/message' && isScoped(session)) handleAssistantMessage(session, event);
    } catch (error) {
      logger.warn(`archive-consistency: 事件处理失败：${error?.message ?? error}`);
    }
  });

  // 兜底定时 flush（防 debounce 意外丢失；5 分钟一次，写盘成本极低）
  ctx.timer.setInterval(() => { try { flush(); } catch { /* ignore */ } }, 5 * 60000);

  bootLine(`[archive-consistency] ready turns=${st.turns.length} waypoints=${st.waypoints.length} calibrated=${st.calibrated} enabled=${st.enabled} α=${st.alpha == null ? '—' : round3(st.alpha)} β=${st.beta == null ? '—' : round3(st.beta)}`);
  return { api };
}
