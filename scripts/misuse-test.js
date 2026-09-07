// 系统级误用探测：重复采纳、循环并发触发互斥、符号查询
// evolution 用临时目录（不写真实 data/evolution-torture.jsonl + data/skills——
// 避免重复运行时"内容去重"残留互相影响，且污染项目数据）。
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = join(tmpdir(), `misuse-${process.pid}`);
rmSync(dir, { recursive: true, force: true });

const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

// 1) evolution 重复采纳
const evoMod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-evolution/lib/index.js');
const ledgerPath = join(dir, 'evolution.jsonl');
const evoCtx = {
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  provide: () => {}, on: () => {}, emit: () => {},
  get: (n) => n === 'tools' ? { register: () => {} } : undefined,
  llm: { stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: '[{"type":"persona-add","section":"traits","content":"x","rationale":"r"}]' }; yield { type: 'finish', reason: { kind: 'completed' } }; })() },
  memory: { recall: async () => ({ results: [] }), list: () => [] },
  persona: { render: () => '', stats: () => ({ version: 1 }), set: (e, o) => ({ version: 2, added: e.length }), rollback: (v) => true },
  skills: { register: () => {} },
};
const evo = evoMod.apply(evoCtx, { ledgerPath, skillsDir: join(dir, 'skills'), provider: 'x', model: 'y' });
try {
  const { candidateIds } = await evo.suggest({ by: 'test' });
  const id = candidateIds[0];
  await evo.approve(id, { by: 'user', confirm: true });
  let threw = false;
  try { await evo.approve(id, { by: 'user', confirm: true }); } catch { threw = true; }
  check('重复采纳被拒', threw);
  let threw2 = false;
  try { await evo.approve('不存在的id', { by: 'user', confirm: true }); } catch { threw2 = true; }
  check('未知候选采纳被拒', threw2);
  let threw3 = false;
  try { await evo.rollback('不存在的id', { by: 'user', confirm: true }); } catch { threw3 = true; }
  check('未知候选回滚被拒', threw3);
} catch (e) { check('evolution 流程无崩溃', false, e.message); }

// 2) loop 忙时并发触发（互斥：thinking 期间 trigger 排队不并发跑）
const loopMod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-loop/lib/index.js');
let llmCalls = 0;
const loopCtx = {
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  provide: () => {}, on: () => {}, emit: () => {},
  // loop 用 ctx.inject(['settings']) 注册降频开关命名空间——stub 必须提供 inject
  inject: (services, cb) => cb({ settings: { register: () => ({}), get: () => ({}), update: async () => {} } }),
  get: (n) => n === 'tools' ? { register: () => {} } : undefined,
  systemPrompt: { context: () => {} },
  timer: { setTimeout: () => 1, setInterval: () => 1 },
  llm: { stream: () => { llmCalls++; return (async function* () { await new Promise((r) => setTimeout(r, 30)); yield { type: 'text-delta', index: 0, text: '{"analysis":"a","shouldSpeak":false,"shouldAct":false,"actions":[],"consequenceAssessment":"","notifyUser":false}' }; yield { type: 'finish', reason: { kind: 'completed' } }; })(); } },
  virtualClock: { format: () => 't' },
  memory: { list: () => [], recall: async () => ({ results: [] }), stateGet: () => [], state: { snapshot: () => ({ rendered: null }) }, write: async () => ({}) },
  persona: { render: () => '' },
};
const loop = loopMod.apply(loopCtx, { fallbackIntervalMs: 300000, tickMs: 30000, initialDelayMs: 0, thinkTimeoutMs: 5000 });
try {
  loop.trigger('a'); loop.trigger('b'); loop.trigger('c'); // 三次快速触发
  await loop.beforeTurn(); // 触发一次循环（dirty 合并）
  await new Promise((r) => setTimeout(r, 200));
  check('并发触发只跑一个循环（LLM 只调一次）', llmCalls <= 1, `llmCalls=${llmCalls}`);
} catch (e) { check('loop 并发无崩溃', false, e.message); }

// 3) 纯符号查询
const { MemoryStore } = await import('../modules/memory/lib/store.js');
const m = new MemoryStore('C:/DSH-ARCHIVE/dsh/data/memory.db');
try {
  const r = m.recall({ query: '!!!？？？', mode: 'keyword' });
  check('纯符号查询不崩溃', Array.isArray(r));
} catch (e) { check('纯符号查询不崩溃', false, e.message); }
m.close();

console.log(failures.length === 0 ? '\nSYSTEM MISUSE: ALL PASS' : `\nSYSTEM MISUSE: ${failures.length} FAILED`);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length === 0 ? 0 : 1);
