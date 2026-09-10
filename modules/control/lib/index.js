/**
 * dsh-archive-control —— Host 半部：把全部服务暴露为 RPC（供 Client 总控面板调用）。
 *  - connection.rpc.intercept('/api', ...)：端点 'archive-control'，载荷 {args:{op,args}}（静态插件通道）。
 *  - 总会话流：仅 scope='chat' 的 notify（AI 面向用户的自然消息/用户要求的提醒）注入 session-main 对话流，
 *    且避开回合并行输出与静默窗（挂起队列按序送达）；scope='panel' 系统状态只进通知流水/「通知」页。
 *    办公室 = DSH webui 的会话/工作区（侧栏原生）。
 *  - 不注册 agent 工具（面板是用户操作入口，避免与 agent 工具面混叠）。
 */
import { readFileSync, rmSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from 'schemastery';

// 数据根（DATA_ROOT）由 cordis.patch.yml 显式配置（与 memory/schedule/notify 一致）：
// 此前用 import.meta.url 推导项目根，模块经 node_modules 硬链接加载时落点错误 → 备份落到
// dsh\backups、DATA_ROOT 指向不存在的 dsh\dsh\data、关闭按钮读不到 dsh\data\tray.pid。
// 分发到任意位置时按文档改 cordis.patch.yml 的绝对路径即可，本文件无需改动。

// 项目模型提供商配置命名空间（自定义 OpenAI 兼容 provider 列表，settings 持久化）
const ArchiveModelsSchema = z.object({
  providers: z.array(z.object({
    id: z.string(), name: z.string(), baseURL: z.string(),
    apiKey: z.string(), model: z.string(), enabled: z.boolean(),
  })).default([]),
});
const ARCHIVE_MODELS_NS = settingsNamespace('archive-models');
const DESCRIBE_IMAGE_NS = settingsNamespace('describe-image');

/** 开机自启 vbs（启动文件夹）。 */
const AUTOSTART_VBS = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'DSH-ARCHIVE-AutoStart.vbs');
/** 勿扰模式设置命名空间（开启后仅不响提示音，通知等其余不变）。 */
const DND_SCHEMA = z.object({ enabled: z.boolean().default(false) });
const DND_NS = settingsNamespace('archive-dnd');
/** 聊天 UI 设置命名空间（流式输出开关，SSE 实时增量渲染；关闭则退化为轮询）。 */
const UI_SCHEMA = z.object({ streaming: z.boolean().default(true) });
const UI_NS = settingsNamespace('archive-ui');
/** 一键更新去重命名空间（方案 D，：同一远程版本只主动通知一次）。 */
const UPDATER_SCHEMA = z.object({ lastNotifiedCommit: z.string().default('') });
const UPDATER_NS = settingsNamespace('archive-updater');
/** 自循环降频开关命名空间（ 起由 loop 模块自身注册——见 archive-loop；此处不再注册，
 *  避免与 loop 的 ctx.inject(['settings']) 注册冲突/时序问题）。 */
/** 备份进行中标志（关闭按钮等待备份完成后才退出，避免备份目录不完整）。 */
let backupInFlight = false;
/**
 * 上次备份开始时刻（ 修复：RPC 分发可能串行化，两个并行请求不会同时处于 in-flight，
 * 单纯 in-flight 守卫拦不住连点/重复调用 → 用 3s 时间窗去重，任何分发模型下都生效）。
 */
let lastBackupAt = 0;
/**
 *：关闭时释放本项目在 ollama 中加载的模型副本（keep_alive=0），
 * 让显存/内存在关闭那一刻就归还，而不是等 ollama 默认 5 分钟空闲后自行卸载。
 * 边界（务必保持，勿改成"结束 ollama 进程"）：
 *   - 只发 HTTP 卸载请求，绝不结束 ollama 进程；
 *   - 模型名取自本项目自身服务（memory.describe / subconscious.runtimeInfo），此处不硬编码，
 *     配置改了自动跟随；
 *   - 该 ollama 可能是系统安装版并被其它程序共用：其它程序的模型一律不碰，
 *     它们最多在下次使用时多付一次本地自动加载；
 *   - 纯尽力而为：单请求 2s 超时，失败只减少返回项，绝不抛错阻断关闭。
 * 已在本机实测：对未加载的模型发 keep_alive:0 不会触发加载；对已加载模型即时卸载生效。
 * @param {object} ctx Cordis 上下文
 * @returns {Promise<string[]>} 已收到成功响应的模型名（用于诊断输出）
 */
async function releaseOllamaModels(ctx) {
  const targets = new Set();
  let baseUrl = '';
  try {
    const info = ctx.memory?.describe?.();
    if (info?.model) targets.add(String(info.model));
    if (info?.baseUrl) baseUrl = String(info.baseUrl);
  } catch { /* 服务不可用：跳过该来源，不影响其它来源 */ }
  try {
    const info = ctx.subconscious?.runtimeInfo?.();
    if (info?.phiModel) targets.add(String(info.phiModel));
    if (!baseUrl && info?.ollamaBaseUrl) baseUrl = String(info.ollamaBaseUrl);
  } catch { /* 同上 */ }
  if (targets.size === 0) return [];
  const base = (baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const released = [];
  await Promise.allSettled([...targets].map(async (model) => {
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) released.push(model);
    } catch { /* ollama 未运行/超时：卸载失败不影响关闭 */ }
  }));
  return released;
}

/** 每日简报生成提示词。 */
const REPORT_PROMPT = `你是 DSH-ARCHIVE 的每日简报助手。根据提供的"最近 24 小时"素材（自循环决策、主动发言、记忆统计、通知、定时任务），生成一份简洁中文简报：
1. 一句话总结（今天 AI 的整体状态）；
2. 分节要点：想了什么（思考/决策）｜做了什么（行动/发言）｜记住了什么（记忆变化）；
3. 结尾一句对明天的展望。
只基于素材，不要编造；每条要点尽量简短（每节 2~5 条）。`;

export const name = 'dsh-archive-control';

export const inject = ['persona', 'loop', 'memory', 'evolution', 'schedule', 'notify', 'virtualClock', 'sessions', 'timer', 'consistency', 'subconscious'];

/** 总会话固定 id：主动消息注入该会话对话（webui 侧栏可见）。 */
const MAIN_SESSION_ID = 'session-main';
/** 总会话工作区（办公室根目录）——由 PROJECT_ROOT 推导（见文件头）。 */

export function apply(ctx, rawConfig) {
  // 数据根由 cordis.patch.yml 显式配置（dataRoot），与 memory/schedule/notify 一致。
  // 备份根 = 项目根 backups（dataRoot 上级的上级，如 dataRoot=dsh/data → 项目根=DSH-ARCHIVE）；
  //  修复回归：此前 PROJECT_ROOT 只上溯一级 → 备份错落在 dsh\backups。
  //  修正：主会话工作目录（MAIN_CWD）保持"数据根上级"（=dsh profile 目录）——
  // 主会话是持久化会话（存储目录 --...-dsh-- 由 cwd 生成，改 cwd 会破坏存储路径定位），
  // 其 agent 实际工作目录即 dsh；若把 MAIN_CWD 改成项目根，置顶逻辑找 path=项目根 工作区
  // attach 主会话时会因 cwd≠path 被 dsh 原生校验拒绝（静默失败）。BACKUP_ROOT 独立取项目根。
  const cfg = rawConfig ?? {};
  const DATA_ROOT = String(cfg.dataRoot ?? '').trim() || join(process.cwd(), 'data');
  const PROJECT_ROOT = resolve(DATA_ROOT, '..', '..');
  const MAIN_CWD = resolve(DATA_ROOT, '..');
  /** 一键备份根目录（项目文件夹内独立 backups/，便于用户查找）。 */
  const BACKUP_ROOT = join(PROJECT_ROOT, 'backups');
  /** 系统监控采样（每 5 分钟一条，cap 240）。 */
  const METRICS_PATH = join(DATA_ROOT, 'metrics.jsonl');
  const logger = ctx.root?.logger?.('archive-control') ?? console;

  // 总会话：优先恢复持久化会话，否则新建（ 修复 fatal）。
  // 原因：固定 id 每次启动全新 create，首次 flush 时持久化协调器发现磁盘已有该 id 的日志
  // 且 live seed 不覆盖 → "id collision" fatal。正确做法是经 sessionPersistence.prepare 恢复
  // （seed=完整存储日志，天然覆盖），恢复不了且未持久化才 create。
  // 总会话：优先经 agents.resume 恢复（session+agent 一起 live），否则 agents.create。
  // 原因①：固定 id 每次全新 create 会撞持久化协调器 "id collision" fatal（恢复优先，见下）。
  // 原因②（ 修复）：此前只 sessions.enter 而不建 agent → session live 但 agent 不存在，
  //   对话 prompt 的 resume 路径撞 "cannot prepare session while it is live"（prepare 只接受非 live 会话）。
  //   agents.resume/create 内部完成 persistence load + enter + agent 发布（含 announce），
  //   prompt 走 fencedLiveAgent 直接命中 live agent。无 agents（headless 面）才退回手动的
  //   persistence.prepare + enter（仅作 notify 注入通道，不保证对话）。
  let mainSession = null;
  let mainSessionReady = Promise.resolve();
  // agent factory 的 setup 钩子里挂载 archive-standard preset（standard 的本地副本，
  // tool-web fetch: true；否则 agent 无标准工具：
  // preset 经 agentPresets.mount(agentCtx) 绑定作用域，官方 api-gateway/api-remotes 路径都传 setup）。
  // 注意 setup 契约：返回值必须是 undefined/void 或 {commit()}——不能返回 mount 的 preset 对象，
  // 否则 setupAndPublish 的 (await setup(...))?.commit() 抛 "commit is not a function" → agent 创建回滚。
  const mountPresetSetup = async (agentCtx) => {
    const agent = agentCtx.agent;
    const ap = ctx.get('agentPresets');
    if (ap && typeof ap.mount === 'function') {
      try {
        await ap.mount(agentCtx, 'archive-standard');
        bootLine(`[archive-control] preset mounted: archive-standard (agent=${agent?.id ?? '?'})`);
      } catch (error) {
        bootLine(`[archive-control] preset mount FAILED: ${error.message}`);
        throw error;
      }
      return undefined;
    }
    bootLine('[archive-control] preset mount skipped: agentPresets unavailable');
    return undefined;
  };
  async function ensureMainSession() {
    const existing = ctx.sessions.get(MAIN_SESSION_ID);
    if (existing !== undefined) return existing;
    const agents = ctx.get('agents');
    if (agents !== undefined && typeof agents.resume === 'function') {
      try {
        await agents.resume({ resumeSessionId: MAIN_SESSION_ID, setup: mountPresetSetup });
        return ctx.sessions.get(MAIN_SESSION_ID);
      } catch (error) {
        bootLine(`[archive-control] resume FAILED: ${error.message}`);
        const persistence = ctx.get('sessionPersistence');
        const persisted = persistence
          ? (await persistence.list().catch(() => [])).some((h) => h.id === MAIN_SESSION_ID)
          : false;
        if (persisted) {
          logger.warn(`archive-control: 主会话恢复失败：${error.message}`);
          return null;
        }
        try {
          await agents.create({ sessionId: MAIN_SESSION_ID, meta: { cwd: MAIN_CWD, agentPreset: 'archive-standard' }, setup: mountPresetSetup });
          return ctx.sessions.get(MAIN_SESSION_ID);
        } catch (createError) {
          logger.warn(`archive-control: 主会话创建失败：${createError.message}`);
          return null;
        }
      }
    }
    const persistence = ctx.get('sessionPersistence');
    if (persistence !== undefined) {
      try {
        const prep = await persistence.prepare(MAIN_SESSION_ID);
        const session = prep.session;
        ctx.sessions.enter(session);
        ctx.sessions.announce(session);
        return session;
      } catch (error) {
        const persisted = (await persistence.list().catch(() => [])).some((h) => h.id === MAIN_SESSION_ID);
        if (persisted) {
          logger.warn(`archive-control: 总会话恢复失败：${error.message}`);
          return null;
        }
      }
    }
    try {
      return ctx.sessions.create(MAIN_SESSION_ID, { meta: { cwd: MAIN_CWD } });
    } catch (error) {
      logger.warn(`archive-control: 总会话创建失败：${error.message}`);
      return null;
    }
  }
  const initMainSession = () => {
    mainSessionReady = ensureMainSession()
      .then((s) => { mainSession = s; })
      .catch((error) => logger.warn(`archive-control: 总会话初始化失败：${error.message}`));
  };
  // 必须等 agentPresets 服务就绪再创建主会话 agent：早期 agents.create 会跳过 preset 挂载
  // （preset 经 agent factory 的 setup 挂载，agent-presets 插件未就绪时挂不上 → 主会话无标准工具）。
  // 注意：inject 回调在临时 childCtx 执行——直接在其中 agents.resume 会把 agent 绑定到 childCtx，
  // 回调结束后 agent 随 childCtx dispose（agents.list() 空）。必须经 ctx.parallel 切回插件主 ctx。
  if (ctx.get('sessionPersistence') !== undefined && ctx.get('agentPresets') !== undefined) initMainSession();
  else ctx.inject(['sessionPersistence', 'agentPresets'], () => {
    bootLine('[archive-control] inject ready; dispatching init via parallel');
    ctx.parallel(['dsh-archive/init-main-session'], () => initMainSession());
  });

  /** 主会话置顶并命名"主会话"（webui 侧栏会话列表第一项；界面与其他会话一致）。 */
  ctx.inject(['workspaceRegistry', 'sessionTitle'], (childCtx) => {
    void mainSessionReady.then(async () => {
      if (!mainSession) return;
      try {
        if (childCtx.sessionTitle) childCtx.sessionTitle.rename(mainSession, '主会话');
      } catch (error) {
        logger.warn(`archive-control: 主会话命名失败：${error.message}`);
      }
      try {
        const registry = childCtx.workspaceRegistry;
        const workspaces = await registry.list();
        const norm = (p) => String(p ?? '').replace(/\\/g, '/');
        const target = workspaces.find((w) => norm(w.path) === norm(MAIN_CWD));
        if (target !== undefined) {
          // detach 再 attach：重建 sessionPath 映射并插到会话列表首位
          // （record.sessionIds 可能已含但映射缺失 → 仅 attach 会因已含而 no-op）
          await target.detachSession(MAIN_SESSION_ID).catch(() => {});
          await target.attachSession(MAIN_SESSION_ID);
        }
      } catch (error) {
        logger.warn(`archive-control: 主会话置顶失败：${error.message}`);
      }
    });
  });

  // 总会话注入（ 分级改造，防机器状态文案泄露进对话/割裂对话）：
  //  - 仅 scope='chat' 的记录（AI 面向用户的自然消息：loop 主动发言 / notify_send / 用户设置的定时提醒）
  //    注入 session-main 对话流；scope='panel'（主动行动状态串、自进化/潜意识/停机错过/更新提示等系统状态）
  //    只进通知流水与总控「通知」页——此前全部 notify 都被追加成 assistant 消息，"🤖 主动行动：已执行
  //    memory_write…"等操作流水以 AI 普通回复的样式出现在用户对话里（ 03:49 实机泄露）。
  //  - 送达时机门控：对话回合进行中（conversing/thinking）或静默窗内（用户刚发消息/回合刚结束）到达的
  //    chat 级记录先挂起，等回合并行输出结束再按序送达——避免提醒/主动消息插进 AI 正在回复的对话中间（割裂）。
  const chatHold = { queue: [], since: 0, chain: false };
  const loopChatState = () => {
    try {
      const s = ctx.loop?.state?.();
      const mode = s?.mode;
      return {
        busy: mode === 'conversing' || mode === 'thinking',
        quietLeftMs: Number(s?.quietLeftMs ?? 0),
      };
    } catch { return { busy: false, quietLeftMs: 0 }; }
  };
  const appendProactive = (record) => {
    if (!mainSession || !record?.content) return;
    try {
      mainSession.append('assistant/message', {
        turn: 0,
        step: 0,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: record.content }],
          source: { kind: 'model', provider: 'proactive', model: record.source || 'system' },
          id: `proactive-${record.id}`,
          time: record.at,
        },
      }, { surfaceOp: 'append' });
      //  flush 异步失败兜底，防 unhandled rejection 崩溃
      void ctx.sessions.flush(mainSession).catch((e) => logger.warn(`archive-control: 总会话 flush 失败：${e?.message ?? e}`));
    } catch (error) {
      logger.warn(`archive-control: 总会话注入失败：${error.message}`);
    }
  };
  /** 挂起队列排空：仅当无并行对话输出且（静默窗已过或已超 5 分钟兜底）时按序注入。 */
  const drainChatHold = () => {
    if (chatHold.queue.length === 0) return;
    const { busy, quietLeftMs } = loopChatState();
    const heldMs = Date.now() - chatHold.since;
    if (busy) return; // 回合进行中：继续等下一次检查（回合结束必有 idle 间隙）
    if (quietLeftMs > 0 && heldMs < 300000) return; // 静默窗内短等；5 分钟兜底后照常送达（提醒不丢失）
    const batch = chatHold.queue;
    chatHold.queue = [];
    chatHold.since = 0;
    for (const r of batch) appendProactive(r);
  };
  /** 自再挂 setTimeout 轮询（队列非空才存在；ctx.timer 自动随插件销毁清理）。 */
  const armChatHold = () => {
    if (chatHold.chain) return;
    chatHold.chain = true;
    ctx.timer.setTimeout(() => {
      chatHold.chain = false;
      if (chatHold.queue.length === 0) return;
      drainChatHold();
      if (chatHold.queue.length > 0) armChatHold();
    }, 2000);
  };
  ctx.on('archive/notify-sent', ({ record }) => {
    if (!record?.content) return;
    if (record.scope !== 'chat') return; // panel 级：只进通知流水/「通知」页，绝不进对话
    void mainSessionReady.then(() => {
      if (!mainSession) return;
      const { busy, quietLeftMs } = loopChatState();
      if (!busy && quietLeftMs <= 0) { appendProactive(record); return; }
      chatHold.queue.push(record);
      if (chatHold.since === 0) chatHold.since = Date.now();
      armChatHold();
      drainChatHold(); // 启动即排空一次（覆盖挂起瞬间已无并行输出的情况）
    });
  });

  /** RPC 操作表（闭包内定义，持有 ctx）。 */

  // ---- 一键更新（方案 D）：git 远程版本检查与更新触发 ----
  const execFileP = promisify(execFile);

  // git 代理自动识别：git 不读 Windows 系统代理——开着 v2rayN/Clash 等代理软件时，
  // 若只设置了系统代理（或仅监听 socks 口），git fetch 仍走直连，检测更新/一键更新必失败。
  // 解析顺序：①环境变量代理 → ②git 全局/本地 http.proxy → ③Windows 系统代理（registry；
  // 纯 host:port 无法判断协议 → 先做端口协议探测，识别 socks5h/http 再选用，避免把 socks 口当 http）。
  // 结果缓存 5 分钟（本地探测）；返回 {url, source, text}。
  const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  let gitProxyCache = { t: 0, v: null };
  const withProxySocket = (host, port, onReady) => new Promise((resolve) => {
    let socket;
    const done = (v) => { clearTimeout(timer); try { socket.destroy(); } catch { /* ignore */ } resolve(v); };
    try { socket = connect({ host, port, timeout: 2500 }); } catch { resolve(null); return; }
    const timer = setTimeout(() => done(null), 2500);
    socket.on('error', () => done(null));
    socket.on('timeout', () => done(null));
    socket.on('connect', () => { try { onReady(socket, done); } catch { done(null); } });
  });
  // 端口协议探测：先发 socks5 握手，回 05 00 即 socks；否则 http CONNECT 探测，回 HTTP/1.x 状态行即 http。
  const probeProxyProtocol = async (host, port) => {
    const socks = await withProxySocket(host, port, (socket, done) => {
      socket.once('data', (b) => done(b.length >= 2 && b[0] === 0x05 && b[1] === 0x00 ? 'socks5h' : null));
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    if (socks) return socks;
    const http = await withProxySocket(host, port, (socket, done) => {
      let buf = '';
      socket.on('data', (b) => {
        buf += b.toString('latin1');
        if (buf.includes('\r\n') || buf.length > 512) { done(/^HTTP\/1\.[01]\s+\d{3}/.test(buf) ? 'http' : null); }
      });
      socket.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n');
    });
    return http;
  };
  const splitHostPort = (s) => {
    s = String(s ?? '').trim();
    if (s.startsWith('[')) { const e = s.indexOf(']'); return { host: s.slice(1, e), port: Number(s.slice(e + 2)) || 0 }; }
    const i = s.lastIndexOf(':');
    return { host: i > 0 ? s.slice(0, i) : s, port: Number(i > 0 ? s.slice(i + 1) : 0) || 0 };
  };
  const normalizeProxy = (raw) => {
    const p = String(raw ?? '').trim();
    if (!p) return '';
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p) ? p: `http://${p}`;
  };
  const readSystemProxy = async () => {
    if (process.platform !== 'win32') return null;
    let stdout;
    try {
      ({ stdout } = await execFileP('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }));
      if (!/0x1\s*$/m.test(String(stdout ?? ''))) return null;
    } catch { return null; }
    try {
      ({ stdout } = await execFileP('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }));
      const m = /ProxyServer\s+REG_SZ\s+(.+)$/m.exec(String(stdout ?? ''));
      if (!m) return null;
      // IE 风格可能是 "http=..;https=.." 多段：https 段优先，其次 http/socks，最后单段裸值
      const parts = m[1].trim().split(';').map((x) => x.trim()).filter(Boolean);
      const kv = {};
      const plain = [];
      for (const e of parts) { const mm = /^([a-zA-Z]+)=(.*)$/.exec(e); if (mm) kv[mm[1].toLowerCase()] = mm[2].trim(); else plain.push(e); }
      const raw = kv.https || kv.http || kv.socks || plain[0] || '';
      if (!raw) return null;
      const { host, port } = splitHostPort(String(raw).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ''));
      if (!host || !port) return null;
      const scheme = await probeProxyProtocol(host, port);
      return scheme ? { url: `${scheme}://${host}:${port}`, source: '系统代理' } : null;
    } catch { return null; }
  };
  const resolveGitProxy = async () => {
    for (const k of PROXY_ENV_KEYS) {  // ① 环境变量
      const raw = process.env[k];
      if (raw && String(raw).trim()) return { url: normalizeProxy(raw), source: '环境变量' };
    }
    try {  // ② git 全局/本地 http.proxy（显式空值 = 用户强制直连，不再探测系统代理）
      const { stdout, stderr } = await execFileP('git', ['config', '--get', 'http.proxy'], { cwd: PROJECT_ROOT, timeout: 8000, windowsHide: true, encoding: 'utf8' });
      const val = String(stdout ?? '').trim();
      if (val) return { url: normalizeProxy(val), source: 'git 配置' };
      if (!stderr && process.platform === 'win32') return { url: null, source: 'direct', text: '已按 git 配置强制直连' };
    } catch { /* 未配置 → 继续 */ }
    const sys = await readSystemProxy();  // ③ Windows 系统代理（端口协议实测）
    if (sys) return { ...sys, text: `代理 ${sys.url}（${sys.source}）` };
    return { url: null, source: 'none', text: '未配置代理（git 直连）' };
  };
  const getGitProxy = async () => {
    const now = Date.now();
    if (gitProxyCache.v && now - gitProxyCache.t < 5 * 60000) return gitProxyCache.v;
    const p = await resolveGitProxy();
    p.text = p.text || (p.url ? `代理 ${p.url}（${p.source}）` : '未配置代理（git 直连）');
    gitProxyCache = { t: now, v: p };
    return p;
  };
  const gitErrShort = (error) => {
    const msg = String(error?.message ?? error ?? '');
    const lines = msg.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const pick = lines.find((l) => /fatal|unable|could not|schannel|timed? ?out|SSL|TLS|denied|authentication|credentials|HTTP/i.test(l)) || lines[lines.length - 1] || '';
    return pick.slice(0, 140);
  };
  const runGit = async (args, timeoutMs = 30000) => {
    const proxy = await getGitProxy();
    const cmdArgs = proxy.url
      ? ['-c', `http.proxy=${proxy.url}`, '-c', `https.proxy=${proxy.url}`, ...args]
      : args;
    try {
      const { stdout } = await execFileP('git', cmdArgs, { cwd: PROJECT_ROOT, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' });
      return { ok: true, out: String(stdout ?? '').trim(), proxy: proxy.text };
    } catch (error) {
      return { ok: false, err: gitErrShort(error), proxy: proxy.text };
    }
  };
  const readVersion = () => {
    try {
      const v = readFileSync(join(PROJECT_ROOT, 'VERSION'), 'utf8').trim();
      if (v) return v;
    } catch { /* 无 VERSION 文件 */ }
    return '';
  };
  // updater.check 结果缓存（见 updater.check 注释）+ 进行中请求复用（防 startupUpdateCheck 与用户打开总控页
  // 并发触发两个 git fetch —— git index.lock 竞争会令一方失败/等待）。
  let updaterCheckCache = null;
  let updaterCheckInflight = null;

  const OPS = {
    // 总会话/概览（每个服务调用单独容错——任一服务异常不再让整个总控页失败）
    'overview': () => ({
      clock: { now: ctx.virtualClock.format() },
      loop: (() => { try { return { stats: ctx.loop.stats(), sleep: ctx.loop.state().sleep }; } catch { return null; } })(),
      memory: (() => { try { return ctx.memory.forgetStats(); } catch { return null; } })(),
      evolution: (() => { try { return ctx.evolution.stats(); } catch { return null; } })(),
      schedule: (() => { try { return ctx.schedule.stats(); } catch { return null; } })(),
      notify: (() => { try { return ctx.notify.stats(); } catch { return null; } })(),
    }),
    'clock.now': () => ({ now: ctx.virtualClock.format() }),
    // 人格
    'persona.get': () => ctx.persona.get(),
    'persona.stats': () => ctx.persona.stats(),
    'persona.history': (a) => ctx.persona.history(a.limit),
    'persona.set': (a) => ctx.persona.set(a.entries, { by: 'user', summary: a.summary }),
    'persona.update': (a) => ctx.persona.update(a.id, { content: a.content, importance: a.importance, confidence: a.confidence, by: a.by ?? 'user' }),
    'persona.remove': (a) => ctx.persona.remove(a.id, { by: 'user' }),
    'persona.rollback': (a) => ctx.persona.rollback(a.version, a.by ?? 'user'),
    // 人格一键凝练：LLM 无损整理全部条目（合并相同/相似、按六分区归类、严格 YAML 重写）
    // → 先预览（不生效）→ 用户确认后经 persona.replace 整体重建（版本+1、留档、可回滚）。
    'persona.distillPreview': () => ctx.evolution.distillPersona(),
    'persona.distillApply': (a) => {
      if (!a || typeof a.token !== 'string' || !a.token) throw new Error('persona.distillApply: 缺少凝练结果 token');
      return ctx.evolution.applyPersonaDistill(a.token);
    },
    // 思维循环
    'loop.state': () => ctx.loop.state(),
    'loop.stats': () => ctx.loop.stats(),
    'loop.configure': (a) => ctx.loop.configure(a),
    'loop.trigger': (a) => ctx.loop.trigger(a.reason),
    // 思维预设：用户指令注入（预设/指令 CRUD 走整存 save；命中预览供 UI 调试）
    'loop.instructions.get': () => ctx.loop.instructions.get(),
    'loop.instructions.save': (a) => ctx.loop.instructions.save(a.state),
    'loop.instructions.preview': (a) => ctx.loop.instructions.preview(a.text ?? '', a.presetId),
    // 自循环活动流：从记忆库取 source=loop 的 thought 决策记录（排除已整合/遗忘的）
    'loop.history': (a) => {
      const limit = Math.min(100, Number(a?.limit) || 60);
      //  取数窗口从 100 提到 store 硬上限 200——高频期（用户消息每回合落一条
      // conversation 记忆）thought 决策记录会被挤出前 100 行，导致活动流静默缺记录（无翻页）。
      // store.list 上限即 200，超出部分属展示窗口设计边界。
      const all = ctx.memory.list({ limit: 200 });
      const items = all.filter((m) => m.kind === 'thought' && m.source === 'loop' && m.forgotten === 0)
        .slice(0, limit)
        .map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt }));
      return { items };
    },
    // 记忆
    'memory.list': (a) => ctx.memory.list(a),
    'memory.recall': (a) => ctx.memory.recall(a),
    'memory.get': (a) => ctx.memory.get(a.id),
    'memory.update': (a) => ctx.memory.update(a.id, a.patch),
    'memory.forget': (a) => ctx.memory.forget(a.id),
    'memory.forgetRun': () => ctx.memory.forgetRun(),
    'memory.restore': (a) => ctx.memory.restore(a.id),
    'memory.forgottenList': (a) => ctx.memory.forgottenList(a.limit),
    'memory.forgetStats': () => ctx.memory.forgetStats(),
    'memory.profile': () => ctx.memory.profile.list({ limit: 100 }),
    'memory.state': () => ctx.memory.state.snapshot(),
    'memory.stats': () => ctx.memory.stats(),
    // 自进化
    'evolution.view': (a) => ctx.evolution.view(a.limit),
    'evolution.stats': () => ctx.evolution.stats(),
    'evolution.suggest': async (a) => {
      //  手动触发成功且产出候选 → 铃铛通知（与每日 22:00 自动候选同款文案/通道）。
      // 仅 UI 手动路径走本 OPS；agent 工具 evolution_suggest 直调服务层，不在此重复打扰。
      const res = await ctx.evolution.suggest({ by: a.by ?? 'user' });
      const n = (res?.candidateIds ?? []).length;
      if (n > 0 && typeof ctx.notify?.send === 'function') {
        try {
          const passed = (res.results ?? []).filter((r) => r.decision?.passed).length;
          ctx.notify.send({
            content: `🧬 自进化：手动已生成 ${n} 条进化候选（${passed} 条通过安全评估），请到「自进化」页审阅采纳或拒绝。`,
            source: 'evolution',
            scope: 'panel',
          });
        } catch { /* 通知失败不阻断生成结果 */ }
      }
      return res;
    },
    //  一致性协同已统一在 evolution 服务层发射（approve/autoApply 全路径覆盖，
    // 含 agent 工具与潜意识自动微调）——此处不再手动调用，避免双触发重复入轨
    'evolution.approve': (a) => ctx.evolution.approve(a.candidateId, { by: 'user', confirm: a.confirm }),
    'evolution.reject': (a) => ctx.evolution.reject(a.candidateId, { by: 'user' }),
    'evolution.rollback': (a) => ctx.evolution.rollback(a.candidateId, { by: 'user', confirm: a.confirm }),
    // 人格一致性：开关/阈值/轨迹坐标/拦截修订倒叙修正记录
    'consistency.state': () => ctx.consistency.state(),
    'consistency.stats': () => ctx.consistency.stats(),
    'consistency.pca': () => ctx.consistency.pca(),
    'consistency.log': (a) => ctx.consistency.log(a.limit),
    'consistency.revisions': () => ctx.consistency.revisionsMap(),
    'consistency.configure': (a) => ctx.consistency.configure(a),
    // 潜意识系统·梦境引擎：状态/配置/手动触发/日志/Phi 模型管理
    'subconscious.state': () => ctx.subconscious.state(),
    'subconscious.stats': () => ctx.subconscious.stats(),
    'subconscious.log': (a) => ctx.subconscious.log(a.limit),
    'subconscious.configure': (a) => ctx.subconscious.configure(a),
    'subconscious.run': () => ctx.subconscious.run(),
    'subconscious.model': () => ctx.subconscious.model(),
    'subconscious.modelDownload': () => ctx.subconscious.modelDownload(),
    'subconscious.modelRemove': () => ctx.subconscious.modelRemove(),
    // 定时任务
    'schedule.list': () => ({ tasks: ctx.schedule.list() }),
    'schedule.create': (a) => ctx.schedule.create(a),
    'schedule.cancel': (a) => ctx.schedule.cancel(a.id),
    'schedule.stats': () => ctx.schedule.stats(),
    // 通知
    'notify.view': (a) => ctx.notify.view(a.limit),
    'notify.markRead': (a) => ctx.notify.markRead(a.id),
    'notify.stats': () => ctx.notify.stats(),
    // 工具与技能清单（主会话 agent 视角：preset 工具是 agent 作用域，
    // tools.schemas(scope) 省略 scope=全局视图；scope key 经 ctx 的 dsh.scope Symbol 获取）
    'tools.list': () => {
      const agent = ctx.get('agents')?.get?.(MAIN_SESSION_ID);
      const tools = agent?.ctx?.get?.('tools');
      // scope 参数可传 Agent 对象（dsh-tools 内部 chainLayers(exec.agent) 同款用法）
      const list = agent !== undefined ? (tools?.schemas?.(agent) ?? []) : [];
      return { tools: list.map((t) => ({ name: String(t.name ?? ''), description: String(t.description ?? '') })) };
    },
    'skills.list': async () => {
      const agent = ctx.get('agents')?.get?.(MAIN_SESSION_ID);
      const skills = ctx.get('skills');
      const list = skills !== undefined && agent !== undefined ? (await skills.list({ scope: agent })) : [];
      return { skills: list.map((s) => ({
        name: String(s.name ?? ''), description: String(s.description ?? ''),
        whenToUse: String(s.whenToUse ?? ''), source: String(s.source ?? ''), provider: String(s.provider ?? ''),
      })) };
    },
    // 模型提供商：DeepSeek 官方密钥（写 credentials）+ 自定义 OpenAI 兼容 provider（settings archive-models）
    'models.get': async () => {
      const settings = ctx.get('settings');
      const value = settings?.get?.(ARCHIVE_MODELS_NS) ?? { providers: [] };
      let deepseekConfigured = false;
      try {
        const creds = ctx.get('credentials');
        if (creds && typeof creds.resolve === 'function') {
          const rec = await creds.resolve('DEEPSEEK_API_KEY');
          deepseekConfigured = Boolean(rec?.value);
        }
      } catch { /* 容错 */ }
      return {
        providers: Array.isArray(value.providers) ? value.providers.map((p) => ({
          id: String(p.id ?? ''), name: String(p.name ?? ''), baseURL: String(p.baseURL ?? ''),
          apiKeySet: Boolean(p.apiKey), model: String(p.model ?? ''), enabled: p.enabled !== false,
        })) : [],
        deepseekConfigured,
        deepseekBaseURL: 'https://api.deepseek.com/v1',
        deepseekModel: 'deepseek-v4-flash',
      };
    },
    // 未配置模型提供商检测（聊天发送前拦截提示用；与 models.get 口径一致）：
    // DeepSeek 官方密钥（credentials 解析）+ 自定义 OpenAI 兼容 provider（settings archive-models）任一可用即视为已配置
    'models.checkReady': async () => {
      let deepseekConfigured = false;
      try {
        const creds = ctx.get('credentials');
        if (creds && typeof creds.resolve === 'function') {
          const rec = await creds.resolve('DEEPSEEK_API_KEY');
          deepseekConfigured = Boolean(rec?.value);
        }
      } catch { /* 容错 */ }
      let customConfigured = false;
      try {
        const settings = ctx.get('settings');
        const value = settings?.get?.(ARCHIVE_MODELS_NS);
        const list = Array.isArray(value?.providers) ? value.providers : [];
        customConfigured = list.some((p) => p.enabled !== false
          && String(p.baseURL ?? '').trim() && String(p.apiKey ?? '').trim() && String(p.model ?? '').trim());
      } catch { /* 容错 */ }
      const configured = deepseekConfigured || customConfigured;
      return { configured, deepseekConfigured, customConfigured, reason: configured ? '' : '未配置模型提供商：请先在「模型」页配置 DeepSeek 官方密钥或启用自定义提供商' };
    },
    'models.setProviders': async (a) => {
      //  （高危）：models.get 只回 apiKeySet 布尔、从不回明文 apiKey（安全惯例），
      // 而前端保存/启停/删除/编辑都会把整表 providers 原样回传——若把空 apiKey 直接落盘，
      // 任意一次操作都会静默清空全部自定义提供商的密钥（不可逆）。修法：先读旧配置按 id 合并，
      // apiKey 留空 = 保留原密钥（与 vision.config.set 的"留空保留"惯例一致）；显式传新值才覆盖。
      const settings = ctx.get('settings');
      if (!settings || typeof settings.update !== 'function') throw new Error('settings 服务不可用');
      let oldKeys = {};
      try {
        const prev = settings.get?.(ARCHIVE_MODELS_NS);
        const arr = prev?.providers;
        if (Array.isArray(arr)) for (const p of arr) if (p && p.id) oldKeys[String(p.id)] = String(p.apiKey ?? '');
      } catch { /* 旧配置读取失败不阻断（按全空处理） */ }
      const list = Array.isArray(a.providers) ? a.providers.map((p, i) => {
        const id = String(p.id || `p${Date.now()}-${i}`);
        const apiKey = String(p.apiKey ?? '');
        return {
          id, name: String(p.name ?? '').slice(0, 60), baseURL: String(p.baseURL ?? '').slice(0, 300),
          apiKey: apiKey || oldKeys[id] || '', model: String(p.model ?? '').slice(0, 100), enabled: p.enabled !== false,
        };
      }) : [];
      await settings.update(ARCHIVE_MODELS_NS, { providers: list });
      //：配置写入成功后唤醒 loop 凭证冷却（无 key 期间 loop 低频暂停，配置后立即恢复）
      try { ctx.emit('archive/credentials-changed', { at: Date.now() }); } catch { /* 事件失败不阻断 */ }
      return { saved: true, count: list.length };
    },
    'models.setDeepSeekKey': async (a) => {
      const key = String(a.key ?? '').trim();
      if (!key) throw new Error('API 密钥不能为空');
      const creds = ctx.get('credentials');
      if (!creds || typeof creds.set !== 'function') throw new Error('credentials 服务不可用');
      await creds.set('DEEPSEEK_API_KEY', key);
      //：配置写入成功后唤醒 loop 凭证冷却
      try { ctx.emit('archive/credentials-changed', { at: Date.now() }); } catch { /* 事件失败不阻断 */ }
      return { saved: true };
    },
    // 自定义提供商连通性测试（ 新增：模型页"测试连接"，避免配错后自循环静默瘫痪）
    'models.testProvider': async (a) => {
      const baseURL = String(a.baseURL ?? '').trim().replace(/\/+$/, '');
      const model = String(a.model ?? '').trim();
      const apiKey = String(a.apiKey ?? '').trim();
      if (!baseURL || !model) return { ok: false, error: '接口地址与模型名必填' };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const res = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: ctrl.signal,
        });
        const j = await res.json().catch(() => null);
        if (!res.ok) return { ok: false, error: j?.error?.message ? `API: ${j.error.message}` : `HTTP ${res.status}` };
        return { ok: true, note: `连通成功 · ${model}` };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      } finally { clearTimeout(timer); }
    },
    // 识图提供商（describe-image settings，原生生效）
    'vision.config.get': () => {
      const settings = ctx.get('settings');
      const value = settings?.get?.(DESCRIBE_IMAGE_NS) ?? {};
      return {
        baseURL: String(value.baseURL ?? ''), model: String(value.model ?? ''),
        apiKeySet: Boolean(value.apiKey || value.apiKeyEnv), apiKeyEnv: String(value.apiKeyEnv ?? ''),
      };
    },
    'vision.config.set': async (a) => {
      const patch = {};
      //  baseURL/model/apiKeyEnv 允许显式清空（此前空串被跳过 → 界面显示已保存实则旧值保留）；
      // apiKey 留空仍保留原值（密钥不回显的编辑惯例）
      if (a.baseURL !== undefined) patch.baseURL = String(a.baseURL).trim();
      if (a.model !== undefined) patch.model = String(a.model).trim();
      if (a.apiKey !== undefined && String(a.apiKey).trim()) patch.apiKey = String(a.apiKey).trim();
      if (a.apiKeyEnv !== undefined) patch.apiKeyEnv = String(a.apiKeyEnv).trim();
      if (Object.keys(patch).length === 0) throw new Error('没有可保存的配置');
      const settings = ctx.get('settings');
      if (!settings || typeof settings.update !== 'function') throw new Error('settings 服务不可用');
      await settings.update(DESCRIBE_IMAGE_NS, patch);
      return { saved: true, keys: Object.keys(patch) };
    },
    // 识图测试（全新 UI 专用）：host 侧调视觉模型（端点/模型/密钥读 describe-image 配置，
    //  修复：此前硬编码 DeepSeek 官方，与"识图-提供商配置"完全脱节，改了配置测试仍走官方）
    'vision.test': async (a) => {
      const p = String(a?.path ?? '').trim();
      if (!p) throw new Error('vision.test: 图片路径/URL 必填');
      const mimeOf = (x) => {
        const ext = x.split('.').pop()?.toLowerCase();
        return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[ext] ?? 'image/png';
      };
      let url = p;
      if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) {
        const data = readFileSync(p);
        url = `data:${mimeOf(p)};base64,${data.toString('base64')}`;
      }
      const settings = ctx.get('settings');
      const cfg = settings?.get?.(DESCRIBE_IMAGE_NS) ?? {};
      const base = String(cfg.baseURL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
      const model = String(cfg.model || 'deepseek-v4-flash-vision-exp');
      const credentials = ctx.get('credentials');
      let key = '';
      if (String(cfg.apiKey ?? '').trim()) key = String(cfg.apiKey).trim();
      else if (String(cfg.apiKeyEnv ?? '').trim() && credentials && typeof credentials.resolve === 'function') {
        try { const rec = await credentials.resolve(String(cfg.apiKeyEnv)); key = rec?.value ?? ''; } catch { /* 容错 */ }
      }
      if (!key && credentials && typeof credentials.resolve === 'function') {
        try { const rec = await credentials.resolve('DEEPSEEK_API_KEY'); key = rec?.value ?? ''; } catch { /* 容错 */ }
      }
      if (!key) key = process.env.DEEPSEEK_API_KEY ?? '';
      if (!key) throw new Error('未找到视觉 API 密钥（检查识图提供商配置或项目内 credentials.yaml）');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: [
              { type: 'text', text: '请用简洁中文描述这张图片的内容（形状、颜色、布局、文字）。' },
              { type: 'image_url', image_url: { url } },
            ] }],
          }),
          signal: ctrl.signal,
        });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error?.message ? `API: ${j.error.message}` : `HTTP ${res.status}`);
        const content = j.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) throw new Error('API 返回空内容');
        return { text: content };
      } finally { clearTimeout(timer); }
    },
    // 关闭：保存未保存数据（flush 全部会话）→ 优雅关闭有资源服务 → 退出进程（端口随之释放）
    'system.shutdown': async () => {
      //：若备份进行中，等待其完成后再关闭（避免备份目录不完整；上限 60s）
      const backupWaitStart = Date.now();
      while (backupInFlight && Date.now() - backupWaitStart < 60000) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      let flushed = 0;
      try {
        const all = typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : [];
        for (const s of all) {
          try { await ctx.sessions.flush(s); flushed++; } catch { /* 单个失败不阻断 */ }
        }
      } catch { /* 会话服务异常不阻断 */ }
      //  整体恢复：存在 .restore-marker 时，关闭有连接的服务后用暂存内容覆盖 data（重启即恢复）
      const dataRoot = DATA_ROOT;
      const marker = join(dataRoot, '.restore-marker');
      const pending = join(dataRoot, '.restore-pending');
      if (existsSync(marker)) {
        try {
          const info = JSON.parse(readFileSync(marker, 'utf8'));
          try { ctx.memory?.close?.(); } catch { /* ignore */ }
          try { ctx.schedule?.close?.(); } catch { /* ignore */ }
          const { cpSync, readdirSync } = await import('node:fs');
          for (const e of readdirSync(pending, { withFileTypes: true })) {
            const name = e.name;
            if (name === 'credentials.yaml') continue; // 当前凭据保留
            rmSync(join(dataRoot, name), { recursive: true, force: true });
            cpSync(join(pending, name), join(dataRoot, name), { recursive: true });
          }
          rmSync(marker, { force: true });
          rmSync(pending, { recursive: true, force: true });
          logger.info(`archive-control: 已从备份 ${info.from ?? '?'} 完成恢复（重启后为备份状态）`);
          bootLine(`[archive-control] 恢复完成：${info.from ?? '?'}（前状态备份：${info.preBackup ?? '?'}）`);
        } catch (error) {
          logger.warn(`archive-control: 恢复执行失败：${error.message}`);
        }
      }
      try { ctx.schedule?.close?.(); } catch { /* ignore */ }
      try { ctx.memory?.close?.(); } catch { /* ignore */ }
      //：人格一致性轨迹 flush（节流写盘未落的内容强制落盘）
      try { ctx.consistency?.close?.(); } catch { /* ignore */ }
      //：潜意识状态（潜记忆池/草案/呓语）flush
      try { ctx.subconscious?.close?.(); } catch { /* ignore */ }
      //：释放本项目在 ollama 中加载的模型副本（详见 releaseOllamaModels 注释）。
      // 位置：各服务 close 之后、进程退出之前，好让 ollama 尚能收到请求；失败不影响关闭。
      try {
        const releasedModels = await releaseOllamaModels(ctx);
        if (releasedModels.length > 0) bootLine(`[archive-control] 已释放 ollama 模型副本：${releasedModels.join(', ')}`);
        else bootLine('[archive-control] 未释放 ollama 模型副本（ollama 未运行 / 模型未加载 / 请求失败，均不影响关闭）');
      } catch { /* 释放异常不影响关闭 */ }
      //：关闭按钮 = 完全退出 —— 顺带关闭系统托盘（tray.ps1 独立进程）。
      // tray.pid 由 tray.ps1 写入两行：PID / 进程名；按名校验防 PID 复用误杀；
      // 每步带 bootLine 诊断输出；pid 文件无论 kill 成败都删除（避免残留）。
      const trayPidFile = join(DATA_ROOT, 'tray.pid');
      if (existsSync(trayPidFile)) {
        try {
          const lines = String(readFileSync(trayPidFile, 'utf8')).split('\n');
          const trayPid = parseInt(String(lines[0] ?? '').trim(), 10);
          const trayName = String(lines[1] ?? '').trim();
          if (Number.isFinite(trayPid) && trayPid > 0 && trayName === 'powershell') {
            try {
              process.kill(trayPid);
              bootLine(`[archive-control] 系统托盘已随关闭退出（PID ${trayPid}）`);
            } catch (killError) {
              bootLine(`[archive-control] 托盘进程结束失败（PID ${trayPid}）：${killError.message}`);
            }
          } else {
            bootLine(`[archive-control] 托盘 pid 文件内容异常，跳过清理：${String(lines.join('/')).slice(0, 60)}`);
          }
        } catch (readError) {
          bootLine(`[archive-control] 托盘 pid 文件读取失败：${readError.message}`);
        }
        try { rmSync(trayPidFile, { force: true }); } catch { /* ignore */ }
      } else {
        bootLine('[archive-control] 关闭时未发现托盘 pid 文件（托盘可能未启动完成或未启动）');
      }
      setTimeout(() => { try { process.exit(0); } catch { /* ignore */ } }, 400);
      return { ok: true, flushed };
    },
    // 权限预设（与 DSH 本体 /permission 同源）：读取/切换当前会话的
    // sandbox 模式 + 审批策略。宿主侧服务 ctx.permissionPresets 由 base 行提供
    // （read-only / workspace-write / danger-full-access 三档），archive 实例已随
    // @deepseek-ai/dsh-base 挂载；此处仅做 RPC 桥，不重复实现折叠逻辑。
    'permission.state': async (a) => {
      const sessionId = String(a?.sessionId || MAIN_SESSION_ID);
      const presets = ctx.get('permissionPresets');
      if (!presets || typeof presets.current !== 'function') {
        return { available: false, reason: 'permission service unavailable' };
      }
      // 会话可能尚未 live（例如 headless 兜底路径）——无事件时退化为空折叠，
      // current()/derive() 会落到组成默认值（workspace-write + ask）。
      const session = ctx.sessions.get(sessionId);
      const events = session?.events ?? [];
      const names = (() => { try { return presets.names ?? []; } catch { return []; } })();
      const options = names.map((name) => {
        try {
          const o = presets.optionOf(name) ?? {};
          return { value: name, name: String(o.name ?? name), description: String(o.description ?? '') };
        } catch { return { value: name, name: String(name), description: '' }; }
      });
      let current = null;
      try { current = presets.current(events) ?? null; } catch { /* custom/无匹配 → null */ }
      return { available: true, sessionId, current, options };
    },
    'permission.set': async (a) => {
      const sessionId = String(a?.sessionId || MAIN_SESSION_ID);
      const preset = String(a?.preset ?? '').trim();
      if (!preset) throw new Error('permission.set: preset 必填');
      const presets = ctx.get('permissionPresets');
      if (!presets || typeof presets.apply !== 'function') throw new Error('权限预设服务不可用');
      const names = (() => { try { return presets.names ?? []; } catch { return []; } })();
      if (!names.includes(preset)) throw new Error(`未知权限预设：${preset}（可用：${names.join(' / ')}）`);
      const session = ctx.sessions.get(sessionId);
      if (!session) throw new Error(`会话不存在：${sessionId}`);
      // 与 DSH 本体 /permission 命令同路径：presets.apply(session, name, policyWriter)。
      // 有 live agent 时走 ctx.approval.setPolicy（会话事件 + agent 通知注入）；
      // 无 live agent（如 headless 兜底）则退化为 presets.set()（纯会话级折叠写入，下次回合生效）。
      const agents = ctx.get('agents');
      const agent = agents?.get?.(sessionId);
      const approval = ctx.get('approval');
      if (agent && approval && typeof approval.setPolicy === 'function') {
        presets.apply(session, preset, (policy) => approval.setPolicy(agent, policy));
      } else if (typeof presets.set === 'function') {
        presets.set(session, preset);
      } else {
        throw new Error('权限预设服务不支持无 agent 切换（set 不可用）');
      }
      return { ok: true, preset, sessionId };
    },
    // 彻底清理一个会话：从工作区 detach + 删除持久化目录（用于清除测试/遗留会话）
    //  安全修复：①id 校验（防目录穿越）②禁止删除主会话 ③扫描 sessions 根下全部
    // 子目录（此前硬编码 --C-DSH-ARCHIVE--，项目外工作区会话删不掉、路径硬编码失效）
    //  附加：UI 的 session.create（api-gateway 通道）创建后不 attach 工作区 → 由本 op 补 attach
    'workspace.attach': async (a) => {
      const workspaceId = String(a?.workspaceId ?? '').trim();
      const sessionId = String(a?.sessionId ?? '').trim();
      if (!workspaceId || !sessionId) throw new Error('workspaceId 与 sessionId 必填');
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(sessionId)) throw new Error('非法的 sessionId');
      const registry = ctx.get('workspaceRegistry');
      const ws = registry?.get?.(workspaceId);
      if (!ws || typeof ws.attachSession !== 'function') throw new Error('workspace 服务不可用');
      await ws.attachSession(sessionId);
      return { attached: true, sessionId, workspaceId };
    },
    //  工作区目录选择（类似 DSH 原生）——调用宿主 directoryPicker 的
    // native 能力（Windows 上弹出系统文件夹选择对话框 IFileOpenDialog；选目录或取消）。
    //  修复：native pick 契约签名 pick(signal: AbortSignal)，必传 signal，
    // 否则 pick 内部 signal.aborted 直接 TypeError（对话框无法弹出）。signal 来自
    // connection handle 的 request.signal（真实 AbortSignal）；缺省时用新 controller 兜底。
    'directory.pick': async (_args, signal) => {
      const dp = ctx.get('directoryPicker');
      const cap = dp?.capability?.();
      if (!cap) throw new Error('目录选择服务不可用（directoryPicker 未启用）');
      if (cap.kind === 'native' && typeof cap.pick === 'function') {
        const picked = await cap.pick(signal ?? new AbortController().signal);
        return { path: picked ?? null };
      }
      throw new Error(`不支持的目录选择能力：${cap.kind ?? 'unknown'}`);
    },
    //  手机端修复：browse 能力（Linux/远程/手机无系统对话框时）——
    // 前端自绘目录浏览弹窗：capability 探测 + 单层列目录 + 建目录。
    'directory.capability': async () => {
      const dp = ctx.get('directoryPicker');
      return { kind: dp?.capability?.()?.kind ?? 'unavailable' };
    },
    'directory.browse': async (a, signal) => {
      const dp = ctx.get('directoryPicker');
      const cap = dp?.capability?.();
      if (cap?.kind !== 'browse' || typeof cap.list !== 'function') {
        throw new Error(`目录浏览仅在 browse 能力下可用（当前：${cap?.kind ?? 'unavailable'}）`);
      }
      const path = typeof a?.path === 'string' && a.path.trim() ? a.path : undefined;
      const res = await cap.list(path, signal);
      return {
        path: res?.path ?? null,
        home: res?.home ?? null,
        crumbs: Array.isArray(res?.crumbs) ? res.crumbs.map((c) => ({ name: String(c?.name ?? ''), path: String(c?.path ?? '') })) : [],
        entries: (res?.entries ?? []).map((en) => ({ name: String(en?.name ?? ''), path: String(en?.path ?? ''), hidden: !!en?.hidden })),
        truncated: !!res?.truncated,
      };
    },
    'directory.browseCreate': async (a) => {
      const dp = ctx.get('directoryPicker');
      const cap = dp?.capability?.();
      if (cap?.kind !== 'browse' || typeof cap.createDirectory !== 'function') {
        throw new Error('目录创建仅在 browse 能力下可用');
      }
      const parent = String(a?.path ?? '').trim();
      const name = String(a?.name ?? '').trim();
      if (!parent) throw new Error('browseCreate: 缺少父路径');
      if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new Error('browseCreate: 目录名不合法');
      const created = await cap.createDirectory(parent, name);
      return { path: created };
    },
    'system.purgeSession': async (a) => {
      const id = String(a?.id ?? '').trim();
      if (!id) throw new Error('purgeSession: id 必填');
      if (id === MAIN_SESSION_ID) throw new Error('不能删除主会话');
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('purgeSession: 非法的会话 id');
      let detached = false;
      //：尽量注销该会话的 agent（dsh 原生不随会话删除自动清理；空闲 agent 无副作用，能清则清）
      try {
        const agents = ctx.get('agents');
        const ag = agents?.get?.(id);
        if (ag && typeof ag.dispose === 'function') await ag.dispose();
        else if (ag && typeof ag.cancel === 'function') { try { await ag.cancel({ kind: 'disposed' }); } catch { /* ignore */ } }
      } catch { /* ignore */ }
      try {
        const registry = ctx.get('workspaceRegistry');
        if (registry) {
          const workspaces = await registry.list();
          for (const w of workspaces) {
            try { await w.detachSession(id); detached = true; } catch { /* 容错 */ }
          }
        }
      } catch { /* ignore */ }
      let purged = false;
      try {
        const sessionsRoot = join(DATA_ROOT, 'sessions');
        const { readdirSync } = await import('node:fs');
        for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          try {
            rmSync(join(sessionsRoot, entry.name, id), { recursive: true, force: true });
            purged = true;
          } catch { /* 容错 */ }
        }
      } catch { /* ignore */ }
      return { detached, purged };
    },
    // 一键备份：checkpoint 各 SQLite → 全量复制 dsh/data → backups/backup-<时间戳>/
    // kind 区分：manual（手动按钮）/ auto（每 3 天自动，保留最近 10 份）
    'system.backup': async (a) => {
      //  修复：并发双触发（双击/并行调用）曾同秒写同一备份目录（内容竞争）或生成重复目录。
      // ① in-flight 守卫（重叠时拒绝）；② 3s 时间窗去重（RPC 串行化时 in-flight 已复位，靠时间窗兜底）。
      const now0 = Date.now();
      if (backupInFlight || now0 - lastBackupAt < 3000) throw new Error('备份进行中，请稍候再试');
      backupInFlight = true;
      lastBackupAt = now0;
      try {
        try { ctx.memory?.checkpoint?.(); } catch { /* ignore */ }
        try { ctx.schedule?.checkpoint?.(); } catch { /* ignore */ }
        const kind = a?.kind === 'auto' ? 'auto' : 'manual';
        const { cpSync, mkdirSync, writeFileSync, statSync, readdirSync } = await import('node:fs');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dest = join(BACKUP_ROOT, `backup-${stamp}`);
        mkdirSync(dest, { recursive: true });
        cpSync(DATA_ROOT, dest, { recursive: true });
        const walk = (dir) => {
          let files = 0; let bytes = 0;
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) { const sub = walk(p); files += sub.files; bytes += sub.bytes; }
            else { files++; bytes += statSync(p).size; }
          }
          return { files, bytes };
        };
        const { files, bytes } = walk(dest);
        const meta = { at: Date.now(), stamp, kind, redacted: true, source: DATA_ROOT, files, bytes, note: '全量数据备份（会话/工作区/设置/附件/记忆/任务/人格/通知/进化/技能；凭据已脱敏）' };
        //  备份脱敏：不备份明文凭据——删除 credentials.yaml，settings.yaml 的 apiKey 置为占位
        try { rmSync(join(dest, 'credentials.yaml'), { force: true }); } catch { /* ignore */ }
        try {
          const settingsFile = join(dest, 'settings.yaml');
          if (existsSync(settingsFile)) {
            const raw = readFileSync(settingsFile, 'utf8');
            const redacted = raw.replace(/(^|\n)(\s*apiKey:\s*)\S+/g, '$1$2[REDACTED]');
            writeFileSync(settingsFile, redacted, 'utf8');
          }
        } catch { /* ignore */ }
        try {
          writeFileSync(join(dest, 'backup-notes.txt'), '本备份为脱敏备份：\n- 不含 credentials.yaml（API 密钥未备份）\n- settings.yaml 中的 apiKey 已置为 [REDACTED]\n恢复后请在「模型」页与「识图-提供商配置」重新填写密钥。\n恢复为整体还原（覆盖当前数据），需重启生效。\n', 'utf8');
        } catch { /* ignore */ }
        writeFileSync(join(dest, 'backup.json'), JSON.stringify(meta, null, 2), 'utf8');
        bootLine(`[archive-control] 备份完成(${kind}): ${dest}（${files} 文件，${(bytes / 1024 / 1024).toFixed(2)} MB）`);
        // 自动备份保留最近 10 份（手动备份永不自动删除）
        if (kind === 'auto') {
          try {
            const all = readdirSync(BACKUP_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
            const autos = [];
            for (const name of all) {
              try {
                const m = JSON.parse(readFileSync(join(BACKUP_ROOT, name, 'backup.json'), 'utf8'));
                if (m.kind === 'auto') autos.push(name);
              } catch { /* 无 backup.json 视为手动 */ }
            }
            for (const name of autos.slice(10)) rmSync(join(BACKUP_ROOT, name), { recursive: true, force: true });
          } catch { /* 清理失败不阻断 */ }
        }
        return { path: dest, ...meta };
      } finally {
        backupInFlight = false;
      }
    },
    'backup.list': async () => {
      const { existsSync, readdirSync, statSync } = await import('node:fs');
      if (!existsSync(BACKUP_ROOT)) return { backups: [] };
      //  性能修复（阶段1）：system.backup 完成时已把 {files,bytes} 写入该备份的 backup.json
      // （见 system.backup 的 walk 统计），此处直接采用记录值，避免每次打开总控页都全量递归遍历
      // 备份目录（同步 readdirSync/statSync 在手机慢 I/O 下可致数秒事件循环阻塞，波及并行 RPC）。
      // dirBytes 仅兜底用于无 backup.json 的旧备份。
      const dirBytes = (dir) => {
        let n = 0;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) n += dirBytes(p);
          else { try { n += statSync(p).size; } catch { /* ignore */ } }
        }
        return n;
      };
      const backups = readdirSync(BACKUP_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const p = join(BACKUP_ROOT, d.name);
          let bytes = 0; let kind = 'manual';
          let recorded = false;
          try {
            const m = JSON.parse(readFileSync(join(p, 'backup.json'), 'utf8'));
            if (m.kind === 'auto') kind = 'auto';
            if (Number.isFinite(m.bytes)) { bytes = m.bytes; recorded = true; }
          } catch { /* 无 backup.json（旧备份）视为手动 */ }
          if (!recorded) { try { bytes = dirBytes(p); } catch { /* ignore */ } }
          const m = String(d.name).match(/^backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
          const at = m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`) : 0;
          return { name: d.name, at: Number.isFinite(at) ? at : 0, bytes, kind };
        })
        .sort((a, b) => b.at - a.at);
      return { backups, root: BACKUP_ROOT };
    },
    // 整体恢复：把项目恢复到备份记录的状态（覆盖当前数据，需重启生效）。
    // 流程：先自动备份当前状态（可回退）→ 备份内容暂存 data/.restore-pending + 写 marker →
    // 点击「关闭」按钮时，进程退出前完成覆盖（当前凭据 credentials.yaml 保留）。
    'system.restore': async (a) => {
      const dir = String(a?.backupDir ?? '').trim();
      if (!dir || !/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(dir)) throw new Error('非法的备份目录名');
      const src = join(BACKUP_ROOT, dir);
      if (!existsSync(src)) throw new Error(`备份不存在：${dir}`);
      const { cpSync } = await import('node:fs');
      const dataRoot = DATA_ROOT;
      const pending = join(dataRoot, '.restore-pending');
      const marker = join(dataRoot, '.restore-marker');
      // 先自动备份当前状态（防误操作，可回退）
      const cur = await OPS['system.backup']({ kind: 'manual' });
      rmSync(pending, { recursive: true, force: true });
      cpSync(src, pending, { recursive: true });
      // 暂存区自身/凭据不参与恢复（凭据保留当前）
      for (const skip of ['.restore-pending', '.restore-marker', 'credentials.yaml']) rmSync(join(pending, skip), { recursive: true, force: true });
      writeFileSync(marker, JSON.stringify({ from: dir, at: Date.now(), preBackup: cur.path }), 'utf8');
      bootLine(`[archive-control] 恢复已暂存：${dir}（重启后生效；当前状态已备份至 ${cur.path}）`);
      return { pending: true, from: dir, preBackup: cur.path, note: '恢复已暂存：请点击右上角「关闭」按钮重启，进程退出前会自动把项目整体恢复到该备份状态（当前凭据保留；备份为脱敏版，模型密钥需重新填写）' };
    },
    // 每日简报：汇总最近 24h 记忆/决策/发言/通知/任务 → LLM 生成带时间戳简报
    'report.daily': async () => {
      const since = Date.now() - 24 * 3600000;
      //：仅统计活跃记忆（排除已整合软遗忘/归档），简报不再包含重复决策
      const mems = (ctx.memory.list({ limit: 200 }) || []).filter((m) => m.createdAt >= since && m.forgotten === 0);
      const notifs = (ctx.notify.view(100)?.notifications || []).filter((n) => n.at >= since);
      const tasks = (ctx.schedule.list(100) || []).filter((t) => (t.firedAt ?? 0) >= since || (t.createdAt ?? 0) >= since);
      const byKind = {};
      for (const m of mems) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      const decisions = mems.filter((m) => m.kind === 'thought' && m.source === 'loop').map((m) => m.content);
      const speaks = mems.filter((m) => m.source === 'loop-speak').map((m) => m.content);
      const material = [
        `记忆统计（24h）：${JSON.stringify(byKind)}；通知 ${notifs.length} 条；任务 ${tasks.length} 个。`,
        decisions.length > 0 ? `自循环决策（最近 ${Math.min(decisions.length, 12)} 条）：\n${decisions.slice(-12).join('\n---\n').slice(0, 4000)}` : '（无自循环决策）',
        speaks.length > 0 ? `主动发言（最近 ${Math.min(speaks.length, 8)} 条）：\n${speaks.slice(-8).join('\n')}` : '（无主动发言）',
      ].join('\n\n');
      const llm = ctx.get('llm');
      if (!llm || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用，无法生成简报');
      // 自定义 OpenAI 兼容 provider 优先，失败回退官方
      let brief = '';
      const custom = (() => {
        try {
          const settings = ctx.get('settings');
          const value = settings?.get?.(ARCHIVE_MODELS_NS);
          const list = Array.isArray(value?.providers) ? value.providers : [];
          return list.find((p) => p.enabled !== false && p.baseURL && p.apiKey && p.model) || null;
        } catch { return null; }
      })();
      if (custom) {
        //  韧性补丁：自定义 provider 请求加 60s 超时（此前无 signal，端点挂起会让简报 RPC 永久卡住）
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort(), 60000);
        try {
          const url = `${String(custom.baseURL).replace(/\/+$/, '')}/chat/completions`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${custom.apiKey}` },
            body: JSON.stringify({ model: custom.model, messages: [{ role: 'system', content: REPORT_PROMPT }, { role: 'user', content: material }], max_tokens: 900 }),
            signal: ctrl2.signal,
          });
          const j = await res.json();
          if (!res.ok || j.error) throw new Error(j.error?.message ? `API: ${j.error.message}` : `HTTP ${res.status}`);
          brief = String(j.choices?.[0]?.message?.content ?? '').trim();
        } catch (error) {
          logger.warn(`archive-control: 简报自定义提供商失败，回退官方：${error.message}`);
          brief = '';
        } finally { clearTimeout(timer2); }
      }
      if (!brief) {
        //  修复：官方流偶发空返回/网络抖动时重试一次（同 loop callLlm  模式），
        // 此前直接抛"简报生成失败：LLM 未返回内容"（实测偶发复现，重试即成功）
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          brief = '';
          try {
            const stream = llm.stream({
              provider: 'deepseek-official',
              model: 'deepseek-v4-flash',
              system: REPORT_PROMPT,
              messages: [{ role: 'user', content: [{ type: 'text', text: material }] }],
              //：900 → 2000——推理模型（deepseek-v4-flash）reasoning 占满小预算致正文截断
              maxTokens: 2000,
            });
            for await (const chunk of stream) {
              if (chunk.type === 'text-delta') brief += chunk.text;
              if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(`${chunk.reason.failure?.code ?? 'LLM'}: ${chunk.reason.failure?.message ?? '调用失败'}`);
            }
            if (brief.trim() !== '') break;
            lastErr = new Error('简报生成失败：LLM 未返回内容');
          } catch (error) {
            lastErr = error;
            if (String(error?.code ?? error?.message ?? '').includes('ABORTED')) throw error;
          }
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
        }
        if (!brief.trim()) throw lastErr ?? new Error('简报生成失败：LLM 未返回内容');
      }
      if (!brief.trim()) throw new Error('简报生成失败：LLM 未返回内容');
      return { generatedAt: Date.now(), windowStart: since, brief, counts: { memories: mems.length, notifications: notifs.length, tasks: tasks.length, decisions: decisions.length } };
    },
    // 记忆整合：把最近窗口的自循环 thought 凝练为一条语义记忆（手动触发；自动每日一次）
    'memory.integrate': (a) => ctx.memory.integrate({ windowMs: a?.windowMs }),
    // 从备份导入记忆（合并，id 去重； 一键导入）
    'memory.import': async (a) => {
      const dir = String(a?.backupDir ?? '').trim();
      if (!dir) throw new Error('backupDir 必填');
      if (!/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(dir)) throw new Error('非法的备份目录名');
      const db = join(BACKUP_ROOT, dir, 'memory.db');
      if (!existsSync(db)) throw new Error(`备份中没有 memory.db：${dir}`);
      return ctx.memory.importBackup(db);
    },
    // 记忆批量删除（记忆页多选）
    'memory.batchForget': (a) => {
      const ids = Array.isArray(a?.ids) ? a.ids.filter((x) => typeof x === 'string' && x.length > 0) : [];
      if (ids.length === 0) throw new Error('ids 必填');
      let removed = 0;
      for (const id of ids.slice(0, 200)) {
        try { if (ctx.memory.forget(id).removed) removed++; } catch { /* 单条失败不阻断 */ }
      }
      return { removed, requested: ids.length };
    },
    // 通知清空已读
    'notify.clearRead': () => ctx.notify.clearRead(),
    // token 用量（会话级经 RPC 面 session.list 投影获取精确值；循环/进化按调用次数）
    'system.tokenUsage': async () => {
      const session = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      try {
        const port = 3081;
        //  self-RPC 加超时（api-gateway 挂起/端口改动时不再整页卡死在
        // Promise.all 里"总控加载中…"）； 阶段1：8s→3s——总控页已改为 overview
        // 先行渲染、本 op 后台补更，短超时即可兜底，不再让慢自调拖住页面。
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        let res;
        try {
          res = await fetch(`http://127.0.0.1:${port}/api/session.list`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: `tok-${Date.now()}`, method: 'session.list', payload: {} }),
            signal: ctrl.signal,
          });
        } finally { clearTimeout(timer); }
        const j = await res.json().catch(() => null);
        const items = Array.isArray(j?.result?.value?.items) ? j.result.value.items : [];
        for (const it of items) {
          const tu = it?.projections?.values?.tokenUsage;
          if (tu) for (const k of Object.keys(session)) session[k] += Number(tu[k] ?? 0) || 0;
        }
      } catch { /* self-RPC 失败则显示 0（不阻断） */ }
      const loopStats = (() => { try { return ctx.loop.stats(); } catch { return null; } })();
      const evoStats = (() => { try { return ctx.evolution.stats(); } catch { return null; } })();
      return {
        session,
        loop: loopStats ? { cycleCount: loopStats.cycleCount, errorCount: loopStats.errorCount, model: loopStats.config?.model ?? '' } : null,
        evolution: evoStats ? { totalCandidates: evoStats.totalCandidates ?? 0 } : null,
        note: '会话为精确 token（经 session 投影）；循环/进化按调用次数展示（未接入流式计费）',
      };
    },
    // 系统监控：实时运行信息 + 历史采样（metrics.jsonl）
    'system.metrics': () => {
      const mem = process.memoryUsage?.() ?? {};
      const now = Date.now();
      let history = [];
      try {
        if (existsSync(METRICS_PATH)) {
          history = readFileSync(METRICS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-60);
        }
      } catch { /* ignore */ }
      return {
        uptime: Math.round(process.uptime?.() ?? 0),
        rss: mem.rss ?? 0, heapUsed: mem.heapUsed ?? 0,
        loop: (() => { try { return { cycleCount: ctx.loop.stats().cycleCount, errorCount: ctx.loop.stats().errorCount }; } catch { return null; } })(),
        memory: (() => { try { return ctx.memory.forgetStats(); } catch { return null; } })(),
        sampledAt: now, history,
      };
    },
    // 开机自启开关：启动文件夹 vbs 方式（schtasks 在本环境被系统拒绝）
    'system.autostart': (a) => {
      if (a?.enabled === true) {
        //  start.ps1 路径由数据根推导（此前硬编码 C:/DSH-ARCHIVE，分发/移动后自启失效）；
        //：PROJECT_ROOT 已是项目根（dataRoot 上级的上级），start.ps1 直接在项目根下
        const startScript = join(PROJECT_ROOT, 'start.ps1');
        const content = `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""${startScript}"" -NoOpen", 0, False\r\n`;
        //  （major）：'ascii' 编码会把中文路径按 latin1 截断成乱码（默认部署路径
        // 含"总文件夹"）→ VBS 路径损坏、开机自启静默失效。改 UTF-8 带 BOM（WSH 可正确解码）
        writeFileSync(AUTOSTART_VBS, `\uFEFF${content}`, 'utf8');
        return { enabled: true, path: AUTOSTART_VBS };
      }
      if (a?.enabled === false) {
        if (existsSync(AUTOSTART_VBS)) rmSync(AUTOSTART_VBS, { force: true });
        return { enabled: false, path: AUTOSTART_VBS };
      }
      return { enabled: existsSync(AUTOSTART_VBS), path: AUTOSTART_VBS };
    },
    // 勿扰模式：开启后仅不响提示音，通知/桌面弹窗等其余不变；settings 持久化
    'system.dnd': async (a) => {
      const settings = ctx.get('settings');
      if (a?.enabled === true || a?.enabled === false) {
        const enabled = a.enabled === true;
        if (settings && typeof settings.update === 'function') await settings.update(DND_NS, { enabled });
        return { enabled };
      }
      const value = settings?.get?.(DND_NS) ?? {};
      return { enabled: value.enabled === true };
    },
    // 聊天 UI 设置：流式输出开关——开=SSE 实时增量渲染（思考/回答逐字出现）；
    // 关=仅轮询刷新（消息按 3s 间隔出现）。settings 持久化，浏览器端读写。
    'ui.settings.get': () => {
      const settings = ctx.get('settings');
      const value = settings?.get?.(UI_NS) ?? {};
      return { streaming: value.streaming !== false };
    },
    'ui.settings.set': async (a) => {
      const settings = ctx.get('settings');
      if (!settings || typeof settings.update !== 'function') throw new Error('settings 服务不可用');
      const streaming = a?.streaming !== false;
      await settings.update(UI_NS, { streaming });
      return { streaming };
    },
    // ---- 一键更新（方案 D）----
    // 检查远程是否有新版本：git fetch（静默，失败=离线）→ 对比 HEAD 与 origin/main；
    // behind>0 = 可更新；ahead>0 = 本地领先（开发者本机忘了推送，提示先推送）。
    //  性能优化：git fetch/ls-remote 是网络操作（实测 4.7s，差网可超时 45s+30s），
    // 总控页每次打开都会触发 → 结果内存缓存 60s；手动「检查更新」按钮传 {force:true} 绕过缓存实时复查。
    'updater.check': async (a) => {
      const now = Date.now();
      if (updaterCheckCache && now - updaterCheckCache.t < 60000 && !(a && a.force)) return updaterCheckCache.v;
      const run = async () => {
        const t0 = Date.now();
        const currentVersion = readVersion();
        const head = await runGit(['rev-parse', 'HEAD']);
        if (!head.ok) { const v = { ok: true, offline: true, note: 'git 不可用（请先安装 git 后重试）', currentVersion }; updaterCheckCache = { t: t0, v }; return v; }
        const fetch = await runGit(['fetch', 'origin'], 45000);
        if (!fetch.ok) {
          //：失败原因落到 note（此前一律"网络或凭据不可用"，挂着代理软件时无从判断——
          // git 不读系统代理；此处展示实际代理状态与 git 错误摘要，便于对症处理）
          const v = {
            ok: true, offline: true,
            note: `网络或凭据不可用（${fetch.proxy || 'git 直连'}${fetch.err ? '；' + fetch.err : ''}）。私有仓库需配置 GitHub Token，见《手机版说明.md》更新章节；或按《一键更新方案.md》配置 git 代理`,
            currentVersion, currentCommit: head.out,
          };
          updaterCheckCache = { t: t0, v };
          return v;
        }
        const remote = await runGit(['rev-parse', 'origin/main']);
        const remoteHead = remote.ok ? remote.out : '';
        const behindRaw = remoteHead ? await runGit(['rev-list', '--count', 'HEAD..origin/main']) : null;
        const aheadRaw = remoteHead ? await runGit(['rev-list', '--count', 'origin/main..HEAD']) : null;
        const behind = Number(behindRaw?.ok ? behindRaw.out : 0) || 0;
        const ahead = Number(aheadRaw?.ok ? aheadRaw.out : 0) || 0;
        const tags = await runGit(['ls-remote', '--tags', 'origin', 'refs/tags/v*']);
        let remoteVersion = '';
        if (tags.ok && tags.out) {
          // 注解 tag 会附带 refs/tags/vX^{} 行，过滤掉
          const vs = tags.out.split('\n').map((l) => l.replace(/^[0-9a-f]+\s+refs\/tags\//, '').trim()).filter((v) => v && !v.includes('^{}'));
          vs.sort().reverse();
          remoteVersion = vs[0] ?? '';
        }
        const v = {
          ok: true, offline: false,
          currentVersion, currentCommit: head.out,
          remoteCommit: remoteHead, remoteVersion,
          hasUpdate: behind > 0, ahead, behind,
        };
        updaterCheckCache = { t: t0, v };
        return v;
      };
      // 手动「检查更新」按钮（force）：绕过缓存与进行中请求，实时复查
      if (a && a.force) return run();
      // 并发复用：startupUpdateCheck（启动 30s 后自动检查）与总控页打开可能同时触发，只跑一次 git 网络
      if (updaterCheckInflight) return updaterCheckInflight;
      updaterCheckInflight = run().finally(() => { updaterCheckInflight = null; });
      return updaterCheckInflight;
    },
    // 触发更新：spawn 独立进程执行 update.ps1（Windows）/ update.sh（Linux）。
    // 更新会停止服务（stop 杀 3081 进程树，含当前 dsh）→ git 更新 → 重启——页面将短暂断开。
    // 失败一律 throw → dispatch 统一转 {ok:false,error:{code,message,details}} 标准信封。
    'updater.apply': async () => {
      const isWin = process.platform === 'win32';
      const script = isWin ? join(PROJECT_ROOT, 'update.ps1') : join(PROJECT_ROOT, 'update.sh');
      if (!existsSync(script)) throw new Error(`未找到更新脚本：${script}`);
      try {
        const args = isWin
          ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
          : [script];
        const child = spawn(isWin ? 'powershell' : 'bash', args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return { started: true };
      } catch (error) {
        throw new Error(String(error?.message ?? error));
      }
    },
  };

  // 注册项目模型提供商配置命名空间（settings 持久化；识图用 describe-image 已注册的命名空间）
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.register(ARCHIVE_MODELS_NS, ArchiveModelsSchema, { base: { providers: [] } });
      settingsCtx.settings.register(DND_NS, DND_SCHEMA, { base: { enabled: false } });
      //  archive-loop 命名空间改由 loop 模块自身注册（启动时读取才生效，
      // 此前在此注册晚于 loop 启动读 settings → 降频开关重启后丢失）
      settingsCtx.settings.register(UI_NS, UI_SCHEMA, { base: { streaming: true } });
      settingsCtx.settings.register(UPDATER_NS, UPDATER_SCHEMA, { base: { lastNotifiedCommit: '' } });
      bootLine('[archive-control] settings ns=archive-models ready');
      //  报告目录选择能力（directoryPicker native/browse/unavailable），供 UI 工作区浏览按钮诊断
      try {
        const dpCap = ctx.get('directoryPicker')?.capability?.();
        bootLine(`[archive-control] 目录选择能力: ${dpCap?.kind ?? 'unavailable'}`);
      } catch { /* 能力探测失败不阻断 */ }
    } catch (error) {
      bootLine(`[archive-control] settings 注册失败: ${error.message}`);
    }
  });

  // RPC 桥：经 connection 的专属通道 '/archive-control' 注册（ 修复）。
  // 说明：intercept('/api') 的共享通道已被 dsh-api-gateway 等占用（单一注册制，
  // 后注册者抛 "already has an interceptor" 被静默吞掉 → 浏览器端 /api/archive-control 404）。
  // 改用 connection.rpc.handle 挂独立前缀路由（浏览器 URL=/archive-control/<endpoint>），
  // handler 签名 (endpoint, payload, signal) 与 intercept 一致。
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      connectionCtx.connection.rpc.handle('/archive-control',
        async (endpoint, payload, signal) => {
          const { op, args = {} } = payload?.args ?? {};
          const fn = OPS[op];
          if (!fn) return { ok: false, error: { code: 'internal', message: `unknown op: ${op}`, details: {} } };
          try {
            //  修复：connection 传入的 request.signal 透传给 op（directory.pick 的 native
            // pick 契约签名 pick(signal) 必收 AbortSignal，否则内部 signal.aborted 直接 TypeError，
            // 目录选择对话框无法弹出）。
            return { ok: true, value: await fn(args, signal) };
          } catch (error) {
            //  非 Error 异常（字符串/undefined）也能序列化传递，避免 toast 显示 undefined。
            //  修复：错误信封必须是对象 {code,message,details}——浏览器端 serverResponseSchema
            // 对 result 做 union 校验（error 为字符串时校验失败，toast 显示 zod JSON 而非真实错误）。
            //  RPC 操作级报错统一转发 ledger（总控底部「报错」面板不漏用户操作错误）
            try { ctx.get('archiveLedger')?.recordError?.({ source: 'rpc', module: 'control', level: 'error', message: String(error?.message ?? error), stack: error?.stack }); } catch { /* 转发失败不影响原错误返回 */ }
            return { ok: false, error: { code: 'internal', message: String(error?.message ?? error), details: {} } };
          }
        },
        { authority: 'trusted-host' });
      bootLine(`[archive-control] ready RPC=archive-control`);
    } catch (error) {
      // 注册失败必须显眼（logger.warn 可能被级别过滤看不到 → 曾致浏览器端 404 静默数月）
      bootLine(`[archive-control] RPC 注册失败: ${error.message}`);
      logger.warn(`archive-control: RPC 注册失败：${error.message}`);
    }
  });
  // 系统监控采样（每 5 分钟，cap 240 条）+ 自动备份（每 3 天，6h 检查一次）
  const recordMetrics = () => {
    try {
      const entry = {
        t: Date.now(), rss: process.memoryUsage?.().rss ?? 0, heap: process.memoryUsage?.().heapUsed ?? 0,
        uptime: Math.round(process.uptime?.() ?? 0),
        cycle: (() => { try { return ctx.loop.stats().cycleCount; } catch { return 0; } })(),
        errors: (() => { try { return ctx.loop.stats().errorCount; } catch { return 0; } })(),
      };
      appendFileSync(METRICS_PATH, JSON.stringify(entry) + '\n', 'utf8');
      const raw = readFileSync(METRICS_PATH, 'utf8').split('\n').filter(Boolean);
      if (raw.length > 240) writeFileSync(METRICS_PATH, raw.slice(-240).join('\n') + '\n', 'utf8');
    } catch { /* 采样失败不阻断 */ }
  };
  const autoBackupCheck = async () => {
    try {
      const list = (await OPS['backup.list']()).backups ?? [];
      const lastAuto = list.find((b) => b.kind === 'auto');
      if (!lastAuto || Date.now() - lastAuto.at >= 3 * 86400000) {
        const r = await OPS['system.backup']({ kind: 'auto' });
        logger.info(`archive-control: 自动备份完成：${r.path}`);
      }
    } catch (error) { logger.warn(`archive-control: 自动备份失败：${error.message}`); }
  };
  recordMetrics();
  ctx.timer.setInterval(recordMetrics, 5 * 60000);
  ctx.timer.setInterval(() => { void autoBackupCheck(); }, 6 * 3600000);
  void autoBackupCheck();

  // 方案 D：启动 30s 后静默检查一次更新，发现新版经 notify 主动通知（同一远程版本只提醒一次）
  const startupUpdateCheck = async () => {
    try {
      const r = await OPS['updater.check']();
      if (!r.ok || r.offline || !r.hasUpdate || !r.remoteCommit) return;
      const settings = ctx.get('settings');
      const last = (settings?.get?.(UPDATER_NS) ?? {}).lastNotifiedCommit ?? '';
      if (last === r.remoteCommit) return;   // 已提醒过该版本
      if (typeof ctx.notify?.send === 'function') {
        const ver = r.remoteVersion ? ` v${r.remoteVersion}` : `（${r.remoteCommit.slice(0, 7)}）`;
        ctx.notify.send({
          content: `发现新版本${ver}，当前 ${r.currentVersion || '?'}。可到总控页「🔄 检查更新」一键更新。`,
          source: 'updater',
          scope: 'panel',
        });
      }
      if (settings && typeof settings.update === 'function') {
        await settings.update(UPDATER_NS, { lastNotifiedCommit: r.remoteCommit }).catch(() => {});
      }
    } catch { /* 静默检查失败不打扰 */ }
  };
  ctx.timer.setTimeout(startupUpdateCheck, 30000);

  return { ops: Object.keys(OPS) };
}

function bootLine(line) {
  try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
}
