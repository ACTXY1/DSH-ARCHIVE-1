/**
 * dsh-archive-notify —— DSH-ARCHIVE 主动消息通道（Cordis 插件）。
 *
 * 可插拔通道：
 *  - 默认：长驻进程控制台输出（[archive-notify] 时间 [来源] 内容）+ 通知流水
 *    data/notifications.jsonl（追加式，含已读标记）。
 *  - 总会话对话流（control 注入）：仅 scope='chat' 的记录（AI 面向用户的自然消息/用户要求的提醒）
 *    注入主会话；scope='panel'（系统状态/操作流水，默认）只进通知流水与总控「通知」页，绝不进对话。
 *
 * 服务 ctx.notify：send / view / markRead / stats。
 * 工具：notify_view / notify_markRead。
 * 防打扰：工程级限频（minIntervalMs，默认 30s；loop 已另有决策级限频）。
 */
import { join, dirname } from 'node:path';
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-archive-notify';

export const inject = ['tools', 'timer'];

const DEFAULTS = {
  notificationsPath: join(process.cwd(), 'data', 'notifications.jsonl'),
  consoleEnabled: true,
  minIntervalMs: 30000,
  cleanupRetentionDays: 7, // 已读通知保留天数（防数据无限增长；未读永不清理）
};

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.notificationsPath !== undefined && typeof raw.notificationsPath === 'string') cfg.notificationsPath = raw.notificationsPath;
  if (raw.consoleEnabled !== undefined && typeof raw.consoleEnabled === 'boolean') cfg.consoleEnabled = raw.consoleEnabled;
  if (raw.minIntervalMs !== undefined && Number.isFinite(raw.minIntervalMs) && raw.minIntervalMs >= 0) cfg.minIntervalMs = raw.minIntervalMs;
  if (raw.cleanupRetentionDays !== undefined && Number.isFinite(raw.cleanupRetentionDays) && raw.cleanupRetentionDays >= 0) cfg.cleanupRetentionDays = raw.cleanupRetentionDays;
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
  const logger = ctx.root?.logger?.('archive-notify') ?? console;
  mkdirSync(dirname(config.notificationsPath), { recursive: true });
  // 限频按来源组分别计数：loop 主动发言与 schedule 定时提醒互不挤兑；
  // 防刷屏只针对同一来源组（loop 连续发言、schedule 连续提醒）。组规则：loop*→loop，schedule*→schedule，其余→other。
  const lastSendAtByGroup = new Map();
  const groupOf = (source) => {
    const s = String(source ?? 'system');
    if (s.startsWith('loop')) return 'loop';
    if (s.startsWith('schedule')) return 'schedule';
    return 'other';
  };

  /** 读取通知流水（新→旧）。 */
  function readAll() {
    if (!existsSync(config.notificationsPath)) return [];
    return readFileSync(config.notificationsPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  }

  /** 整文件重写（原子写 tmp+rename；强杀/断电不会截断通知文件）。 */
  function rewrite(lines) {
    const tmp = `${config.notificationsPath}.tmp-${process.pid}`;
    writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    renameSync(tmp, config.notificationsPath);
  }

  const api = {
    /**
     * 发送一条主动消息到全部已注册通道。
     * @param {object} input {content, source?, scope?}
     * @param {string} [input.scope] 'chat'（AI 对用户说的话/用户要求的提醒 → 可注入总会话对话流）
     *   | 'panel'（系统状态/操作流水 → 仅通知流水与总控「通知」页，绝不注入对话流）。默认 'panel'。
     *   分级：chat 级仅限 AI 面向用户的自然消息——机器状态文案（主动行动/自进化/提醒错过等）不应以
     *   "AI 普通回复"样式进入对话流（出戏）。
     * @returns {{sent:boolean, at:number, limited:boolean}}
     */
    send(input) {
      const content = String(input?.content ?? '').trim();
      if (!content) throw new Error('notify.send: content 必填');
      const source = String(input.source ?? 'system').slice(0, 60);
      const scope = input.scope === 'chat' ? 'chat' : 'panel';
      const now = Date.now();
      // 按来源组限频（loop 发言与 schedule 提醒互不挤兑）
      const group = groupOf(source);
      const lastAt = lastSendAtByGroup.get(group) ?? 0;
      if (now - lastAt < config.minIntervalMs) return { sent: false, at: now, limited: true, group };
      lastSendAtByGroup.set(group, now);
      const record = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, at: now, source, content, scope, read: false };
      appendFileSync(config.notificationsPath, JSON.stringify(record) + '\n', 'utf8');
      if (config.consoleEnabled) {
        const time = new Date(now).toLocaleString('zh-CN', { hour12: false });
        bootLine(`[archive-notify] ${time} [${source}] ${content}`);
      }
      try { ctx.emit('archive/notify-sent', { record }); } catch { /* 事件失败不阻断 */ }
      return { sent: true, at: now, limited: false };
    },

    /** 查看通知（未读优先）。 */
    view(limit = 30) {
      return { notifications: readAll().slice(0, Math.min(100, limit)) };
    },

    /** 标记已读（id 或全部）。 */
    markRead(id) {
      const lines = existsSync(config.notificationsPath) ? readFileSync(config.notificationsPath, 'utf8').split('\n').filter(Boolean) : [];
      let changed = 0;
      const out = [];
      for (const line of lines) {
        let rec = null;
        try { rec = JSON.parse(line); } catch { continue; }
        if ((id === undefined && !rec.read) || (id !== undefined && rec.id === id && !rec.read)) {
          rec.read = true;
          changed++;
        }
        out.push(rec);
      }
      if (changed > 0) rewrite(out.map((r) => JSON.stringify(r)));
      return { marked: changed };
    },

    stats() {
      const all = readAll();
      return { total: all.length, unread: all.filter((n) => !n.read).length, path: config.notificationsPath, minIntervalMs: config.minIntervalMs };
    },

    /** 清空全部已读通知（未读保留）。 */
    clearRead() {
      if (!existsSync(config.notificationsPath)) return { removed: 0 };
      const lines = readFileSync(config.notificationsPath, 'utf8').split('\n').filter(Boolean);
      const keep = [];
      let removed = 0;
      for (const line of lines) {
        let rec = null;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.read === true) removed++;
        else keep.push(line);
      }
      if (removed > 0) rewrite(keep);
      return { removed };
    },

    /** 清理超期已读通知：read=true 且超过保留期删除；未读永不清理（用户可能要看）。 */
    cleanup() {
      const cutoff = Date.now() - config.cleanupRetentionDays * 86400000;
      if (!existsSync(config.notificationsPath)) return { removed: 0 };
      const lines = readFileSync(config.notificationsPath, 'utf8').split('\n').filter(Boolean);
      const keep = [];
      let removed = 0;
      for (const line of lines) {
        let rec = null;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.read === true && Number.isFinite(rec.at) && rec.at < cutoff) removed++;
        else keep.push(line);
      }
      if (removed > 0) rewrite(keep);
      if (removed > 0) logger.info(`archive-notify: 清理已读通知 ${removed} 条（保留 ${config.cleanupRetentionDays} 天）`);
      return { removed };
    },
  };
  ctx.provide('notify', api);

  const tools = ctx.get('tools');
  if (tools !== undefined) {
    const registered = [];
    const reg = (tool) => { tools.register(tool); registered.push(tool.name); };
    reg(defineTool({
      name: 'notify_view',
      description: '查看主动消息通知（自循环发言、定时任务提醒等；未读优先）。',
      parameters: { limit: { type: 'number', description: '返回条数（默认 30）' } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          notifications: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      }),
      execute(args) {
        return api.view(args.limit);
      },
    }));
    reg(defineTool({
      name: 'notify_markRead',
      description: '标记通知已读（按 id 或全部）。',
      parameters: { id: { type: 'string', description: '通知 id；省略则全部标记' } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { marked: { type: 'number', required: true } },
      }),
      execute(args) {
        return api.markRead(args.id);
      },
    }));
    logger.info(`archive-notify: 已注册工具 ${registered.join(', ')}`);
    bootLine(`[archive-notify] 工具已注册: ${registered.join(', ')}`);
  }

  // 历史已读通知清理（启动一次 + 每 6 小时；未读永不清理，不涉及记忆库）
  try { api.cleanup(); } catch { /* 清理失败不阻断启动 */ }
  ctx.timer.setInterval(() => { try { api.cleanup(); } catch { /* 清理失败不阻断 */ } }, 6 * 3600000);

  bootLine(`[archive-notify] ready ${config.notificationsPath} 限频=${Math.round(config.minIntervalMs / 1000)}s 保留=${config.cleanupRetentionDays}d`);
  return api;
}
