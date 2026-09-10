/**
 * dsh-archive-ledger —— 提示词 / 报错全量记录（Host 半部，总控底部面板数据源）。
 *
 * 目标：无论哪个模块（自研 modules/*、主会话 agent、describe-image 识图、本地 ollama）以何种
 * 方式调用 LLM，或在哪里产生报错，都"不可能有遗漏"地落入本账本，供总控底部面板查看/复制。
 *
 * 采集路径（五路）：
 *  1) ctx.root.logger 工厂包裹：各模块统一 `logger=ctx.root?.logger?.('archive-X')`，其
 *     warn/error 全部自动入账（模块失败的主要出口，一处拦截即全模块覆盖）。
 *  2) console.warn/console.error 包裹：个别直用 console 的模块/三方库兜底（按 archive- 前缀启发归源）。
 *  3) globalThis.fetch 包裹：匹配 POST 以 /chat/completions、/api/chat、/api/generate 结尾的请求（自定义
 *     OpenAI 兼容 provider、describe-image、subconscious 本地 phi 等直连路径）。core 栈的内部
 *     fetch 跳过（避免与路径 4 重复）。
 *  4) ctx.llm.stream/complete 包裹：官方 DeepSeek 路由（各模块官方回退 + 主会话 agent 聊天），
 *     按调用方栈归源模块。
 *  5) 进程级 uncaughtException / unhandledRejection：运行期现无监听（boot 期 fail-loud 装完即卸），
 *     本模块补监听；若本模块是唯一监听者则记录后退出（保持"崩溃"语义不改变），否则只记录。
 *
 * 归源：提示词/报错的"来源模块"一律通过调用栈中命中的自研模块文件（modules/loop、node_modules/
 * dsh-archive-loop 等同源）推断，任何模块都无需为此改业务代码。
 *
 * 存储：内存环形缓冲（promptCap/errorCap，各默认 400，最新在后）+ 批量落盘
 * data/ledger/prompts.jsonl、errors.jsonl（flushMs 合并写，防失败风暴同步 IO），
 * 启动时按 fileLineCap 裁剪。RPC：/archive-ledger（prompts.list/errors.list/stats/clear/errors.push）。
 * 服务：ctx.archiveLedger.recordPrompt/recordError（供 control RPC dispatch catch 等转发）、
 * listPrompts/listErrors（旧·返回数组）、listPromptsPage/listErrorsPage（新·增量，返回 {items,next,oldest}）。
 *
 * 增量（ 性能修复）：每条记录带进程内单调递增 seq；prompts.list/errors.list 接受 since，
 * 只回传 seq > since 的记录。原实现每次全量回传尾部 100 条（实测 599KB），面板 2.5s 一轮导致
 * 浏览器主线程持续阻塞。
 *
 * 配置（cordis.patch.yml 行 config，绝对路径分发时随文档改）：
 *  - dataPath:     账本目录（默认 <cwd>/data/ledger）
 *  - promptCap/errorCap: 内存条数上限
 *  - fileLineCap/fileTrimTo: 启动裁剪阈值（行）
 *  - flushMs:      批量落盘间隔
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 防重入标记（Symbol 避免污染框架对象命名空间）。 */
const W_FACTORY = Symbol('archiveLedger.wrapped.factory');
const W_INST = Symbol('archiveLedger.wrapped.inst');

export const name = 'dsh-archive-ledger';

const DEFAULTS = {
  dataPath: join(process.cwd(), 'data', 'ledger'),
  promptCap: 400,
  errorCap: 400,
  fileLineCap: 15000,
  fileTrimTo: 8000,
  flushMs: 1500,
};

/** 归一化配置：未知字段忽略，类型错误直接抛出（配置即契约，与其它模块一致）。 */
function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS };
  if (raw.dataPath !== undefined) {
    if (typeof raw.dataPath !== 'string' || raw.dataPath === '') throw new Error('archive-ledger 配置错误：dataPath 必须是非空字符串');
    cfg.dataPath = raw.dataPath;
  }
  for (const key of ['promptCap', 'errorCap', 'fileLineCap', 'fileTrimTo', 'flushMs']) {
    if (raw[key] !== undefined) {
      if (!Number.isFinite(raw[key]) || raw[key] <= 0) throw new Error(`archive-ledger 配置错误：${key} 必须是正数`);
      cfg[key] = Math.floor(raw[key]);
    }
  }
  return cfg;
}

function bootLine(line) {
  try { process.stdout.write(line + '\n'); } catch { /* 非 CLI 环境忽略 */ }
}

/* ---------- 归源辅助 ---------- */

/**
 * 账本分页（ 性能修复）。since 为上次返回的 next，即"客户端已完整持有到哪个 seq"。
 * 返回 { items, next, oldest }：
 *  - items  本次新增（至多 limit 条）；since 缺失/非法时退化为"尾部 limit 条"全量（首次加载与兜底路径）
 *  - next   下次应传的 since；无新增时原样返回 since
 *  - oldest 服务端当前仍保留的最早 seq（客户端据此判定环形挤出导致的断档 → 回退全量）
 * 设计取舍：任一记录缺 seq（理论上不会发生，内存环只装本进程写入的记录）时整体退化为全量，
 * 宁可多发一次也不静默丢记录——符合本模块"不可能有遗漏"的设计初衷。
 */
function pageRecords(arr, limit, since, level) {
  const cap = limit || 200;
  const view = level ? arr.filter((x) => x.level === level) : arr;
  if (view.some((x) => typeof x.seq !== 'number')) {
    const items = arr.filter((x) => !level || x.level === level).slice(-cap);
    return { items, next: null, oldest: null };
  }
  const oldest = view.length > 0 ? view[0].seq : 0;
  const last = view.length > 0 ? view[view.length - 1].seq : 0;
  if (!Number.isFinite(since)) return { items: view.slice(-cap), next: last, oldest };
  // 服务端重启（seq 归零）守卫：游标比服务端最新 seq 还大 → 判定为重启，回退全量并把游标重置为 last。
  // 缺此判断时 fresh 恒为空、next 原样回传 since，客户端既不等（next < since 不成立）也不追加，
  // 游标永久停在一个不可能被超越的值上 → 记录面板每次重启后静默停更（旧实现每轮全量拉取，天然自愈；
  // 改增量后必须显式处理）。重启后 next < since 亦满足客户端既有的"回退全量"分支，无需改客户端。
  if (since > last) return { items: view.slice(-cap), next: last, oldest };
  const fresh = view.filter((x) => x.seq > since);
  const items = fresh.slice(-cap);
  return { items, next: items.length > 0 ? items[items.length - 1].seq : since, oldest };
}

/** 文本截断（按码点，避免切断代理对/emoji）。 */
function trunc(s, n) {
  const t = String(s ?? '');
  const a = [...t];
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : t;
}

function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (!b) return '';
      if (b.type === 'text') return String(b.text ?? '');
      if (b.type === 'image') return `[图片 ${b.name || b.mediaType || ''}]`;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

/** messages/单 prompt → {system,user}（截断）。 */
function promptParts(messages, singlePrompt) {
  let system = '';
  let user = singlePrompt ? String(singlePrompt ?? '') : '';
  for (const m of Array.isArray(messages) ? messages : []) {
    const t = textOfContent(m?.content);
    if (!t) continue;
    if (m.role === 'system') system = system ? `${system}\n${t}` : t;
    else if (m.role === 'user') user = user ? `${user}\n${t}` : t;
    else if (!user) user = t;
  }
  return { system: trunc(system, 3000), user: trunc(user, 6000) };
}

/** 从调用栈推断发起模块：优先自研模块目录/包名，其次 describe-image；其余视为 core（不记录，走 llm 包裹）。 */
function stackSource(stack) {
  const lines = String(stack ?? '').split('\n');
  for (const line of lines) {
    if (/ledger[\\/]lib[\\/]/.test(line)) continue; // 本模块自身帧
    const m = line.match(/(?:[\\/]modules[\\/]|dsh-archive-)([a-z0-9-]+)[\\/]lib[\\/]/);
    if (m) return m[1];
    if (/linxin666[\\/]dsh-tool-describe-image/.test(line)) return 'describe-image';
  }
  return 'core';
}

/** 记录形状构建（统一时间/id/裁剪）。 */
let seqCounter = 0;
function recId() {
  seqCounter = (seqCounter + 1) % 100000;
  return `${Date.now().toString(36)}-${seqCounter}`;
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  try { mkdirSync(cfg.dataPath, { recursive: true }); } catch { /* 目录不可建不阻断 */ }
  const promptFile = join(cfg.dataPath, 'prompts.jsonl');
  const errorFile = join(cfg.dataPath, 'errors.jsonl');

  /** 启动裁剪：文件超过 fileLineCap 行时保留尾部 fileTrimTo 行。 */
  const trimFile = (file) => {
    try {
      if (!existsSync(file)) return;
      const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (raw.length > cfg.fileLineCap) writeFileSync(file, raw.slice(-cfg.fileTrimTo).join('\n') + '\n', 'utf8');
    } catch { /* 裁剪失败不阻断 */ }
  };
  trimFile(promptFile);
  trimFile(errorFile);

  const prompts = [];   // 内存环形（最新在后）
  const errors = [];
  //  增量游标：每条记录分配进程内单调递增的 seq，供总控记录面板"只拉新增"用。
  // 重启后 seq 从 1 重新计数——客户端靠 next 回退（next < since）自行判定并回退全量，无需额外握手。
  let promptSeq = 0;
  let errorSeq = 0;
  const queuedPrompt = []; // 待落盘行
  const queuedError = [];
  let flushTimer = null;
  let flushing = false;

  const flushFiles = () => {
    flushTimer = null;
    if (flushing) return;
    flushing = true;
    try {
      if (queuedPrompt.length > 0) appendFileSync(promptFile, queuedPrompt.join('\n') + '\n', 'utf8');
      if (queuedError.length > 0) appendFileSync(errorFile, queuedError.join('\n') + '\n', 'utf8');
    } catch { /* 落盘失败（磁盘满等）不阻断业务 */ }
    queuedPrompt.length = 0;
    queuedError.length = 0;
    flushing = false;
  };
  const scheduleFlush = () => {
    if (flushTimer === null) flushTimer = setTimeout(flushFiles, cfg.flushMs);
  };
  const queuePrompt = (rec) => {
    if (queuedPrompt.length >= 4000) return; // 风暴保险：防单次 flush 同步写超大块阻塞事件循环（内存环仍保留）
    queuedPrompt.push(JSON.stringify(rec));
    scheduleFlush();
  };
  const queueError = (rec) => {
    if (queuedError.length >= 4000) return;
    queuedError.push(JSON.stringify(rec));
    scheduleFlush();
  };

  /** 记录一条提示词。字段：module/model/system/user/url/kind/status/err。 */
  const recordPrompt = (r = {}) => {
    const rec = {
      id: recId(),
      seq: ++promptSeq,
      t: Date.now(),
      module: r.module || 'core',
      model: trunc(r.model, 100),
      kind: r.kind || 'chat',
      system: trunc(r.system, 3000),
      user: trunc(r.user, 6000),
      url: trunc(r.url, 300),
      status: r.status || 'sent',
      err: trunc(r.err, 500),
    };
    prompts.push(rec);
    if (prompts.length > cfg.promptCap) prompts.shift();
    try { queuePrompt(rec); } catch { /* 队列失败不阻断 */ }
    return rec;
  };

  /** 记录一条报错。字段：module/level/source/message/stack/errKey。 */
  const recordError = (r = {}) => {
    const rec = {
      id: recId(),
      seq: ++errorSeq,
      t: Date.now(),
      module: r.module || 'core',
      level: r.level || 'error', // warn|error|uncaught|unhandled|rpc|client
      source: r.source || 'logger', // logger|console|process|rpc|client|llm
      message: trunc(r.message, 2000),
      stack: trunc(r.stack, 4000),
    };
    errors.push(rec);
    if (errors.length > cfg.errorCap) errors.shift();
    try { queueError(rec); } catch { /* 同上 */ }
    return rec;
  };

  const api = {
    recordPrompt,
    recordError,
    stats: () => ({
      prompts: prompts.length,
      errors: errors.length,
      promptFile: promptFile,
      errorFile: errorFile,
      promptCap: cfg.promptCap,
      errorCap: cfg.errorCap,
    }),
    // 旧接口（返回数组）语义不变，verify-ledger.js 与任何外部调用零改动。
    listPrompts: (limit) => pageRecords(prompts, limit).items,
    listErrors: (opts = {}) => pageRecords(errors, opts.limit, undefined, opts.level).items,
    // 新增增量接口（返回 { items, next, oldest }）：since 非有限数时为"尾部 limit 条"的全量兜底。
    listPromptsPage: (limit, since) => pageRecords(prompts, limit, since),
    listErrorsPage: (opts = {}) => pageRecords(errors, opts.limit, opts.since, opts.level),
    clear: (kind) => {
      if (kind === 'prompts' || kind === 'all') {
        prompts.length = 0; queuedPrompt.length = 0;
        try { writeFileSync(promptFile, '', 'utf8'); } catch { /* ignore */ }
      }
      if (kind === 'errors' || kind === 'all') {
        errors.length = 0; queuedError.length = 0;
        try { writeFileSync(errorFile, '', 'utf8'); } catch { /* ignore */ }
      }
      return { cleared: true };
    },
  };
  ctx.provide('archiveLedger', api);

  /* ================= 路径 1：logger 工厂包裹（Proxy 版） ================= */
  // 关键约束（ 实机崩溃修复）：Cordis 的 ctx.logger 是"可调用 LoggerService"，其
  // error/warn/info/debug 挂在原型上且内部通过 this() 委托；若用普通函数整体替换 ctx.root.logger，
  // 会丢失这些原型方法 → 核心（如 cordis-plugin-loader 的 this.ctx.logger.error）直接
  // "is not a function" → 宿主崩溃。因此这里用 Proxy 只拦"以函数方式调用"（=建具名 logger），
  // 其余一切（原型方法、ctx/exporters 等实例属性、符号、instanceof）全部透传原 LoggerService，
  // 语义零破坏。
  (() => {
    try {
      const root = ctx.root;
      const factory = root?.logger;
      if (typeof factory !== 'function' || factory[W_FACTORY]) return;
      const proxied = new Proxy(factory, {
        apply(target, thisArg, args) {
          let inst;
          try { inst = Reflect.apply(target, target, args); } catch (error) { throw error; }
          if (inst && !inst[W_INST]) {
            const patch = (method, level) => {
              try {
                const orig = inst[method];
                if (typeof orig !== 'function') return;
                inst[method] = function (...margs) {
                  try {
                    const { text, stack } = summarizeArgs(margs);
                    const mod = String(args[0] ?? '').replace(/^archive-/, '') || 'core';
                    recordError({ module: mod, level, source: 'logger', message: text.slice(0, 2000), stack: stack.slice(0, 4000) });
                  } catch { /* 记录失败绝不影响原日志 */ }
                  return orig.apply(inst, margs);
                };
              } catch { /* 实例不可写则跳过包裹 */ }
            };
            patch('warn', 'warn');
            patch('error', 'error');
            inst[W_INST] = true;
          }
          return inst;
        },
      });
      factory[W_FACTORY] = true; // 标在原对象上（代理透传可见），防热重载重复包裹
      root.logger = proxied;
      bootLine('[archive-ledger] hook: ctx.root.logger wrapped (Proxy, 原型方法透传)');
    } catch (e) { bootLine(`[archive-ledger] logger hook 失败: ${e.message}`); }
  })();

  /* ================= 路径 2：console 包裹（兜底） ================= */
  (() => {
    try {
      const wrapConsole = (method, level) => {
        const orig = console[method];
        if (typeof orig !== 'function' || orig[W_FACTORY]) return;
        console[method] = function (...args) {
          try {
            const { text } = summarizeArgs(args);
            // 归源：消息常带 [archive-xxx] / archive-xxx: 前缀
            let mod = 'core';
            const m = text.match(/(?:\[?archive-)([a-z0-9-]+)(?:\]|:| )/);
            if (m) mod = m[1];
            recordError({ module: mod, level, source: 'console', message: text.slice(0, 2000) });
          } catch { /* ignore */ }
          return orig.apply(console, args);
        };
        console[method][W_FACTORY] = true;
      };
      wrapConsole('warn', 'warn');
      wrapConsole('error', 'error');
      bootLine('[archive-ledger] hook: console.warn/error wrapped');
    } catch (e) { bootLine(`[archive-ledger] console hook 失败: ${e.message}`); }
  })();

  /* ================= 路径 3：globalThis.fetch 包裹（直连 LLM） ================= */
  // 普通请求走"零开销直通"（非 async、无额外 Promise 微任务）；仅命中 LLM 类 URL 才做
  // 栈归源/body 快照并按 .then/.catch 记录（不消费响应体，SSE 流不受影响）。
  (() => {
    try {
      const origFetch = globalThis.fetch;
      if (typeof origFetch !== 'function' || origFetch[W_FACTORY]) return;
      const LLM_URL = /\/chat\/completions$|\/api\/chat$|\/api\/generate$/i;
      globalThis.fetch = function ledgerFetch(input, init) {
        const rawUrl = typeof input === 'string' ? input : (input && (typeof input.url === 'string' ? input.url : (input instanceof URL ? input.href : '')));
        if (!rawUrl || !LLM_URL.test(rawUrl)) return origFetch(input, init);
        let meta = null;
        try {
          const bodyRaw = init && init.body;
          let body = null;
          if (typeof bodyRaw === 'string') { try { body = JSON.parse(bodyRaw); } catch { body = null; } }
          if (body && (Array.isArray(body.messages) || typeof body.prompt === 'string' || typeof body.model === 'string')) {
            meta = {
              url: rawUrl, body,
              module: stackSource(new Error('ledger-attribution').stack),
              kind: /\/api\/generate$/i.test(rawUrl) ? 'generate' : (/\/api\/chat$/i.test(rawUrl) ? 'phi' : 'chat'),
            };
          }
        } catch { meta = null; }
        // core 内部 fetch（llm 适配器）由 ctx.llm 包裹记录，此处跳过防重复
        if (!meta || meta.module === 'core') return origFetch(input, init);
        const record = (status, err) => {
          try {
            const parts = promptParts(meta.body.messages, meta.body.prompt);
            //  去重修复：官方 ctx.llm 的内部 HTTP fetch 由调用方模块的 for-await 驱动，
            // 栈归源会命中模块（非 core）→ 与 llm 包裹先记的 sent 记录重复（面板同一提示词出现两行）。
            // 处理：2s 内存在 同 module + 同 user/system 前缀 的 sent 记录 → 原位更新其状态（不新增）；
            // 面板读内存环 → 一调用一条且状态正确（ok/http-*/error）；文件仅归档（sent 行保留）。
            const keyUser = (parts.user ?? '').slice(0, 60);
            const keySys = (parts.system ?? '').slice(0, 40);
            let merged = false;
            for (let i = prompts.length - 1; i >= 0 && i >= prompts.length - 10; i--) {
              const p = prompts[i];
              if (p.status === 'sent' && p.module === meta.module
                && (p.user ?? '').slice(0, 60) === keyUser
                && (p.system ?? '').slice(0, 40) === keySys
                && Date.now() - p.t < 2000) {
                p.status = status;
                p.url = meta.url;
                if (err) p.err = trunc(err, 500);
                merged = true;
                break;
              }
            }
            if (!merged) {
              recordPrompt({
                module: meta.module, model: meta.body?.model, kind: meta.kind,
                system: parts.system, user: parts.user,
                url: meta.url, status, err: err ? String(err).slice(0, 500) : '',
              });
            }
          } catch { /* ignore */ }
        };
        return origFetch(input, init).then(
          (res) => { record(res.ok ? 'ok' : `http-${res.status}`, ''); return res; },
          (err) => { record('error', err?.message ?? err); throw err; },
        );
      };
      globalThis.fetch[W_FACTORY] = true;
      bootLine('[archive-ledger] hook: globalThis.fetch wrapped');
    } catch (e) { bootLine(`[archive-ledger] fetch hook 失败: ${e.message}`); }
  })();

  /* ================= 路径 4：ctx.llm 包裹（官方路由，含主会话） ================= */
  ctx.inject(['llm'], (llmCtx) => {
    try {
      const llm = llmCtx.llm;
      if (!llm) return;
      const wrapMethod = (name) => {
        const orig = llm[name];
        if (typeof orig !== 'function' || orig.__archiveLedgerWrapped) return;
        llm[name] = function (...args) {
          const opts = args[0] ?? {};
          try {
            const parts = promptParts(opts.messages, null);
            recordPrompt({
              module: stackSource(new Error('ledger-attribution').stack),
              model: opts.model, kind: 'chat',
              system: opts.system ? trunc(String(opts.system), 3000) : parts.system,
              user: parts.user,
              url: '', status: 'sent',
            });
          } catch { /* ignore */ }
          return orig.apply(llm, args);
        };
        llm[name].__archiveLedgerWrapped = true;
      };
      wrapMethod('stream');
      wrapMethod('complete');
      const wrappedOk = Boolean(llm.stream?.__archiveLedgerWrapped || llm.complete?.__archiveLedgerWrapped);
      bootLine(wrappedOk ? '[archive-ledger] hook: ctx.llm wrapped' : '[archive-ledger] hook: ctx.llm 方法包裹失败（服务对象只读）→ 官方路由提示词不会记录，请检查');
    } catch (e) { bootLine(`[archive-ledger] llm hook 失败: ${e.message}`); }
  });

  /* ================= 路径 5：进程级未捕获错误 ================= */
  // 语义保持：若事件发生时本模块是唯一监听者 → 记录后按默认行为退出（崩溃语义不变，仅补记录）；
  // 若届时已有其它监听者（如后续插件自行接管）→ 只记录、交由其处置。
  const onUncaught = (err) => {
    try {
      recordError({ module: 'core', level: 'uncaught', source: 'process', message: String(err?.message ?? err), stack: err?.stack });
    } catch { /* ignore */ }
    if (process.listenerCount('uncaughtException') === 1) {
      try { process.stderr.write(`[archive-ledger] uncaughtException: ${err?.stack ?? err}\n`); } catch { /* ignore */ }
      try { flushFiles(); } catch { /* ignore */ }
      process.exit(1);
    }
  };
  const onRejection = (reason) => {
    try {
      recordError({ module: 'core', level: 'unhandled', source: 'process', message: String(reason?.message ?? reason), stack: reason?.stack });
    } catch { /* ignore */ }
    if (process.listenerCount('unhandledRejection') === 1) {
      try { process.stderr.write(`[archive-ledger] unhandledRejection: ${reason?.stack ?? reason}\n`); } catch { /* ignore */ }
      try { flushFiles(); } catch { /* ignore */ }
      process.exit(1);
    }
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  const onExit = () => { try { flushFiles(); } catch { /* ignore */ } };
  process.on('exit', onExit);
  bootLine('[archive-ledger] hook: process uncaught/unhandled（唯一监听时记录后按默认语义退出，避免改变崩溃行为）');

  /* ================= RPC：/archive-ledger ================= */
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      connectionCtx.connection.rpc.handle('/archive-ledger',
        async (endpoint, payload) => {
          const { op, args = {} } = payload?.args ?? {};
          try {
            let value;
            if (op === 'stats') value = api.stats();
            else if (op === 'prompts.list') value = api.listPromptsPage(args.limit, args.since);
            else if (op === 'errors.list') value = api.listErrorsPage({ limit: args.limit, level: args.level, since: args.since });
            else if (op === 'prompts.clear') value = api.clear('prompts');
            else if (op === 'errors.clear') value = api.clear('errors');
            else if (op === 'errors.push') {
              api.recordError({ module: args.module || 'web', level: args.level || 'error', source: 'client', message: args.message, stack: args.stack });
              value = { ok: true };
            }
            else return { ok: false, error: { code: 'internal', message: `unknown ledger op: ${op}`, details: {} } };
            return { ok: true, value };
          } catch (error) {
            return { ok: false, error: { code: 'internal', message: String(error?.message ?? error), details: {} } };
          }
        },
        { authority: 'trusted-host' });
      bootLine('[archive-ledger] ready RPC=/archive-ledger');
    } catch (e) {
      bootLine(`[archive-ledger] RPC 注册失败: ${e.message}`);
    }
  });

  ctx.on('dispose', () => {
    try { if (flushTimer !== null) clearTimeout(flushTimer); } catch { /* ignore */ }
    try { flushFiles(); } catch { /* ignore */ }
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
    process.removeListener('exit', onExit);
  });

  bootLine('[archive-ledger] ready 数据目录=' + cfg.dataPath);
  return api;
}

/* ---------- 模块级工具 ---------- */

/**
 * 日志/错误参数 → {text, stack}。策略：绝不整对象 JSON.stringify（巨型对象会卡事件循环）——
 * 字符串原样、Error 取 message（stack 单独带回）、其余取 .message 或摘要；按码点截断。
 */
function summarizeArgs(args) {
  let text = '';
  let stack = '';
  for (const x of Array.isArray(args) ? args : [args]) {
    let seg = '';
    if (x instanceof Error) {
      seg = x.message ?? String(x);
      if (!stack && x.stack) stack = String(x.stack);
    } else if (typeof x === 'string') {
      seg = x;
    } else if (x && typeof x === 'object') {
      seg = (typeof x.message === 'string' && x.message) ? x.message
        : (typeof x.code !== 'undefined' ? `[${x.code}]` : '[对象]');
    } else if (x !== undefined) {
      seg = String(x);
    }
    if (seg) text = text ? `${text} ${seg}` : seg;
  }
  const t = [...text];
  return { text: t.length > 2500 ? t.slice(0, 2499).join('') + '…' : text, stack };
}
