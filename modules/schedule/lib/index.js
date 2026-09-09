/**
 * dsh-archive-schedule —— DSH-ARCHIVE 定时任务（Cordis 插件，阶段五）。
 *
 * 需求："和 AI 说自己几点钟要干什么，AI 记住并到时间发消息或按要求干活。"
 *
 * - 存储：data/tasks.db（SQLite，node:sqlite，WAL）tasks 表——跨重启持久。
 * - 触发：ctx.virtualClock 为唯一时间源；timer 每 30s 检查到期任务。
 * - 类型：one-time（绝对时间）/ daily（每天 HH:mm）/ interval（每 N 分钟）。
 * - 执行：
 *   - type=message → ctx.notify.send(scope='chat')（用户要求的提醒：主动消息通道 + 总会话对话流送达；
 *     2026-09-03 起"停机错过"等系统状态提示走 panel 级，只进通知流水不进对话）。
 *   - type=work    → 生成待办记忆（source='task-due'）+ 触发自循环（ctx.loop.trigger）。
 * - 过期处理：进程未运行时到期的任务标记 missed（重启后提示）。
 * - 工具：schedule_create / schedule_list / schedule_cancel。
 */
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-archive-schedule';

export const inject = ['tools', 'timer', 'virtualClock', 'notify', 'memory', 'loop'];

const DEFAULTS = {
  dbPath: join(process.cwd(), 'data', 'tasks.db'),
  checkMs: 30000,
  missedGraceMs: 600000, // 停机错过宽限：停机期间到期超过该时长 → 标记 missed 不执行；宽限内补执行
  cleanupRetentionDays: 7, // 已完成/取消/错过任务的保留天数（2026-08-30：防数据无限增长；pending 永不清理）
};

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.dbPath !== undefined && typeof raw.dbPath === 'string') cfg.dbPath = raw.dbPath;
  if (raw.checkMs !== undefined && Number.isFinite(raw.checkMs) && raw.checkMs >= 1000) cfg.checkMs = raw.checkMs;
  if (raw.missedGraceMs !== undefined && Number.isFinite(raw.missedGraceMs) && raw.missedGraceMs >= 0) cfg.missedGraceMs = raw.missedGraceMs;
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
  const logger = ctx.root?.logger?.('archive-schedule') ?? console;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA wal_autocheckpoint = 500'); // 2026-08-30：WAL 更频繁 checkpoint，防增长/强杀落后
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      task_text TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'message',
      schedule TEXT NOT NULL DEFAULT 'one-time',
      due_at INTEGER,
      interval_minutes INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      fired_at INTEGER,
      missed_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);

  /** 计算下次到期时间（按 schedule 类型）。 */
  function computeDueAt({ schedule, dueAt, intervalMinutes }) {
    const now = Date.now();
    if (schedule === 'interval' && intervalMinutes != null) return now + intervalMinutes * 60000;
    if (schedule === 'daily' && dueAt != null) {
      const d = new Date(dueAt);
      const next = new Date(now);
      next.setHours(d.getHours(), d.getMinutes(), 0, 0);
      if (next.getTime() <= now) next.setDate(next.getDate() + 1); // 今天已过 → 明天
      return next.getTime();
    }
    return dueAt ?? now; // one-time
  }

  const api = {
    /**
     * 创建定时任务。
     * @param {object} input
     * @param {string} input.task 任务内容（"下午3点提醒我喝水"→AI 解析为具体参数）
     * @param {string} [input.type] message|work（默认 message）
     * @param {string} [input.schedule] one-time|daily|interval（默认 one-time）
     * @param {number} [input.at] 绝对到期时间（epoch ms；daily 用当天时刻）
     * @param {number} [input.intervalMinutes] interval 用
     */
    create(input) {
      const task = String(input.task ?? '').trim();
      if (!task) throw new Error('schedule.create: task 必填');
      const type = input.type === 'work' ? 'work' : 'message';
      // 2026-08-31 审计修复：非法 schedule 枚举不再静默回退 one-time（曾致无 at 时下一 tick 立即触发）
      if (!['one-time', 'daily', 'interval'].includes(input.schedule)) throw new Error(`schedule.create: 非法 schedule：${input.schedule}`);
      const schedule = input.schedule;
      if (schedule === 'interval' && !(Number.isFinite(input.intervalMinutes) && input.intervalMinutes >= 1)) {
        throw new Error('schedule.create: interval 类型需要 intervalMinutes ≥ 1');
      }
      // 2026-08-31 审计修复：one-time/daily 的 at 必须可解析（NaN/垃圾串会落成幽灵任务永不到期）
      if (schedule !== 'interval' && input.at != null && input.at !== '') {
        const ts = computeDueAt({ schedule, dueAt: input.at, intervalMinutes: null });
        if (!Number.isFinite(ts)) throw new Error(`schedule.create: 无效的时间：${input.at}`);
      }
      const dueAt = computeDueAt({ schedule, dueAt: input.at ?? null, intervalMinutes: input.intervalMinutes });
      if (!Number.isFinite(dueAt)) throw new Error('schedule.create: 无法计算到期时间');
      const id = randomUUID();
      db.prepare('INSERT INTO tasks (id, task_text, type, schedule, due_at, interval_minutes, status, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, task, type, schedule, dueAt, schedule === 'interval' ? input.intervalMinutes : null, 'pending', input.source ?? 'user', Date.now());
      return { id, task, type, schedule, dueAt, status: 'pending' };
    },

    list(limit = 50) {
      // 2026-08-31 审计修复：钳制 limit（负数 → SQLite LIMIT -1 返回全部任务）
      const n = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 50));
      return db.prepare('SELECT * FROM tasks ORDER BY due_at ASC LIMIT ?').all(n).map(hydrateTask);
    },

    cancel(id) {
      // 2026-08-30：取消任务时解除其待办记忆的保护（任务不再需要，待办可被遗忘/归档/手动删除）
      try {
        const row = db.prepare('SELECT task_text FROM tasks WHERE id = ?').get(id);
        if (row?.task_text) unprotectTaskMemories(ctx, row.task_text);
      } catch { /* 忽略 */ }
      const r = db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
      return { cancelled: r.changes > 0 };
    },

    stats() {
      const by = {};
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all()) by[row.status] = row.n;
      return { byStatus: by };
    },

    /** 清理超期历史任务（2026-08-30）：fired 按 fired_at、cancelled/missed/failed 按 created_at 超过保留期删除；pending 永不清理。 */
    cleanup() {
      const cutoff = Date.now() - config.cleanupRetentionDays * 86400000;
      const r1 = db.prepare("DELETE FROM tasks WHERE status = 'fired' AND fired_at IS NOT NULL AND fired_at < ?").run(cutoff);
      // 2026-08-31 审计修复：纳入 failed（fire 抛错置 failed 的孤儿记录此前永不清理）
      const r2 = db.prepare("DELETE FROM tasks WHERE status IN ('cancelled','missed','failed') AND created_at < ?").run(cutoff);
      const removed = r1.changes + r2.changes;
      if (removed > 0) logger.info(`archive-schedule: 清理历史任务 ${removed} 条（保留 ${config.cleanupRetentionDays} 天）`);
      return { removed };
    },

    /** 强制 WAL checkpoint（2026-08-30：定时 + 备份前调用）。 */
    checkpoint() {
      try {
        const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        return { ok: true, checkpointed: row?.checkpointed ?? 0 };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    close() {
      // 2026-08-30 修复：关闭置位 disposed，防止检查 tick 在 db.close() 后触发
      // "database is not open" 未捕获异常（system.shutdown 关闭流程中实测撞上 → 退出码 1）
      disposed = true;
      try { db.close(); } catch { /* ignore */ }
    },
  };
  ctx.provide('schedule', api);

  /** 到期任务执行。 */
  function fire(task) {
    const now = Date.now();
    // 2026-08-31 睡眠期打断：任何定时任务触发都先唤醒智能体（asleep → 强制清醒间隔）。
    // schedule 已 inject loop（单向依赖，无循环引用；loop 侧读 schedule 走 ctx.get 可选访问）
    try { ctx.loop.wake?.('task'); } catch { /* 唤醒失败不阻断任务执行 */ }
    if (task.type === 'message') {
      try {
        // 2026-09-03 分级：用户显式要求的定时提醒 → scope='chat'（可注入总会话对话流，由 control 在非对话/非静默
        // 时机送达）；停机错过等系统状态提示默认 panel（只进通知流水与总控「通知」页，不进对话）。
        const res = ctx.notify.send({ content: `⏰ 定时任务提醒：${task.task}`, source: 'schedule', scope: 'chat' });
        // 2026-08-30 修复：notify 全局限频会静默吞掉提醒（任务却标记 fired）→
        // 限频窗口内推迟重试、保持 pending，保证用户显式要求的提醒最终送达
        if (res && res.limited) {
          db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(now + 5000, task.id);
          logger.warn(`archive-schedule: 提醒被限频，5s 后重试（${task.id}）`);
          return;
        }
      } catch (error) {
        // 2026-08-31 审计修复：发送异常（写盘失败等）与限频同处理——保持 pending 推迟重试，
        // 绝不在未送达时标记 fired（曾致提醒永久丢失）
        logger.warn(`archive-schedule: 通知发送失败，5s 后重试（${task.id}）：${error.message}`);
        db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(now + 5000, task.id);
        return;
      }
    } else {
      // work：生成待办记忆 + 触发自循环思考
      // 2026-08-30：新提醒前先解除同任务旧待办记忆的保护（新提醒取代旧）；新待办 protected=true 防遗忘。
      unprotectTaskMemories(ctx, task.task);
      try {
        // 2026-08-30 审计修复：memory.write 异步（含 embedding），.catch 兜底防 unhandled rejection 崩溃
        ctx.memory.write({ content: `<task-due time="${ctx.virtualClock.format()}">${task.task}</task-due>`, kind: 'episodic', source: 'task-due', importance: 0.7, tags: ['task', 'todo'], protected: true })
          .catch((error) => logger.warn(`archive-schedule: 待办记忆写入失败：${error?.message ?? error}`));
      } catch { /* ignore */ }
      try { ctx.loop.trigger('task-due'); } catch { /* ignore */ }
    }
    // 重复任务：重排下次
    // 2026-08-30 修复：hydrateTask 输出 camelCase（intervalMinutes/dueAt），此处曾用 snake_case
    // （task.interval_minutes/task.due_at=undefined）→ 重排到期=now → interval/daily 每 tick 疯狂重触发。
    if (task.schedule === 'interval') {
      db.prepare('UPDATE tasks SET due_at = ?, status = ?, fired_at = ?, missed_note = NULL WHERE id = ?')
        .run(computeDueAt({ schedule: 'interval', intervalMinutes: task.intervalMinutes }), 'pending', now, task.id);
    } else if (task.schedule === 'daily') {
      db.prepare('UPDATE tasks SET due_at = ?, status = ?, fired_at = ?, missed_note = NULL WHERE id = ?')
        .run(computeDueAt({ schedule: 'daily', dueAt: task.dueAt }), 'pending', now, task.id);
    } else {
      db.prepare("UPDATE tasks SET status = 'fired', fired_at = ? WHERE id = ?").run(now, task.id);
    }
  }

  /** 每 checkMs 检查到期任务（虚拟时钟为时间源）。 */
  let checkedStartup = false;
  let lastCleanupAt = 0;
  let lastCheckpointAt = 0;
  let disposed = false;
  ctx.timer.setInterval(() => {
    if (disposed) return; // 2026-08-30：关闭后不再执行检查（防止 db closed 未捕获异常）
    try {
      const now = Date.now();
      // WAL checkpoint（每 10 分钟；2026-08-30）
      if (now - lastCheckpointAt >= 10 * 60000) {
        lastCheckpointAt = now;
        try { api.checkpoint(); } catch { /* 失败不阻断 */ }
      }
      // 历史任务清理（每 6 小时一次，防数据无限增长；pending 永不清理）
      if (now - lastCleanupAt >= 6 * 3600000) {
        lastCleanupAt = now;
        try { api.cleanup(); } catch { /* 清理失败不阻断 */ }
      }
      // 启动首检：停机期间到期超过宽限的一次性任务 → missed（不执行，提示），避免补执行堆积
      if (!checkedStartup) {
        checkedStartup = true;
        const cutoff = now - config.missedGraceMs;
        const missed = db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND due_at < ? AND schedule = 'one-time'").all(cutoff);
        for (const row of missed) {
          db.prepare("UPDATE tasks SET status = 'missed', missed_note = '进程未运行时到期' WHERE id = ?").run(row.id);
          try { ctx.notify.send({ content: `⚠️ 进程停机期间有任务错过（未执行）：${row.task_text}`, source: 'schedule', scope: 'panel' }); } catch { /* ignore */ }
        }
      }
      const due = db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?").all(now);
      for (const row of due) {
        try {
          fire(hydrateTask(row));
        } catch (error) {
          logger.warn(`archive-schedule: 任务执行失败（${row.id}）：${error.message}`);
          try { db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(row.id); } catch { /* ignore */ }
        }
      }
    } catch (error) {
      logger.warn(`archive-schedule: 检查任务失败：${error.message}`);
    }
  }, config.checkMs);

  const tools = ctx.get('tools');
  if (tools !== undefined) {
    const registered = [];
    const reg = (tool) => { tools.register(tool); registered.push(tool.name); };
    reg(defineTool({
      name: 'schedule_create',
      description: '创建定时任务：用户说"几点干什么"时调用。type=message 到点发消息提醒；type=work 到点生成待办并触发思考处理。',
      parameters: {
        task: { type: 'string', required: true, description: '任务内容（自包含）' },
        type: { type: 'string', description: 'message（提醒/发消息）| work（干活）' },
        schedule: { type: 'string', description: 'one-time（默认）| daily（每天）| interval（每 N 分钟）' },
        at: { type: 'number', description: '绝对到期时间（epoch ms）；daily 时表示每天的时刻' },
        intervalMinutes: { type: 'number', description: 'interval 类型的间隔分钟' },
      },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          task: { type: 'string', required: true },
          type: { type: 'string', required: true },
          schedule: { type: 'string', required: true },
          dueAt: { type: 'number', required: true },
          status: { type: 'string', required: true },
        },
      }),
      execute(args) {
        return api.create(args);
      },
    }));
    reg(defineTool({
      name: 'schedule_list',
      description: '查看全部定时任务（按到期时间排序）。',
      parameters: {},
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } },
      }),
      execute() {
        return { tasks: api.list() };
      },
    }));
    reg(defineTool({
      name: 'schedule_cancel',
      description: '取消一个待执行定时任务。',
      parameters: { id: { type: 'string', required: true, description: '任务 id' } },
      output: toolOutput({
        type: 'object', additionalProperties: false,
        properties: { cancelled: { type: 'boolean', required: true } },
      }),
      execute(args) {
        return api.cancel(args.id);
      },
    }));
    logger.info(`archive-schedule: 已注册工具 ${registered.join(', ')}`);
    bootLine(`[archive-schedule] 工具已注册: ${registered.join(', ')}`);
  }

  // 启动即清理一次超期历史任务
  try { api.cleanup(); } catch { /* 清理失败不阻断启动 */ }

  bootLine(`[archive-schedule] ready ${config.dbPath} 检查=${Math.round(config.checkMs / 1000)}s 保留=${config.cleanupRetentionDays}d`);
  return api;
}

function hydrateTask(row) {
  return {
    id: row.id,
    task: row.task_text,
    type: row.type,
    schedule: row.schedule,
    dueAt: row.due_at,
    intervalMinutes: row.interval_minutes,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    missedNote: row.missed_note,
  };
}

/** 解除指定任务文本对应的待办记忆保护（2026-08-30：任务取消/新提醒取代旧时调用）。
 * 审计修复（2026-08-30）：此前定义为模块顶层函数却引用 apply 形参 ctx → 每次调用抛 ReferenceError，
 * work 型任务整链路失效；改为显式接收 ctx。
 * 2026-08-31 审计修复：翻页遍历 + 精确匹配——高频对话记忆会把旧 task-due 挤出 200 窗口（保护残留），
 * 子串匹配会误伤不同任务（"提醒喝水"与"提醒喝水并吃药"互相解除）。 */
function unprotectTaskMemories(ctx, taskText) {
  try {
    let offset = 0;
    const BATCH = 200;
    const target = String(taskText);
    for (;;) {
      const items = ctx.memory.list({ limit: BATCH, offset }) || [];
      for (const m of items) {
        if (m.source !== 'task-due' || !m.protected) continue;
        const content = String(m.content ?? '');
        // 精确匹配任务文本（标准格式 <task-due time="...">任务</task-due>；旧数据整串相等兜底）
        const exact = content.includes(`>${target}</task-due>`) || content.trim() === target;
        if (exact) {
          try { ctx.memory.update(m.id, { protected: false }).catch(() => {}); } catch { /* 单条失败忽略 */ }
        }
      }
      if (items.length < BATCH) break;
      offset += BATCH;
    }
  } catch { /* 忽略 */ }
}
