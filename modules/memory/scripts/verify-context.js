// 验证插件在真实 Loader 环境下的 apply：systemPrompt context 注册 + 快照注入文本
// 数据来源：临时库（脚本自种画像与状态种子）。
// 此前直连真实库并在其中写入"测试状态"——用户状态是单槽互斥，
// 种入临时状态会把用户真实状态（如"睡眠中"）挤成已过期，自循环据此误判
// "用户已醒"而提前离开睡眠期（实机已复现）。改为临时库后既不动真实数据，
// 也不再依赖真实库是否已有画像/状态行。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCore } from '../lib/core.js';

const dir = mkdtempSync(join(tmpdir(), 'verify-memory-context-'));
const dbPath = join(dir, 'memory.db');
const core = new MemoryCore({ dbPath, defaultStateTtlSeconds: 14400 });
core.profileSet({ key: 'language', content: '用户偏好简体中文交流', confidence: 0.9, source: 'user' });
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
  mod.apply(ctx, { dbPath, defaultStateTtlSeconds: 14400 });

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
  // 临时库整体删除：真实库不写入、不留测试状态（即使 apply/断言中途抛错）
  try { core.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(exitCode);
