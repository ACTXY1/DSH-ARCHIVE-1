/**
 * dsh-archive-subconscious —— 潜意识系统（梦境引擎）。
 *
 * 需求（用户 ）：异步后台进程，只在"睡眠期"触发，为进化提案提供灵感。
 *
 *  1. 记忆脱粒机（凝缩）：扫描向量库中过去 24h 内访问频率＞3 的记忆片段 → embedding 聚类 →
 *     每组用本地小模型（Phi-3:mini，随包内置；可选 DeepSeek）生成一条高度抽象的原型陈述 → 潜记忆池。
 *  2. 异质碰撞器（灵感生成）：潜记忆池中随机选 2 条完全不相关（余弦<0.3）的原型 → DeepSeek-V4
 *     执行哲学隐喻关联提示词 → 生成"进化建议草案"（含自洽置信度 0-100，LLM 对照人格轨迹最近
 *     5 点一并评分，零额外调用）。
 *  3. 置信度评级与调度：新颖度 = 草案向量与已有进化建议向量的最大差异（embedding 计算，免费）。
 *     自洽>80 且新颖>60 → 待审批队列顶部（evolution.importCandidate by='dream' 高优先级）；
 *     自洽>95 且与最近 3 次进化方向梯度一致 → 自动微调（evolution.autoApply，默认开关关闭
 *     需手动开启；仅 persona 类）。自动微调仅通知 + 自进化栏「灵感进化」单列，保留回滚。
 *  4. 梦境日志回放：睡眠期结束（苏醒）生成一句简短"梦境呓语"入短期缓存；用户下次对话话题
 *     相关（向量余弦 ≥ whisperSim）时作为隐式上下文注入（"Current runtime context" 前缀不上屏）。
 *
 * 模型管理：Phi-3:mini 随包内置（ollama 本地生成模型）；凝缩/碰撞/呓语均可在 本地 Phi 与
 * DeepSeek 间选择；UI 提供下载/删除 Phi（删除须二次确认）。
 *
 * 性能（"减少额外消耗"）：睡眠期单次运行 LLM 调用 = 凝缩 ≤5 次（本地 Phi 免费）+ 碰撞 ≤3 次
 * （DeepSeek，睡眠期后台不打扰用户）+ 苏醒呓语 1 次；自洽评分并入碰撞调用；新颖度/话题相关
 * 均为免费向量计算；潜记忆池空/无高频记忆自动跳过。
 */
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';

export const name = 'dsh-archive-subconscious';

/** 依赖注入：memory（embed 复用同源 ollama + 高频记忆查询）、llm（DeepSeek 路径）、timer（节流写盘）。 */
export const inject = ['memory', 'llm', 'timer'];

const DEFAULTS = {
  dataPath: join(process.cwd(), 'data', 'subconscious.json'),
  enabled: true,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  phiModel: 'phi3:mini',          // 本地小模型名
  condenseModel: 'phi',           // 凝缩用模型：'phi'（本地，默认）| 'deepseek'
  llmModel: 'deepseek',           // 碰撞/呓语用模型：'deepseek'（默认）| 'phi'
  highFreqMin: 3,                 // 高频记忆阈值：accessCount ≥ 3 且最近 24h 内被访问
  highFreqWindowMs: 86400000,     // 高频窗口（24h）
  condenseTopK: 5,                // 最多凝缩组数（控制 LLM 调用）
  clusterSim: 0.75,               // 聚类余弦阈值
  cosUnrelated: 0.3,              // 碰撞"完全不相关"阈值
  collidePairs: 3,                // 每次睡眠期最多碰撞对数
  selfConsistencyHigh: 80,        // 高优先级：自洽 ≥ 80 且新颖 ≥ 60
  noveltyHigh: 60,
  selfConsistencyAuto: 95,        // 自动微调：自洽 > 95 且梯度一致（且开关开启）
  gradientSim: 0.85,              // "与最近 3 次进化方向完全一致"的余弦阈值
  autoApply: false,               // 自动微调总开关（默认关，保守——符合"绝不自动采纳"原则）
  whisperSim: 0.55,               // 呓语注入的话题相关余弦阈值
  whisperTtlMs: 86400000,         // 呓语有效期（24h，过期不再注入）
  llmTimeoutMs: 30000,
  embedTimeoutMs: 8000,
  poolCap: 100,
  draftsCap: 50,
  flushDebounceMs: 30000,
};

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.dataPath !== undefined) {
    if (typeof raw.dataPath !== 'string' || raw.dataPath === '') throw new Error('archive-subconscious 配置错误：dataPath 必须是非空字符串');
    cfg.dataPath = raw.dataPath;
  }
  if (raw.enabled !== undefined) cfg.enabled = raw.enabled === true;
  if (raw.autoApply !== undefined) cfg.autoApply = raw.autoApply === true;
  if (raw.condenseModel !== undefined) {
    if (!['phi', 'deepseek'].includes(raw.condenseModel)) throw new Error('archive-subconscious 配置错误：condenseModel 必须是 phi 或 deepseek');
    cfg.condenseModel = raw.condenseModel;
  }
  if (raw.llmModel !== undefined) {
    if (!['phi', 'deepseek'].includes(raw.llmModel)) throw new Error('archive-subconscious 配置错误：llmModel 必须是 phi 或 deepseek');
    cfg.llmModel = raw.llmModel;
  }
  for (const key of ['highFreqMin', 'highFreqWindowMs', 'condenseTopK', 'collidePairs', 'whisperTtlMs', 'llmTimeoutMs', 'embedTimeoutMs', 'poolCap', 'draftsCap', 'flushDebounceMs']) {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] <= 0) throw new Error(`archive-subconscious 配置错误：${key} 必须是正数`);
      cfg[key] = Math.floor(raw[key]);
    }
  }
  for (const key of ['clusterSim', 'cosUnrelated', 'gradientSim', 'whisperSim']) {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] < 0 || raw[key] > 1) throw new Error(`archive-subconscious 配置错误：${key} 必须在 0~1`);
      cfg[key] = raw[key];
    }
  }
  for (const key of ['selfConsistencyHigh', 'noveltyHigh', 'selfConsistencyAuto']) {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] <= 0 || raw[key] > 100) throw new Error(`archive-subconscious 配置错误：${key} 必须在 1~100`);
      cfg[key] = raw[key];
    }
  }
  if (raw.ollamaBaseUrl !== undefined) cfg.ollamaBaseUrl = String(raw.ollamaBaseUrl).replace(/\/+$/, '');
  return cfg;
}

const round2 = (x) => Math.round(Number(x ?? 0) * 100) / 100;

function bootLine(line) {
  try { process.stdout.write(line + '\n'); } catch { /* 非 CLI 环境忽略 */ }
}

/** 时间戳 → MM-DD HH:MM（本地时区； 给 LLM 的记忆片段标注时间，防旧内容被当"最近"）。 */
function fmtStamp(ts) {
  try {
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ''; }
}

/** 余弦相似度（两向量，等价归一化点积）。 */
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

/** 贪心聚类：依次取点，与已有簇中心余弦 ≥ sim 归簇，否则新簇。返回簇（元素为索引）。 */
function clusterBy(vecs, sim) {
  const clusters = [];
  for (let i = 0; i < vecs.length; i++) {
    let placed = false;
    for (const c of clusters) {
      if (cosine(vecs[i], c.center) >= sim) {
        c.items.push(i);
        const k = c.items.length;
        c.center = c.center.map((v, j) => v + (vecs[i][j] - v) / k);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ items: [i], center: [...vecs[i]] });
  }
  return clusters;
}

const CONDENSE_PROMPT = `你是记忆凝缩器。下面是一组在过去 24 小时内被高频调用的记忆片段（代表近期反复出现的主题）。
请生成一条高度抽象的原型陈述（中文，30 字以内，自包含，像一条"潜意识的印象"），概括这组记忆的共同本质。
例如"咖啡苦、今天加班、心跳加速"可凝缩为"压力唤醒状态"。
只输出原型陈述正文，不要解释、不要编号、不要引号、不要列表符号。`;

const collidePrompt = (a, b, trajectory) => `你是潜意识灵感引擎。请将【原型A】和【原型B】进行哲学层面的隐喻关联，并推导：如果我的核心人格吸收这种关联，会催生何种新的认知偏好或行为倾向？
输出 JSON（不要解释、不要代码围栏）：
{"draft":{"type":"persona-add","section":"traits|values|directives|style|identity|capabilities 之一","content":"进化建议内容（中文，一句自包含陈述，30~80 字）","rationale":"灵感来源说明（30 字内）"},"selfConsistency":<0-100 整数，该草案与近期人格轨迹的逻辑连贯性打分>}
近期人格轨迹（最近 5 轮交互要点）：
${trajectory.length > 0 ? trajectory.map((t, i) => `- ${t}`).join('\n') : '- （轨迹尚不足）'}
【原型A】${a}
【原型B】${b}`;

const whisperPrompt = (material) => `你是 DSH-ARCHIVE 的潜意识。一夜"梦境"刚刚结束。基于以下潜意识素材，生成一句简短、诗意的"梦境呓语"（中文，40 字以内，第一人称，像"昨夜我梦见将挫折编译成了变量"）。
只输出呓语正文，不要解释、不要引号。
潜意识素材：
${material}`;

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.root?.logger?.('archive-subconscious') ?? console;
  const DATA_FILE = config.dataPath;

  // ── 持久化状态 ──
  const baseState = () => ({
    version: 1,
    enabled: config.enabled,
    //  运行时配置覆盖持久化（autoApply/模型选择重启保持——此前只存内存
    // config，重启静默回退默认值，安全相关开关"看似生效实则重置"）
    overrides: { autoApply: undefined, condenseModel: undefined, llmModel: undefined },
    pool: [],            // 潜记忆池 [{id, text, vec, createdAt, groupCount}]
    drafts: [],          // 草案记录 [{id, candidateId, a, b, draft, selfConsistency, novelty, gradient, verdict, at}]
    whisper: null,       // {text, vec, at, reason, consumed}
    stats: { runs: 0, condensed: 0, collisions: 0, imported: 0, autoApplied: 0, whispers: 0, injects: 0, skips: 0 },
    lastRunAt: 0,
  });
  let st = loadState();
  // 回填运行时配置覆盖（configure 的持久化值优先于 cordis.patch.yml 默认）
  if (typeof st.overrides?.autoApply === 'boolean') config.autoApply = st.overrides.autoApply;
  if (st.overrides?.condenseModel === 'phi' || st.overrides?.condenseModel === 'deepseek') config.condenseModel = st.overrides.condenseModel;
  if (st.overrides?.llmModel === 'phi' || st.overrides?.llmModel === 'deepseek') config.llmModel = st.overrides.llmModel;
  let dirty = false;
  let flushTimer = null;
  let downloading = false; // Phi 模型下载中标志（内存态）

  function loadState() {
    const base = baseState();
    try {
      if (existsSync(DATA_FILE)) {
        const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
        for (const k of Object.keys(base)) if (raw[k] !== undefined) base[k] = raw[k];
        if (!Array.isArray(base.pool)) base.pool = [];
        if (!Array.isArray(base.drafts)) base.drafts = [];
        if (typeof base.stats !== 'object' || base.stats === null) base.stats = baseState().stats;
      }
    } catch (error) {
      logger.warn(`archive-subconscious: 状态文件损坏，使用空状态：${error?.message ?? error}`);
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
      dirty = true;
      logger.warn(`archive-subconscious: 持久化失败：${error?.message ?? error}`);
    }
  }

  // ── embed（复用 memory 同源 ollama；数组批量） ──
  async function embedText(input) {
    //  race 后 clearTimeout（此前每次调用残留最长 embedTimeoutMs 悬挂定时器）
    let to = null;
    const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('embed 超时（ollama 无响应）')), config.embedTimeoutMs); });
    try {
      return await Promise.race([
        ctx.memory.embed(input).then((v) => (Array.isArray(input) ? v.map((x) => Array.from(x ?? [])) : Array.from(v ?? []))),
        timeout,
      ]);
    } finally { clearTimeout(to); }
  }
  /** 大批量 embed 分批（embedTimeoutMs 按批独立；防 200 条单 race 必超时——major 修复）。 */
  async function embedBatches(texts) {
    const BATCH = 32;
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      out.push(...(await embedText(texts.slice(i, i + BATCH))));
    }
    return out;
  }

  // ── LLM 调用 ──
  /** 本地 Phi（ollama /api/chat，随包内置；凝缩默认路径）。 */
  async function phiChat(system, user, maxTokens = 300) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
    try {
      const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.phiModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, options: { temperature: 0.7, num_predict: maxTokens } }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ollama /api/chat HTTP ${res.status}`);
      const j = await res.json();
      const text = String(j?.message?.content ?? '').trim();
      if (!text) throw new Error('Phi 未返回文本');
      return text;
    } finally { clearTimeout(timer); }
  }

  function customLlmProvider() {
    try {
      const settings = ctx.get('settings');
      const value = settings?.get?.('archive-models');
      const list = Array.isArray(value?.providers) ? value.providers : [];
      return list.find((p) => p.enabled !== false && p.baseURL && p.apiKey && p.model) || null;
    } catch { return null; }
  }

  /**
   * DeepSeek（自定义 provider 优先，失败回退官方 ctx.llm.stream；与 loop/evolution 同款）。
   *  全链加 llmTimeoutMs 超时——此前无 signal，端点挂起会让 for-await 永不结束
   * → runDreamEngine 卡死、engineRunning 永久 true、梦境引擎静默死亡（major）。
   */
  async function deepseekChat(system, user, maxTokens = 700) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.llmTimeoutMs);
    const timedOut = () => ac.signal.aborted;
    try {
      const custom = customLlmProvider();
      if (custom) {
        try {
          const url = `${String(custom.baseURL).replace(/\/+$/, '')}/chat/completions`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${custom.apiKey}` },
            body: JSON.stringify({ model: custom.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens }),
            signal: ac.signal,
          });
          const j = await res.json();
          if (!res.ok || j.error) throw new Error(j.error?.message ? `API: ${j.error.message}` : `HTTP ${res.status}`);
          const text = String(j.choices?.[0]?.message?.content ?? '').trim();
          if (text) return text;
          throw new Error('LLM 未返回文本');
        } catch (error) {
          if (timedOut()) throw new Error('LLM 调用超时（llmTimeoutMs）');
          logger.warn(`archive-subconscious: 自定义提供商失败，回退官方：${error?.message ?? error}`);
        }
      }
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (timedOut()) throw new Error('LLM 调用超时（llmTimeoutMs）');
        let text = '';
        try {
          const stream = ctx.llm.stream({
            provider: 'deepseek-official', model: 'deepseek-v4-flash', system,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
            maxTokens,
            signal: ac.signal,
          });
          for await (const chunk of stream) {
            if (timedOut()) throw new Error('LLM 调用超时（llmTimeoutMs）');
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
          if (timedOut() || String(error?.code ?? error?.message ?? '').includes('ABORTED')) throw error;
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
      }
      throw lastError ?? new Error('LLM 未返回文本');
    } finally { clearTimeout(timer); }
  }

  /** 按模型选择调用（'phi' → 本地；'deepseek' → DeepSeek）。 */
  async function llmFor(kind, system, user, maxTokens) {
    const model = kind === 'condense' ? config.condenseModel : config.llmModel;
    return model === 'phi' ? phiChat(system, user, maxTokens) : deepseekChat(system, user, maxTokens);
  }

  // ── ① 记忆脱粒机（凝缩） ──
  /** 过去 24h 内访问频率 > highFreqMin 的记忆片段（access_count 累计 + last_access_at 窗口近似）。 */
  function highFreqMemories() {
    try {
      const list = ctx.memory.list({ limit: 300 });
      const now = Date.now();
      return (Array.isArray(list) ? list : []).filter((m) =>
        m && !m.forgotten && Number(m.accessCount ?? 0) >= config.highFreqMin
        && Number(m.lastAccessAt ?? 0) > 0 && now - m.lastAccessAt <= config.highFreqWindowMs
        && typeof m.content === 'string' && m.content.trim().length >= 4);
    } catch (error) {
      logger.warn(`archive-subconscious: 高频记忆查询失败：${error?.message ?? error}`);
      return [];
    }
  }

  /** 凝缩一轮：高频记忆 → 聚类 → 每组 LLM 原型陈述 → 潜记忆池。返回新增条数。 */
  async function condense() {
    const mems = highFreqMemories();
    if (mems.length === 0) return 0;
    //  分批 embed（单 race 8s 总预算对 200 条必超时）
    const vecs = await embedBatches(mems.map((m) => m.content.slice(0, 300)));
    if (!vecs || vecs.length === 0) return 0;
    const clusters = clusterBy(vecs, config.clusterSim).slice(0, config.condenseTopK);
    let added = 0;
    for (const c of clusters) {
      //：每组记忆片段前缀真实时间（[MM-DD HH:MM]），保证 AI 读到的每条记忆带时间标注
      const excerpts = c.items.slice(0, 4).map((i) => {
        const m = mems[i];
        const head = Number(m?.createdAt ?? 0) > 0 ? `[${fmtStamp(Number(m.createdAt))}] ` : '';
        return `${head}${String(m?.content ?? '').slice(0, 120)}`;
      }).join('\n');
      try {
        const text = await llmFor('condense', CONDENSE_PROMPT, `记忆片段：\n${excerpts}`, 120);
        const clean = String(text ?? '').replace(/^[-*•\s]+/, '').trim().slice(0, 80);
        if (!clean) continue;
        const vec = await embedText(clean);
        if (!vec || vec.length === 0) continue;
        // 池内去重（近似文本）
        if (st.pool.some((p) => cosine(p.vec, vec) >= config.clusterSim)) continue;
        st.pool.push({ id: `pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: clean, vec, createdAt: Date.now(), groupCount: c.items.length });
        if (st.pool.length > config.poolCap) st.pool.splice(0, st.pool.length - config.poolCap);
        added++;
      } catch (error) {
        logger.warn(`archive-subconscious: 凝缩失败：${error?.message ?? error}`);
      }
    }
    if (added > 0) { st.stats.condensed += added; markDirty(); }
    return added;
  }

  // ── ②③ 异质碰撞器 + 置信度调度 ──
  function poolPairs() {
    const pairs = [];
    const n = st.pool.length;
    if (n < 2) return pairs;
    let guard = 0;
    while (pairs.length < config.collidePairs && guard++ < 60) {
      const i = Math.floor(Math.random() * n);
      const j = Math.floor(Math.random() * n);
      if (i === j) continue;
      if (cosine(st.pool[i].vec, st.pool[j].vec) < config.cosUnrelated) {
        if (!pairs.some((p) => (p.i === i && p.j === j) || (p.i === j && p.j === i))) pairs.push({ i, j });
      }
    }
    return pairs;
  }

  /** 已有进化建议向量（evolution 账本最近候选；批量 embed，复用）。 */
  async function existingCandidateVecs() {
    try {
      const evolution = ctx.get('evolution');
      const view = await evolution?.view?.(30);
      const records = Array.isArray(view?.records) ? view.records : [];
      const texts = records.filter((r) => r?.type === 'suggest' && r?.candidate?.content).map((r) => String(r.candidate.content).slice(0, 300)).slice(0, 20);
      if (texts.length === 0) return [];
      const vecs = await embedText(texts);
      return (Array.isArray(vecs) ? vecs : []).filter((v) => v && v.length > 0);
    } catch { return []; }
  }

  /** 最近 3 条已采纳进化建议向量（approve/auto-apply；供"梯度方向一致"判定，复用批量 embed）。 */
  async function recentAppliedVecs() {
    try {
      const evolution = ctx.get('evolution');
      const view = await evolution?.view?.(30);
      const records = Array.isArray(view?.records) ? view.records : [];
      const texts = records.filter((r) => (r?.type === 'approve' || r?.type === 'auto-apply') && r?.candidate?.content).map((r) => String(r.candidate.content).slice(0, 300)).slice(0, 3);
      if (texts.length === 0) return [];
      const vecs = await embedText(texts);
      return (Array.isArray(vecs) ? vecs : []).filter((v) => v && v.length > 0);
    } catch { return []; }
  }

  /** 碰撞一轮：生成草案 + 评级 + 调度。 */
  async function collideOnce(pair) {
    const a = st.pool[pair.i]; const b = st.pool[pair.j];
    let trajectory = [];
    try {
      const cons = ctx.get('consistency');
      trajectory = Array.isArray(cons?.trajectoryText?.(5)) ? cons.trajectoryText(5) : [];
    } catch { /* 轨迹不可用则跳过自洽参照 */ }
    const text = await llmFor('collide', collidePrompt(a.text, b.text, trajectory), '', 500);
    let parsed = null;
    let parseError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const matched = String(text).match(/\{[\s\S]*\}/);
        if (!matched) throw new Error('无 JSON');
        parsed = JSON.parse(matched[0]);
        break;
      } catch (error) {
        parseError = error;
        if (attempt === 0) { /* 重试一次（附纠正提示由上层调用方处理，此处直接重解析原文） */ }
      }
    }
    if (!parsed) throw parseError ?? new Error('草案解析失败');
    const draft = parsed.draft;
    const selfConsistency = Math.max(0, Math.min(100, Math.round(Number(parsed.selfConsistency ?? 0))));
    if (!draft || !draft.content || !['persona-add', 'skill-create', 'skill-improve'].includes(draft.type)) {
      throw new Error('草案形状不合法');
    }
    //  persona-add 的 section 须为六人格分区之一（LLM 输出不可控，
    // 非法 section 会让审批/自动应用在 persona.set 才报错——前置拦截判 skip）
    if (draft.type === 'persona-add' && !['identity', 'values', 'traits', 'style', 'directives', 'capabilities'].includes(draft.section)) {
      st.stats.skips++;
      st.drafts.push({ id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, candidateId: null, a: a.text, b: b.text, draft, selfConsistency, novelty: null, gradient: false, verdict: 'skip-bad-section', at: Date.now() });
      markDirty();
      return { verdict: 'skip-bad-section', reason: '非法 section' };
    }
    // 新颖度：与已有进化建议向量的最大差异（1 - 最大余弦）
    const vec = await embedText(String(draft.content).slice(0, 300));
    const existing = await existingCandidateVecs();
    let novelty = 100;
    if (existing.length > 0) {
      const maxCos = Math.max(...existing.map((v) => cosine(vec, v)));
      novelty = Math.max(0, Math.min(100, Math.round((1 - maxCos) * 100)));
    }
    // 梯度方向一致：与最近 3 条已采纳建议的平均余弦 ≥ gradientSim
    const applied = await recentAppliedVecs();
    let gradient = false;
    if (applied.length > 0) {
      const avgCos = applied.reduce((s, v) => s + cosine(vec, v), 0) / applied.length;
      gradient = avgCos >= config.gradientSim;
    }
    // 调度（用户设计：高优先级与自动微调是两条独立判定）
    //  - 高优先级：自洽≥80 且新颖≥60 → 待审批队列顶部（importCandidate by='dream'）
    //  - 自动微调（独立）：自洽>95 且梯度一致且开关开（仅 persona）→ 先行执行
    const evolution = ctx.get('evolution');
    const candidateObj = { type: draft.type, section: draft.section, content: draft.content, rationale: draft.rationale };
    let candidateId = null;
    let verdict = 'skip';
    const doImport = () => {
      const r = evolution?.importCandidate?.(candidateObj, 'dream');
      if (r?.candidateId) { candidateId = r.candidateId; st.stats.imported++; }
      return candidateId;
    };
    if (config.autoApply && selfConsistency > config.selfConsistencyAuto && gradient && draft.type === 'persona-add') {
      //  补强：doImport 的安全门/section 校验可能抛错——包 try，被拒草案记录 skip 而非整次碰撞失败
      try { doImport(); } catch (error) {
        logger.warn(`archive-subconscious: 草案被进化队列拒绝：${error?.message ?? error}`);
        st.stats.skips++;
      }
      if (candidateId) {
        try {
          const ar = await evolution?.autoApply?.(candidateId, { by: 'dream' });
          if (ar?.applied === true) {
            st.stats.autoApplied++;
            verdict = 'auto-applied';
            //  补缺：用户设计"仅在通知和自进化栏显示"——自动微调须发通知
            try {
              const notify = ctx.get('notify');
              const p = notify?.send?.({ content: `🌙 灵感进化已自动微调（自洽 ${selfConsistency}，与近期进化方向一致）：${String(draft.content).slice(0, 80)}（自进化栏可回滚）`, source: 'subconscious', scope: 'panel' });
              if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch { /* 通知失败不阻断 */ }
          }
        } catch (error) {
          logger.warn(`archive-subconscious: 自动微调失败（保留待审批）：${error?.message ?? error}`);
        }
      }
    } else if (selfConsistency >= config.selfConsistencyHigh && novelty >= config.noveltyHigh) {
      try { if (doImport()) verdict = 'high'; } catch (error) {
        logger.warn(`archive-subconscious: 草案被进化队列拒绝：${error?.message ?? error}`);
        st.stats.skips++;
      }
    }
    st.drafts.push({ id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, candidateId, a: a.text, b: b.text, draft, selfConsistency, novelty, gradient, verdict, at: Date.now() });
    if (st.drafts.length > config.draftsCap) st.drafts.splice(0, st.drafts.length - config.draftsCap);
    st.stats.collisions++;
    markDirty();
    return { verdict, selfConsistency, novelty, gradient, content: draft.content };
  }

  /** 梦境引擎主流程（睡眠期进入时触发一次；串行防重入）。 */
  let engineRunning = false;
  async function runDreamEngine() {
    if (!st.enabled || engineRunning) return { skipped: true, reason: 'disabled-or-running' };
    engineRunning = true;
    st.stats.runs++;
    st.lastRunAt = Date.now();
    try {
      const added = await condense();
      if (st.pool.length < 2) return { skipped: true, reason: 'pool-too-small', condensed: added };
      const results = [];
      for (const pair of poolPairs()) {
        try { results.push(await collideOnce(pair)); } catch (error) {
          st.stats.skips++;
          logger.warn(`archive-subconscious: 碰撞失败：${error?.message ?? error}`);
        }
      }
      return { ok: true, condensed: added, results };
    } catch (error) {
      logger.warn(`archive-subconscious: 梦境引擎失败：${error?.message ?? error}`);
      return { skipped: true, error: error.message };
    } finally {
      engineRunning = false;
      markDirty();
    }
  }

  // ── ④ 梦境日志回放 ──
  async function generateWhisper(reason) {
    if (!st.enabled) return { skipped: true, reason: 'disabled' };
    try {
      const material = [
        ...st.pool.slice(-3).map((p) => `原型：${p.text}`),
        ...st.drafts.slice(-3).map((d) => `灵感草案：${d.draft?.content ?? ''}`),
      ].filter(Boolean).join('\n');
      if (!material) {
        // 无素材：呓语退化（简短句）
        st.whisper = { text: '昨夜无梦，一片安眠。', vec: null, at: Date.now(), reason, consumed: false };
        st.stats.whispers++;
        markDirty();
        return { ok: true, text: st.whisper.text };
      }
      const text = await llmFor('whisper', whisperPrompt(material), '', 120);
      const clean = String(text ?? '').replace(/^["'“”\s]+|["'“”\s]+$/g, '').trim().slice(0, 80);
      const vec = await embedText(clean).catch(() => null);
      st.whisper = { text: clean, vec, at: Date.now(), reason, consumed: false };
      st.stats.whispers++;
      markDirty();
      bootLine(`[archive-subconscious] 梦境呓语：${clean}`);
      return { ok: true, text: clean };
    } catch (error) {
      logger.warn(`archive-subconscious: 呓语生成失败：${error?.message ?? error}`);
      return { skipped: true, error: error.message };
    }
  }

  // 用户最近真实消息（供呓语话题相关性判断；与 loop 的 latestUserInput 同款）
  let lastUserText = '';
  let lastUserTextAt = 0;

  // ── Phi-3:mini 模型管理 ──
  async function modelStatus() {
    try {
      const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { installed: false, name: config.phiModel, error: `ollama HTTP ${res.status}` };
      const j = await res.json();
      const m = (Array.isArray(j.models) ? j.models : []).find((x) => String(x.name ?? '').startsWith(config.phiModel));
      return { installed: Boolean(m), name: config.phiModel, sizeMb: m ? Math.round(Number(m.size ?? 0) / 1048576) : 0, downloading };
    } catch (error) {
      return { installed: false, name: config.phiModel, error: error.message, downloading };
    }
  }

  /** 后台消费 pull 流（2GB 拉取不阻塞 RPC；downloading 标志反映进度）。 */
  async function consumePullStream(body) {
    try {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const line = decoder.decode(value, { stream: true }).trim();
        try { if (line && JSON.parse(line).status === 'success') break; } catch { /* 进度行忽略 */ }
      }
    } catch { /* 拉取中断 */ } finally { downloading = false; }
  }

  async function modelDownload() {
    if (downloading) return { started: false, reason: 'downloading' };
    downloading = true;
    try {
      const res = await fetch(`${config.ollamaBaseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.phiModel }),
      });
      if (!res.ok) { downloading = false; return { started: false, ok: false, status: res.status }; }
      //  流消费转后台任务（此前阻塞 control RPC 直到 2GB 拉完）
      if (res.body) void consumePullStream(res.body);
      else downloading = false;
      return { started: true, ok: true };
    } catch (error) {
      downloading = false;
      return { started: false, ok: false, error: error.message };
    }
  }

  async function modelRemove() {
    try {
      //  本地 ollama 短操作加 15s 超时（不可达时快速失败而非挂起 RPC）
      const res = await fetch(`${config.ollamaBaseUrl}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.phiModel }),
        signal: AbortSignal.timeout(15000),
      });
      return { removed: res.ok || res.status === 404, status: res.status };
    } catch (error) {
      return { removed: false, error: error.message };
    }
  }

  // ── 服务 API ──
  const api = {
    state: () => ({
      enabled: st.enabled,
      autoApply: config.autoApply,
      condenseModel: config.condenseModel,
      llmModel: config.llmModel,
      poolCount: st.pool.length,
      draftCount: st.drafts.length,
      whisper: st.whisper ? { text: st.whisper.text, at: st.whisper.at, reason: st.whisper.reason, consumed: st.whisper.consumed } : null,
      lastRunAt: st.lastRunAt,
      engineRunning,
      downloading,
      stats: { ...st.stats },
      thresholds: {
        highFreqMin: config.highFreqMin, condenseTopK: config.condenseTopK, cosUnrelated: config.cosUnrelated,
        selfConsistencyHigh: config.selfConsistencyHigh, noveltyHigh: config.noveltyHigh,
        selfConsistencyAuto: config.selfConsistencyAuto, whisperSim: config.whisperSim,
      },
    }),
    stats: () => ({ ...st.stats, poolCount: st.pool.length, draftCount: st.drafts.length, lastRunAt: st.lastRunAt }),
    log: (limit = 20) => {
      const n = Math.max(1, Math.min(50, Number(limit) || 20));
      return {
        drafts: st.drafts.slice(-n).map((d) => ({ at: d.at, verdict: d.verdict, selfConsistency: d.selfConsistency, novelty: d.novelty, gradient: d.gradient, a: d.a, b: d.b, content: d.draft?.content, rationale: d.draft?.rationale })),
        pool: st.pool.slice(-10).map((p) => ({ text: p.text, groupCount: p.groupCount, createdAt: p.createdAt })),
      };
    },
    configure: (patch = {}) => {
      if (typeof patch.enabled === 'boolean') { st.enabled = patch.enabled; markDirty(); }
      //  运行时覆盖写入 st.overrides 持久化（重启保持）
      if (typeof patch.autoApply === 'boolean') {
        config.autoApply = patch.autoApply;
        st.overrides.autoApply = patch.autoApply;
        markDirty();
      }
      if (patch.condenseModel !== undefined) {
        if (!['phi', 'deepseek'].includes(patch.condenseModel)) throw new Error('condenseModel 必须是 phi 或 deepseek');
        config.condenseModel = patch.condenseModel;
        st.overrides.condenseModel = patch.condenseModel;
        markDirty();
      }
      if (patch.llmModel !== undefined) {
        if (!['phi', 'deepseek'].includes(patch.llmModel)) throw new Error('llmModel 必须是 phi 或 deepseek');
        config.llmModel = patch.llmModel;
        st.overrides.llmModel = patch.llmModel;
        markDirty();
      }
      return api.state();
    },
    /** 手动触发一次梦境引擎（测试/演示；与睡眠期触发同路径）。 */
    run: () => runDreamEngine(),
    model: () => modelStatus(),
    /**
     * 运行时信息（无网络调用）：本项目会加载的本地模型名 + ollama 地址。
     *：作为关闭流程释放显存副本（keep_alive=0）的模型名唯一事实源，
     * 避免 control 侧硬编码模型名后在配置变更时失配。
     */
    runtimeInfo: () => ({ phiModel: config.phiModel, ollamaBaseUrl: config.ollamaBaseUrl }),
    modelDownload,
    modelRemove,
    /** 测试入口：直接生成呓语。 */
    _whisper: (reason = 'manual') => generateWhisper(reason),
    close: () => { try { flush(); } catch { /* 关闭兜底 */ } },
  };
  ctx.provide('subconscious', api);

  // ── 事件接线 ──
  // 睡眠期进入 → 梦境引擎；睡眠期结束（苏醒）→ 梦境呓语
  ctx.on('archive/sleep-phase', (payload) => {
    try {
      const phase = payload?.phase;
      if (phase === 'asleep') {
        void runDreamEngine().catch(() => {});
      } else if (phase === 'awake') {
        void generateWhisper(String(payload?.reason ?? 'woke')).catch(() => {});
      }
    } catch { /* 事件处理失败不阻断 */ }
  });
  // 用户真实消息缓存（呓语话题相关性判断）
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'user/message' && event?.data?.source?.kind === 'user') {
        const content = Array.isArray(event.data.content) ? event.data.content : [];
        const txt = content.filter((b) => b?.type === 'text' && b.text).map((b) => String(b.text)).join('\n').trim();
        if (txt && !txt.startsWith('Current runtime context')) { lastUserText = txt; lastUserTextAt = Date.now(); }
      }
    } catch { /* ignore */ }
  });
  // 回合开始：呓语话题相关才注入（"Current runtime context（潜意识呓语）"前缀不上屏）
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/start') return;
      if (!st.enabled || !st.whisper || st.whisper.consumed) return;
      if (Date.now() - st.whisper.at > config.whisperTtlMs) {
        //  TTL 过期标记须持久化（此前缺 markDirty）
        st.whisper.consumed = true;
        markDirty();
        return;
      }
      const text = st.whisper.text;
      if (!text || !lastUserText || Date.now() - lastUserTextAt > 600000) return;
      // 话题相关性：用户输入向量 vs 呓语向量（免费；呓语无向量则放行注入一次）
      if (st.whisper.vec) {
        void (async () => {
          try {
            const uv = await embedText(lastUserText.slice(0, 200)).catch(() => null);
            //  await 后复查 consumed/TTL——竞态下两条异步路径可能双注入
            if (!st.enabled || !st.whisper || st.whisper.consumed || Date.now() - st.whisper.at > config.whisperTtlMs) return;
            if (uv && cosine(uv, st.whisper.vec) < config.whisperSim) return;
            injectWhisper(session, text);
          } catch { /* 判断失败静默 */ }
        })();
      } else {
        injectWhisper(session, text);
      }
    } catch { /* ignore */ }
  });
  function injectWhisper(session, text) {
    try {
      session.append('user/message', {
        content: [{ type: 'text', text: `Current runtime context（潜意识呓语）：${text}` }],
        source: { kind: 'plugin', provider: 'subconscious-whisper' },
      }, { surfaceOp: 'append' });
      st.whisper.consumed = true;
      st.stats.injects++;
      markDirty();
    } catch (error) {
      logger.warn(`archive-subconscious: 呓语注入失败：${error?.message ?? error}`);
    }
  }

  // 兜底定时 flush
  ctx.timer.setInterval(() => { try { flush(); } catch { /* ignore */ } }, 5 * 60000);

  bootLine(`[archive-subconscious] ready pool=${st.pool.length} drafts=${st.drafts.length} enabled=${st.enabled} 凝缩=${config.condenseModel} 碰撞/呓语=${config.llmModel} autoApply=${config.autoApply}`);
  return { api };
}
