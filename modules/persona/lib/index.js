/**
 * dsh-archive-persona —— DSH-ARCHIVE 人格系统入口（Cordis 插件）。
 *
 * 提供：
 *  - `ctx.persona` 服务：get / view / set / update / remove / rollback / reset / stats / history
 *  - Agent 工具：persona_view / persona_set / persona_update
 *  - systemPrompt 动态 context（persona-identity）：每回合注入人格文本（"我"侧身份）
 *
 * 设计要点：
 *  - persona.json 唯一权威；persona-history.jsonl 追加式留档（每次变更含完整快照），
 *    阶段四自进化的"留档 + 回滚"直接复用（rollback(version, by)）。
 *  - 溯源：条目带 addedBy/addedAt/modifiedBy/modifiedAt；update 可传 by='evolution'。
 *  - 与记忆系统无双写（人格经提示词注入常驻可见，不回写记忆库，保持单一权威）。
 *
 * 配置（cordis.patch.yml 行 config）：
 *  - personaPath:   persona.json 路径（默认 <cwd>/data/persona.json）
 *  - injectOrder:   systemPrompt context 顺序（默认 500，先于用户上下文 1000）
 *  - injectEnabled: 是否注入人格文本（默认 true）
 */
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { PersonaStore, PERSONA_SECTIONS } from './persona-store.js';

export const name = 'dsh-archive-persona';

export const inject = ['tools', 'systemPrompt'];

const DEFAULTS = {
  personaPath: join(process.cwd(), 'data', 'persona.json'),
  injectOrder: 500,
  injectEnabled: true,
};

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.personaPath !== undefined) {
    if (typeof raw.personaPath !== 'string' || raw.personaPath === '') throw new Error('archive-persona 配置错误：personaPath 必须是非空字符串');
    cfg.personaPath = raw.personaPath;
  }
  if (raw.injectOrder !== undefined) {
    if (!Number.isFinite(raw.injectOrder)) throw new Error('archive-persona 配置错误：injectOrder 必须是数字');
    cfg.injectOrder = raw.injectOrder;
  }
  if (raw.injectEnabled !== undefined) {
    if (typeof raw.injectEnabled !== 'boolean') throw new Error('archive-persona 配置错误：injectEnabled 必须是布尔');
    cfg.injectEnabled = raw.injectEnabled;
  }
  return cfg;
}

function toolOutput(schema, render) {
  return { schema, render: render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]) };
}

function bootLine(line) {
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* 非 CLI 环境下忽略 */
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const store = new PersonaStore({ path: config.personaPath });
  const logger = ctx.root?.logger?.('archive-persona') ?? console;

  const api = {
    get: () => store.get(),
    view: () => ({ version: store.stats().version, rendered: store.render() }),
    set: (entries, opts) => store.set(entries, opts),
    // 2026-09-08 一键凝练：整体重建（替换全部分区），一次版本+1 并留档（可回滚）
    replace: (entries, opts) => store.replace(entries, opts),
    update: (id, patch) => store.update(id, patch),
    remove: (id, opts) => ({ removed: store.remove(id, opts) }),
    rollback: (version, by) => ({ rolledBack: store.rollback(version, by ?? 'user') }),
    stats: () => store.stats(),
    history: (limit) => store.history(limit),
    render: () => store.render(),
  };
  ctx.provide('persona', api);

  // 人格注入：每回合组装 system prompt 时实时渲染当前人格（"我"侧身份）。
  if (config.injectEnabled) {
    try {
      ctx.systemPrompt.context({
        name: 'persona-identity',
        order: config.injectOrder,
        text: () => store.render() ?? '',
      });
      logger.info('archive-persona: 已注册 systemPrompt 动态 context(persona-identity)');
    } catch (error) {
      logger.warn(`archive-persona: systemPrompt context 注册失败：${error.message}`);
    }
  }

  const tools = ctx.get('tools');
  if (tools !== undefined) {
    const registered = [];
    const reg = (tool) => {
      tools.register(tool);
      registered.push(tool.name);
    };
    reg(defineTool({
      name: 'persona_view',
      description: '查看当前人格（身份/价值观/性格/表达风格/行为准则/能力清单）与版本号。',
      parameters: {},
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          version: { type: 'number', required: true },
          rendered: { type: 'string' },
        },
      }),
      execute() {
        return { version: store.stats().version, rendered: store.render() ?? '' };
      },
    }));
    reg(defineTool({
      name: 'persona_set',
      description: `设定/增补基础人格：批量写入人格条目。sections 可选：${PERSONA_SECTIONS.join('/')}。用于建立"我是谁、价值观、性格、表达风格、行为准则、能力清单"。`,
      parameters: {
        entries: {
          type: 'array', required: true,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              section: { type: 'string', required: true, description: `人格分区：${PERSONA_SECTIONS.join('/')}` },
              content: { type: 'string', required: true, description: '条目内容（自包含陈述）' },
              importance: { type: 'number', description: '重要度 0..1，默认 0.5' },
            },
          },
          description: '要写入的条目列表（可一次多条）',
        },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          version: { type: 'number', required: true },
          added: { type: 'number', required: true },
        },
      }),
      execute(args) {
        return api.set(args.entries, { by: 'user' });
      },
    }));
    reg(defineTool({
      name: 'persona_update',
      description: '增补/修正一条已存在的人格条目（按 id）。修改会记录修改者与时间并留档；阶段四自进化系统将以 evolution 身份调用。',
      parameters: {
        id: { type: 'string', required: true, description: '条目 id（persona_view 中可见，或用 persona 服务 history 查询）' },
        content: { type: 'string', description: '新内容（省略则不修改）' },
        importance: { type: 'number', description: '重要度 0..1' },
        confidence: { type: 'number', description: '置信度 0..1' },
        by: { type: 'string', description: '修改者标识（默认 user；阶段四自进化用 evolution）' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          updated: { type: 'boolean', required: true },
          entry: { type: 'object', additionalProperties: true },
        },
      }),
      execute(args) {
        const entry = api.update(args.id, { content: args.content, importance: args.importance, confidence: args.confidence, by: args.by ?? 'user' });
        return { updated: Boolean(entry), entry: entry ?? {} };
      },
    }));
    logger.info(`archive-persona: 已注册工具 ${registered.join(', ')}`);
    bootLine(`[archive-persona] 工具已注册: ${registered.join(', ')}`);
  } else {
    logger.warn('archive-persona: 未发现 tools 服务，跳过工具注册（仅提供 ctx.persona 服务）');
    bootLine('[archive-persona] 警告: 未发现 tools 服务，跳过工具注册');
  }

  const stats = store.stats();
  logger.info(`archive-persona: ready path=${config.personaPath} version=${stats.version} entries=${stats.total}`);
  bootLine(`[archive-persona] ready path=${config.personaPath} version=${stats.version} entries=${stats.total}`);

  ctx.on('dispose', () => {
    /* persona-store 无长驻资源，无需清理 */
  });

  return api;
}
