/**
 * dsh-archive-clock —— DSH-ARCHIVE 虚拟时钟（Cordis 插件）。
 *
 * 需求：每次启动按设备时间同步（年月日 + 24 小时制）。
 * 设计：
 *  - ctx.virtualClock 服务：now()/today()/time24h()/format()/sync()/describe()
 *  - 启动同步 + 周期校准（config.calibrateMs，默认 60s，成本可忽略）
 *  - systemPrompt 动态 context（virtual-clock, order 200）每回合注入 <time>…</time>
 *  - 作为唯一时间源：自循环/记忆时间戳/场景简报全部读它
 */
export const name = 'dsh-archive-clock';

export const inject = ['systemPrompt', 'timer'];

const DEFAULTS = {
  calibrateMs: 60000,
  injectOrder: 200,
  injectEnabled: true,
};

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.calibrateMs !== undefined) {
    if (!Number.isFinite(raw.calibrateMs) || raw.calibrateMs <= 0) throw new Error('archive-clock 配置错误：calibrateMs 必须是正数');
    cfg.calibrateMs = raw.calibrateMs;
  }
  if (raw.injectOrder !== undefined) {
    if (!Number.isFinite(raw.injectOrder)) throw new Error('archive-clock 配置错误：injectOrder 必须是数字');
    cfg.injectOrder = raw.injectOrder;
  }
  if (raw.injectEnabled !== undefined) {
    if (typeof raw.injectEnabled !== 'boolean') throw new Error('archive-clock 配置错误：injectEnabled 必须是布尔');
    cfg.injectEnabled = raw.injectEnabled;
  }
  return cfg;
}

function bootLine(line) {
  try {
    process.stdout.write(line + '\n');
  } catch { /* 非 CLI 环境忽略 */ }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  let lastSyncAt = Date.now(); // 启动同步

  const api = {
    /** 当前时间（Date）——唯一时间源入口。 */
    now: () => new Date(),
    /** 年月日 YYYY-MM-DD（设备本地）。 */
    today: () => formatDate(new Date()),
    /** 24 小时制 HH:mm:ss。 */
    time24h: () => formatTime(new Date()),
    /** 完整格式 YYYY-MM-DD HH:mm:ss（24h）。 */
    format: () => formatDateTime(new Date()),
    /** 重新同步（记录同步时刻，长驻进程周期校准用）。 */
    sync: () => {
      lastSyncAt = Date.now();
      return { syncedAt: lastSyncAt, now: formatDateTime(new Date()) };
    },
    describe: () => ({
      format: 'YYYY-MM-DD HH:mm:ss（24 小时制，设备本地时间）',
      syncedAt: lastSyncAt,
      calibrateMs: config.calibrateMs,
    }),
  };
  ctx.provide('virtualClock', api);

  if (config.injectEnabled) {
    try {
      ctx.systemPrompt.context({
        name: 'virtual-clock',
        order: config.injectOrder,
        text: () => `<time>${formatDateTime(new Date())}</time>`,
      });
    } catch (error) {
      console.warn(`[archive-clock] systemPrompt context 注册失败：${error.message}`);
    }
  }

  // 周期校准（时间源本身实时，sync 仅记录校准时刻）
  // 记录句柄并在 dispose 时清理（热重载/插件停止不残留定时器）
  const calibrateTimer = ctx.timer.setInterval(() => { lastSyncAt = Date.now(); }, config.calibrateMs);
  ctx.on('dispose', () => {
    try { ctx.timer.clearInterval?.(calibrateTimer); } catch { /* 清理失败无碍 */ }
  });

  bootLine(`[archive-clock] ready ${formatDateTime(new Date())} 校准周期=${Math.round(config.calibrateMs / 1000)}s`);
  return api;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatDateTime(d) {
  return `${formatDate(d)} ${formatTime(d)}`;
}
