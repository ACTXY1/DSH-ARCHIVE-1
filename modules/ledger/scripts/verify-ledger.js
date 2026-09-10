// dsh-archive-ledger 单元自检（）：验证五路采集中的宿主侧逻辑（logger/console 包裹、
// 环形存储、清空、批量落盘、fetch 分类归源）。真实 ctx/llm/connection 集成在实机验收阶段验证。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { apply } from '../lib/index.js';

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
}

const dataPath = join(tmpdir(), `ledger-verify-${Date.now()}`);
// 假 ctx：仅实现 ledger 用到的最小面（root/logger、provide、inject 记录回调、on）
const injectCbs = [];
const origRootLogger = (name) => ({ warn() {}, error() {} });
const fakeCtx = {
  root: {
    logger: origRootLogger,
  },
  provide: () => {},
  inject: (deps, cb) => { injectCbs.push({ deps, cb }); },
  on: () => {},
};
const api = apply(fakeCtx, { dataPath, flushMs: 120, promptCap: 50, errorCap: 50 });

// Proxy 替换：仍可调用、与原件不同、原型方法透传原对象（fake 上无原型方法，仅验证可调用与隔离）
check('logger 工厂已被 Proxy 替换且可调用', typeof fakeCtx.root.logger === 'function' && fakeCtx.root.logger !== origRootLogger);

// 1) logger.warn 入账（module 归源自名称 archive-X）
const loopLogger = fakeCtx.root.logger('archive-loop');
loopLogger.warn('循环失败测试：boom');
loopLogger.error(new Error('错误对象测试'));
let st = api.stats();
check('logger.warn 已入账 errors', st.errors === 2, `errors=${st.errors}`);
const errs = api.listErrors({ limit: 10 });
check('module 归源 archive-loop → loop', errs.every((x) => x.module === 'loop') && errs.length === 2);

// 2) console 包裹兜底（archive- 前缀启发归源）
const before = api.stats().errors;
console.error('[archive-clock] 时钟测试错误');
console.warn('archive-schedule: 任务测试告警');
check('console.error/warn 已入账（归源 clock/schedule）', api.stats().errors === before + 2,
  `before=${before} after=${api.stats().errors}`);
check('console 归源正确', api.listErrors({ limit: 10 }).slice(-2).map((x) => x.module).join(',') === 'clock,schedule');

// 3) api.recordPrompt 直接入账 + 截断
api.recordPrompt({ module: 'loop', model: 'deepseek-v4-flash', system: 'S'.repeat(5000), user: '场景简报', url: 'https://api.deepseek.com/v1/chat/completions', status: 'ok' });
st = api.stats();
check('recordPrompt 入账', st.prompts === 1, `prompts=${st.prompts}`);
const p = api.listPrompts(10)[0];
check('system 截断到 3000', [...p.system].length <= 3001 && p.system.endsWith('…'));
check('url/status 字段保留', p.url.includes('chat/completions') && p.status === 'ok' && p.model === 'deepseek-v4-flash');

// 3.5) 增量分页（ 性能修复）：面板每 2.5s 只拉新增，替代原"每次全量尾部 100 条"
const pg1 = api.listPromptsPage(100);
check('listPromptsPage 首次返回全量尾部 + 游标',
  Array.isArray(pg1.items) && pg1.items.length === api.stats().prompts
    && typeof pg1.next === 'number' && typeof pg1.oldest === 'number',
  JSON.stringify({ n: pg1.items.length, next: pg1.next, oldest: pg1.oldest }));
api.recordPrompt({ module: 'loop', user: '增量新增' });
const pg2 = api.listPromptsPage(100, pg1.next);
check('listPromptsPage 增量只回新增', pg2.items.length === 1 && pg2.items[0].user === '增量新增', `len=${pg2.items.length}`);
check('seq 单调递增', pg2.items[0].seq > pg1.items[pg1.items.length - 1].seq,
  `prev=${pg1.items[pg1.items.length - 1].seq} now=${pg2.items[0].seq}`);
const pg3 = api.listPromptsPage(100, pg2.next);
check('无新增时 items 为空且 next 不动（无变化守卫依据）', pg3.items.length === 0 && pg3.next === pg2.next,
  JSON.stringify({ n: pg3.items.length, next: pg3.next, prevNext: pg2.next }));
//  回归守卫（高危）：服务端重启后 promptSeq 归零，客户端旧游标必然大于服务端最新 seq。
// 此时必须回退全量并重置游标——否则 fresh 恒空、next 原样回传，客户端既不替换也不追加，
// 记录面板每次重启后静默停更（旧实现每轮全量拉取，天然自愈；改增量后丢掉该路径）。
const pgReset = api.listPromptsPage(100, 999999);
check('游标超前（模拟服务端重启）回退全量并重置游标',
  pgReset.items.length > 0 && typeof pgReset.next === 'number' && pgReset.next < 999999,
  JSON.stringify({ n: pgReset.items.length, next: pgReset.next }));
check('旧接口 listPrompts 仍返回数组（向后兼容）', Array.isArray(api.listPrompts(10)) && api.listPrompts(10).length === 2);
// errors 侧同理（含 level 过滤下的增量正确性）
const ep1 = api.listErrorsPage({ limit: 100 });
check('listErrorsPage 首次返回全量 + 游标',
  ep1.items.length === api.stats().errors && typeof ep1.next === 'number' && typeof ep1.oldest === 'number',
  JSON.stringify({ n: ep1.items.length, next: ep1.next }));
api.recordError({ module: 'memory', level: 'warn', message: '增量告警' });
const ep2 = api.listErrorsPage({ limit: 100, since: ep1.next, level: 'warn' });
check('listErrorsPage 增量 + level 过滤只回新增', ep2.items.length === 1 && ep2.items[0].message === '增量告警', `len=${ep2.items.length}`);
check('seq 在过滤视图下仍严格递增', ep2.items[0].seq > ep1.next, `seq=${ep2.items[0].seq} since=${ep1.next}`);

// 4) 环形上限
for (let i = 0; i < 60; i++) api.recordPrompt({ module: 'loop', user: `u${i}` });
check('prompt 环形上限 50', api.stats().prompts === 50);

// 5) 清空
api.clear('errors');
api.clear('prompts');
check('清空生效', api.stats().errors === 0 && api.stats().prompts === 0);

// 6) 批量落盘（flushMs=120）
api.recordError({ module: 'memory', level: 'warn', message: '落盘测试' });
await new Promise((r) => setTimeout(r, 400));
const errFile = join(dataPath, 'errors.jsonl');
check('errors.jsonl 已生成且含记录', existsSync(errFile) && readFileSync(errFile, 'utf8').includes('落盘测试'));

// 7) fetch 包裹：命中 chat/completions 记一条、非 LLM URL 不记（归源依赖调用栈，单测栈无模块帧 → module=core 跳过，
//    故此处仅验证"命中不崩溃 + 不命中零开销"，真实归源在实机验证）
const realFetch = globalThis.fetch;
let llmHit = 0;
globalThis.fetch = async (url) => { llmHit++; return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
try {
  const r1 = await fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
  check('fetch 命中不破坏返回', r1.status === 200 && llmHit === 1);
  await fetch('https://example.com/index.html');
  check('非 LLM URL 不额外拦截', llmHit === 2);
} finally {
  globalThis.fetch = realFetch;
}

// 8) inject 回调已登记（llm/connection），供实机接入
check('inject 回调已登记', injectCbs.length >= 2 && injectCbs.some((c) => c.deps[0] === 'llm') && injectCbs.some((c) => c.deps[0] === 'connection'));

try { rmSync(dataPath, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\nledger verify: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
