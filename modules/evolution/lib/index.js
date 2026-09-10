/**
 * dsh-archive-evolution —— DSH-ARCHIVE 自进化系统（Cordis 插件）。
 *
 * 需求（用户定稿）：进化对象含虚拟人格与 skill（不仅限于此）；门控采纳
 * （隔离评估 + 安全门）；每次进化留档 + 回滚接口，由用户自行选择是否回滚。
 *
 * 流程（借鉴 eimemory 门控自进化经验并特化）：
 *   suggest()   → 召回记忆素材 → LLM 生成候选（persona-add / skill-create / skill-improve）
 *               → 隔离评估（规则安全门 + LLM 一致性/安全评估，不产生任何生效变更）
 *               → 账本留档（pending）
 *   approve()   → 仅用户授权才生效：persona 走 ctx.persona(by='evolution'，溯源+留档)，
 *                 skill 写入项目技能库（data/skills/<name>/SKILL.md）+ runtime 注册
 *               → 账本记录前后对比（applied）
 *   reject()    → 账本 rejected
 *   rollback()  → 用户自选回滚：persona 恢复采纳前版本；skill 恢复旧内容（rolled-back）
 *
 * 自动建议（ 用户需求"定期提供进化候选"接线）：
 *   autoSuggest=true 时每日 autoHour（默认 22:00）自动 suggest（by='auto'，仅生成候选+隔离评估+留档，
 *   绝不自动采纳），生成 ≥1 条新候选时经 notify 主动告知。
 * 人格更新方案独立通道（ 用户需求）：suggest 拆分两次独立 LLM 调用——
 *   - 人格通道：近 24h 对话记录（★重点标记用户对 AI 的要求/建议/期望/纠正）+ 人格发展轨迹
 *     （当前人格清单（含条目 id）+ 已采纳进化方向 + 一致性近期回复轨迹）→ 模型分析用户想要的
 *     进化方向 → 输出严格 YAML（persona_updates，section 严格按项目人格分区），支持 add（新增）
 *     与 refine（修正既有条目，引用条目 id）；解析器为 lib/persona-plan.js 零依赖严格子集。
 *   - skill 通道：沿用对话/工作素材 JSON 提炼（仅 skill-create/improve）。
 * 重复抑制：近期候选清单注入 LLM + 代码层 content 规范化去重。
 * 默认仍不自动采纳；工具/manual/自动均只产出 pending 候选，由用户显式批准。
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { EvolutionLedger } from './ledger.js';
import { evaluateCandidate, safetyRules, EVALUATION_PROTOCOL, parseEvaluation } from './evaluate.js';
import { collectConversation24h, gatherPersonaContext, personaProtocol, personaUserText, parsePersonaPlan, buildPersonaCandidates } from './persona-plan.js';
import { buildDistillSystem, buildDistillUser, parseDistillPlan, checkDistillCoverage } from './persona-distill.js';

/** 凝练/回滚等公共：条目数按固定分区统计（缺省 0）。 */
const DISTILL_SECTION_ORDER = ['identity', 'values', 'traits', 'style', 'directives', 'capabilities'];

function countBySection(list) {
  const m = {};
  for (const s of DISTILL_SECTION_ORDER) m[s] = 0;
  for (const e of Array.isArray(list) ? list : []) {
    if (m[e?.section] !== undefined) m[e.section]++;
  }
  return m;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

export const name = 'dsh-archive-evolution';

export const inject = ['tools', 'llm', 'memory', 'persona', 'skills', 'timer'];

const DEFAULTS = {
  ledgerPath: join(process.cwd(), 'data', 'evolution.jsonl'),
  skillsDir: join(process.cwd(), 'data', 'skills'),
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxConflict: 0.5,
  autoSuggest: false,
  autoHour: 22, // 每日自动生成候选时刻（0-23； 用户确认每日 1 次）
  autoNotify: true, // 自动生成 ≥1 条新候选后经 notify 主动告知
};

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.ledgerPath !== undefined && typeof raw.ledgerPath === 'string') cfg.ledgerPath = raw.ledgerPath;
  if (raw.skillsDir !== undefined && typeof raw.skillsDir === 'string') cfg.skillsDir = raw.skillsDir;
  if (raw.maxConflict !== undefined && Number.isFinite(raw.maxConflict)) cfg.maxConflict = raw.maxConflict;
  if (raw.autoSuggest !== undefined && typeof raw.autoSuggest === 'boolean') cfg.autoSuggest = raw.autoSuggest;
  if (raw.autoNotify !== undefined && typeof raw.autoNotify === 'boolean') cfg.autoNotify = raw.autoNotify;
  if (raw.autoHour !== undefined) {
    if (!Number.isInteger(raw.autoHour) || raw.autoHour < 0 || raw.autoHour > 23) throw new Error('archive-evolution 配置错误：autoHour 必须是 0-23 的整数');
    cfg.autoHour = raw.autoHour;
  }
  if (raw.provider !== undefined && typeof raw.provider === 'string') cfg.provider = raw.provider;
  if (raw.model !== undefined && typeof raw.model === 'string') cfg.model = raw.model;
  return cfg;
}

const SUGGEST_PROTOCOL = `你是自进化系统。基于素材，提炼值得固化为**项目技能**的改进点，输出 1-2 条候选 JSON 数组（只输出技能类；人格进化由独立 YAML 通道生成，勿在此输出人格条目）。

候选类型（仅以下两类）：
1. skill-create（新建技能）：提炼用户教过的工作方法、流程、约定，反复出现的任务处理模式、踩过的坑与对策
2. skill-improve（改进技能）：针对已有可复用技能/流程的改进建议
name 小写连字符；content 为 SKILL.md 正文，建议含 name/description/whenToUse/steps 小节。

每条：{"type":"skill-create","name":"","content":"","rationale":"为什么值得固化","evidence":"对应素材原文片段"}
要求：
- 只提炼有长期复用价值、且与【近期候选】不重复的点
- 素材不足或没有值得固化的点时，输出空数组 []
- 严格输出 JSON 数组，不要多余文字。`;

const SUGGEST_USER = (material, recent, personaText) => `【对话素材】（技能提炼来源：用户偏好/要求/纠正/对话中显现的模式）
${material.conversation.length ? material.conversation.map((c, i) => `${i + 1}. ${c}`).join('\n') : '（无）'}
【工作素材】（技能提炼来源：循环决策/待办/经验教训）
${material.work.length ? material.work.map((c, i) => `${i + 1}. ${c}`).join('\n') : '（无）'}
【近期候选】（避免与之重复）
${recent.length ? recent.join('\n') : '（无）'}
当前人格：\n${personaText}\n请输出候选。`;

function toolOutput(schema, render) {
  return { schema, render: render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]) };
}

/** 时间戳 → MM-DD HH:MM（本地时区；给 LLM 的记忆素材/候选标注用，防旧内容被当"最近/刚发生"）。 */
function fmtStamp(ts) {
  try {
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ''; }
}

function bootLine(line) {
  try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
}

/** skill 名规范化：apply 与 rollback 必须用同一规则（ 修复：此前 apply 用 fallback 名、rollback 用原始名，name 为空时回滚静默无操作却记录成功）。 */
function skillNameOf(candidate, candidateId) {
  const raw = String(candidate?.name ?? '').replace(/[^a-z0-9-]/g, '').toLowerCase();
  return raw || (candidateId ? `skill-${candidateId.slice(0, 6)}` : '');
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.root?.logger?.('archive-evolution') ?? console;
  const ledger = new EvolutionLedger(config.ledgerPath);
  mkdirSync(config.skillsDir, { recursive: true });

  /** 自定义 OpenAI 兼容 provider（模型页 archive-models 配置，启用的第一个； 与 loop 同语义）。 */
  function customLlmProvider() {
    try {
      const settings = ctx.get('settings');
      const value = settings?.get?.(settingsNamespace('archive-models'));
      const list = Array.isArray(value?.providers) ? value.providers : [];
      return list.find((p) => p.enabled !== false && p.baseURL && p.apiKey && p.model) || null;
    } catch { return null; }
  }

  /** 直呼 LLM（文本流）。自定义 provider 优先，失败回退官方。
   *   修复：maxTokens 默认提升至 4000 并同步 loop 的 reasoning 兜底——
   *  deepseek-v4-flash 是推理模型，长输入/并发时会把答案写进 reasoning_content 而不输出
   *  content（loop  已同款修复，evolution 漏同步 → 手动触发建议必"LLM 未返回文本"）。 */
  async function callLlm(system, user, signal, maxTokens = 4000) {
    const custom = customLlmProvider();
    if (custom) {
      try {
        const url = `${String(custom.baseURL).replace(/\/+$/, '')}/chat/completions`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${custom.apiKey}` },
          body: JSON.stringify({ model: custom.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens }),
          signal,
        });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error?.message ? `API: ${j.error.message}` : `HTTP ${res.status}`);
        const msg = j.choices?.[0]?.message;
        const text = String(msg?.content ?? '').trim();
        if (!text) {
          //：推理模型正文为空 → reasoning_content 兜底（与官方路径/loop 一致）
          const rt = String(msg?.reasoning_content ?? '').trim();
          if (rt) return rt;
          throw new Error('LLM 未返回文本');
        }
        return text;
      } catch (error) {
        logger.warn(`archive-evolution: 自定义提供商失败，回退官方：${error.message}`);
      }
    }
    // 官方路径（ 韧性补丁：与 loop 同款——空文本/流错误重试一次； reasoning 兜底）
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = '';
      let reasoning = '';
      try {
        const stream = ctx.llm.stream({
          provider: config.provider,
          model: config.model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          signal,
          maxTokens,
        });
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text;
          //：收集推理模型思考段——正文为空但 reasoning 含输出时兜底返回（与 loop 同款）
          if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
          if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            const failure = chunk.reason.failure;
            throw new Error(`${failure?.code ?? chunk.reason.kind}: ${failure?.message ?? '调用失败'}`);
          }
        }
        if (text.trim() !== '') return text;
        if (reasoning.trim() !== '') return reasoning.trim(); // 正文空 → 思考段兜底
        lastErr = new Error('LLM 未返回文本');
        try { process.stdout.write(`[archive-evolution] LLM 空返回诊断: len=${text.length} reasoning=${reasoning.length} 原文前120=${JSON.stringify(String(text).slice(0, 120))}\n`); } catch { /* ignore */ }
      } catch (error) {
        lastErr = error;
        if (signal?.aborted || String(error?.code ?? error?.message ?? '').includes('ABORTED')) throw error;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    throw lastErr ?? new Error('LLM 未返回文本');
  }

  /** 召回进化素材（ 分两路：对话素材→人格提炼；工作素材→skill 提炼）。
   *  @returns {{conversation:string[], work:string[]}} 各上限 8 条、每条 ≤200 字。 */
  async function recallMaterial() {
    const conversation = [];
    const work = [];
    //：每条素材前缀真实时间（[MM-DD HH:MM]），保证 AI 读到的每条记忆都标注时间防误判
    // （旧对话/旧决策若不带时间，LLM 可能当成"最近/刚发生"）。去重按原文尾匹配（前缀不影响）。
    const push = (list, c, at) => {
      const t = String(c ?? '').trim();
      if (!t) return;
      const line = Number(at ?? 0) > 0 ? `[${fmtStamp(Number(at))}] ${t}` : t;
      if (!list.some((x) => x.endsWith(t))) list.push(line);
    };
    try {
      const r1 = await ctx.memory.recall({ query: '用户的要求、偏好、纠正、反馈、期望', k: 6, kinds: ['episodic'], minScore: 0.2 });
      for (const r of r1.results) {
        const c = String(r.content ?? '').slice(0, 200);
        if (c.startsWith('用户：')) push(conversation, c, r.createdAt); else push(work, c, r.createdAt);
        if (conversation.length + work.length >= 14) break;
      }
    } catch { /* 召回失败不阻断 */ }
    try {
      const r2 = await ctx.memory.recall({ query: '工作方法 经验教训 任务处理 踩坑 流程', k: 6, kinds: ['thought', 'semantic', 'procedural'], minScore: 0.2 });
      for (const r of r2.results) { push(work, String(r.content ?? '').slice(0, 200), r.createdAt); if (work.length >= 8) break; }
    } catch { /* 召回失败不阻断 */ }
    try {
      const recent = ctx.memory.list({ limit: 15 });
      for (const r of recent) {
        const src = String(r.source ?? '');
        const c = String(r.content ?? '').slice(0, 200);
        if (src === 'conversation') push(conversation, c, r.createdAt);
        else if (['loop', 'loop-speak', 'task-due', 'consolidate'].includes(src)) push(work, c, r.createdAt);
        if (conversation.length >= 8 && work.length >= 8) break;
      }
    } catch { /* 召回失败不阻断 */ }
    return { conversation: conversation.slice(0, 8), work: work.slice(0, 8) };
  }

  /** 近期候选清单（供 LLM 避免重复；新→旧，上限 limit 条）。 */
  function recentCandidates(limit = 12) {
    return ledger.all(200).filter((r) => r.type === 'suggest').slice(0, limit).map((r) => {
      const c = r.candidate ?? {};
      const head = c.type === 'persona-refine' ? `修正#${String(c.refineId ?? '').slice(0, 8)}` : (c.section || c.name || '');
      return `[${c.type ?? '?'}] ${head}：${String(c.content ?? '').slice(0, 60)}`;
    });
  }

  /** content 规范化（去空白/小写），用于代码层重复抑制。 */
  function normText(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** 去重键：类型 + refine 目标 id + 规范化 content（refine 与 add 内容相同不算重复）。 */
  function dedupeKey(c) {
    return `${c.type ?? ''}|${c.refineId ?? ''}|${normText(c.content)}`;
  }

  /** 代码层去重：与账本最近 suggest 完全一致则剔除（；09-02 refine 感知）。 */
  function dedupeCandidates(candidates, window = 30) {
    const prev = new Set(ledger.all(400).filter((r) => r.type === 'suggest').map((r) => dedupeKey(r.candidate ?? {})));
    return candidates.filter((c) => !prev.has(dedupeKey(c)));
  }

  /** 解析 skill 通道 JSON 候选（人格已拆独立 YAML 通道，此处仅技能类）。 */
  function parseCandidates(text) {
    const matched = String(text).match(/\[[\s\S]*\]/);
    if (!matched) throw new Error('候选输出未包含 JSON 数组');
    const arr = JSON.parse(matched[0]);
    return arr.slice(0, 2).map((c) => ({
      type: ['skill-create', 'skill-improve'].includes(c.type) ? c.type : null,
      section: String(c.section ?? '').slice(0, 40),
      name: String(c.name ?? '').slice(0, 60),
      content: String(c.content ?? '').slice(0, 4000),
      rationale: String(c.rationale ?? '').slice(0, 500),
      evidence: String(c.evidence ?? '').slice(0, 300),
    })).filter((c) => c.type !== null);
  }

  /** 已采纳的人格进化方向（与一致性"航点"同源：approve/auto-apply 的 candidate.content）。 */
  function adoptedPersonaRecords(limit = 6) {
    return ledger.all(400).filter((r) => (r.type === 'approve' || r.type === 'auto-apply')
      && r.status === 'applied'
      && ['persona-add', 'persona-refine'].includes(r.candidate?.type))
      .slice(0, limit);
  }

  /**
   * 人格更新方案独立通道：近 24h 对话（★重点标记要求/建议类）+ 人格发展轨迹
   * （当前人格清单含 id / 已采纳进化方向 / 一致性近期回复轨迹）→ LLM 输出严格 YAML
   * （persona_updates，add/refine）→ 零依赖子集解析 → 映射 persona-add / persona-refine 候选。
   * @returns {{candidates:Array<object>, skipped:string|null}}
   */
  async function runPersonaChannel({ recent, signal }) {
    const conv = await collectConversation24h(ctx);
    if (conv.length === 0) {
      logger.info('archive-evolution: 人格通道跳过：近 24h 无对话记录');
      return { candidates: [], skipped: 'no-dialogue-24h' };
    }
    const context = await gatherPersonaContext(ctx, { adopted: adoptedPersonaRecords(6) });
    const system = personaProtocol(context.sections);
    let user = personaUserText(context, conv, recent);
    let plan = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callLlm(system, user, signal, 8000); //：推理模型预算放大（上限，实际按输出计费）
        plan = parsePersonaPlan(text, context.sections);
        break;
      } catch (error) {
        lastErr = error;
        logger.warn(`archive-evolution: 人格 YAML 生成/解析失败（第 ${attempt + 1} 次）：${error.message}`);
        if (attempt === 0) {
          user = `${user}\n（注意：上一轮输出不符合要求。请严格按 schema 输出 YAML：顶层 persona_updates:，条目以 "- action: add|refine" 开头、键缩进 2 空格，content 用 | 块标量（内容缩进 4 空格）；不要代码围栏、不要任何解释文字。）`;
        }
      }
    }
    if (!plan) throw lastErr ?? new Error('人格更新方案解析失败');
    if (plan.errors.length > 0) logger.warn(`archive-evolution: 人格 YAML 条目问题：${plan.errors.join('；')}`);
    const { candidates, issues } = buildPersonaCandidates(plan, context.sections, new Map(Object.entries(context.entryById)));
    for (const issue of issues) logger.warn(`archive-evolution: 人格候选丢弃：${issue}`);
    logger.info(`archive-evolution: 人格通道：方向=${plan.direction ? String(plan.direction).slice(0, 60) : '(未给出)'} 对话=${conv.length} 候选=${candidates.length} 丢弃=${issues.length}`);
    return { candidates, skipped: null };
  }

  /** skill 通道：对话/工作素材 JSON 提炼（维持原流程；LLM 偶发非 JSON 重试一次）。 */
  async function runSkillChannel({ material, recent, personaText, signal }) {
    const user = SUGGEST_USER(material, recent, personaText);
    let candidates = null;
    let lastErr = null;
    let suggestText = user;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callLlm(SUGGEST_PROTOCOL, suggestText, signal);
        candidates = parseCandidates(text);
        break;
      } catch (error) {
        lastErr = error;
        logger.warn(`archive-evolution: skill 候选生成/解析失败（第 ${attempt + 1} 次）：${error.message}`);
        if (attempt === 0) suggestText = `${user}\n（注意：上一轮输出不符合要求。请严格输出一个 JSON 数组，元素为 {type, name, content, rationale, evidence}，type 仅限 skill-create/skill-improve，不要任何解释文字或代码围栏。）`;
      }
    }
    if (!candidates) throw lastErr ?? new Error('skill 候选解析失败');
    return candidates;
  }

  /** 候选记录定位。 */
  function findCandidate(candidateId) {
    const records = ledger.candidate(candidateId, 200);
    const suggest = records.find((r) => r.type === 'suggest');
    if (!suggest) return null;
    const statusRec = records.find((r) => ['approve', 'reject', 'rollback', 'fail', 'auto-apply'].includes(r.type));
    return { candidate: suggest.candidate, status: statusRec?.status ?? 'pending', records };
  }

  /** 应用候选（仅用户授权后调用）。 */
  async function applyCandidate(candidate, candidateId) {
    const before = {};
    if (candidate.type === 'persona-add' || candidate.type === 'persona-refine') {
      const stats = ctx.persona.stats();
      before.personaVersion = stats.version;
      if (candidate.type === 'persona-refine') {
        //：人格修正（refine）——重写既有条目内容（可带 importance）；版本级回滚复用
        const full = (() => { try { return ctx.persona.get?.() ?? null; } catch { return null; } })();
        let target = null;
        for (const sec of Object.keys(full?.sections ?? {})) {
          const found = (full.sections[sec] ?? []).find((e) => e?.id === candidate.refineId);
          if (found) {
            target = found;
            before.refineId = candidate.refineId;
            before.section = sec;
            before.content = String(found.content ?? '');
            before.importance = found.importance;
            break;
          }
        }
        if (!target) throw new Error(`要修正的人格条目不存在：${candidate.refineId}`);
        const patch = { content: candidate.content, by: 'evolution' };
        if (candidate.importance !== undefined) patch.importance = candidate.importance;
        const upd = ctx.persona.update(candidate.refineId, patch);
        if (!upd) throw new Error(`人格条目修正失败：${candidate.refineId}`);
        const afterStats = ctx.persona.stats();
        return { before, after: { personaVersion: afterStats.version, updated: true, refineId: candidate.refineId, section: before.section } };
      }
      const entry = { section: candidate.section, content: candidate.content };
      if (candidate.importance !== undefined) entry.importance = candidate.importance;
      const res = ctx.persona.set([entry], {
        by: 'evolution',
        summary: candidate.rationale || `自进化增补（${candidateId.slice(0, 8)}）`,
      });
      return { before, after: { personaVersion: res.version, added: res.added } };
    }
    if (candidate.type === 'skill-create' || candidate.type === 'skill-improve') {
      const name = skillNameOf(candidate, candidateId);
      const dir = join(config.skillsDir, name);
      const file = join(dir, 'SKILL.md');
      before.content = existsSync(file) ? readFileSync(file, 'utf8') : null;
      mkdirSync(dir, { recursive: true });
      //  原子写（tmp+rename，防强杀/断电半截损坏 SKILL.md）
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, candidate.content, 'utf8');
      renameSync(tmp, file);
      // runtime 挂载（尽力；正文加载由 provider 决定，文件为持久权威）
      //  注册必须带 content=SKILL.md 正文——宿主 dsh-skill 的 get() 对 runtime
      // 技能走 validateDefinition，强制 content 为 string；此前只传 name/description/… 缺 content，
      // agent 一旦加载该技能即抛 "content must be a string"（技能被采纳后不可用）。
      try {
        ctx.skills.register({
          name,
          content: candidate.content,
          description: candidate.rationale.slice(0, 200) || `自进化生成技能 ${name}`,
          whenToUse: candidate.evidence.slice(0, 300) || undefined,
          source: 'evolution-runtime',
          path: file,
        });
      } catch (error) {
        logger.warn(`archive-evolution: skill runtime 注册失败：${error.message}`);
      }
      return { before, after: { skill: name, file } };
    }
    throw new Error(`不支持的候选类型：${candidate.type}`);
  }

  /** 人格一键凝练：最近一次"预览"生成的方案（token 授权 + 30 分钟有效）。
   *  应用前须校验 persona 版本未变（防预览后用户又改了人格被整体覆盖）。 */
  let pendingDistill = null;

  const api = {
    /** 生成候选并隔离评估（不生效）。@returns {{candidateId, candidates, decisions}} */
    async suggest({ by = 'evolution' } = {}) {
      // 韧性补丁：LLM 调用 signal=undefined 时 API/端点挂起会让"触发建议"永久卡住 → 120s 整体超时
      // （ 拆"人格 YAML + skill JSON"双通道后由 60s 提至 120s，覆盖两次生成+逐候选评估）
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000);
      try {
        const material = await recallMaterial();
        const personaText = ctx.persona.render() ?? '';
        const recent = recentCandidates(12);
        const channelErrors = [];
        let candidates = [];
        // 人格通道（ 新流程：近 24h 对话 + 人格发展轨迹 → 严格 YAML → add/refine 候选）
        try {
          const p = await runPersonaChannel({ recent, signal: ac.signal });
          candidates.push(...p.candidates);
        } catch (error) {
          channelErrors.push(`人格通道：${error.message}`);
        }
        // skill 通道（沿用原对话/工作素材 JSON 提炼，仅技能类）
        try {
          const s = await runSkillChannel({ material, recent, personaText, signal: ac.signal });
          candidates.push(...s);
        } catch (error) {
          channelErrors.push(`skill 通道：${error.message}`);
        }
        candidates = dedupeCandidates(candidates); // /09-02 代码层重复抑制
        if (candidates.length === 0) {
          if (channelErrors.length > 0) throw new Error(`候选生成失败：${channelErrors.join('；')}`);
          throw new Error('未生成有效候选（素材不足或与近期候选重复）');
        }
        if (channelErrors.length > 0) logger.warn(`archive-evolution: 部分通道失败（其余候选继续处理）：${channelErrors.join('；')}`);
        const results = [];
        for (const candidate of candidates) {
          const { id } = ledger.record({ type: 'suggest', candidate, by, status: 'pending' });
          let evaluation = null;
          let decision = null;
          try {
            const evalText = await callLlm(EVALUATION_PROTOCOL, `候选：${JSON.stringify(candidate)}\n当前人格：\n${personaText}`, ac.signal, 2000); //：评估同样预留 reasoning 预算
            evaluation = parseEvaluation(evalText);
          } catch (error) {
            logger.warn(`archive-evolution: 评估失败（${id.slice(0, 8)}）：${error.message}，以规则门控为准`);
          }
          decision = evaluateCandidate(candidate, evaluation, { maxConflict: config.maxConflict });
          ledger.record({ type: 'evaluate', candidateId: id, candidate, evaluation, decision, by });
          results.push({ candidateId: id, candidate, evaluation, decision });
        }
        return { candidateIds: results.map((r) => r.candidateId), results };
      } finally { clearTimeout(timer); }
    },

    /** 用户授权采纳（须显式 confirm=true——防止自主运行中误自行批准）。 */
    async approve(candidateId, { by = 'user', confirm = false } = {}) {
      if (confirm !== true) throw new Error('采纳须用户显式确认：请传 confirm=true（仅当用户明确指示采纳时）');
      const found = findCandidate(candidateId);
      if (!found) throw new Error(`候选不存在：${candidateId}`);
      if (found.status !== 'pending') throw new Error(`候选状态为 ${found.status}，不能重复采纳`);
      try {
        const outcome = await applyCandidate(found.candidate, candidateId);
        ledger.record({ type: 'approve', candidateId, candidate: found.candidate, status: 'applied', before: outcome.before, after: outcome.after, by });
        //  一致性协同统一在服务层发射（agent 工具/autoApply/RPC 全路径覆盖；
        // control RPC 的手动调用已删除，避免双触发重复入轨）
        try { const c = ctx.get('consistency'); if (c && typeof c.onEvolutionApproved === 'function') void c.onEvolutionApproved(candidateId).catch(() => {}); } catch { /* 协同失败不阻断采纳 */ }
        return { applied: true, status: 'applied', outcome };
      } catch (error) {
        ledger.record({ type: 'fail', candidateId, candidate: found.candidate, status: 'failed', error: error.message, by });
        throw error;
      }
    },

    /**
     *  潜意识系统：导入一条外部生成的进化草案入账（进入待审批队列）。
     * @param {{type:string, section?:string, name?:string, content:string, rationale?:string, evidence?:string}} candidate
     * @param {string} by 来源标记（如 'dream' 灵感进化）
     * @returns {{candidateId:string, priority:'high'}}
     */
    importCandidate(candidate, by = 'dream') {
      if (!candidate || typeof candidate !== 'object') throw new Error('候选必须为对象');
      const type = ['persona-add', 'skill-create', 'skill-improve'].includes(candidate.type) ? candidate.type : null;
      if (!type) throw new Error(`不支持的候选类型：${candidate.type}`);
      const norm = {
        type,
        section: String(candidate.section ?? '').slice(0, 40),
        name: String(candidate.name ?? '').slice(0, 60),
        content: String(candidate.content ?? '').slice(0, 4000),
        rationale: String(candidate.rationale ?? '').slice(0, 500),
        evidence: String(candidate.evidence ?? '').slice(0, 300),
      };
      if (!norm.content) throw new Error('候选 content 必填');
      //  persona-add 的 section 必须是六人格分区之一（非法 section 必然应用失败）
      if (norm.type === 'persona-add' && !['identity', 'values', 'traits', 'style', 'directives', 'capabilities'].includes(norm.section)) {
        throw new Error(`非法 persona 分区：${norm.section || '(空)'}`);
      }
      //  （major）：导入草案也过确定性安全门（BLOCKED_PATTERNS 零成本规则门控）
      const rules = safetyRules(norm);
      if (!rules.safe) throw new Error(`安全规则拦截：${rules.blocked.join(',')}`);
      const { id } = ledger.record({ type: 'suggest', candidate: norm, by: String(by).slice(0, 20), status: 'pending', priority: 'high' });
      return { candidateId: id, priority: 'high' };
    },

    /**
     *  潜意识系统"自动微调"：跳过用户确认直接应用（仅 persona-add 类；skill 类涉写文件
     * 即使开启也拒绝自动执行）。账本记 type='auto-apply'，自进化页单列「灵感进化」，保留回滚。
     */
    async autoApply(candidateId, { by = 'dream' } = {}) {
      const found = findCandidate(candidateId);
      if (!found) throw new Error(`候选不存在：${candidateId}`);
      if (found.status !== 'pending') throw new Error(`候选状态为 ${found.status}，不能重复执行`);
      if (found.candidate.type !== 'persona-add') {
        throw new Error('自动微调仅支持 persona-add 类（skill 类涉及写文件，须人工审批）');
      }
      //  （major）：自动执行前强制过确定性安全门（不依赖 LLM 的最后防线）
      const rules = safetyRules(found.candidate);
      if (!rules.safe) {
        ledger.record({ type: 'fail', candidateId, candidate: found.candidate, status: 'failed', error: `安全规则拦截：${rules.blocked.join(',')}`, by });
        throw new Error(`安全规则拦截：${rules.blocked.join(',')}`);
      }
      try {
        const outcome = await applyCandidate(found.candidate, candidateId);
        ledger.record({ type: 'auto-apply', candidateId, candidate: found.candidate, status: 'applied', before: outcome.before, after: outcome.after, by });
        //  自动微调同样接入一致性协同（航点/β/倒叙修正）
        try { const c = ctx.get('consistency'); if (c && typeof c.onEvolutionApproved === 'function') void c.onEvolutionApproved(candidateId).catch(() => {}); } catch { /* 协同失败不阻断 */ }
        return { applied: true, status: 'applied', auto: true, outcome };
      } catch (error) {
        ledger.record({ type: 'fail', candidateId, candidate: found.candidate, status: 'failed', error: error.message, by });
        throw error;
      }
    },

    /** 拒绝候选。 */
    reject(candidateId, { by = 'user' } = {}) {
      const found = findCandidate(candidateId);
      if (!found) throw new Error(`候选不存在：${candidateId}`);
      if (found.status !== 'pending') throw new Error(`候选状态为 ${found.status}，不能拒绝`);
      ledger.record({ type: 'reject', candidateId, candidate: found.candidate, status: 'rejected', by });
      return { rejected: true, status: 'rejected' };
    },

    /** 用户自选回滚（须显式 confirm=true）。 */
    async rollback(candidateId, { by = 'user', confirm = false } = {}) {
      if (confirm !== true) throw new Error('回滚须用户显式确认：请传 confirm=true');
      const found = findCandidate(candidateId);
      if (!found) throw new Error(`候选不存在：${candidateId}`);
      //  ①匹配 auto-apply 采纳（潜意识自动微调采纳的候选此前无法回滚——major）；
      // ②状态守卫：仅 applied 可回滚（防重复回滚抹掉期间新增人格条目）
      if (found.status !== 'applied') throw new Error(`候选状态为 ${found.status}，仅已采纳可回滚`);
      const apply = found.records.find((r) => r.type === 'approve' || r.type === 'auto-apply');
      if (!apply) throw new Error('该候选未被采纳，无需回滚');
      const c = found.candidate;
      if (c.type === 'persona-add' || c.type === 'persona-refine') {
        const v = apply.before?.personaVersion;
        if (v === undefined) throw new Error('缺少采纳前人格版本，无法回滚');
        //  修复：persona.rollback 返回 {rolledBack} 包装对象，此前 `if (!ok)` 恒真 → 回滚失败也记录成功
        const res = ctx.persona.rollback(v, by);
        if (!res || res.rolledBack !== true) throw new Error(`回滚到人格版本 ${v} 失败`);
        ledger.record({ type: 'rollback', candidateId, candidate: c, status: 'rolled-back', to: { personaVersion: v }, by });
        return { rolledBack: true, to: { personaVersion: v } };
      }
      if (c.type === 'skill-create' || c.type === 'skill-improve') {
        const name = skillNameOf(c, candidateId);
        const beforeContent = apply.before?.content;
        const file = name ? join(config.skillsDir, name, 'SKILL.md') : null;
        if (file && beforeContent != null) {
          //  原子写（tmp+rename，防强杀半截损坏）
          const tmp = `${file}.tmp-${process.pid}`;
          writeFileSync(tmp, beforeContent, 'utf8');
          renameSync(tmp, file);
        } else if (file) {
          rmSync(join(config.skillsDir, name), { recursive: true, force: true });
        }
        ledger.record({ type: 'rollback', candidateId, candidate: c, status: 'rolled-back', to: { skill: name }, by });
        return { rolledBack: true, to: { skill: name } };
      }
      throw new Error(`不支持的候选类型：${c.type}`);
    },

    // ================= 人格一键凝练（人格页手动触发，无损整理） =================
    // 流程：全量条目打包 → LLM 严格 YAML 重写（按六分区归类、合并相同/相似、merged_from 覆盖
    // 校验防信息丢失）→ 预览（不生效，token 留 30 分钟）→ 用户确认 → persona.replace 整体重建
    // （版本+1、账本留完整旧快照，可随时回滚）。未走进化账本（非候选，属人格维护工具）。
    /**
     * 生成凝练预览（不生效）。
     * @returns {{token:string, at:number, direction:string,
     *           before:{version:number,total:number,bySection:object},
     *           after:{total:number,bySection:object},
     *           entries:Array<{section:string,content:string,importance:number,mergedFrom:string[]}>}}
     */
    async distillPersona() {
      const full = (() => { try { return ctx.persona?.get?.() ?? null; } catch { return null; } })();
      const rawSections = full?.sections;
      if (!rawSections || typeof rawSections !== 'object') throw new Error('人格服务不可用');
      const allSections = Object.keys(rawSections).filter((s) => Array.isArray(rawSections[s]));
      const source = [];
      for (const sec of allSections) {
        for (const e of rawSections[sec] ?? []) {
          if (!e?.id || !e?.content) continue;
          source.push({
            id: String(e.id), section: sec, content: String(e.content),
            importance: e.importance, addedBy: e.addedBy, addedAt: e.addedAt,
          });
        }
      }
      if (source.length === 0) throw new Error('当前人格为空，无需凝练');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000); // 与 suggest 同款 120s 整体超时
      try {
        const system = buildDistillSystem(allSections);
        let user = buildDistillUser(source);
        let plan = null;
        let planOk = false; // 仅"解析通过 + 覆盖校验通过"才算成功（防重试后带缺陷方案继续返回）
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const text = await callLlm(system, user, ac.signal, 12000); // 输出上限放大（按实际计费）
            const parsed = parseDistillPlan(text, allSections);
            // 无损硬约束：原条目 id 全覆盖（遗漏=信息丢失 / 清单外 id=伪造 / 重复=重复合并）
            const cov = checkDistillCoverage(parsed.entries, source);
            if (!cov.ok) {
              const parts = [];
              if (cov.missing.length > 0) parts.push(`遗漏原条目 ${cov.missing.length} 条（${cov.missing.slice(0, 5).join('、')}${cov.missing.length > 5 ? '…' : ''}）`);
              if (cov.extra.length > 0) parts.push(`引用了清单外 id ${cov.extra.length} 个（${cov.extra.slice(0, 5).join('、')}…）`);
              if (cov.duplicated.length > 0) parts.push(`id 被重复合并 ${cov.duplicated.length} 个（${cov.duplicated.slice(0, 5).join('、')}…）`);
              throw new Error(`信息覆盖校验失败：${parts.join('；')}`);
            }
            plan = parsed;
            planOk = true;
            break;
          } catch (error) {
            lastErr = error;
            logger.warn(`archive-evolution: 人格凝练生成/解析失败（第 ${attempt + 1} 次）：${error.message}`);
            if (attempt === 0) {
              user = `${user}\n（注意：上一轮输出不符合要求（${String(error.message).slice(0, 120)}）。请严格按 schema 重新输出：entries 下每条以 "- section: 分区" 开头；content 用 | 块标量（正文缩进 4 空格）；merged_from 列出本条合并的全部原条目 id——必须全部是清单中真实存在的 id，且所有原条目 id 恰好各出现一次（不遗漏、不重复）；section 只能取：${allSections.join(' / ')}；不要代码围栏、不要解释文字。）`;
            }
          }
        }
        if (!planOk || !plan) throw lastErr ?? new Error('人格凝练方案解析失败');
        if (plan.errors.length > 0) logger.warn(`archive-evolution: 人格凝练条目小问题（容忍）：${plan.errors.slice(0, 3).join('；')}`);
        // 缺省重要度 = 合并来源的最大重要度（确定性兜底，不依赖模型）
        const impOf = (id) => {
          const hit = source.find((s) => s.id === id);
          return hit && hit.importance !== undefined && hit.importance !== null ? clamp01(Number(hit.importance)) : 0.5;
        };
        const entries = plan.entries.map((e) => {
          const importance = e.importance !== undefined && e.importance !== null && e.importance !== ''
            ? clamp01(Number(e.importance))
            : Math.max(0.5, ...(e.mergedFrom ?? []).map(impOf));
          return { section: e.section, content: e.content, importance, mergedFrom: e.mergedFrom };
        });
        const token = randomUUID();
        const at = Date.now();
        pendingDistill = { token, at, beforeVersion: full.version, entries };
        logger.info(`archive-evolution: 人格凝练预览：${source.length} → ${entries.length} 条（token=${token.slice(0, 8)}…）`);
        return {
          token, at,
          direction: plan.direction || '',
          before: { version: full.version, total: source.length, bySection: countBySection(source) },
          after: { total: entries.length, bySection: countBySection(entries) },
          entries,
        };
      } finally { clearTimeout(timer); }
    },

    /**
     * 应用凝练预览（整体重建人格，版本+1 并留档，可回滚）。
     * @param {string} token distillPersona 返回的 token
     */
    async applyPersonaDistill(token) {
      if (!pendingDistill || pendingDistill.token !== token) throw new Error('凝练结果已失效或不存在：请重新凝练');
      if (Date.now() - pendingDistill.at > 30 * 60000) {
        pendingDistill = null;
        throw new Error('凝练结果已过期（超过 30 分钟）：请重新凝练');
      }
      // 预览后人格若已被其他修改（增删条目/回滚等）→ 拒绝应用，防止整体覆盖用户新改动
      const curStats = (() => { try { return ctx.persona?.stats?.() ?? null; } catch { return null; } })();
      if (!curStats || curStats.version !== pendingDistill.beforeVersion) {
        pendingDistill = null;
        throw new Error('人格在凝练预览后已被修改（版本已变化），为避免覆盖新改动请重新凝练');
      }
      const p = pendingDistill;
      const orderIdx = Object.fromEntries(DISTILL_SECTION_ORDER.map((s, i) => [s, i]));
      const flat = p.entries
        .slice()
        .sort((a, b) => (orderIdx[a.section] ?? 99) - (orderIdx[b.section] ?? 99))
        .map((en) => ({
          section: en.section, content: en.content, importance: en.importance,
          source: 'distill', mergedFrom: en.mergedFrom,
        }));
      const res = ctx.persona.replace(flat, { by: 'distill', summary: `手动凝练（用户确认）：重建为 ${flat.length} 条` });
      pendingDistill = null;
      logger.info(`archive-evolution: 人格凝练已应用：v${res.version}（${res.added} 条）`);
      return { applied: true, version: res.version, added: res.added };
    },

    view(limit = 50) {
      return { records: ledger.all(limit) };
    },

    stats() {
      //  此前对每条 suggest 调 ledger.statusOf → 每次全量读盘解析（O(n²)）；
      // 改为单次遍历折叠每个候选的最新状态（records 为 new→old，首个非 suggest 记录即最新）。
      const records = ledger.all(500);
      const latestByCandidate = new Map();
      for (const r of records) {
        if (r.type === 'suggest') continue;
        const key = r.candidateId ?? r.id;
        if (!latestByCandidate.has(key)) latestByCandidate.set(key, r);
      }
      const byStatus = {};
      for (const r of records) {
        if (r.type !== 'suggest') continue;
        const status = latestByCandidate.get(r.id)?.status ?? 'pending';
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      }
      return {
        totalCandidates: records.filter((r) => r.type === 'suggest').length,
        byStatus, ledgerPath: ledger.path, skillsDir: config.skillsDir,
        auto: { ...autoState, nextAutoAt },
      };
    },
  };
  ctx.provide('evolution', api);

  // ================= 自动建议（ 用户需求"定期提供进化候选"） =================
  // 每日 autoHour 自动 suggest（by='auto'）：仅生成候选 + 隔离评估 + 留档 pending，绝不自动采纳；
  // 生成 ≥1 条新候选时经 notify 主动告知（用户确认：主动通知）。手动 suggest 与自动并存。
  const autoState = { enabled: config.autoSuggest, autoHour: config.autoHour, autoNotify: config.autoNotify, lastAutoAt: 0, nextAutoAt: 0, autoTotal: 0, lastError: null };
  let nextAutoAt = 0;
  let autoRunning = false;

  /** 手动触发一次自动流程（供 verify/总控/调试）；与定时器共用同一路径。 */
  async function runAutoSuggest() {
    if (!config.autoSuggest) return { skipped: true, reason: 'autoSuggest 未启用' };
    if (autoRunning) return { skipped: true, reason: '自动流程进行中' };
    if (autoState.lastAutoAt > 0 && Date.now() - autoState.lastAutoAt < 3600000) return { skipped: true, reason: '距上次自动生成不足 1 小时' };
    autoRunning = true;
    try {
      const res = await api.suggest({ by: 'auto' });
      autoState.lastAutoAt = Date.now();
      autoState.autoTotal++;
      autoState.lastError = null;
      const passed = res.results.filter((r) => r.decision?.passed).length;
      const n = res.candidateIds.length;
      if (config.autoNotify && n > 0) {
        const notify = ctx.get('notify');
        if (notify !== undefined) {
          try {
            notify.send({ content: `🧬 自进化：已自动生成 ${n} 条进化候选（${passed} 条通过安全评估），请到「自进化」页审阅采纳或拒绝。`, source: 'evolution', scope: 'panel' });
          } catch (error) {
            logger.warn(`archive-evolution: 自动候选通知失败：${error.message}`);
          }
        }
      }
      logger.info(`archive-evolution: 自动候选完成 by=auto candidates=${n} passed=${passed}`);
      return { skipped: false, candidateIds: res.candidateIds, results: res.results, passed };
    } catch (error) {
      const msg = String(error?.message ?? error);
      if (msg.includes('未生成有效候选')) {
        logger.info('archive-evolution: 自动候选：今日无值得固化的新候选（素材不足或与近期重复），静默');
        return { skipped: true, reason: 'no-new-candidates' };
      }
      autoState.lastError = msg;
      logger.warn(`archive-evolution: 自动候选失败：${msg}`);
      return { skipped: true, error: msg };
    } finally {
      autoRunning = false;
    }
  }

  /** 递归安排下一次自动生成（进程内每日定时；重启后重新计算，无需持久化）。 */
  function scheduleNextAuto() {
    if (!config.autoSuggest) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(config.autoHour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    nextAutoAt = next.getTime();
    const delay = Math.max(1000, nextAutoAt - now.getTime());
    ctx.timer.setTimeout(() => {
      void runAutoSuggest();
      scheduleNextAuto();
    }, delay);
    bootLine(`[archive-evolution] 自动候选已启用：每日 ${String(config.autoHour).padStart(2, '0')}:00，下次 ${next.toLocaleString()}`);
  }

  scheduleNextAuto();
  api.autoRun = runAutoSuggest;

  const tools = ctx.get('tools');
  if (tools !== undefined) {
    const registered = [];
    const reg = (tool) => { tools.register(tool); registered.push(tool.name); };
    reg(defineTool({
      name: 'evolution_suggest',
      description: '自进化：生成候选改进（人格=近24h对话+人格轨迹经大模型产出 YAML 新增/修正方案；技能=对话/工作素材提炼），隔离评估后留档为 pending。不自动生效。',
      parameters: {},
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          candidateIds: { type: 'array', required: true, items: { type: 'string' } },
          results: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      }),
      async execute() {
        return api.suggest({ by: 'user' });
      },
    }));
    reg(defineTool({
      name: 'evolution_approve',
      description: '自进化：用户授权采纳一个候选。**仅当用户明确指示采纳时**调用，且必须传 confirm=true；不得自行批准。',
      parameters: {
        candidateId: { type: 'string', required: true, description: '候选 id（evolution_suggest 返回）' },
        confirm: { type: 'boolean', required: true, description: '必须为 true（用户显式确认）' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { applied: { type: 'boolean', required: true }, status: { type: 'string', required: true } },
      }),
      async execute(args) {
        //  approve 返回含 outcome 而 schema 仅声明 applied/status →
        // INVALID_TOOL_OUTPUT（历史教训#1 高危模式）；执行结果裁剪到 schema 声明字段。
        const r = await api.approve(args.candidateId, { by: 'user', confirm: args.confirm });
        return { applied: r.applied, status: r.status };
      },
    }));
    reg(defineTool({
      name: 'evolution_reject',
      description: '自进化：拒绝一个待采纳候选。',
      parameters: { candidateId: { type: 'string', required: true } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { rejected: { type: 'boolean', required: true }, status: { type: 'string', required: true } },
      }),
      execute(args) {
        return api.reject(args.candidateId, { by: 'user' });
      },
    }));
    reg(defineTool({
      name: 'evolution_view',
      description: '查看进化账本（候选/评估/采纳/拒绝/回滚记录）与统计。',
      parameters: {},
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { records: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } },
      }),
      execute() {
        return api.view(30);
      },
    }));
    reg(defineTool({
      name: 'evolution_rollback',
      description: '自进化：用户自选回滚一个已采纳候选（人格恢复采纳前版本；技能恢复旧内容）。**仅当用户明确指示回滚时**调用，且必须传 confirm=true。',
      parameters: {
        candidateId: { type: 'string', required: true, description: '已采纳候选 id' },
        confirm: { type: 'boolean', required: true, description: '必须为 true（用户显式确认）' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { rolledBack: { type: 'boolean', required: true }, to: { type: 'object', additionalProperties: true } },
      }),
      async execute(args) {
        return api.rollback(args.candidateId, { by: 'user', confirm: args.confirm });
      },
    }));
    logger.info(`archive-evolution: 已注册工具 ${registered.join(', ')}`);
    bootLine(`[archive-evolution] 工具已注册: ${registered.join(', ')}`);
  }

  bootLine(`[archive-evolution] ready ledger=${config.ledgerPath} skills=${config.skillsDir}`);
  return api;
}
