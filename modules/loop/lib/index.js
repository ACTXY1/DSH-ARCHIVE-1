/**
 * dsh-archive-loop —— DSH-ARCHIVE 自循环思考驱动器（Cordis 插件）。
 *
 * 需求（阶段四，方案 docs/阶段四-设计方案-虚拟时钟与自循环.md v2）：
 *  - 基于虚拟时钟，事件触发 + 定时兜底（默认 5 分钟，可运行时调整）；
 *  - 每循环：召回近期及有关记忆 → 结合用户状态/人格/时间分析场景 → 决定行为
 *    （主动发言等一切主动能力统一由"决定行为"一步决策；工具类主动行动前先评估后果及是否告知用户）；
 *  - 对话打断思考循环 → 先完成该循环（有界）再进入对话（beforeTurn 互斥）；
 *  - 防护：行动预算（每循环/每日）、发言限频、空转抑制、超时终止；
 *  - 循环日志写回记忆（source='loop'）；
 *  - 2026-09-01 限制：用户主动发消息后立即暂停时间驱动循环（fallback/startup/hour）quietAfterUserMs
 *    （默认 180s），窗口内只运行对话循环（pre-turn）；若有正在运行的时间驱动循环/过期 pre-turn 循环
 *    则立刻中止，并清理其循环记录、回退其行为（不发言/不行动/不留档/不更新 lastDecision）；
 *    pre-turn 按 reason 无条件禁言（不依赖调用方传 suppressSpeak），25s 上限后的后台收尾循环也被中止——
 *    防止两个并行思维循环基于同一时刻记忆做出并列而非延续的决策，割裂对话。
 *
 * 边界（诚实声明）：本插件决定"是否发言/是否行动"，发言与工具行动的实际执行
 * 通道由 agent 应用面/消息通道（阶段四对话面、阶段五主动消息）承载——决策经
 * `archive/loop-cycle` 事件与循环日志交付；本插件直接执行的安全内部动作见 executeInternalActions。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from 'schemastery';
import { buildSceneBrief, parseDecision, DECISION_PROTOCOL, renderLoopLog } from './scene.js';
import { defaultState as defaultInstrState, normalizeState as normalizeInstrState, validateForSave as validateInstrForSave, assembleInstructions, dialogueInstructionText, previewInstructions } from './instructions.js';
import { LoopGuards } from './guards.js';

export const name = 'dsh-archive-loop';

export const inject = ['tools', 'systemPrompt', 'timer', 'llm', 'virtualClock', 'memory', 'persona'];

const DEFAULTS = {
  enabled: true,
  fallbackIntervalMs: 300000, // 兜底 5 分钟（用户确认默认值）
  reducedFallbackMs: 1800000, // 降频模式兜底 30 分钟（2026-08-30：由总控开关控制，不再依赖用户状态）
  reducedMode: false, // 降频模式开关（settings archive-loop 持久化）
  tickMs: 30000,
  initialDelayMs: 30000, // 启动后延迟首循环，避免干扰短生命周期任务
  // 2026-09-03-9：思维循环 LLM 总上限 60s→120s（用户指示"延长思维循环默认时限到 120 秒"）——
  // 双 Agent 开启后时间驱动循环也含"记忆概括+决策"两段调用，60s 内两段易超时致失败风暴；
  // pre-turn 另有 preTurnCapMs(120s)+10s 独立上限，二者均放宽后"思考被砍只剩留痕"显著减少。
  thinkTimeoutMs: 120000,
  // 2026-09-03 凭证缺失冷却时长：未配置 API key 时循环暂停低频探测，避免 30s 风暴空转
  credentialRetryMs: 300000,
  conversationTimeoutMs: 300000, // 对话占位自动释放（未调用 endConversation 时）
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  // 2026-09-01-4：单次决策调用最大 token 预算（默认 10000，总控「思维循环」页可运行时调整）。
  // deepseek-v4-flash 是推理模型，reasoning 会吃掉大量预算，700/2000 下复杂简报易致正文截断
  // → "LLM 未返回文本" → 循环失败风暴（实测 700 下 75% 空返回）。10000 预留充足思考空间。
  maxTokens: 10000,
  maxActionsPerCycle: 1,
  maxActionsPerDay: 20,
  minSpeakIntervalMs: 30000,
  recallRecent: 5,
  recallRelated: 5,
  injectOrder: 900,
  preTurnRefreshMs: 60000,
  // 2026-09-01：用户主动发消息后暂停时间驱动循环的时长（窗口内只运行对话循环，防并行决策割裂对话）。
  // 2026-09-03 记忆错乱修复：30s→180s——对话回合结束后 60s 内仍可能触发 proactive 重复/串线发言
  // （实机 2026-09-03 00:00:30 在用户消息 67s 后推送了一条 15h 前旧问答的串线回复）。
  // 2026-09-03-3/6 修正（遵用户指示撤回）：本字段=对话让路窗口，原值 30s；曾为防 00:00:30 串线提至 180s、
  // 又一度误拉 300s。防串线/割裂的治本已独立就位（<recent-dialogue> 上下文回馈 + 记忆/注入带 at 时间线 +
  // pre-turn 禁言 + action 门控），窗口仅作最后兜底。按用户指示回归 30s~60s 区间：取 60s
  // （覆盖 00:00:30 事故点=回合结束后 60s 的紧贴发言；30s 会漏掉该点）。
  quietAfterUserMs: 60000,
  // 2026-09-03-4/9：对话前置思考（pre-turn）专用——完成时限 120s + 单次预算 4000（只产简短决策 JSON）。
  // 120s 为用户指示（2026-09-03-9）：双 Agent 开启后 pre-turn 含"记忆概括+决策"两段 LLM，时限须覆盖两段；
  // 放宽后也减少"思考被砍只剩留痕"。避免推理模型 reasoning 拖满预算超时。
  preTurnCapMs: 120000,
  preTurnMaxTokens: 4000,
  // 2026-09-10：冷启动首条免等（"挂机后首条消息迟迟不回显"修复）——
  //   距上一条被处理过的真实用户回合超过 preTurnColdGapMs 视为"冷启动首条"，
  //   此时 pre-turn 的等待上限临时收窄为 preTurnColdCapMs（默认 5s）：
  //   上限先到即中止（与既有 cap 中止路径一致：超时留痕、对话照常推进），
  //   避免挂机唤醒后整条前置思考链（实测 47~50s）把消息回显/回复阻塞近一分钟；
  //   对话中的连续消息仍走 preTurnCapMs（默认 120s，遵用户 2026-09-03 指示放宽）。
  preTurnColdGapMs: 900000,    // 距上一真实用户回合 ≥15 分钟 → 判为冷启动首条
  preTurnColdCapMs: 5000,      // 冷启动首条时前置思考最多同步等待 5s
  // 2026-09-03-9：双 Agent 记忆加工 + 输出审查（默认关 = 与旧流程完全一致，总控可开）。
  //  - dualAgent=true：agent1 概括记忆（recent/语义两类严格分源）→ agent2 决策读概括而非原文；
  //    agent2 输出前审查（通顺/行动合理/不重复/符合人设 → ok/revise/cancel）；对话回复经注入自检约束。
  //  - dualMemMaxTokens/dualReviewMaxTokens：agent1 概括与审查调用的小预算（默认 1200/800），
  //    失败自动降级（回退原文 / 跳过审查），不阻断功能。
  dualAgent: false,
  dualMemMaxTokens: 1200,
  dualReviewMaxTokens: 800,
  // 睡眠/清醒期（2026-08-31 用户设计）：用户"睡眠中"状态持续 ≥30 分钟且未来窗口内无
  // 定时任务 → 进入睡眠期（循环完全暂停，无视降频开关）；任务触发/用户状态清除或改标签
  // /用户发消息 → 解除并进入 3 小时强制清醒间隔（期间无法再睡眠）。
  // 2026-09-03 记忆错乱修复（语义修正）：状态 TTL 到期 ≠ 醒来——睡眠期不再因行过期或
  // 固定时长上限而强制解除（夜行作息长睡眠可远超 8h，实机 15h 睡眠在 20:57 TTL 到期后
  // 18:16-22:40 被连环打扰）；仅"真实唤醒信号"解除：用户状态被清除/改标为其他状态、
  // 用户主动发消息、定时任务打断。sleepMaxMs 仅作为"无 TTL 睡眠行（直到手动清除）"的
  // 绝对兜底上限，防止状态卡死。
  sleepEnterDelayMs: 1800000,   // 用户睡眠状态持续多久后进入睡眠期（30 分钟，防"晚安"误判）
  sleepMaxMs: 28800000,         // 无 TTL 睡眠行的绝对兜底上限（8 小时；正常带 TTL 的睡眠不适用）
  sleepCooldownMs: 10800000,    // 解除后强制清醒间隔（3 小时），期间无法再睡眠（防抖动）
  sleepCheckWindowMs: 28800000, // "有工作任务"判定窗口：未来多久内到期的 pending 任务（默认 8h）
};

// 2026-09-03-5：pre-turn 参数合法范围（UI 编辑框与 configure/normalizeConfig 双端一致）。
// 上限约束意义：JS setTimeout 超 2^31-1ms(~24.8 天) 会 32 位溢出变成 ~1ms 立即触发——用户若把
// preTurnCapMs 填成 9999999999，cap 会瞬时命中、每个对话回合的 pre-turn 全被砍；故收窄到 5s~10min。
const PRE_TURN_CAP_MIN = 5000;    // 5 秒以下必超时，无意义
const PRE_TURN_CAP_MAX = 600000;  // 10 分钟
const PRE_TURN_TOK_MIN = 500;     // 决策 JSON 所需的最小 token 预算
const PRE_TURN_TOK_MAX = 60000;   // 单次决策预算上限兜底
// 2026-09-10：冷启动判定阈值与临时上限的范围（normalizeConfig/configure 双端一致）
const PRE_TURN_COLD_GAP_MIN = 60000;      // 判定阈值 ≥1 分钟
const PRE_TURN_COLD_GAP_MAX = 604800000;  // 判定阈值 ≤7 天
const PRE_TURN_COLD_CAP_MIN = 1000;       // 冷启动临时等待上限 ≥1s
const PRE_TURN_COLD_CAP_MAX = 600000;     // ≤10 分钟（最终再与 preTurnCapMs 取小）

// 2026-09-03-9：双 Agent —— agent1 记忆分析师（严格分源概括；输出即 XML 数据块，供 agent2 决策读）
const MEMORY_SUMMARIZE_PROMPT = `你是记忆分析师。把下面的记忆材料按来源分两类概括，供决策者使用。硬性要求：
1) 忠实概括，不得编造事实；引用时尽量保留原文时间（[MM-DD HH:MM]）。
2) <memory-summary source="recent">：概括最近经历与事件流程（<flow>）、当前情况（<situation>）、用户隐含情绪（<mood>——若属推断必须标注"推断"）。
3) <memory-summary source="semantic">：概括长期重要信息（偏好/要求/经验教训/画像/项目要点等），关键细节不得因概括而丢失。
4) 只输出以下 XML，不要任何解释文字或代码围栏：
<memory-summary source="recent"><flow>…</flow><situation>…</situation><mood>…（推断）</mood></memory-summary>
<memory-summary source="semantic"><key>…</key></memory-summary>`;

// 2026-09-03-9：输出审查员（对拟发言/拟行动做四维检查并给出更正/取消/阻止）
// 2026-09-04-2 思维预设：增第⑤维「符合用户指令」（材料含【用户指令】；无指令则本项通过）
const REVIEW_PROMPT = `你是输出审查员。审查即将向用户输出或执行的内容，做五项检查：
① 通顺自然：句子通顺、语气得体、不啰嗦；
② 行动合理：动作是否必要、在白名单语义内、无越权或副作用误解；
③ 不重复/不推翻：对照【最近对话里 AI 已说过的内容】——同一事项不得重复推送，不得推翻刚给出的方案/推荐（除非用户明确否定）；
④ 符合人设：对照【人设要点】；
⑤ 符合用户指令：对照【用户指令】——用户启用的思维预设要求不得违背；revise 时把发言/行动改到符合，严重违背用 cancel/blocked；无指令时本项通过。
只输出 JSON（不要任何解释或代码围栏）：
{"verdict":"ok|revise|cancel","correctedSpeak":"revise 时给修正后的发言全文（无发言则空）","blockedActions":["被阻止的行动名"],"reason":"一句话理由"}`;

// 2026-09-03-9：对话回复正文的软自检约束（dualAgent 开启时注入主会话 systemPrompt；回复生成前自我核对）
const OUTPUT_SELFCHECK = `输出前自检（每次回复前在心里快速核对，不合则先调整再输出；不要把这行检查写进回复）：
① 通顺自然、口语化、不啰嗦；② 承接最近对话：不重复自己刚说过的内容，不推翻刚给出的方案/推荐（用户明确否定时除外）；③ 若要执行工具行动，先确认必要且合理；④ 符合你的人设与表达习惯。`;

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  const num = (key, min = 0) => {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] < min) throw new Error(`archive-loop 配置错误：${key} 必须是不小于 ${min} 的数`);
      cfg[key] = raw[key];
    }
  };
  num('fallbackIntervalMs', 1000);
  num('reducedFallbackMs', 1000);
  num('tickMs', 1000);
  num('initialDelayMs', 0);
  num('thinkTimeoutMs', 1000);
  num('credentialRetryMs', 1000);
  num('maxActionsPerCycle', 1);
  num('maxActionsPerDay', 0);
  num('minSpeakIntervalMs', 0);
  num('maxTokens', 1);
  num('recallRecent', 1);
  num('recallRelated', 0);
  num('injectOrder');
  num('preTurnRefreshMs', 0);
  num('quietAfterUserMs', 0);
  // 2026-09-03-4：对话前置思考（pre-turn）专用参数——推理模型 reasoning 常超 25s/高预算，
  // 此前 cap 25s 固定、预算共用 maxTokens(10000)，pre-turn 频繁被砍只剩留痕（用户实测反馈）。
  // 2026-09-03-5：范围约束（5s~10min / 500~60000）与 UI 编辑框一致，防乱填（见 PRE_TURN_* 常量注释）。
  num('preTurnCapMs', PRE_TURN_CAP_MIN);
  if (cfg.preTurnCapMs > PRE_TURN_CAP_MAX) throw new Error(`archive-loop 配置错误：preTurnCapMs 不能超过 ${PRE_TURN_CAP_MAX}ms`);
  num('preTurnMaxTokens', PRE_TURN_TOK_MIN);
  if (cfg.preTurnMaxTokens > PRE_TURN_TOK_MAX) throw new Error(`archive-loop 配置错误：preTurnMaxTokens 不能超过 ${PRE_TURN_TOK_MAX}`);
  // 2026-09-10：冷启动首条免等参数（范围护栏与 configure 一致；coldCap 再与 preTurnCapMs 取小）
  num('preTurnColdGapMs', PRE_TURN_COLD_GAP_MIN);
  if (cfg.preTurnColdGapMs > PRE_TURN_COLD_GAP_MAX) throw new Error(`archive-loop 配置错误：preTurnColdGapMs 不能超过 ${PRE_TURN_COLD_GAP_MAX}ms`);
  num('preTurnColdCapMs', PRE_TURN_COLD_CAP_MIN);
  if (cfg.preTurnColdCapMs > PRE_TURN_COLD_CAP_MAX) throw new Error(`archive-loop 配置错误：preTurnColdCapMs 不能超过 ${PRE_TURN_COLD_CAP_MAX}ms`);
  if (cfg.preTurnColdCapMs > cfg.preTurnCapMs) cfg.preTurnColdCapMs = cfg.preTurnCapMs;
  // 2026-09-03-9：双 Agent 开关与预算（预算范围护栏，防乱填致概括/审查输出不可用）
  if (raw.dualAgent !== undefined) {
    if (typeof raw.dualAgent !== 'boolean') throw new Error('archive-loop 配置错误：dualAgent 必须是布尔');
    cfg.dualAgent = raw.dualAgent;
  }
  num('dualMemMaxTokens', 100);
  if (cfg.dualMemMaxTokens > 6000) throw new Error('archive-loop 配置错误：dualMemMaxTokens 不能超过 6000');
  num('dualReviewMaxTokens', 100);
  if (cfg.dualReviewMaxTokens > 4000) throw new Error('archive-loop 配置错误：dualReviewMaxTokens 不能超过 4000');
  num('sleepEnterDelayMs', 1000);
  num('sleepMaxMs', 1000);
  num('sleepCooldownMs', 1000);
  num('sleepCheckWindowMs', 1000);
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new Error('archive-loop 配置错误：enabled 必须是布尔');
    cfg.enabled = raw.enabled;
  }
  if (raw.reducedMode !== undefined) {
    if (typeof raw.reducedMode !== 'boolean') throw new Error('archive-loop 配置错误：reducedMode 必须是布尔');
    cfg.reducedMode = raw.reducedMode;
  }
  if (raw.provider !== undefined && typeof raw.provider !== 'string') throw new Error('archive-loop 配置错误：provider 必须是字符串');
  if (raw.model !== undefined && typeof raw.model !== 'string') throw new Error('archive-loop 配置错误：model 必须是字符串');
  return cfg;
}

function toolOutput(schema, render) {
  return { schema, render: render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]) };
}

function bootLine(line) {
  try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  // 2026-09-04-2 思维预设：内存态（默认空=零注入零变化）；settings 可用时回填并持久化
  let instr = defaultInstrState();
  let instrPersist = null;
  // 2026-08-31 审计修复（major）：archive-loop 命名空间由本模块注册（此前在 control 注册，
  // 晚于本模块启动读取 → 降频开关重启后必然丢失）。register 后回填 saved 值。
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.register(settingsNamespace('archive-loop'), z.object({ reducedMode: z.boolean().default(false), dualAgent: z.boolean().default(false) }), { base: { reducedMode: false, dualAgent: false } });
      const saved = settingsCtx.settings.get(settingsNamespace('archive-loop'));
      if (saved && typeof saved.reducedMode === 'boolean') config.reducedMode = saved.reducedMode;
      if (saved && typeof saved.dualAgent === 'boolean') config.dualAgent = saved.dualAgent; // 2026-09-03-9
      // 2026-09-04-2 思维预设命名空间（本模块注册 + 回填 + 持久化引用）
      settingsCtx.settings.register(settingsNamespace('archive-instructions'), z.object({
        presets: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
        activePresetId: z.string().default(''),
        entries: z.array(z.object({
          id: z.string(), presetId: z.string(), name: z.string(), mode: z.string().default('always'),
          keys: z.array(z.string()).default([]), text: z.string().default(''), scope: z.string().default('loop'),
          enabled: z.boolean().default(true), order: z.number().default(0),
        })).default([]),
        injectCapChars: z.number().default(1200),
      }), { base: { presets: [], activePresetId: '', entries: [], injectCapChars: 1200 } });
      const savedInstr = settingsCtx.settings.get(settingsNamespace('archive-instructions'));
      if (savedInstr && typeof savedInstr === 'object') instr = normalizeInstrState(savedInstr);
      instrPersist = () => settingsCtx.settings.update(settingsNamespace('archive-instructions'), { presets: instr.presets, activePresetId: instr.activePresetId, entries: instr.entries, injectCapChars: instr.injectCapChars });
    } catch { /* 注册/读取失败用默认 */ }
  });
  const logger = ctx.root?.logger?.('archive-loop') ?? console;
  if (!config.enabled) {
    bootLine('[archive-loop] disabled');
    return {};
  }

  const state = {
    mode: 'idle', // idle | thinking | conversing
    lastCycleAt: 0,
    lastDecisionAt: 0,
    lastDecision: null,
    dirty: false,
    dirtyReasons: [],
    cycleCount: 0,
    errorCount: 0,
    conversingSince: 0,
    // 2026-09-01 用户消息静默窗口：quietUntil 之前暂停时间驱动循环（fallback/startup/hour），
    // 只运行对话（pre-turn）循环；activeCycle 记录进行中的循环，供用户消息到达时中止
    // （两个并行循环用同一时刻记忆 → 行为并列而非延续 → 须中止并清理记录/回退行为）。
    quietUntil: 0,
    activeCycle: null,
    cancelledCount: 0,
    // 睡眠/清醒期（2026-08-31）：awake | asleep | cooldown（内存态，重启后从 awake 重新积累，
    // 30 分钟后自动重入睡眠期——重启属罕见事件，行为正确且免去额外持久化）
    sleep: { phase: 'awake', asleepSince: 0, wakeReason: '', cooldownUntil: 0, skips: 0, sleepExpirySeen: 0 },
    // 2026-09-03 凭证缺失冷却：MISSING_CREDENTIAL（未配置 API key）是"等用户配置"的持久性错误，
    // 每 30s 重试只会空转耗资源（手机端实测 error#1..#14 刷屏 + 周期拖慢网页）。进入冷却后
    // 时间驱动循环暂停低频探测，配置写入事件（archive/credentials-changed）会立即唤醒重试。
    credentialCooldownUntil: 0,
    // 2026-09-03-3：最近真实对话缓冲（主会话 user↔ai，内存态，cap 40 条）——主动循环简报
    // <recent-dialogue> 的数据源（对话记忆只落用户侧，AI 回复仅存在于会话事件流，须在此缓冲）。
    dialogue: [],
    // 2026-09-03-3：最近一次决策的触发原因（<loop-analysis> 注入时附带，供模型判断新旧/来源）。
    lastDecisionReason: '',
  };
  const guards = new LoopGuards(config);
  let lastHour = new Date().getHours();

  const markDirty = (reason) => {
    state.dirty = true;
    state.dirtyReasons.push(reason);
  };

  // ── 2026-09-01 用户消息静默窗口 / 时间驱动循环中止 ──
  /** 是否时间驱动循环（用户消息后须暂停/中止的一类；对话循环 pre-turn 不在此列）。 */
  function isTimeBasedReason(reason) {
    return reason === 'fallback' || reason === 'startup' || /^hour-/.test(String(reason));
  }
  /** 中止"会产生并行输出"的运行中循环：时间驱动循环（fallback/startup/hour-*）+ 过期 pre-turn
   *  （pre-turn 决策基于旧输入，与当前对话并列而非延续）。会话层与 beforeTurn 共用；幂等。
   *  @param {{capAbort?:boolean}} [opts] 2026-09-03-3：capAbort=true 表示"25s 对话前置思考上限"中止
   *  （对话已推进、决策超时）——cycle 据此补一条"超时留痕"记录而非完全静默消失。 */
  function abortParallelCycle({ capAbort = false } = {}) {
    const active = state.activeCycle;
    if (!active) return false;
    if (!isTimeBasedReason(active.reason) && active.reason !== 'pre-turn') return false;
    active.userCancelled = true;
    active.abortKind = capAbort ? 'cap' : 'user';
    try { active.ac.abort(); } catch { /* ignore */ }
    logger.info(`archive-loop: 中止进行中的 ${active.reason} 循环（${capAbort ? `对话前置思考超时(${Math.round(config.preTurnCapMs / 1000)}s 上限)` : '防并行决策割裂对话'}）`);
    return true;
  }
  /** 用户主动发消息：暂停时间驱动循环 quietAfterUserMs，并中止运行中的时间驱动循环
   *  （中止后该循环不留记忆记录、不执行发言/行动、不更新 lastDecision——行为保持延续而非并列）。
   *  2026-09-03 记忆错乱修复：用户发消息即真实唤醒信号——若正处于睡眠期立即解除
   *  （睡眠期常因 TTL 到期而"行已消失但人仍在睡"，用户消息是唯一可靠的醒来判定）。 */
  function handleUserMessage() {
    state.quietUntil = Date.now() + config.quietAfterUserMs;
    if (state.sleep.phase === 'asleep') wake('user');
    abortParallelCycle();
  }

  // ── 睡眠/清醒期状态机（2026-08-31） ──
  /** 状态名归一（2026-09-03 记忆错乱修复）：英文/口语名 → 规范中文。
   *  与 memory 模块 canonicalState 同义（loop 不能反向依赖 memory 包），改动须同步。
   *  'sleeping' 曾是实机写入的英文状态名——精确匹配 '睡眠中' 的旧逻辑看不到它，
   *  睡眠闸门失效、睡眠期间照常发主动消息。 */
  function canonState(raw) {
    const t = String(raw ?? '').trim();
    if (t === '') return '';
    const map = {
      sleeping: '睡眠中', asleep: '睡眠中', sleep: '睡眠中', '睡着了': '睡眠中',
      '睡觉中': '睡眠中', '已入睡': '睡眠中', 睡眠: '睡眠中',
      awake: '在线', active: '在线', online: '在线', '醒着': '在线', 清醒: '在线',
      '已醒': '在线', 醒来: '在线', '在线': '在线',
    };
    return map[t.toLowerCase()] ?? t;
  }
  /** 当前全部有效用户状态（未过期）。 */
  function activeUserStates() {
    try { return ctx.memory.state.get() ?? []; } catch { return []; }
  }
  /** 当前"睡眠中"项（带 setAt/expiresAt；无则视为未在睡眠）。 */
  function sleepStateOf() {
    const list = activeUserStates();
    return list.find((x) => canonState(x?.state) === '睡眠中') ?? null;
  }
  /** 当前"非睡眠"的其他有效状态（如 在线/困了/忙碌…）——出现即"被显式改标签"。 */
  function otherStateOf() {
    const list = activeUserStates();
    return list.find((x) => canonState(x?.state) !== '睡眠中') ?? null;
  }
  /** 未来 sleepCheckWindowMs 内是否有到期的 pending remind/work 任务（有则视为"有工作任务"，不进入睡眠期）。
   *  2026-08-31 审计修复（设计冲突）：排除 interval 周期任务——"每 N 分钟"任务每次触发都重排到
   *  窗口内，若计为"工作任务"则存在任一周期任务时智能体永不入睡（潜意识梦境引擎永不运行）；
   *  周期任务到点仍会经 wake('task') 打断睡眠，语义不变。 */
  function hasPendingTaskWithin(windowMs) {
    try {
      const schedule = ctx.get('schedule');
      const list = schedule?.list?.();
      const tasks = Array.isArray(list) ? list : (Array.isArray(list?.tasks) ? list.tasks : []);
      const now = Date.now();
      return tasks.some((t) => t?.status === 'pending' && t?.schedule !== 'interval' && Number(t?.dueAt ?? 0) > now && Number(t.dueAt) - now <= windowMs);
    } catch { return false; }
  }
  /**
   * 睡眠状态推进（在 cycle 入口与 tick 中调用，幂等）：
   *  - asleep：仅"真实唤醒信号"解除 → cooldown：
   *      a) 睡眠状态行被清除/改标为其他状态（显式醒来）；
   *      b) 用户主动发消息（handleUserMessage → wake('user')）；
   *      c) 定时任务打断（wake('task')）；
   *      d) 无 TTL（直到手动清除）的睡眠行超过 sleepMaxMs 绝对上限（防状态卡死兜底）。
   *    状态行 TTL 到期 ≠ 醒来（2026-09-03 修复：夜行长睡眠远超 TTL 是常态，
   *    到期后保持静默，等真实唤醒信号，杜绝睡眠期连环主动打扰）。
   *  - cooldown：倒计时结束 → awake；
   *  - awake：用户"睡眠中"持续 ≥ sleepEnterDelayMs 且未来窗口无 pending 任务 → asleep。
   */
  function updateSleepState(now = Date.now()) {
    const s = state.sleep;
    if (s.phase === 'asleep') {
      const cur = sleepStateOf();
      const other = otherStateOf();
      // 退出条件判定（满足其一 → cooldown）
      let exit = false;
      let reason = '';
      if (other) {
        exit = true; reason = 'woke'; // 被显式改标为其他状态（在线/困了…）→ 醒来
      } else if (cur) {
        if (cur.expiresAt) {
          s.sleepExpirySeen = Number(cur.expiresAt); // 刷新记忆的到期点
        } else if (now - s.asleepSince > config.sleepMaxMs) {
          exit = true; reason = 'timeout'; // 无 TTL 行的绝对兜底上限
        }
      } else {
        // 睡眠行消失：区分"TTL 到期"（仍在睡，保持静默）与"显式清除"（醒来）
        const expiredSeen = Number(s.sleepExpirySeen ?? 0);
        const ttlExpired = expiredSeen > 0 && now >= expiredSeen;
        if (!ttlExpired) { exit = true; reason = 'woke'; }
      }
      if (exit) {
        s.phase = 'cooldown';
        s.cooldownUntil = now + config.sleepCooldownMs;
        s.wakeReason = reason;
        logger.info(`archive-loop: 睡眠期解除（${reason}），进入 3 小时强制清醒间隔`);
        // 2026-08-31 潜意识系统：睡眠期结束事件（生成梦境呓语等）
        try { ctx.emit?.('archive/sleep-phase', { phase: 'awake', reason, at: now }); } catch { /* ignore */ }
      }
      return;
    }
    if (s.phase === 'cooldown') {
      if (now < s.cooldownUntil) return;
      s.phase = 'awake';
      s.wakeReason = '';
      logger.info('archive-loop: 强制清醒间隔结束，恢复可睡眠');
      // 不提前 return：到期后落入 awake 分支，若条件仍满足（用户还在睡）可立即重入睡眠期
    }
    // awake（含 cooldown 刚到期）：检查进入条件
    const cur = sleepStateOf();
    if (!cur) return;
    const since = Number(cur.setAt ?? 0);
    if (!since || now - since < config.sleepEnterDelayMs) return;
    if (hasPendingTaskWithin(config.sleepCheckWindowMs)) return;
    s.phase = 'asleep';
    s.asleepSince = now;
    s.wakeReason = '';
    s.sleepExpirySeen = cur.expiresAt ? Number(cur.expiresAt) : 0; // 记录睡眠行的到期点
    logger.info('archive-loop: 用户已睡眠 ≥30 分钟且无近期待办任务 → 进入睡眠期（循环暂停）');
    // 2026-08-31 潜意识系统：睡眠期开始事件（触发梦境引擎）
    try { ctx.emit?.('archive/sleep-phase', { phase: 'asleep', reason: '', at: now }); } catch { /* ignore */ }
  }
  /** 任务打断/外部唤醒：asleep → cooldown（schedule 触发定时任务或用户发消息时调用）。
   *  2026-09-03：wake('user') 由 handleUserMessage 调用（用户发消息=真实唤醒信号）。 */
  function wake(reason = 'task') {
    const s = state.sleep;
    if (s.phase === 'asleep') {
      s.phase = 'cooldown';
      s.cooldownUntil = Date.now() + config.sleepCooldownMs;
      s.wakeReason = String(reason);
      logger.info(`archive-loop: ${reason === 'task' ? '定时任务触发' : reason === 'user' ? '用户发消息（唤醒）' : '唤醒信号'}，打断睡眠期（${reason}）→ 强制清醒间隔`);
      // 2026-08-31 潜意识系统：任务打断也算苏醒（生成梦境呓语）
      try { ctx.emit?.('archive/sleep-phase', { phase: 'awake', reason: String(reason), at: Date.now() }); } catch { /* ignore */ }
      return { woke: true, phase: 'cooldown', cooldownUntil: s.cooldownUntil };
    }
    return { woke: false, phase: s.phase };
  }
  /** 睡眠摘要（state/stats 共用；剩余时长单位毫秒）。 */
  function sleepSummary(now = Date.now()) {
    const s = state.sleep;
    return {
      phase: s.phase,
      wakeReason: s.wakeReason,
      asleepSince: s.asleepSince,
      cooldownUntil: s.cooldownUntil,
      asleepForMs: s.phase === 'asleep' ? now - s.asleepSince : 0,
      cooldownLeftMs: s.phase === 'cooldown' ? Math.max(0, s.cooldownUntil - now) : 0,
      skips: s.skips,
      sleepExpirySeen: s.sleepExpirySeen, // 2026-09-03：当前睡眠行到期点（诊断用）
      enterDelayMs: config.sleepEnterDelayMs,
      sleepMaxMs: config.sleepMaxMs,
      cooldownMs: config.sleepCooldownMs,
      checkWindowMs: config.sleepCheckWindowMs,
    };
  }

  /** 自定义 OpenAI 兼容 provider（archive-models settings，启用的第一个）。 */
  function customLlmProvider() {
    try {
      const settings = ctx.get('settings');
      const value = settings?.get?.(settingsNamespace('archive-models'));
      const list = Array.isArray(value?.providers) ? value.providers : [];
      return list.find((p) => p.enabled !== false && p.baseURL && p.apiKey && p.model) || null;
    } catch { return null; }
  }

  /** 直呼 LLM（文本流）并拼装回复。@param {string} brief 场景简报正文 */
  /** 通用 LLM 文本调用（2026-09-03-9 重构）：自定义 OpenAI 兼容 provider 优先 → 失败回退官方；
   *  官方路径重试一次（llm 流偶发空返回/网络抖动自愈）+ reasoning_content 兜底。
   *  system/user/maxTokens 参数化，供三处复用：决策（callLlm 薄封装）、双 Agent 记忆概括、输出审查。
   *  @param {{system:string, user:string, signal?:AbortSignal, maxTokens:number}} opts */
  async function callText({ system, user, signal, maxTokens }) {
    const custom = customLlmProvider();
    if (custom) {
      try {
        const url = `${String(custom.baseURL).replace(/\/+$/, '')}/chat/completions`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${custom.apiKey}` },
          body: JSON.stringify({
            model: custom.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: [{ type: 'text', text: user }] },
            ],
            max_tokens: maxTokens,
          }),
          signal,
        });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error?.message ? `API: ${j.error.message}` : `HTTP ${res.status}`);
        let text = String(j.choices?.[0]?.message?.content ?? '').trim();
        // 2026-09-01-3 兜底：正文为空但 reasoning_content 含输出（推理模型偶发把答案写进思考段）
        if (!text) text = String(j.choices?.[0]?.message?.reasoning_content ?? '').trim();
        if (!text) throw new Error('LLM 未返回文本');
        return text;
      } catch (error) {
        logger.warn(`archive-loop: 自定义提供商调用失败，回退官方：${error.message}`);
      }
    }
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new Error('思考超时中止');
      let text = '';
      let reasoningText = '';
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
          if (chunk.type === 'reasoning-delta') reasoningText += chunk.text;
          if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            const failure = chunk.reason.failure;
            throw new Error(`${failure?.code ?? chunk.reason.kind}: ${failure?.message ?? '调用失败'}`);
          }
        }
        if (text.trim() !== '') return text;
        if (reasoningText.trim() !== '') return reasoningText; // 正文空 → 思考段兜底
        lastError = new Error('LLM 未返回文本');
      } catch (error) {
        lastError = error;
        if (signal?.aborted || String(error?.code ?? error?.message ?? '').includes('ABORTED')) throw error; // 超时中止不重试
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800)); // 短暂等待后重试
    }
    throw lastError ?? new Error('LLM 未返回文本');
  }

  /** 决策调用（薄封装：固定决策协议 system；保留原签名供既有调用方/测试）。 */
  async function callLlm(brief, signal, maxTokensOverride) {
    return callText({ system: DECISION_PROTOCOL, user: `场景简报：\n${brief}`, signal, maxTokens: maxTokensOverride ?? config.maxTokens });
  }

  /** 召回记忆（2026-09-03-9 起按来源返回，供双 Agent 严格分源与单 Agent 拼装共用）。
   *  recent=memory.list 最近（近况/刚发生的对话与事件）；related=语义召回（长期/画像/关注相关）。
   *  条目带真实时间 {text, at}（简报 <memory at=…> 供模型以时间判断新旧）。 */
  async function recallMemories() {
    const recent = ctx.memory.list({ limit: config.recallRecent }).map((m) => ({ text: m.content, at: Number(m.createdAt ?? 0) }));
    let related = [];
    try {
      const query = deriveRecallQuery();
      if (query) {
        const res = await ctx.memory.recall({ query, k: config.recallRelated, minScore: 0.3 });
        related = res.results.map((r) => ({ text: r.content, at: Number(r.createdAt ?? 0) }));
      }
    } catch { /* 召回失败不阻断循环 */ }
    return { recent, related };
  }

  /** 时间戳 → MM-DD HH:MM（本地；agent1/审查材料标注用）。 */
  function fmtMemTime(ts) {
    try {
      const d = new Date(Number(ts));
      if (Number.isNaN(d.getTime())) return '';
      const p = (x) => String(x).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch { return ''; }
  }

  /** agent1 记忆分析师（2026-09-03-9，双 Agent 开启时）：把召回记忆按 recent/语义 两类严格概括，
   *  recent 含 flow/situation/用户隐含情绪（推断标注），semantic 保留重要信息。
   *  失败返回 {ok:false,reason}，调用方降级使用原始记忆（不阻断循环）。 */
  async function summarizeMemories(mem, signal) {
    try {
      const part = (label, list) => {
        const txt = (Array.isArray(list) ? list : [])
          .map((m) => (Number(m?.at ?? 0) > 0 ? `[${fmtMemTime(Number(m.at))}] ${m.text}` : m.text))
          .filter(Boolean).join('\n');
        return `${label}\n${txt || '（无）'}`;
      };
      const user = `${part('【最近记忆 recent】', mem?.recent)}\n\n${part('【语义相关记忆 semantic】', mem?.related)}`;
      const raw = await callText({ system: MEMORY_SUMMARIZE_PROMPT, user, signal, maxTokens: config.dualMemMaxTokens });
      const text = String(raw ?? '').trim();
      if (!text) return { ok: false, reason: '概括为空' };
      const clipped = [...text];
      return { ok: true, text: clipped.length > 3000 ? clipped.slice(0, 2999).join('') + '…' : text };
    } catch (error) { return { ok: false, reason: error?.message ?? String(error) }; }
  }

  /** 最近对话文本化（供审查对照"自己刚说过什么"，防重复/推翻）。 */
  function dialogueTextForReview() {
    return recentDialogue().map((d) => `[${fmtMemTime(d.at)}] ${d.role === 'user' ? '用户' : 'AI'}：${d.text}`).join('\n');
  }

  /** 输出前审查（2026-09-03-9，双 Agent 开启且确有输出时）：五维检查（通顺/行动合理/不重复/符合人设/
   *  符合用户指令）→ ok/revise/cancel + blockedActions。失败返回 {ok:false}（调用方跳过审查按原样投递，不阻断）。
   *  2026-09-04-2 思维预设：instructionsText = 本次注入的用户指令（可为空）。 */
  async function reviewOutput({ speak, actions, dialogueText, personaText, instructionsText = '' }, signal) {
    try {
      const user = [
        `【拟主动发言】${speak ? String(speak) : '（无）'}`,
        `【拟执行行动】${Array.isArray(actions) && actions.length ? actions.map((a) => `${a.name}${a.reason ? `（${a.reason}）` : ''}`).join('\n') : '（无）'}`,
        `【最近对话里 AI 已说过的内容】${dialogueText || '（无）'}`,
        `【人设要点】${personaText || '（无）'}`,
        `【用户指令】${instructionsText || '（无）'}`,
      ].join('\n');
      const raw = await callText({ system: REVIEW_PROMPT, user, signal, maxTokens: config.dualReviewMaxTokens });
      const m = String(raw ?? '').match(/\{[\s\S]*\}/);
      if (!m) return { ok: false, reason: '审查输出非 JSON' };
      const r = JSON.parse(m[0]);
      return {
        ok: true,
        verdict: r?.verdict === 'cancel' ? 'cancel' : (r?.verdict === 'revise' ? 'revise' : 'ok'),
        correctedSpeak: String(r?.correctedSpeak ?? '').trim(),
        blockedActions: Array.isArray(r?.blockedActions) ? r.blockedActions.map(String).filter(Boolean) : [],
        reason: String(r?.reason ?? '').slice(0, 200),
      };
    } catch (error) { return { ok: false, reason: error?.message ?? String(error) }; }
  }

  /** 近期用户消息（感知用户状态的直接证据，2026-09-01）：取最近写入的对话记忆
   *  （source='conversation'，内容形如"用户：…"）去前缀后回传；上限 3 条防 token 膨胀。
   *  时间驱动循环（fallback/startup/hour）无 <user-input>，靠此块感知用户状态变化。
   *  2026-09-01 实机修复：提取窗口从 20 扩大到 200（store.list 上限）——循环决策记忆
   *  （loop/manual）每 5 分钟写 2 条，会把用户消息挤出前 20，导致证据块恒为空、
   *  状态感知失效（用户 06:47"等会睡"→ 循环 3.5h 内无任何状态更新，user_state 表空）。
   *  取 200 条再过滤 conversation，保证跨数小时仍能找到用户消息。
   *  2026-09-03-2 时间线修复：返回 {text, at}——带上记忆行真实时间（createdAt）。
   *  根因：夜行作息下用户消息可相隔 15h+（实机 08:57"你很关心我吗"与 23:59"我刚醒"），
   *  纯文本相邻排列会让模型误判为几分钟内的连续对话（00:00:30"当然关心啊"串线推送，
   *  决策分析原文："一分钟前我刚回应过用户那句'你很关心我吗'"）。 */
  function recentUserMessages(limit = 3) {
    try {
      const list = ctx.memory.list({ limit: 200 }) ?? [];
      return list
        .filter((m) => m?.source === 'conversation' && typeof m?.content === 'string')
        .map((m) => {
          const text = m.content.replace(/^用户：/, '').trim();
          return text ? { text, at: Number(m.createdAt ?? 0) } : null;
        })
        .filter(Boolean)
        .slice(0, limit);
    } catch { return []; }
  }

  function deriveRecallQuery() {
    // 注意：memory 服务的用户状态在 state 命名空间（state.get()），非顶层 stateGet()
    const states = ctx.memory.state.get();
    if (states.length > 0) return `用户当前状态：${states.map((s) => `${s.state}${s.detail ? `（${s.detail}）` : ''}`).join('，')}`;
    return '当前用户状态与关注事项';
  }

  // ── 2026-09-03-3：最近真实对话缓冲（主会话 user↔ai；对话记忆只落"用户：…"，AI 回复仅在会话事件流，
  //    主动循环要看到"AI 刚在对话里说过什么"必须在此内存缓冲） ──
  /** 追加一条对话实录；相邻同角色 60s 内同文去重；cap 40 条。 */
  function pushDialogue(role, text, at) {
    const t = String(text ?? '').trim();
    if (!t || t.startsWith('Current runtime context')) return;
    const arr = state.dialogue;
    const last = arr[arr.length - 1];
    if (last && last.role === role && at - last.at < 60000 && last.text === t) return;
    const clipped = [...t];
    arr.push({ role, text: clipped.length > 400 ? clipped.slice(0, 399).join('') + '…' : t, at });
    if (arr.length > 40) arr.splice(0, arr.length - 40);
  }
  /** 最近真实对话（2026-09-03-7/8 用户语义）：
   *  - **15 分钟内的对话全注入**（不按 5 条截断，避免漏掉中间关键轮次）；工程护栏上限 20 条
   *    （防极密集对话把简报撑爆 → pre-turn 4000 预算截断 → "LLM 未返回文本"，防连锁缺陷）；
   *  - 若 15 分钟内不足 5 条 → 从更早历史回补至满 5 条（对话间隔过长时 AI 仍可见最近真实消息）；
   *  - 每条带真实 at（渲染 <turn at="MM-DD HH:MM" role=…>），模型按 at 判断新旧，防时间错乱。 */
  function recentDialogue() {
    const win = Date.now() - 15 * 60000;
    const fresh = state.dialogue.filter((it) => it.at >= win).slice(-20);
    if (fresh.length >= 5) return fresh;
    const need = 5 - fresh.length;
    const older = state.dialogue.filter((it) => it.at < win).slice(-need);
    return [...older, ...fresh]; // 升序（旧→新）
  }
  /** 事件正文（user/message 在 data.content、assistant/message 在 data.message.content，二者兼容）。 */
  function eventTextOf(data) {
    const payload = (data?.message && (Array.isArray(data.message.content) || typeof data.message.content === 'string'))
      ? data.message.content
      : (Array.isArray(data?.content) || typeof data?.content === 'string' ? data.content : null);
    if (typeof payload === 'string') return String(payload).trim();
    if (Array.isArray(payload)) {
      return payload.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    }
    return '';
  }

  /** 执行本插件可直接执行的安全内部动作（当前：无；外部动作经事件/日志交付 agent 通道）。 */
  /**
   * 内部安全动作白名单：循环可直接执行（低风险、系统内自包含）。
   * 外部工具动作不在此列 → 标记 deferred，经告知通道交用户/会话确认后执行。
   */
  const INTERNAL_ACTIONS = {
    // 用户状态读写走 memory 服务的 state 命名空间（2026-08-30 修复：此前调不存在的 stateSet/stateClear 顶层方法，动作永远 failed）
    // 2026-09-01：confidence 透传（与 user_state_set 工具一致，LLM 可给出置信度）
    user_state_set: (args) => ctx.memory.state.set({ state: args.state, detail: args.detail, confidence: args.confidence, evidence: args.evidence, ttlSeconds: args.ttlSeconds }),
    user_state_clear: (args) => ctx.memory.state.clear(args.state),
    memory_write: (args) => ctx.memory.write({ content: args.content, kind: args.kind, importance: args.importance, tags: args.tags, protected: args.protected }),
    // 2026-08-30 审计修复：notify/schedule 经 ctx.get 可选访问（schedule 亦注入 loop → 显式 inject 会循环依赖死锁）
    // 2026-09-03 分级：notify_send 内容由 AI 撰写、面向用户 → scope='chat'（受对话/静默窗门控，见 cycle）
    notify_send: (args) => {
      const notify = ctx.get('notify');
      if (notify === undefined) return { skipped: true, reason: 'notify 服务不可用' };
      return notify.send({ content: args.content, source: 'loop-action', scope: 'chat' });
    },
    schedule_create: (args) => {
      const schedule = ctx.get('schedule');
      if (schedule === undefined) return { skipped: true, reason: 'schedule 服务不可用' };
      return schedule.create(args);
    },
    loop_configure: (args) => ctx.loop.configure(args),
  };
  // 2026-09-03 静默/免流水动作集：纯系统内自包含（用户状态维护/记忆笔记）或内容已自行送达（notify_send，
  // 其内容按 chat 级直接投递给用户）——这些动作不进入"🤖 主动行动"操作流水文案：即使 LLM 误设
  // notifyUser=true 也强制压制（见 cycle 告知分支）。想告知用户相关内容时，AI 应通过 speakContent 用自然
  // 语言说出，而非动作状态串。
  const SILENT_ACTIONS = new Set(['user_state_set', 'user_state_clear', 'memory_write', 'notify_send']);

  function safeDetail(out) {
    try {
      if (out == null) return '';
      if (typeof out === 'object') return JSON.stringify(out).slice(0, 120);
      return String(out).slice(0, 120);
    } catch { return ''; }
  }

  /** 执行动作：内部白名单直接执行；外部动作标记待确认。async：动作可能是异步（memory_write 含 embedding），
   *  必须 await，否则 rejection 变 unhandled → Node 进程崩溃（2026-08-29 fatal load failure 根因）。
   *  2026-09-03 门控：notify_send（AI 撰写、面向用户的 chat 级消息）在 pre-turn 对话循环或静默窗内
   *  不投递（对话中由 agent 正常回复承担，避免并列消息割裂对话）——此时动作标记 suppressed 不执行。 */
  async function executeInternalActions(actions, { allowNotifySend = true } = {}) {
    const results = [];
    for (const a of actions) {
      const fn = INTERNAL_ACTIONS[a.name];
      if (fn) {
        if (a.name === 'notify_send' && !allowNotifySend) {
          results.push({ name: a.name, status: 'suppressed', detail: '对话循环/静默窗内不投递主动消息' });
          continue;
        }
        try {
          const out = await fn(a.args ?? {});
          results.push({ name: a.name, status: 'executed', detail: safeDetail(out) });
        } catch (error) {
          results.push({ name: a.name, status: 'failed', detail: String(error?.message ?? error).slice(0, 120) });
        }
      } else {
        results.push({ name: a.name, status: 'deferred', detail: '外部动作，经 agent 工具通道执行' });
      }
    }
    return results;
  }

  /** 执行一个思考循环。@param {string} reason 触发原因 @param {{userInput?:string}} [extra] 附加场景信息（对话前置思考携带用户最新输入） */
  async function cycle(reason, extra = {}) {
    // 2026-09-03-3：对话占位（conversing）中允许跑 pre-turn——此前仅 idle 可跑，若 turn/end 未及时
    // 复位占位，连续对话回合会整段跳过前置思考（用户"看不到刚输入/回应的思维"的成因之一）。
    if (state.mode !== 'idle' && !(reason === 'pre-turn' && state.mode === 'conversing')) {
      return { skipped: true, reason: `busy:${state.mode}` };
    }
    // 2026-09-03 凭证缺失冷却：未配置 API key 时循环必失败，30s 风暴只会空转耗资源
    // （手机端实测 error#1..#14 刷屏 + 同步 SQLite/embedding 周期性拖慢网页打开）。
    // 冷却期内跳过时间驱动循环；pre-turn（用户发消息触发）不拦——对话时用户在场，
    // 配好 key 后立即生效，且 pre-turn 失败不影响对话主流程。配置写入后经
    // archive/credentials-changed 事件立即清冷却并 markDirty，下个 tick（≤30s）自动恢复。
    if (reason !== 'pre-turn' && Date.now() < state.credentialCooldownUntil) {
      return { skipped: true, reason: `credential-cooldown:${Math.round((state.credentialCooldownUntil - Date.now()) / 1000)}s` };
    }
    // 2026-09-01：静默窗口内暂停时间驱动循环（fallback/startup/hour），只跑对话循环（pre-turn）
    if (isTimeBasedReason(reason) && Date.now() < state.quietUntil) return { skipped: true, reason: 'quiet' };
    // 2026-08-31 睡眠期：先推进睡眠状态机；睡眠期中循环完全暂停（无视降频开关，事件触发也跳过）
    updateSleepState();
    if (state.sleep.phase === 'asleep') {
      state.sleep.skips++;
      return { skipped: true, reason: 'sleeping' };
    }
    state.mode = 'thinking';
    // 2026-09-03-6 连锁修复：pre-turn（现允许对话占位 conversing 中运行）不得清空 dirty——
    // conversing 中用户连发消息会频繁触发 pre-turn cycle，若清 dirty 会把对话期间到达的
    // state-changed 等排队事件吞掉（状态变化将延迟到下次兜底才处理）；dirty 只由
    // 时间/事件驱动循环消费。pre-turn 自身产生的 dirty 条目（trigger('pre-turn') 注入，
    // 真实中 pre-turn 不经 dirty 触发，仅测试/外部直调会构造）单独移除，避免残留误导后续触发。
    if (reason === 'pre-turn') {
      state.dirtyReasons = state.dirtyReasons.filter((r) => r !== 'pre-turn');
      if (state.dirtyReasons.length === 0) state.dirty = false;
    } else {
      state.dirty = false;
      state.dirtyReasons = [];
    }
    const ac = new AbortController();
    // 2026-09-01：登记进行中的循环，供用户消息到达时中止（activeCycle 同时携带 userCancelled 标记）
    state.activeCycle = { ac, reason, at: Date.now() };
    // 2026-09-03-4：pre-turn 的 LLM 上限放宽到 preTurnCapMs+10s（让前置思考有正常完成时间，不被 60s thinkTimeout 先掐）；
    // 其余循环仍用 thinkTimeoutMs。
    const llmCapMs = reason === 'pre-turn' ? Math.max(config.thinkTimeoutMs, config.preTurnCapMs + 10000) : config.thinkTimeoutMs;
    const timeout = setTimeout(() => ac.abort(), llmCapMs);
    try {
      const time = ctx.virtualClock.format();
      const userContext = ctx.memory.state.snapshot().rendered;
      const persona = ctx.persona.render() ?? '';
      const mem = await recallMemories();
      // 2026-09-03-9 双 Agent（agent1）：记忆概括替代原始 <memories>（严格分源）；失败降级用原文
      let memorySummaryBlock = null;
      if (config.dualAgent) {
        const sm = await summarizeMemories(mem, ac.signal);
        if (sm.ok && sm.text) memorySummaryBlock = sm.text;
        else logger.warn(`archive-loop: 记忆概括失败，降级使用原始记忆（${sm.reason ?? 'unknown'}）`);
      }
      const memories = [...mem.recent, ...mem.related].slice(0, config.recallRecent + config.recallRelated);
      const loopHistory = recentLoopSummaries();
      // 2026-09-01：近期用户消息作为状态感知证据注入简报（时间驱动循环无 <user-input> 的补充）
      // 2026-09-03-3：recentDialogue = 最近真实对话（含 AI 对话回复）——主动循环判断"是否已答复/延续对话"
      // 2026-09-04-2 思维预设：命中文本 = 用户最新输入 + 用户状态渲染 + 近期用户消息；组装注入块
      const rums = recentUserMessages();
      const instrRes = assembleInstructions(instr, { hitTexts: [extra.userInput, userContext, ...rums.map((m) => m.text)] });
      const userInstructions = instrRes.block || null;
      let brief = buildSceneBrief({ time, userContext, persona, memories, loopHistory, userInput: extra.userInput, recentUserMessages: rums, recentDialogue: recentDialogue(), memorySummaryBlock, userInstructions });
      // 2026-08-30：决策 JSON 解析失败（LLM 偶发输出非 JSON）重试一次并附格式纠正提示——避免循环因解析失败而空转
      let decision = null;
      let parseError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        // 2026-09-03-4：pre-turn 只产简短决策 JSON，用独立小预算（preTurnMaxTokens）加速完成；
        // fallback/startup 等长分析决策保持 maxTokens。
        const mt = reason === 'pre-turn' ? config.preTurnMaxTokens : config.maxTokens;
        const text = await callLlm(brief, ac.signal, mt);
        try {
          decision = parseDecision(text);
          break;
        } catch (error) {
          parseError = error;
          logger.warn(`archive-loop: 决策解析失败（第 ${attempt + 1} 次）：${error.message} 原文=${String(text ?? '').slice(0, 120)}`);
          if (attempt === 0) brief = `${brief}\n（注意：上一轮输出不符合 JSON 格式要求。请严格只输出一个 JSON 对象，不要任何解释文字、不要代码围栏。）`;
        }
      }
      if (!decision) throw parseError ?? new Error('决策解析失败');
      // 2026-09-01：决策产出瞬间被用户消息中止 → 整轮作废（不发言/不行动/不留档/不更新 lastDecision）
      if (state.activeCycle?.userCancelled === true) return { skipped: false, cancelled: true, reason };
      // pre-turn（对话前置思考）：**无论以何种方式触发，一律不投递主动发言**——用户正在对话、agent 即将回复，
      // 任何 pre-turn 发言都是并列输出，会割裂对话。2026-09-01 修复：由 reason 强制（此前依赖调用方传
      // suppressSpeak，trigger('pre-turn')/后台过期循环可绕过 → 对话回合结束后仍投递发言，实机复现于 05:55/06:48）。
      // 发言内容仍记录在决策与循环日志中。其余触发（startup/fallback/hour 等）正常投递。
      if (decision.shouldSpeak && !extra.suppressSpeak && reason !== 'pre-turn') {
        if (state.activeCycle?.userCancelled === true) return { skipped: false, cancelled: true, reason };
        decision.speakAllowed = guards.checkSpeak();
        // 2026-09-03-2 时间线/重复推送修复：静默窗（用户消息/回合结束 quietAfterUserMs 内）对
        // **一切**主动发言生效，不限于时间驱动循环——state-changed 等事件驱动循环可能在回合
        // 结束后 ~60s 内触发并推送（实机 00:00:30"当然关心啊"串线，trigger=state-changed）。
        // 窗口内不投递发言，决策与循环日志照常留档（同 pre-turn 语义）。
        if (decision.speakAllowed && Date.now() < state.quietUntil) {
          decision.speakAllowed = false;
          logger.info(`archive-loop: 主动发言被静默窗抑制（${reason}，剩 ${Math.round((state.quietUntil - Date.now()) / 1000)}s）`);
        }
        // 2026-09-03-9 双 Agent：输出前审查（仅对将实际投递的发言；可更正内容或取消本次发言）
        // 2026-09-04-2 思维预设：审查材料附本次注入的用户指令（核对第⑤维）
        if (decision.speakAllowed && config.dualAgent) {
          const rv = await reviewOutput({ speak: decision.speakContent, actions: null, dialogueText: dialogueTextForReview(), personaText: persona, instructionsText: userInstructions ?? '' }, ac.signal);
          if (rv.ok && rv.verdict === 'revise' && rv.correctedSpeak) {
            decision.speakContent = rv.correctedSpeak;
            decision.reviewed = `revise:${rv.reason || '已更正'}`;
            logger.info(`archive-loop: 主动发言经审查修正（${reason}）：${rv.reason || ''}`);
          } else if (rv.ok && rv.verdict === 'cancel') {
            decision.speakAllowed = false;
            decision.reviewed = `cancel:${rv.reason || '审查取消'}`;
            logger.info(`archive-loop: 主动发言被审查取消（${reason}）：${rv.reason || ''}`);
          } else if (!rv.ok) {
            logger.warn(`archive-loop: 输出审查失败，按原样投递（${rv.reason ?? ''}）`);
          }
        }
        if (decision.speakAllowed) emitSpeak(decision.speakContent, time, { cancelled: state.activeCycle?.userCancelled === true });
      }
      if (decision.shouldAct && decision.actions.length > 0) {
        if (state.activeCycle?.userCancelled === true) return { skipped: false, cancelled: true, reason };
        // 2026-09-03 分级/割裂修复：
        //  - isPreTurnCycle：对话前置循环（用户正在对话）——动作照常执行（衔接对话用），但**任何告知都不投递**
        //    （发言已禁；行动状态串/notify_send 若投递会插进对话中间——实机 03:49"🤖 主动行动：已执行 memory_write"
        //    泄露进用户对话的根因）。
        //  - notify_send（chat 级）另受静默窗门控：用户刚发消息/回合刚结束的窗口内不投递（对话由 agent 回复承担）。
        const isPreTurnCycle = reason === 'pre-turn';
        const inQuietWindow = Date.now() < state.quietUntil;
        // 硬性后果门（用户需求：采取工具类主动行动前必须先思考后果及是否告知用户）：
        // 后果评估缺失 → 一律不执行，标记 deferred 并留档。
        const hasAssessment = String(decision.consequenceAssessment ?? '').trim().length > 0;
        if (!hasAssessment) {
          decision.actionsAllowed = true;
          decision.actionResults = decision.actions.map((a) => ({ name: a.name, status: 'deferred', detail: '缺少后果评估，未执行' }));
        } else {
          decision.actionsAllowed = guards.checkActions(decision.actions.length);
          if (decision.actionsAllowed) {
            // 2026-09-03-9 双 Agent：输出前审查——阻止不合理的行动（不新增行动，仅过滤）
            // 2026-09-04-2 思维预设：审查材料附本次注入的用户指令（核对第⑤维）
            let execActions = decision.actions;
            if (config.dualAgent) {
              const rv = await reviewOutput({ speak: null, actions: decision.actions, dialogueText: dialogueTextForReview(), personaText: persona, instructionsText: userInstructions ?? '' }, ac.signal);
              if (rv.ok && rv.blockedActions.length > 0) {
                const blocked = new Set(rv.blockedActions);
                execActions = decision.actions.filter((a) => !blocked.has(a.name));
                decision.reviewed = `blocked:${rv.blockedActions.join(',')}（${rv.reason || ''}）`;
                logger.info(`archive-loop: 行动经审查阻止（${reason}）：${rv.blockedActions.join(',')} ${rv.reason || ''}`);
              } else if (!rv.ok) {
                logger.warn(`archive-loop: 行动审查失败，按原样执行（${rv.reason ?? ''}）`);
              }
            }
            decision.actionResults = await executeInternalActions(execActions, { allowNotifySend: !isPreTurnCycle && !inQuietWindow });
          } else {
            decision.actionResults = decision.actions.map((a) => ({ name: a.name, status: 'budget-blocked', detail: '行动预算超限' }));
          }
        }
        // 2026-09-01：行动执行期间被用户消息中止 → 不再告知（防并列输出的割裂感）
        if (state.activeCycle?.userCancelled === true) return { skipped: false, cancelled: true, reason };
        // 告知（panel 级操作流水）：由 AI 依据后果评估判定（notifyUser）——小事可静默行动。
        // 2026-09-03 收紧：
        //  1) pre-turn（对话中）不产生任何告知——对话支持动作静默（03:49 泄露回归）；
        //  2) 静默/免流水动作（user_state_*/memory_write/notify_send）即使 notifyUser=true 也不进"主动行动"
        //     文案（LLM 语义误用兜底 + 免重复：notify_send 内容已按 chat 级自行送达）——系统自包含操作；
        //  3) 告知一律 panel 级——"🤖 主动行动"是操作流水文案，绝不注入对话流（chat 级仅 AI 面向用户的自然消息）。
        if (decision.notifyUser && !isPreTurnCycle) {
          const visible = decision.actionResults.filter((r) => r.status !== 'suppressed' && !SILENT_ACTIONS.has(r.name));
          const executed = visible.filter((r) => r.status === 'executed');
          const queued = visible.filter((r) => r.status === 'deferred');
          const failed = visible.filter((r) => r.status === 'failed');
          const parts = [];
          if (executed.length) parts.push(`已执行：${executed.map((r) => r.name).join('、')}`);
          if (queued.length) parts.push(`将执行（agent 通道）：${queued.map((r) => r.name).join('、')}`);
          if (failed.length) parts.push(`执行失败：${failed.map((r) => r.name).join('、')}`);
          if (parts.length > 0) {
            // 2026-08-30 审计修复：notify 经 ctx.get 可选访问（显式 inject 会与 schedule 构成循环依赖）
            const notify = ctx.get('notify');
            if (notify !== undefined) {
              try {
                notify.send({ content: `🤖 主动行动：${parts.join('；')}（后果评估：${decision.consequenceAssessment || '无'}）`, source: 'loop', scope: 'panel' });
              } catch { /* 告知失败不阻断 */ }
            }
          }
        }
      }
      const logContent = renderLoopLog({ time, reason, decision });
      if (state.activeCycle?.userCancelled === true) return { skipped: false, cancelled: true, reason };
      try {
        const written = await ctx.memory.write({ content: logContent, kind: 'thought', source: 'loop', importance: 0.4, tags: ['loop'] });
        // 2026-09-01：写回瞬间被用户消息中止 → 删除刚写的记录（并行决策不留档，行为回退）；
        // 2026-09-03-3：cap（前置思考超时）中止不删档——该记录完整决策已生成，留档供活动流查看。
        if (state.activeCycle?.userCancelled === true && state.activeCycle?.abortKind !== 'cap' && written?.id) {
          try { ctx.memory.forget(written.id); } catch { /* 清理失败不阻断 */ }
          return { skipped: false, cancelled: true, reason };
        }
      } catch (error) {
        logger.warn(`archive-loop: 循环日志写回失败：${error.message}`);
      }
      if (state.activeCycle?.userCancelled === true) return { skipped: false, cancelled: true, reason };
      state.lastDecision = decision;
      state.lastDecisionAt = Date.now();
      state.lastDecisionReason = reason; // 2026-09-03-3：供 <loop-analysis> 注入标注来源（pre-turn/fallback…）
      state.cycleCount++;
      // 2026-08-31 审计修复：事件监听者异常不判循环失败重跑（此前监听者抛错会进 catch →
      // errorCount++ 且 dirty 置回 → 下个 tick 重跑整轮循环（重复 LLM/动作/发言））
      try { ctx.emit('archive/loop-cycle', { at: Date.now(), reason, decision: JSON.parse(JSON.stringify(decision)) }); } catch { /* 事件失败不阻断 */ }
      logger.info(`archive-loop: cycle#${state.cycleCount} trigger=${reason} speak=${decision.shouldSpeak} act=${decision.shouldAct}`);
      if (state.cycleCount === 1) {
        bootLine(`[archive-loop] 首次循环完成 trigger=${reason} speak=${decision.shouldSpeak} act=${decision.shouldAct}`);
      }
      return { skipped: false, decision };
    } catch (error) {
      // 2026-09-01：用户消息中止 → 非故障：不计数错误、不置 dirty（避免下个 tick 用旧记忆重跑并行决策）
      if (state.activeCycle?.userCancelled === true) {
        state.cancelledCount++;
        // 2026-09-03-3：25s 对话前置思考上限（cap）中止 → 补一条"超时"留痕记录，让「思维循环」活动流
        // 可见该回合曾有思考被砍（此前完全静默消失，用户以为对话不经思维循环）；不计错误、不置 dirty。
        if (state.activeCycle?.abortKind === 'cap') {
          try {
            const t = (() => { try { return ctx.virtualClock.format(); } catch { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; } })();
            ctx.memory.write({
              content: `<loop-decision time="${t}" trigger="pre-turn">\n<analysis>对话前置思考未在 ${Math.round(config.preTurnCapMs / 1000)}s 时限内完成（对话已推进，本轮思考被中止）——未注入当前回合，此处留痕。该时限与单次预算均可调（preTurnCapMs/preTurnMaxTokens）。</analysis>\n<speak>不发言</speak>\n<act>不行动</act>\n</loop-decision>`,
              kind: 'thought', source: 'loop', importance: 0.3, tags: ['loop'],
            }).catch(() => {});
          } catch { /* 留痕失败不阻断 */ }
        }
        logger.info(`archive-loop: 循环被${state.activeCycle?.abortKind === 'cap' ? '对话前置思考超时(cap)' : '用户消息'}中止（${reason}）：${error.message}`);
        return { skipped: false, cancelled: true, reason };
      }
      state.errorCount++;
      // 2026-09-03 凭证缺失冷却：MISSING_CREDENTIAL（未配置 API key）是"等用户配置"的持久性错误，
      // 30s 风暴空转（每轮先跑 SQLite 召回/构造简报，手机端实测周期拖慢网页打开）→ 进入 5 分钟冷却，
      // 冷却期内 tick 全部跳过；模型页配置成功会 emit archive/credentials-changed 立即唤醒。
      const errText = String(error?.message ?? error ?? '');
      const isCredentialMissing = /MISSING_CREDENTIAL|no API key|INVALID_CREDENTIAL/i.test(errText);
      if (isCredentialMissing && state.credentialCooldownUntil <= Date.now()) {
        state.credentialCooldownUntil = Date.now() + config.credentialRetryMs;
        bootLine(`[archive-loop] 未配置模型密钥（${reason}）：${errText.slice(0, 140)} → 循环暂停 ${Math.round(config.credentialRetryMs / 60000)} 分钟，配置后自动恢复`);
      } else {
        // 2026-09-01-3 诊断增强：循环失败直写 stdout（进 archive.log）——此前仅 logger.warn，
        // dsh logger 输出不落 archive.log，失败风暴期间具体错误码完全不可见（实机 19:41-20:57 失败
        // 123 次而日志无一条错误详情）。行为不变，仅补诊断可见性。
        bootLine(`[archive-loop] 循环失败(${reason}) error#${state.errorCount}: ${error.message}`);
      }
      // 2026-08-30 韧性补丁：失败保留 dirty 标志——断网/API 瞬时故障后下一个 tick（30s）自动重试，
      // 而不是静默等到下一个自然触发点；持久故障下重试很快失败、无 token 浪费。
      // 2026-09-03：凭证缺失除外（冷却期内不置 dirty，避免 30s 风暴；冷却到期后由兜底触发自然重试）。
      if (!isCredentialMissing) {
        state.dirty = true;
        if (!state.dirtyReasons.includes(reason)) state.dirtyReasons.push(reason);
        logger.warn(`archive-loop: 循环失败（${reason}）：${error.message}`);
      } else {
        logger.warn(`archive-loop: 凭证缺失（${reason}），循环暂停至配置就绪：${error.message}`);
      }
      if (state.cycleCount === 0 && state.errorCount === 1) {
        bootLine(`[archive-loop] 首次循环失败: ${error.message}`);
      }
      return { skipped: false, error: error.message };
    } finally {
      clearTimeout(timeout);
      state.lastCycleAt = Date.now();
      state.mode = 'idle';
      state.activeCycle = null; // 2026-09-01
    }
  }

  /** 最近 1 次循环的决策摘要（供简报 <loop-history>）。2026-09-03-3：带真实时间 at，防旧决策被当"刚才"。 */
  function recentLoopSummaries() {
    if (!state.lastDecision) return [];
    const d = state.lastDecision;
    return [{ text: `${d.analysis}（发言:${d.shouldSpeak}，行动:${d.shouldAct ? d.actions.length : 0}）`, at: state.lastDecisionAt }];
  }

  /** 主动发言交付（阶段五：经 notify 通道送达控制台/通知流水/总会话；同时事件 + 记忆留档）。
   *  2026-09-03 分级：AI 面向用户的自然语言 → scope='chat'（可注入总会话对话流，同 <loop-speak> 留档）；
   *  "🤖 主动行动"等操作状态串一律 panel 级不注入对话（见 cycle 告知分支）。
   *  @param {{cancelled?:boolean}} [opts] 2026-09-01：被用户消息中止的循环不再写 <loop-speak> 留档 */
  function emitSpeak(content, time, { cancelled } = {}) {
    const notify = ctx.get('notify');
    if (notify !== undefined) {
      try {
        const res = notify.send({ content, source: 'loop', scope: 'chat' });
        if (res && res.limited) logger.warn('archive-loop: 主动发言被 notify 全局限频吞掉（未送达，已留档）');
      } catch { /* 通知失败不阻断 */ }
    }
    ctx.emit('archive/loop-speak', { at: Date.now(), time, content });
    if (cancelled) return; // 2026-09-01：并行决策的发言不留档（清理记录/回退行为）
    // 2026-08-30 审计修复：memory.write 异步（含 embedding），必须 .catch 兜底，
    // 否则 ollama 掉线/超时时 unhandled rejection → Node 崩溃（历史 fatal 同类根因）。
    ctx.memory.write({ content: `<loop-speak time="${time}">${content}</loop-speak>`, kind: 'episodic', source: 'loop-speak', importance: 0.5, tags: ['loop', 'speak'] })
      .catch((error) => logger.warn(`archive-loop: 主动发言留档失败：${error?.message ?? error}`));
  }

  /** 当前生效的兜底间隔（2026-08-30 降频开关制：开启则用降频间隔，不再依赖用户状态）。 */
  function effectiveFallback() {
    return config.reducedMode ? config.reducedFallbackMs : config.fallbackIntervalMs;
  }

  /** 触发解析：dirty 事件优先，其次定时兜底（须已有历史循环，避免首 tick 误触发）。
   *  2026-09-01：静默窗口内暂停时间驱动触发（fallback/startup/hour），对话循环优先。
   *  2026-09-03：凭证冷却期内不触发时间驱动循环（避免 30s 风暴空转；cycle 入口兜底跳过）。 */
  function resolveTrigger() {
    if (state.dirty) {
      const reason = state.dirtyReasons[0] ?? 'event';
      if (isTimeBasedReason(reason) && Date.now() < state.quietUntil) return null;
      if (isTimeBasedReason(reason) && Date.now() < state.credentialCooldownUntil) return null;
      return reason;
    }
    if (Date.now() < state.quietUntil) return null;
    if (Date.now() < state.credentialCooldownUntil) return null;
    if (state.lastCycleAt > 0 && Date.now() - state.lastCycleAt >= effectiveFallback()) return 'fallback';
    return null;
  }

  // 事件触发：用户状态变化
  ctx.on('archive/state-changed', () => markDirty('state-changed'));
  // 2026-09-03 凭证配置成功唤醒：模型页写入 DeepSeek key / 自定义 provider 后清除冷却并立即重试
  // （control models.setDeepSeekKey / setProviders 成功后 emit archive/credentials-changed）
  ctx.on('archive/credentials-changed', () => {
    if (state.credentialCooldownUntil > Date.now()) {
      state.credentialCooldownUntil = 0;
      logger.info('archive-loop: 检测到模型凭证已配置，清除冷却并恢复自循环');
      markDirty('credentials-ready');
    }
  });
  // 时钟里程碑：整点变化
  const tick = () => {
    // 2026-08-31 睡眠状态推进（进入/解除/冷却倒计时；即使无循环触发也要及时更新）
    updateSleepState();
    if (state.mode === 'conversing') {
      // 对话占位超时自动释放（对话层未显式 endConversation 时）
      if (Date.now() - state.conversingSince > config.conversationTimeoutMs) {
        state.mode = 'idle';
        logger.info('archive-loop: 对话占位超时，恢复 idle');
      }
      return;
    }
    if (state.mode !== 'idle') return;
    const hour = new Date().getHours();
    if (hour !== lastHour) {
      lastHour = hour;
      markDirty(`hour-${hour}`);
    }
    const trigger = resolveTrigger();
    if (trigger) void cycle(trigger);
  };

  // 定时驱动：tick 检查 + 启动延迟
  ctx.timer.setTimeout(() => {
    ctx.timer.setInterval(tick, config.tickMs);
    // 首循环：启动即触发一次（startup），此后由事件/兜底驱动
    void cycle('startup');
  }, config.initialDelayMs);

  const api = {
    /** 手动/外部触发一次循环（用户消息、状态变化等事件源调用）。 */
    trigger: (reason = 'manual') => {
      markDirty(reason);
      return { queued: true };
    },
    /** 运行时调整（无需重启；2026-08-30 支持降频开关，经 settings archive-loop 持久化）。 */
    configure: (patch = {}) => {
      if (patch.fallbackIntervalMs !== undefined) {
        if (!Number.isFinite(patch.fallbackIntervalMs) || patch.fallbackIntervalMs < 1000) throw new Error('fallbackIntervalMs 必须 ≥1000ms');
        config.fallbackIntervalMs = patch.fallbackIntervalMs;
      }
      if (patch.reducedMode !== undefined) {
        if (typeof patch.reducedMode !== 'boolean') throw new Error('reducedMode 必须是布尔');
        config.reducedMode = patch.reducedMode;
        try {
          const settings = ctx.get('settings');
          if (settings && typeof settings.update === 'function') Promise.resolve(settings.update(settingsNamespace('archive-loop'), { reducedMode: config.reducedMode })).catch(() => {});
        } catch { /* 持久化失败不阻断 */ }
        logger.info(`archive-loop: 降频模式 ${config.reducedMode ? '开启' : '关闭'}（兜底 ${Math.round(effectiveFallback() / 60000)} 分钟）`);
      }
      // 2026-08-31 睡眠参数运行时调整（UI/测试用；默认值在 cordis.patch.yml）
      for (const key of ['sleepEnterDelayMs', 'sleepMaxMs', 'sleepCooldownMs', 'sleepCheckWindowMs']) {
        if (patch[key] !== undefined) {
          if (!Number.isFinite(patch[key]) || patch[key] < 1000) throw new Error(`${key} 必须 ≥1000ms`);
          config[key] = patch[key];
        }
      }
      // 2026-09-01 静默窗口运行时调整（≥0 可关闭该限制；默认 30000 在 cordis.patch.yml）
      if (patch.quietAfterUserMs !== undefined) {
        if (!Number.isFinite(patch.quietAfterUserMs) || patch.quietAfterUserMs < 0) throw new Error('quietAfterUserMs 必须 ≥0ms');
        config.quietAfterUserMs = patch.quietAfterUserMs;
      }
      // 2026-09-01-4 单次决策 token 预算运行时调整（总控「思维循环」页编辑栏；默认 10000 在 cordis.patch.yml）
      if (patch.maxTokens !== undefined) {
        if (!Number.isFinite(patch.maxTokens) || patch.maxTokens < 1) throw new Error('maxTokens 必须 ≥1');
        config.maxTokens = Math.floor(patch.maxTokens);
        logger.info(`archive-loop: maxTokens 更新为 ${config.maxTokens}`);
      }
      // 2026-09-03-4/5 对话前置思考专用参数运行时调整（默认 90s/4000；范围与 UI 一致，防乱填）
      if (patch.preTurnCapMs !== undefined) {
        if (!Number.isFinite(patch.preTurnCapMs) || patch.preTurnCapMs < PRE_TURN_CAP_MIN || patch.preTurnCapMs > PRE_TURN_CAP_MAX) {
          throw new Error(`preTurnCapMs 必须在 ${PRE_TURN_CAP_MIN}~${PRE_TURN_CAP_MAX}ms 之间（5 秒~10 分钟）`);
        }
        config.preTurnCapMs = Math.floor(patch.preTurnCapMs);
        logger.info(`archive-loop: preTurnCapMs 更新为 ${config.preTurnCapMs}`);
      }
      if (patch.preTurnMaxTokens !== undefined) {
        if (!Number.isFinite(patch.preTurnMaxTokens) || patch.preTurnMaxTokens < PRE_TURN_TOK_MIN || patch.preTurnMaxTokens > PRE_TURN_TOK_MAX) {
          throw new Error(`preTurnMaxTokens 必须在 ${PRE_TURN_TOK_MIN}~${PRE_TURN_TOK_MAX} 之间`);
        }
        config.preTurnMaxTokens = Math.floor(patch.preTurnMaxTokens);
        logger.info(`archive-loop: preTurnMaxTokens 更新为 ${config.preTurnMaxTokens}`);
      }
      // 2026-09-10：冷启动首条免等参数运行时调整（默认 15min/5s；范围与 normalizeConfig 一致）
      if (patch.preTurnColdGapMs !== undefined) {
        if (!Number.isFinite(patch.preTurnColdGapMs) || patch.preTurnColdGapMs < PRE_TURN_COLD_GAP_MIN || patch.preTurnColdGapMs > PRE_TURN_COLD_GAP_MAX) {
          throw new Error(`preTurnColdGapMs 必须在 ${PRE_TURN_COLD_GAP_MIN}~${PRE_TURN_COLD_GAP_MAX}ms 之间`);
        }
        config.preTurnColdGapMs = Math.floor(patch.preTurnColdGapMs);
        logger.info(`archive-loop: preTurnColdGapMs 更新为 ${config.preTurnColdGapMs}`);
      }
      if (patch.preTurnColdCapMs !== undefined) {
        if (!Number.isFinite(patch.preTurnColdCapMs) || patch.preTurnColdCapMs < PRE_TURN_COLD_CAP_MIN || patch.preTurnColdCapMs > PRE_TURN_COLD_CAP_MAX) {
          throw new Error(`preTurnColdCapMs 必须在 ${PRE_TURN_COLD_CAP_MIN}~${PRE_TURN_COLD_CAP_MAX}ms 之间`);
        }
        config.preTurnColdCapMs = Math.floor(patch.preTurnColdCapMs);
        if (config.preTurnColdCapMs > config.preTurnCapMs) config.preTurnColdCapMs = config.preTurnCapMs;
        logger.info(`archive-loop: preTurnColdCapMs 更新为 ${config.preTurnColdCapMs}`);
      }
      // 2026-09-03-9 双 Agent 开关运行时调整（持久化 archive-loop settings；默认关=与旧流程一致）
      if (patch.dualAgent !== undefined) {
        if (typeof patch.dualAgent !== 'boolean') throw new Error('dualAgent 必须是布尔');
        config.dualAgent = patch.dualAgent;
        try {
          const settings = ctx.get('settings');
          if (settings && typeof settings.update === 'function') Promise.resolve(settings.update(settingsNamespace('archive-loop'), { dualAgent: config.dualAgent })).catch(() => {});
        } catch { /* 持久化失败不阻断 */ }
        logger.info(`archive-loop: 双 Agent（记忆加工+输出审查）${config.dualAgent ? '开启' : '关闭'}`);
      }
      return { fallbackIntervalMs: config.fallbackIntervalMs, reducedMode: config.reducedMode, effectiveFallbackMs: effectiveFallback(), quietAfterUserMs: config.quietAfterUserMs, maxTokens: config.maxTokens, preTurnCapMs: config.preTurnCapMs, preTurnMaxTokens: config.preTurnMaxTokens, preTurnColdGapMs: config.preTurnColdGapMs, preTurnColdCapMs: config.preTurnColdCapMs, dualAgent: config.dualAgent };
    },
    /** 对话前置：若思考循环进行中，有界等待其完成；随后运行一次 pre-turn 决策循环并进入对话占位（暂停主动循环）。
     * 2026-08-30 修复：去掉 preTurnRefreshMs(60s) 节流——用户明确要求"对话过程进入认知循环"，
     * 每条对话消息都应产生一次围绕该消息的前置思考（决策携带 <user-input>，循环日志落库）。
     *  @param {string} [userInput] 用户最新输入（供 pre-turn 决策围绕该输入分析） */
    beforeTurn: async (userInput) => {
      // 2026-09-01：对话开始前兜底中止仍在运行的时间驱动/过期 pre-turn 循环（session/event 已先行中止；
      // 此处覆盖事件未达/乱序的情况，避免对话回合等待并行的兜底决策）
      abortParallelCycle();
      if (state.mode === 'thinking') {
        const deadline = Date.now() + config.thinkTimeoutMs;
        while (state.mode === 'thinking' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      // 2026-09-03-3：对话占位（conversing）中也跑 pre-turn——连续对话时若 turn/end 未及时复位占位，
      // 此前会整段跳过前置思考（用户"看不到刚输入/回应的思维"成因之一）；conversing 只拦 tick 的主动循环。
      if (state.mode === 'idle' || state.mode === 'conversing') {
        await cycle('pre-turn', { userInput, suppressSpeak: true });
      }
      // 进入对话占位：对话期间 tick 不再启动新主动循环（pre-turn 结束后 cycle 复位 idle，此处重新置位）
      if (state.mode === 'idle') {
        state.mode = 'conversing';
        state.conversingSince = Date.now();
      }
      return { mode: state.mode, decision: state.lastDecision ? JSON.parse(JSON.stringify(state.lastDecision)) : null, lastDecisionAt: state.lastDecisionAt };
    },
    /** 对话结束：恢复 idle（也可依赖超时自动释放）。 */
    endConversation: () => {
      if (state.mode === 'conversing') state.mode = 'idle';
      return { mode: state.mode };
    },
    /** 显式进入/退出对话占位。 */
    beginConversation: () => {
      if (state.mode === 'idle') {
        state.mode = 'conversing';
        state.conversingSince = Date.now();
      }
      return { mode: state.mode };
    },
    state: () => {
      const now = Date.now();
      const { activeCycle, ...rest } = state; // activeCycle 含 AbortController，不序列化（RPC/UI 用 activeCycleReason）
      return {
        ...rest,
        activeCycleReason: state.activeCycle?.reason ?? null, // 2026-09-01
        quietUntil: state.quietUntil, // 2026-09-01 静默窗口截止时间
        quietLeftMs: Math.max(0, state.quietUntil - now), // 2026-09-01 静默窗口剩余
        cancelledCount: state.cancelledCount, // 2026-09-01 被用户消息中止的循环数
        lastDecision: state.lastDecision ? JSON.parse(JSON.stringify(state.lastDecision)) : null,
        dirtyReasons: [...state.dirtyReasons],
        sleep: sleepSummary(),
      };
    },
    stats: () => ({
      mode: state.mode,
      cycleCount: state.cycleCount,
      errorCount: state.errorCount,
      cancelledCount: state.cancelledCount, // 2026-09-01
      quietLeftMs: Math.max(0, state.quietUntil - Date.now()), // 2026-09-01
      credentialCooldownLeftMs: Math.max(0, state.credentialCooldownUntil - Date.now()), // 2026-09-03
      lastCycleAt: state.lastCycleAt,
      lastDecisionAt: state.lastDecisionAt,
      sleepSkips: state.sleep.skips,
      sleepPhase: state.sleep.phase,
      guards: guards.stats(),
      config: {
        fallbackIntervalMs: config.fallbackIntervalMs,
        reducedFallbackMs: config.reducedFallbackMs,
        reducedMode: config.reducedMode,
        effectiveFallbackMs: effectiveFallback(),
        quietAfterUserMs: config.quietAfterUserMs, // 2026-09-01
        maxTokens: config.maxTokens, // 2026-09-01-4
        preTurnCapMs: config.preTurnCapMs, // 2026-09-03-4：对话前置思考完成时限（ms）
        preTurnMaxTokens: config.preTurnMaxTokens, // 2026-09-03-4：对话前置思考单次预算
        preTurnColdGapMs: config.preTurnColdGapMs, // 2026-09-10：冷启动判定阈值（距上一用户回合 ms）
        preTurnColdCapMs: config.preTurnColdCapMs, // 2026-09-10：冷启动首条前置思考临时等待上限（ms）
        dualAgent: config.dualAgent, // 2026-09-03-9：双 Agent（记忆加工+输出审查）开关
        tickMs: config.tickMs, provider: config.provider, model: config.model,
        credentialRetryMs: config.credentialRetryMs, // 2026-09-03
        sleepEnterDelayMs: config.sleepEnterDelayMs, sleepMaxMs: config.sleepMaxMs,
        sleepCooldownMs: config.sleepCooldownMs, sleepCheckWindowMs: config.sleepCheckWindowMs,
      },
    }),
    /** 2026-08-31 定时任务打断睡眠期（schedule 触发任务时调用）：asleep → cooldown。 */
    wake,
    /** 思维预设（2026-09-04-2）：用户指令管理。get=全量读取；save=整存（校验+护栏+持久化）；
     *  preview=按活跃预设模拟命中（UI 调试用）。零配置时全链路零注入。 */
    instructions: {
      get: () => JSON.parse(JSON.stringify(instr)),
      save: (raw) => {
        instr = validateInstrForSave(raw);
        persistInstructions();
        logger.info(`archive-loop: 思维预设已更新（预设 ${instr.presets.length} / 指令 ${instr.entries.length} / 活跃=${instr.activePresetId || '未启用'} / 上限=${instr.injectCapChars}字符）`);
        return api.instructions.get();
      },
      preview: (text, presetId) => previewInstructions(instr, text, presetId),
    },
  };
  ctx.provide('loop', api);

  // 2026-09-04-2 思维预设持久化（settings 不可用/失败时静默降级为内存态，不影响功能）
  const persistInstructions = () => {
    try { if (instrPersist) Promise.resolve(instrPersist()).catch(() => {}); } catch { /* 忽略 */ }
  };

  // 每回合注入最新循环分析（对话回合可见"最近一次思考"）
  try {
    ctx.systemPrompt.context({
      name: 'loop-latest-analysis',
      order: config.injectOrder,
      text: () => {
        if (!state.lastDecision) return '';
        // 2026-09-03-3：附带 reason/at——对话回合据此判断注入的是"本轮前置思考"还是旧的时间驱动决策
        return `<loop-analysis>${JSON.stringify({ at: state.lastDecisionAt, reason: state.lastDecisionReason, analysis: state.lastDecision.analysis, shouldSpeak: state.lastDecision.shouldSpeak, shouldAct: state.lastDecision.shouldAct }).replace(/</g, '&lt;')}</loop-analysis>`;
      },
    });
  } catch (error) {
    logger.warn(`archive-loop: systemPrompt context 注册失败：${error.message}`);
  }

  // 2026-09-03-9：对话回复正文的输出前自检（仅 dualAgent 开启时注入——回复正文由主会话 agent 生成，
  // 不经 cycle 决策，故用"生成前软自检"约束：通顺/承接不重复不推翻/行动合理/符合人设）
  // 2026-09-04-2 思维预设：scope 含 dialogue 的常驻指令附加在自检后（运行时读取当前预设，无需重启）
  try {
    ctx.systemPrompt.context({
      name: 'output-selfcheck',
      order: config.injectOrder - 20,
      text: () => {
        if (!config.dualAgent) return '';
        const extra = dialogueInstructionText(instr);
        return extra ? `${OUTPUT_SELFCHECK}\n⑤ 用户思维预设附加要求（一并遵守）：${extra}` : OUTPUT_SELFCHECK;
      },
    });
  } catch (error) {
    logger.warn(`archive-loop: output-selfcheck 注入失败：${error.message}`);
  }

  // 工具：手动触发 / 运行时调整 / 查看状态
  const tools = ctx.get('tools');
  if (tools !== undefined) {
    const registered = [];
    const reg = (tool) => { tools.register(tool); registered.push(tool.name); };
    reg(defineTool({
      name: 'loop_trigger',
      description: '手动触发一次自循环思考（召回记忆→分析场景→决定行为）。',
      parameters: { reason: { type: 'string', description: '触发原因（默认 manual）' } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { queued: { type: 'boolean', required: true } },
      }),
      execute(args) {
        return api.trigger(args.reason ?? 'manual');
      },
    }));
    reg(defineTool({
      name: 'loop_config',
      description: '运行时调整自循环参数（无需重启）。支持 fallbackIntervalMs（兜底间隔毫秒）、maxTokens（单次决策 token 预算）、quietAfterUserMs（用户消息后静默窗口毫秒）。',
      parameters: {
        fallbackIntervalMs: { type: 'number', description: '兜底间隔毫秒（≥1000）' },
        maxTokens: { type: 'number', description: '单次决策调用最大 token 预算（≥1；推理模型 reasoning 会占用，默认 10000）' },
        quietAfterUserMs: { type: 'number', description: '用户消息后暂停时间驱动循环的毫秒数（≥0，0 关闭）' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          fallbackIntervalMs: { type: 'number', required: true },
          maxTokens: { type: 'number', required: true },
          quietAfterUserMs: { type: 'number', required: true },
        },
      }),
      execute(args) {
        // 裁剪：configure 返回还含 reducedMode/effectiveFallbackMs（schema 未声明，会致 agent 调用被拒）
        const r = api.configure(args);
        return { fallbackIntervalMs: r.fallbackIntervalMs, maxTokens: r.maxTokens, quietAfterUserMs: r.quietAfterUserMs };
      },
    }));
    reg(defineTool({
      name: 'loop_view',
      description: '查看自循环状态（模式/循环次数/上次决策/防护计数/当前配置）。',
      parameters: {},
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { stats: { type: 'object', required: true, additionalProperties: true } },
      }),
      execute() {
        return { stats: api.stats() };
      },
    }));
    logger.info(`archive-loop: 已注册工具 ${registered.join(', ')}`);
    bootLine(`[archive-loop] 工具已注册: ${registered.join(', ')}`);
  }

  bootLine(`[archive-loop] ready 兜底=${Math.round(config.fallbackIntervalMs / 1000)}s provider=${config.provider} model=${config.model} sleep=${state.sleep.phase}`);

  // 对话前置思考接线（2026-08-30 用户反馈"思维循环不在对话中运行"）：
  // 主会话 agent 每回合第一步（step===1）在 LLM 请求前运行 beforeTurn（pre-turn 决策循环：召回记忆→场景简报→
  // LLM 决策→防护→循环日志 thought），决策注入 loop-latest-analysis 供本回合参考；回合结束 endConversation 恢复 idle。
  // 仅主会话（session-main）触发——子代理/其他会话不跑，防 token 浪费；beforeTurn 内部有 preTurnRefreshMs(60s) 刷新间隔，
  // 对话中不会每回合都重跑决策。pre-step 为瀑布事件，必须 next() 放行，失败不阻断对话。
  const MAIN_SESSION_ID = 'session-main';
  const isMainAgent = (agent) => agent?.id === MAIN_SESSION_ID || agent?.session?.id === MAIN_SESSION_ID || agent?.session?.sessionId === MAIN_SESSION_ID;
  // 2026-08-31 修复（A）：pre-step 的 messages 提取对部分回合拿不到用户最新输入
  // （pre-turn 决策写成"无新输入"，与对话脱节）→ 双保险：messages 提取 + session/event user/message 缓冲兜底。
  let latestUserInput = { text: '', at: 0 };
  // 2026-09-10：冷启动判定——最近一次被对话前置思考处理过的真实用户回合时间（0=进程启动后首条亦按冷启动处理）
  let lastUserTurnAt = 0;
  function contentTextOf(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    if (blocks.length === 0 && typeof data?.content === 'string') return String(data.content).trim();
    const texts = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '').trim()).filter(Boolean);
    if (texts.length > 0) return texts.join('\n');
    return '';
  }
  ctx.on('agent/pre-step', async ({ agent, step, messages }, next) => {
    try {
      if (step === 1 && isMainAgent(agent)) {
        // 提取用户最新输入（source.kind==='user' 的真实消息），供 pre-turn 决策围绕该输入分析
        let userInput = '';
        for (const m of (messages ?? [])) {
          if (m?.source?.kind !== 'user') continue;
          const txt = contentTextOf(m);
          if (txt && !txt.startsWith('Current runtime context')) userInput += (userInput ? '\n' : '') + txt;
        }
        // 2026-08-31 兜底：messages 提取为空但 60s 内收到过真实用户消息 → 用缓冲（修复 pre-turn"无新输入"）
        if (!userInput && latestUserInput.text && Date.now() - latestUserInput.at < 60000) {
          userInput = latestUserInput.text;
        }
        if (userInput.length > 200) userInput = `${userInput.slice(0, 200)}…`;
        // 2026-09-10：冷启动首条免等——距上一真实用户回合超过 preTurnColdGapMs（默认 15min）时，
        // 前置思考的等待上限临时收窄为 preTurnColdCapMs（默认 5s）。实测挂机唤醒后首条消息被整条
        // pre-turn 链（记忆概括+决策+审查，约 47~50s）阻塞、期间消息未落库无回显；上限先到即中止
        // （与既有 cap 中止路径一致：超时留痕、对话照常推进）。仅影响冷启动首条，对话内连续消息
        // 仍走 preTurnCapMs（默认 120s，遵用户 2026-09-03 指示放宽）。
        const now = Date.now();
        const coldFirst = (lastUserTurnAt ? now - lastUserTurnAt : Number.POSITIVE_INFINITY) > config.preTurnColdGapMs;
        if (userInput) lastUserTurnAt = now;
        const capMs = coldFirst ? Math.min(config.preTurnCapMs, config.preTurnColdCapMs) : config.preTurnCapMs;
        // 2026-08-30 韧性补丁：前置思考设等待上限——断网/API 挂起时不让对话回合被卡住；
        // 上限先到则对话照常进行；2026-09-01 起不再放任后台自收尾（见下方 abortParallelCycle）。
        let capTimer = null;
        const cap = new Promise((resolve) => { capTimer = setTimeout(() => resolve('cap'), capMs); });
        // 2026-08-30 审计修复：.finally 保证 preTurn 成功/失败都清理 capTimer（此前失败路径遗留悬空定时器）
        const preTurn = api.beforeTurn(userInput || undefined).finally(() => clearTimeout(capTimer));
        const winner = await Promise.race([preTurn.then(() => 'preTurn'), cap]);
        // 上限先到 → 对话已推进，立即中止仍在后台收尾的 pre-turn 循环。
        // 其决策基于旧输入（"并列"记忆），若放任收尾会：更新 lastDecision 污染下一回合注入、
        // 写留档记录，且（此前漏洞）投递主动发言——实机复现于 05:55/06:48 对话回合结束后 26s 的 proactive 消息。
        // 2026-09-03-3：capAbort=true → cycle 补"超时留痕"（活动流可见被砍的思考，见 cycle 中止分支）。
        if (winner === 'cap') abortParallelCycle({ capAbort: true });
      }
    } catch (error) {
      logger.warn(`archive-loop: 对话前置思考失败：${error.message}`);
    }
    return next();
  });
  ctx.on('session/event', (session, event) => {
    try {
      // 2026-08-31：用户消息缓冲（pre-turn userInput 兜底；与 memory 落库同源事件）
      // 2026-08-31 审计修复：仅主会话的用户消息进入缓冲（其他会话的消息混入会让主会话
      // pre-turn 的 <user-input> 用错输入）
      const isMain = session?.id === MAIN_SESSION_ID || session?.sessionId === MAIN_SESSION_ID;
      if (event?.type === 'user/message' && event?.data?.source?.kind === 'user' && isMain) {
        // 2026-09-01：用户主动发消息 → 暂停时间驱动循环 quietAfterUserMs + 中止并行循环（时间驱动/过期 pre-turn）
        handleUserMessage();
        const txt = contentTextOf(event.data);
        if (txt && !txt.startsWith('Current runtime context')) {
          latestUserInput = { text: txt, at: Date.now() };
          pushDialogue('user', txt, Date.now()); // 2026-09-03-3：对话实录（user 侧）
        }
      }
      // 2026-09-03-3：AI 在对话中的最终回复 → 对话实录（ai 侧；主动循环此前完全看不到对话答复，见 <recent-dialogue>）
      if (event?.type === 'assistant/message' && isMain && event?.data?.source?.kind !== 'plugin') {
        const aiText = eventTextOf(event.data);
        if (aiText) pushDialogue('ai', aiText, Date.now());
      }
      if (event?.type === 'turn/end' && isMain) {
        api.endConversation();
        // 2026-09-03 记忆错乱修复：对话回合结束也刷新静默窗口（proactive 不得紧贴刚结束的
        // 对话发言——实机 00:00:30 在回合结束后 60s 推送串线消息）。只在用户消息设置的
        // quietUntil 之上取更晚者，避免缩短既有窗口。
        state.quietUntil = Math.max(state.quietUntil, Date.now() + config.quietAfterUserMs);
      }
    } catch { /* 恢复失败不阻断 */ }
  });

  return api;
}
