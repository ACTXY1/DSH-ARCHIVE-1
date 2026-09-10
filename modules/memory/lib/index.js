/**
 * dsh-archive-memory —— DSH-ARCHIVE 跨会话全局记忆系统（Cordis 插件）。
 *
 * 提供：
 *  - `ctx.memory` 服务：write / recall / forget / get / update / list / stats / health
 *    + profile（用户画像：set/get/list/remove/stats）
 *    + state（用户当前状态：set/get/clear/history/sweep/stats）
 *  - Agent 工具：memory_write / memory_recall / memory_forget / memory_stats
 *    + user_profile_set / user_profile_get / user_profile_remove
 *    + user_state_set / user_state_get / user_state_clear
 *  - systemPrompt 动态 context（每回合注入"当前用户状态 + 画像要点"）
 *
 * 配置（cordis.patch.yml 行 config）：
 *  - dbPath:          SQLite 数据库路径（跨会话全局记忆落点，默认 <cwd>/data/memory.db）
 *  - ollamaBaseUrl:   ollama 服务地址（默认 http://127.0.0.1:11434）
 *  - model:           embedding 模型（默认 shaw/dmeta-embedding-zh:latest）
 *  - timeoutMs:       embedding 请求超时（默认 60000）
 *  - defaultStateTtlSeconds: 用户状态默认有效期秒（默认 14400 = 4 小时）
 */
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MemoryCore, canonicalState } from './core.js';

export const name = 'dsh-archive-memory';

/** 依赖注入：等待 tools（工具注册）与 systemPrompt（每回合状态注入）服务可用。 */
export const inject = ['tools', 'systemPrompt', 'timer'];

const DEFAULTS = {
  dbPath: join(process.cwd(), 'data', 'memory.db'),
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: 'shaw/dmeta-embedding-zh:latest',
  timeoutMs: 60000,
  defaultStateTtlSeconds: 14400,
  tauBaseDays: 30,
  reinforce: 0.05,
  softThreshold: 0.3,
  archiveGraceDays: 30,
  protectImportance: 0.8,
  defaultRecencyBias: 0.15,
};

/** 归一化配置：未知字段忽略，类型错误直接抛出（配置即契约）。 */
function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.dbPath !== undefined) {
    if (typeof raw.dbPath !== 'string' || raw.dbPath === '') throw new Error('archive-memory 配置错误：dbPath 必须是非空字符串');
    cfg.dbPath = raw.dbPath;
  }
  if (raw.ollamaBaseUrl !== undefined) {
    if (typeof raw.ollamaBaseUrl !== 'string') throw new Error('archive-memory 配置错误：ollamaBaseUrl 必须是字符串');
    cfg.ollamaBaseUrl = raw.ollamaBaseUrl;
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || raw.model === '') throw new Error('archive-memory 配置错误：model 必须是非空字符串');
    cfg.model = raw.model;
  }
  if (raw.timeoutMs !== undefined) {
    if (!Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) throw new Error('archive-memory 配置错误：timeoutMs 必须是正数');
    cfg.timeoutMs = raw.timeoutMs;
  }
  if (raw.defaultStateTtlSeconds !== undefined) {
    if (!Number.isFinite(raw.defaultStateTtlSeconds) || raw.defaultStateTtlSeconds < 0) throw new Error('archive-memory 配置错误：defaultStateTtlSeconds 必须是非负数');
    cfg.defaultStateTtlSeconds = raw.defaultStateTtlSeconds;
  }
  for (const key of ['tauBaseDays', 'archiveGraceDays', 'protectImportance', 'defaultRecencyBias']) {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] < 0) throw new Error(`archive-memory 配置错误：${key} 必须是非负数`);
      cfg[key] = raw[key];
    }
  }
  for (const key of ['reinforce', 'softThreshold']) {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] <= 0) throw new Error(`archive-memory 配置错误：${key} 必须是正数`);
      cfg[key] = raw[key];
    }
  }
  return cfg;
}

function toolOutput(schema, render) {
  return { schema, render: render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]) };
}

/**
 * 工具输出裁剪：只保留 schema 声明字段。
 * 背景（ 验收发现）：execute 返回完整数据行（id/source/createdAt/…），
 * 而 output schema 声明 additionalProperties:false 且未列出这些字段 →
 * agent 运行时校验拒绝（INVALID_TOOL_OUTPUT），工具对 agent 不可用。
 */
function pickFields(obj, keys) {
  //  过滤 null 与 undefined——可选字段（detail/evidence 等）未传时
  // 存储层返回 null，而 schema 声明 string → INVALID_TOOL_OUTPUT（实测 user_state_set 未传 detail 即失败）。
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}
const TOOL_PROFILE_FIELDS = ['key', 'content', 'confidence', 'evidenceCount', 'updatedAt'];
const TOOL_STATE_FIELDS = ['state', 'detail', 'confidence', 'evidence', 'setAt', 'expiresAt'];
const TOOL_RECALL_FIELDS = ['id', 'content', 'kind', 'importance', 'score', 'createdAt', 'relativeTime', 'stale', 'protected', 'tags'];

/** 启动就绪行：写 stdout，便于 CLI 长驻进程的可观测与自动化验证（logger 默认级别可能不打印 info）。 */
/** 记忆整合作业提示词（把一段时间的同类自循环决策凝练为一条语义记忆）。 */
const INTEGRATE_PROMPT = `你是记忆整理助手。下面是一段时间内的多条 AI 自循环决策记录（<loop-decision>…</loop-decision>）。
请把它们凝练成 1 条概括性语义记忆（中文，自包含陈述式，150 字以内），涵盖：这段时间 AI 的整体状态/反复出现的模式/值得记住的结论。
只输出概括正文，不要多余文字、不要编号。如果内容高度重复（如大量"安静待命"），概括时明确指出重复模式即可。`;

function bootLine(line) {
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* 非 CLI 环境下忽略 */
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const core = new MemoryCore(config);
  const logger = ctx.root?.logger?.('archive-memory') ?? console;

  const api = {
    write: (input) => core.write(input),
    recall: (query) => core.recall(query),
    forget: (id) => core.forget(id),
    get: (id) => core.get(id),
    update: (id, patch) => core.update(id, patch),
    list: (opts) => core.list(opts),
    stats: () => core.stats(),
    health: () => core.health(),
    describe: () => ({ dbPath: core.dbPath, model: core.embedder.model, baseUrl: core.embedder.baseUrl }),
    //  人格一致性校验器（dsh-archive-consistency）复用同源 ollama embedding：
    // 供一致性模块提取"人格状态"向量（同一模型/端点，零重复配置）。
    embed: (input) => core.embedder.embed(input),
    // 仿生遗忘
    forgetRun: () => core.forgetRun(),
    restore: (id) => core.restore(id),
    forgottenList: (limit) => core.forgottenList(limit),
    forgetStats: () => core.forgetStats(),
    // WAL checkpoint（定时 + 备份前调用，断电/强杀恢复更稳）
    checkpoint: () => core.checkpoint(),
    // 关闭数据库连接（整体恢复前释放文件锁）
    close: () => { try { core.close(); } catch { /* 已关闭 */ } },
    // 记忆整合 / 备份导入
    integrate: (opts) => api.integrate(opts),
    importBackup: (path) => core.importFrom(path),
    // 用户画像（长期稳定事实）
    profile: {
      set: (input) => core.profileSet(input),
      get: (key) => core.profileGet(key),
      list: (opts) => core.profileList(opts),
      remove: (key) => core.profileRemove(key),
      stats: () => core.profileStats(),
    },
    // 用户当前状态（短期实时，TTL 过期）
    state: {
      set: (input) => core.stateSet(input),
      get: () => core.stateGet(),
      clear: (state) => core.stateClear(state),
      history: (limit) => core.stateHistory(limit),
      sweep: () => core.stateSweep(),
      stats: () => core.stateStats(),
      snapshot: () => core.snapshotData(),
    },
  };
  ctx.provide('memory', api);

  // 对话记忆自动落库（ 用户反馈"记忆系统不更新、找不到对话的记忆"）：
  // 把每条真实用户输入写入记忆（source='conversation'，kind='episodic'，tag conversation），跨会话可召回。
  // 过滤：仅 source.kind==='user' —— dsh 每回合注入的 runtime-context 快照是 kind='plugin'（含 sandbox/approval/<time>/<persona>/记忆注入），
  // 不落库；零 LLM 成本，不打断对话。记忆按重要度 0.45 不设保护，交由仿生遗忘自然老化。
  function contentTextOf(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const texts = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '').trim()).filter(Boolean);
    if (texts.length > 0) return texts.join('\n');
    //  与 loop 模块 contentTextOf 对齐——纯字符串形态的 content 也要解析
    if (blocks.length === 0 && typeof data?.content === 'string') return String(data.content).trim();
    if (blocks.some((b) => b.type === 'image')) return '[图片]';
    return '';
  }

  /**
   * 用户状态维护（ 改版）：
   * 此前为系统关键词确定性感知（STATE_RULES 正则匹配用户消息，实测不稳定：同义词/反语/复合语境误判）。
   * 现改为 AI 隐式推断：由 systemPrompt 注入的 user-state-maintenance 指令要求 AI 每回合
   * 读取注入的当前状态 → 结合本条用户消息隐式推断 → 仅在状态变化时调用 user_state_set/clear 修正
   * （user_state_set 工具本身已带证据/TTL 参数，AI 可完整维护）。此处仅保留对话记忆落库，零 LLM 成本。
   */
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'user/message') return;
      const data = event.data;
      if (!data || data.source?.kind !== 'user') return;
      const text = contentTextOf(data);
      if (!text || text.startsWith('Current runtime context')) return;
      if (text.length < 3) return;
      const excerpt = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      core.write({ content: `用户：${excerpt}`, kind: 'episodic', source: 'conversation', importance: 0.45, tags: ['conversation'] })
        .catch(() => { /* 对话记忆失败不影响对话 */ });
    } catch { /* 忽略 */ }
  });


  // 每回合注入"当前用户状态 + 画像要点"（systemPrompt 动态 context，函数式 text 每次组装求值）。
  //  改版：注入后附 user-state-maintenance 指令——要求 AI 读取已注入状态后，
  // 在输出对话前隐式推断用户状态，变化时用 user_state_set/clear 修正（替代原关键词自动感知）。
  try {
    ctx.systemPrompt.context({
      name: 'user-current-context',
      order: 1000,
      text: () => {
        const base = core.snapshot() ?? '';
        return `${base}\n\n<user-state-maintenance>\n每次收到用户消息、输出对话回复之前，执行一次用户状态维护：\n1. 先读取上方 <user-context> 中已注入的当前用户状态与画像；\n2. 结合本条用户消息的语言、语气与行为线索，隐式推断用户当前状态（如 睡眠中/困了/忙碌/离开/在线/开心/伤心/焦虑/专注/饥饿/疲劳…）；\n3. 状态名请用规范中文（sleeping/active 等英文会自动归一，勿混用）；同一时刻只保留一个当前状态，写入新状态会自动清除旧状态；\n4. 护栏：用户正在发消息即在线——过去/将来时陈述（如"刚刚睡了会""我去睡觉了""准备睡"）不等于当前睡眠中，不得据此置 睡眠中；仅当用户明确表示现在就去睡、对话结束且随后静默才置 睡眠中（睡眠 TTL 建议 8-16h，其余 1-4h）；不得仅凭"用户静默 N 分钟/小时"推断 在线/已醒；evidence 只引用本条用户消息原话与真实时间，禁止编造或错位用户说话时间；\n5. 若推断状态与已注入状态不同：在输出回复前调用 user_state_set 更新（附证据与合理 TTL）；\n6. 若用户表明已脱离某状态（如"睡醒了/忙完了/回来了/不困了"）：调用 user_state_clear 清除对应状态；\n7. 状态无变化或证据不足时不要调用，避免无意义写入；\n8. 状态维护对用户完全隐藏：调用后不要在回复中提及"我更新了状态/已把状态设置为…"等任何描述，工具调用过程也不向用户展示，用户不应察觉状态被更新（回复正文可基于状态自然流露关心，但不得说明状态被修改）；\n9. 例外：仅当用户明确要求展示或演示状态更新（如"演示一下你如何更新我的状态"）时，才正常展示工具调用并说明状态推断结果。\n</user-state-maintenance>`;
      },
    });
    logger.info('archive-memory: 已注册 systemPrompt 动态 context(user-current-context)');
  } catch (error) {
    logger.warn(`archive-memory: systemPrompt context 注册失败：${error.message}`);
  }

  // tools 由 inject 保证可用；仍做防御性检查（组合被裁剪时服务独立可用）。
  const tools = ctx.get('tools');
  if (tools !== undefined) {
    const registered = [];
    const reg = (tool) => {
      tools.register(tool);
      registered.push(tool.name);
    };
    reg(defineTool({
      name: 'memory_write',
      description: '把一条事实写入跨会话全局记忆库（语义向量化，后续可用 memory_recall 召回）。适合用户偏好、项目决策、长期事实、经验教训。',
      parameters: {
        content: { type: 'string', required: true, description: '记忆正文（应自包含、陈述式）' },
        kind: { type: 'string', description: '记忆类型：thought（AI思考/想法）|episodic|semantic|procedural|preference|general' },
        importance: { type: 'number', description: '重要度 0..1，默认 0.5（≥0.8 自动保护）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组（lesson/rule/project/directive 等自动保护）' },
        protected: { type: 'boolean', description: '显式保护（不可遗忘），默认自动判定' },
        source: { type: 'string', description: '来源标识（默认 manual）' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', required: true }, createdAt: { type: 'number', required: true } },
      }),
      async execute(args) {
        const { id, createdAt } = await core.write({
          content: args.content, kind: args.kind, importance: args.importance,
          tags: args.tags, source: args.source ?? 'tool:memory_write',
          protected: args.protected,
        });
        return { id, createdAt };
      },
    }));
    reg(defineTool({
      name: 'memory_recall',
      description: '从跨会话全局记忆库按语义召回与查询最相关的记忆（结果含相对时间，结合当前时间判断时效；软遗忘记忆默认不召回）。回答涉及用户偏好/历史决策/项目进展/过往事实前先查询。',
      parameters: {
        query: { type: 'string', required: true, description: '语义查询语句' },
        k: { type: 'number', description: '返回条数 1..100，默认 10' },
        kinds: { type: 'array', items: { type: 'string' }, description: '限定类型，如 ["preference","semantic"]' },
        minScore: { type: 'number', description: '最低相似度阈值 0..1，默认 0' },
        recencyBias: { type: 'number', description: '时效偏置 0..1（默认 0.15：新近记忆自然靠前）' },
        mode: { type: 'string', description: '检索模式：hybrid（默认）| semantic | keyword' },
        includeForgotten: { type: 'boolean', description: '是否包含软遗忘/归档记忆（默认 false）' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          results: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                kind: { type: 'string' },
                importance: { type: 'number' },
                score: { type: 'number', required: true },
                createdAt: { type: 'number' },
                relativeTime: { type: 'string' },
                stale: { type: 'boolean' },
                protected: { type: 'boolean' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      }),
      async execute(args) {
        const r = await core.recall({
          query: args.query, k: args.k, kinds: args.kinds,
          minScore: args.minScore, recencyBias: args.recencyBias, mode: args.mode,
          includeForgotten: args.includeForgotten,
        });
        // 输出裁剪：结果行只保留 schema 声明字段（防止 agent 运行时校验拒绝）
        return { query: r.query ?? args.query, results: (r.results ?? []).map((m) => pickFields(m, TOOL_RECALL_FIELDS)) };
      },
    }));
    reg(defineTool({
      name: 'memory_forget',
      description: '按 id 删除一条记忆。',
      parameters: { id: { type: 'string', required: true, description: '记忆 id' } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { removed: { type: 'boolean', required: true } },
      }),
      execute(args) {
        return core.forget(args.id);
      },
    }));
    reg(defineTool({
      name: 'memory_stats',
      description: '查看全局记忆库统计（总数、各类型数量）。',
      parameters: {},
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          byKind: { type: 'object', required: true, additionalProperties: true },
        },
      }),
      execute() {
        const s = core.stats();
        return { total: s.total, byKind: s.byKind ?? {} }; // 裁剪：去掉顶层 fts（schema 未声明）
      },
    }));
    reg(defineTool({
      name: 'memory_update',
      description: '编辑一条记忆（重要度/是否保护不可遗忘/类型/标签/内容/置信度）。重要条目（经验教训/工作要求/项目信息）请设 protected=true 防遗忘。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id' },
        content: { type: 'string', description: '新内容' },
        importance: { type: 'number', description: '重要度 0..1' },
        protected: { type: 'boolean', description: 'true=保护（不可遗忘）/ false=解除显式保护' },
        kind: { type: 'string', description: '记忆类型' },
        confidence: { type: 'number', description: '置信度 0..1' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { updated: { type: 'boolean', required: true } },
      }),
      execute(args) {
        return core.update(args.id, {
          content: args.content, importance: args.importance, protected: args.protected,
          kind: args.kind, confidence: args.confidence,
        });
      },
    }));
    reg(defineTool({
      name: 'forget_run',
      description: '执行仿生遗忘作业：重算记忆强度（Ebbinghaus 衰减+召回强化）、软遗忘/归档分级、生成待复核队列。受保护记忆不参与。',
      parameters: {},
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          softened: { type: 'number', required: true },
          archived: { type: 'number', required: true },
          reviewQueue: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      }),
      execute() {
        return core.forgetRun();
      },
    }));
    reg(defineTool({
      name: 'forget_restore',
      description: '显式恢复一条被遗忘（软遗忘/归档）的记忆。',
      parameters: { id: { type: 'string', required: true, description: '记忆 id' } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { restored: { type: 'boolean', required: true } },
      }),
      execute(args) {
        return core.restore(args.id);
      },
    }));
    reg(defineTool({
      name: 'user_profile_set',
      description: '写入/确认一条用户画像事实（长期稳定：身份、习惯、偏好、背景、沟通风格）。同 key 同内容再次设置视为再次确认（证据计数+1）；内容变化则覆盖。',
      parameters: {
        key: { type: 'string', required: true, description: '规范键，如 name / shell_preference / work_hours' },
        content: { type: 'string', required: true, description: '事实陈述（自包含、陈述式）' },
        confidence: { type: 'number', description: '置信度 0..1，默认 0.5' },
        source: { type: 'string', description: '来源（默认 user）' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          content: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
          evidenceCount: { type: 'number', required: true },
        },
      }),
      execute(args) {
        return pickFields(core.profileSet({ key: args.key, content: args.content, confidence: args.confidence, source: args.source }), ['key', 'content', 'confidence', 'evidenceCount']);
      },
    }));
    reg(defineTool({
      name: 'user_profile_get',
      description: '按 key 读取一条用户画像事实；不带 key 时列出全部画像。',
      parameters: {
        key: { type: 'string', description: '画像键；省略则列出全部' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          entries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                content: { type: 'string', required: true },
                confidence: { type: 'number' },
                evidenceCount: { type: 'number' },
                updatedAt: { type: 'number' },
              },
            },
          },
        },
      }),
      execute(args) {
        if (args.key) {
          const e = core.profileGet(args.key);
          return { entries: e ? [pickFields(e, TOOL_PROFILE_FIELDS)] : [] };
        }
        return { entries: core.profileList({ limit: 100 }).map((e) => pickFields(e, TOOL_PROFILE_FIELDS)) };
      },
    }));
    reg(defineTool({
      name: 'user_profile_remove',
      description: '按 key 删除一条用户画像事实。',
      parameters: { key: { type: 'string', required: true, description: '画像键' } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { removed: { type: 'boolean', required: true } },
      }),
      execute(args) {
        return core.profileRemove(args.key);
      },
    }));
    reg(defineTool({
      name: 'user_state_set',
      description: '设置用户当前状态（短期实时变量，单槽互斥：新状态写入会自动清除旧状态）。每回合收到用户消息后、输出回复前：先读取 systemPrompt 注入的当前用户状态，再结合本条消息的语言/语气/行为线索隐式推断用户状态；仅当推断结果与已存状态不同时调用。状态名用规范中文（睡眠中/困了/忙碌/离开/在线/开心/伤心/焦虑/专注/饥饿/疲劳…），sleeping/active 等英文会自动归一。护栏：用户正在发消息即在线——过去/将来时陈述（"刚刚睡了会""我去睡觉了"）不等于当前睡眠中，不得据此置 睡眠中；不得仅凭静默推断 在线/已醒。附证据（只引用用户本条消息原话与真实时间，禁止编造）与合理 TTL（睡眠 8-16h、其余 1-4h）。例：用户说"我睡觉去了"且对话结束 → user_state_set(state="睡眠中")。',
      parameters: {
        state: { type: 'string', required: true, description: '规范状态名，如 睡眠中 / 困了 / 在线 / 忙碌（英文自动归一）' },
        detail: { type: 'string', description: '补充描述' },
        confidence: { type: 'number', description: '置信度 0..1，默认 0.5' },
        evidence: { type: 'string', description: '触发证据：用户本条消息原话（含真实时间线索），禁止编造' },
        ttlSeconds: { type: 'number', description: '有效期秒；0=直到手动清除；默认 14400（4 小时）' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          detail: { type: 'string' },
          confidence: { type: 'number', required: true },
          setAt: { type: 'number', required: true },
          expiresAt: { type: 'number' },
        },
      }),
      execute(args) {
        //  仅状态名集合实质变化才 emit（同值状态刷新 TTL 不触发，
        // 避免每次无效调用都驱动一次完整循环浪费 token）；payload 用落库 trim 后的 state。
        //：比较与发射均用归一化后的规范名（'sleeping' 与 '睡眠中' 视为同一状态）。
        const want = canonicalState(args.state);
        const existed = core.stateGet().some((s) => canonicalState(s.state) === want);
        const r = pickFields(core.stateSet({
          state: args.state, detail: args.detail, confidence: args.confidence,
          evidence: args.evidence, ttlSeconds: args.ttlSeconds,
        }), ['state', 'detail', 'confidence', 'setAt', 'expiresAt']);
        //  状态变化事件发射（此前 loop 监听 archive/state-changed 却无发射方——死链）。
        // 仅工具入口发射（agent/用户外部动作）；loop 内部动作走服务层不发射，避免"设状态→触发循环"自激。
        if (!existed) { try { ctx.emit('archive/state-changed', { action: 'set', state: String(r?.state ?? want) }); } catch { /* 通知失败不阻断 */ } }
        return r;
      },
    }));
    reg(defineTool({
      name: 'user_state_get',
      description: '读取用户当前有效状态（未过期）——即"提供给 AI 的变量"：行动前先查，例如用户睡眠中则不应等待实时回复。',
      parameters: {},
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          states: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                state: { type: 'string', required: true },
                detail: { type: 'string' },
                confidence: { type: 'number' },
                evidence: { type: 'string' },
                setAt: { type: 'number' },
                expiresAt: { type: 'number' },
              },
            },
          },
          rendered: { type: 'string' },
        },
      }),
      execute() {
        const snap = core.snapshotData();
        //  snap.rendered 无状态/画像时可能为 null，与 schema 的 string 类型冲突 → 兜底空串
        //：返回状态名统一归一化（sleeping→睡眠中，active→在线）
        return { states: (snap.states ?? []).map((s) => pickFields({ ...s, state: canonicalState(s.state) }, TOOL_STATE_FIELDS)), rendered: snap.rendered ?? '' };
      },
    }));
    reg(defineTool({
      name: 'user_state_clear',
      description: '清除一个用户状态（如用户已回来/已清醒/已睡醒）。按规范名清除（clear("sleeping") 等同清除"睡眠中"）。',
      parameters: { state: { type: 'string', required: true, description: '状态名（英文自动归一）' } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { removed: { type: 'boolean', required: true } },
      }),
      execute(args) {
        const r = core.stateClear(args.state);
        //  状态变化事件发射（同 user_state_set，仅工具入口）。
        //：仅实际清除（removed=true）才发射（清一个不存在的状态不触发循环）
        if (r?.removed === true) { try { ctx.emit('archive/state-changed', { action: 'clear', state: canonicalState(args.state) }); } catch { /* 通知失败不阻断 */ } }
        return r;
      },
    }));
    logger.info(`archive-memory: 已注册工具 ${registered.join(', ')}`);
    bootLine(`[archive-memory] 工具已注册: ${registered.join(', ')}`);
  } else {
    logger.warn('archive-memory: 未发现 tools 服务，跳过工具注册（仅提供 ctx.memory 服务）');
    bootLine('[archive-memory] 警告: 未发现 tools 服务，跳过工具注册');
  }

  const stats = core.stats();
  const profileStats = core.profileStats();
  const stateStats = core.stateStats();
  logger.info(`archive-memory: ready db=${core.dbPath} model=${core.embedder.model} total=${stats.total}`);
  bootLine(`[archive-memory] ready db=${core.dbPath} model=${core.embedder.model} total=${stats.total} profile=${profileStats.total} state=${stateStats.active}`);

  // 记忆整合：把一段时间内的自循环 thought 凝练为一条语义记忆，原条目标记软遗忘。
  // 自动每日最多一次（thought≥12 才执行，省 token）；也可由记忆页按钮手动触发。
  // 保护兼容：listBySourceSince 仅取未保护记忆——受保护记忆不参与聚合、不被凝练、不被软遗忘。
  //  修复：in-flight 守卫——手动按钮与每日自动定时器可能并发，防重复整合/重复软遗忘。
  let integrateInFlight = false;
  api.integrate = async ({ windowMs = 24 * 3600000 } = {}) => {
    if (integrateInFlight) return { skipped: true, reason: '整合进行中，请稍候' };
    integrateInFlight = true;
    try {
      const since = Date.now() - windowMs;
      const items = core.listBySourceSince({ kind: 'thought', source: 'loop', sinceMs: since, limit: 100 });
      if (items.length < 12) return { skipped: true, reason: `thought 条目 ${items.length} < 12，无需整合` };
      const llm = ctx.get('llm');
      if (!llm || typeof llm.stream !== 'function') return { skipped: true, reason: 'LLM 服务不可用' };
      let text = '';
      const stream = llm.stream({
        provider: 'deepseek-official', model: 'deepseek-v4-flash',
        system: INTEGRATE_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: items.map((m) => m.content).join('\n---\n').slice(0, 20000) }] }],
        maxTokens: 500,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
        //  aborted 同样判失败（与 loop/subconscious/consistency 一致）——
        // 否则中止后半截内容会被当成最终摘要写入并软遗忘全部原条目（不可逆损伤）
        if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw new Error(`${chunk.reason.failure?.code ?? chunk.reason.kind}: ${chunk.reason.failure?.message ?? '调用失败'}`);
        }
      }
      const summary = String(text ?? '').trim();
      if (!summary) throw new Error('整合摘要为空');
      const produced = await core.write({ content: summary, kind: 'semantic', source: 'consolidate', importance: 0.6, tags: ['consolidated'] });
      const softened = core.softForgetMany(items.map((m) => m.id));
      logger.info(`archive-memory: 记忆整合 ${items.length} 条 thought → 1 条语义记忆（软遗忘 ${softened.softened} 条）`);
      return { skipped: false, input: items.length, producedId: produced.id, softened: softened.softened, summary };
    } finally {
      integrateInFlight = false;
    }
  };

  // 自动整合（每日最多一次；6h 检查一次）
  //：首检提前（lastIntegrateAt 置 24h 前 + 启动立即检查一次）——窗口内 loop thought ≥12 才真正执行，
  // 不足则 skipped（无 token 浪费），便于验证合并功能；此后保持每日最多一次。
  let lastIntegrateAt = Date.now() - 24 * 3600000;
  const checkIntegrate = async () => {
    if (Date.now() - lastIntegrateAt < 24 * 3600000) return;
    lastIntegrateAt = Date.now();
    try {
      const r = await api.integrate();
      if (r.skipped) logger.info(`archive-memory: 自动整合跳过：${r.reason}`);
      else logger.info(`archive-memory: 自动整合完成 ${r.input} 条 thought → 1 条语义记忆（软遗忘 ${r.softened} 条）`);
    } catch (error) { logger.warn(`archive-memory: 自动整合失败：${error.message}`); }
  };
  ctx.timer.setInterval(checkIntegrate, 6 * 3600000);
  void checkIntegrate();

  // 自动仿生遗忘（ 用户需求 B：每日最多一次，与整合节奏一致；受保护记忆豁免，
  // Ebbinghaus 衰减重算强度 + 软遗忘/归档分级 + 待复核队列；启动 24h 内不自动执行，保守起见）
  let lastForgetRunAt = Date.now();
  ctx.timer.setInterval(() => {
    if (Date.now() - lastForgetRunAt < 24 * 3600000) return;
    lastForgetRunAt = Date.now();
    try {
      const r = core.forgetRun();
      logger.info(`archive-memory: 自动遗忘完成 softened=${r.softened} archived=${r.archived} review=${r.reviewQueue?.length ?? 0}`);
      bootLine(`[archive-memory] 自动遗忘 softened=${r.softened} archived=${r.archived} review=${r.reviewQueue?.length ?? 0}`);
    } catch (error) {
      logger.warn(`archive-memory: 自动遗忘失败：${error.message}`);
    }
  }, 6 * 3600000);

  ctx.on('dispose', () => {
    try { core.close(); } catch { /* 已关闭 */ }
  });

  //  过期用户状态定期清扫（此前 sweep 仅服务层暴露、无任何调用方——
  // 不同状态名无限累积，行数只增不减）
  ctx.timer.setInterval(() => {
    try { const n = core.stateSweep(); if (n > 0) logger.info(`archive-memory: 清扫过期用户状态 ${n} 条`); } catch { /* 清扫失败不阻断 */ }
  }, 6 * 3600000);

  // 启动完整性自检 + 定时 WAL checkpoint（每 10 分钟；close 时也会合并）
  try {
    const integrity = core.checkIntegrity();
    bootLine(`[archive-memory] quick_check=${integrity.ok ? 'ok' : integrity.detail}`);
    if (!integrity.ok) logger.warn(`archive-memory: 数据库完整性异常：${integrity.detail}（建议停止后运行 stop.ps1 并备份 memory.db）`);
  } catch { /* 自检失败不阻断 */ }
  ctx.timer.setInterval(() => { try { core.checkpoint(); } catch { /* checkpoint 失败不阻断 */ } }, 10 * 60000);

  return api;
}
