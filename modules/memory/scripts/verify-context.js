// 验证插件在真实 Loader 环境下的 apply：systemPrompt context 注册 + 快照注入文本
import { MemoryCore } from '../lib/core.js';

const core = new MemoryCore({ dbPath: 'C:/DSH-ARCHIVE/dsh/data/memory.db' });
core.stateSet({ state: '测试状态', evidence: 'verify 用', ttlSeconds: 3600 }); // 种入临时状态

const pluginUrl = 'file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-memory/lib/index.js';
const mod = await import(pluginUrl);

const registeredContexts = [];
const ctx = {
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  provide: () => {},
  on: () => {},
  get: (name) => name === 'tools' ? { register: () => {} } : undefined,
  //  修复：插件 8/30 新增 WAL checkpoint/自动整合定时器（ctx.timer.setInterval），stub 必须提供 timer
  timer: { setInterval: () => 1, setTimeout: () => 1 },
  systemPrompt: {
    context: (c) => { registeredContexts.push(c); },
  },
};

let exitCode = 1;
try {
  mod.apply(ctx, { dbPath: 'C:/DSH-ARCHIVE/dsh/data/memory.db', defaultStateTtlSeconds: 14400 });

  const ctxReg = registeredContexts.find((c) => c.name === 'user-current-context');
  console.log('context registered:', Boolean(ctxReg), 'order:', ctxReg?.order);
  const rendered = ctxReg?.text?.({});
  console.log('--- 注入文本 ---');
  console.log(rendered);
  console.log('--- 断言 ---');
  const checks = [
    ['注册 user-current-context', Boolean(ctxReg)],
    ['text 为函数', typeof ctxReg?.text === 'function'],
    ['注入为 user-context 块 + 状态维护指令', typeof rendered === 'string' && rendered.startsWith('<user-context>') && rendered.includes('</user-context>') && rendered.includes('<user-state-maintenance>') && rendered.includes('user_state_set')],
    ['注入含 user-state 标签', typeof rendered === 'string' && rendered.includes('<user-state name="测试状态"')],
    ['注入含 user-profile 标签', typeof rendered === 'string' && rendered.includes('<user-profile key=')],
  ];
  for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
  exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
} finally {
  // 保证真实库不留测试状态（即使 apply/断言中途抛错）
  try { core.stateClear('测试状态'); } catch { /* ignore */ }
  core.close();
}
process.exit(exitCode);
