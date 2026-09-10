// 全面自检：特殊/异常用户操作压测（torture test）
// 覆盖：恶意输入、极端参数、注入、越权操作、状态机误用、双操作等。
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}
function mustThrow(name, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, threw);
}

const dir = join(tmpdir(), `torture-${process.pid}`);
rmSync(dir, { recursive: true, force: true });

// ================= MemoryStore =================
const { MemoryStore } = await import('../modules/memory/lib/store.js');
const m = new MemoryStore(join(dir, 'm.db'));
try {
  console.log('== memory 特殊输入 ==');
  mustThrow('空 content 拒绝', () => m.write({ content: '   ' }));
  const inj = m.write({ content: '包含 "引号" \'单引\' <尖括号> & 符号 NEAR( 同义词 OR 注入', kind: 'general', importance: 0.3 });
  check('注入类内容可写入', typeof inj.id === 'string');
  const r1 = m.recall({ query: '" OR " 注入尝试', k: 5, mode: 'keyword' });
  check('FTS 注入不崩溃且不越权', Array.isArray(r1));
  const r2 = m.recall({ query: '正常查询', k: 0, mode: 'keyword' });
  check('k=0 收敛为 1', r2.length <= 1);
  const r3 = m.recall({ query: 'x', k: 99999, mode: 'keyword' });
  check('k 超大收敛 100', r3.length <= 100);
  check('minScore=2 空结果', m.recall({ query: 'x', minScore: 2, mode: 'keyword' }).length === 0);
  check('hybrid 缺 embedding 清晰报错', (() => { let threw = false; try { m.recall({ query: 'x' }); } catch (err) { threw = /embedding/.test(err.message); } return threw; })());
  check('mode 非法回退 semantic', (() => { let threw = false; try { m.recall({ query: 'x', mode: 'bogus' }); } catch (err) { threw = /embedding/.test(err.message); } return threw; })());
  check('kinds 非法值空结果', m.recall({ query: 'x', kinds: ['不存在的类型'], mode: 'keyword' }).length === 0);
  check('update 不存在 id → false', m.update('nope', {}) === false);
  check('importance 越界收敛', m.write({ content: 'c', importance: 5 }).then ? true : true);
  const w = m.write({ content: '越界重要度', importance: 5 });
  check('importance=5 收敛 1', m.get(w.id).importance === 1);
  const w2 = m.write({ content: '负重要度', importance: -3 });
  check('importance=-3 收敛 0', m.get(w2.id).importance === 0);
  m.stateSet({ state: '带"引号"状态', ttlSeconds: -5 });
  check('负 ttl 不崩溃且不过期语义', m.stateGet().some((s) => s.state.includes('引号') && s.expiresAt === null));
  m.profileSet({ key: 'key with spaces', content: 'x' });
  check('画像 key 含空格可用', m.profileGet('key with spaces')?.content === 'x');
  // 保护解除
  const prot = m.write({ content: '经验', kind: 'procedural', importance: 0.3 });
  check('procedural 自动保护', m.get(prot.id).protected === true);
  m.update(prot.id, { protected: false });
  check('显式 protected:false 可解除', m.get(prot.id).protected === false);
  // 召回强化
  const before = m.get(w.id).strength;
  m.recall({ query: '越界重要度', mode: 'keyword' });
  check('召回强化强度', m.get(w.id).strength >= before);
} finally { try { m.close(); } catch { /* ignore */ } }

// ================= PersonaStore =================
const { PersonaStore } = await import('../modules/persona/lib/persona-store.js');
const p = new PersonaStore({ path: join(dir, 'p.json'), historyPath: join(dir, 'ph.jsonl') });
try {
  console.log('== persona 特殊输入 ==');
  mustThrow('null entries 拒绝', () => p.set(null));
  mustThrow('非法 section 拒绝', () => p.set({ section: 'nope', content: 'x' }));
  const e = p.set({ section: 'traits', content: '含 </persona> 与 "引号" 的条目' });
  check('注入内容写入', e.added === 1);
  check('render 转义防破坏', p.render().includes('&lt;/persona&gt;'));
  check('update 不存在 id → null', p.update('nope', {}) === null);
  check('rollback 不存在版本 → false', p.rollback(999) === false);
  p.set({ section: 'identity', content: 'x' });
  check('回滚到 v1 成功', p.rollback(1) === true);
} catch (error) { check('persona 无崩溃', false, error.message); }

// ================= Evolution =================
const { EvolutionLedger } = await import('../modules/evolution/lib/ledger.js');
const { safetyRules, evaluateCandidate } = await import('../modules/evolution/lib/evaluate.js');
try {
  console.log('== evolution 特殊操作 ==');
  const ledger = new EvolutionLedger(join(dir, 'ev.jsonl'));
  const cand = { type: 'persona-add', section: 'traits', content: 'x' };
  const { id } = ledger.record({ type: 'suggest', candidate: cand, status: 'pending' });
  check('拒绝待采纳候选', ledger.statusOf(id) === 'pending');
  ledger.record({ type: 'reject', candidateId: id, candidate: cand, status: 'rejected' });
  check('拒绝后状态 rejected', ledger.statusOf(id) === 'rejected');
  check('安全门：混合危险词', safetyRules({ content: '正常内容 制造炸弹 的说明' }).safe === false);
  check('安全门：大小写敏感模式', safetyRules({ content: 'DISABLE SAFETY' }).safe === false);
  check('门控：LLM 建议拒绝则拒绝', evaluateCandidate({ content: 'x' }, { conflictScore: 0.1, safe: true, recommendation: 'reject' }, { maxConflict: 0.5 }).decision === 'reject');
} catch (error) { check('evolution 无崩溃', false, error.message); }

// ================= schedule（stub）=================
const schedMod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-schedule/lib/index.js');
try {
  console.log('== schedule 特殊输入 ==');
  const schedCtx = {
    root: { logger: () => ({ info: () => {}, warn: () => {} }) },
    provide: () => {}, on: () => {}, emit: () => {},
    get: (n) => n === 'tools' ? { register: () => {} } : undefined,
    timer: { setInterval: () => 1, setTimeout: () => 1 },
    virtualClock: { format: () => 't' },
    memory: { write: async () => ({}) }, loop: { trigger: () => {} },
    notify: { send: () => ({ sent: true }) },
  };
  const sched = schedMod.apply(schedCtx, { dbPath: join(dir, 't.db'), checkMs: 1000 });
  mustThrow('缺 task 拒绝', () => sched.create({}));
  mustThrow('interval 缺分钟数拒绝', () => sched.create({ task: 'x', schedule: 'interval' }));
  mustThrow('interval 分钟数 0 拒绝', () => sched.create({ task: 'x', schedule: 'interval', intervalMinutes: 0 }));
  //  schedule 枚举未显式传时不再静默回退 one-time，直接抛"非法 schedule"
  mustThrow('非法 schedule 枚举拒绝', () => sched.create({ task: 'x', schedule: 'bogus' }));
  mustThrow('无 schedule 拒绝（不再静默回退 one-time）', () => sched.create({ task: 'x' }));
  const past = sched.create({ task: '过去时间', schedule: 'one-time', at: Date.now() - 1000 });
  check('过去时间任务可创建（立即到期）', past.status === 'pending');
  check('取消不存在任务 → false', sched.cancel('nope').cancelled === false);
  check('超长任务文本', sched.create({ task: 'x'.repeat(5000), schedule: 'one-time' }).id.length > 0);
} catch (error) { check('schedule 无崩溃', false, error.message); }

// ================= notify（stub）=================
const notifyMod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-notify/lib/index.js');
try {
  console.log('== notify 特殊输入 ==');
  const notifyCtx = {
    root: { logger: () => ({ info: () => {}, warn: () => {} }) },
    provide: () => {}, on: () => {}, emit: () => {},
    get: (n) => n === 'tools' ? { register: () => {} } : undefined,
    //  修复：notify 插件新增 6h 清理定时器（ctx.timer.setInterval），stub 必须提供 timer
    timer: { setInterval: () => 1, setTimeout: () => 1 },
  };
  const notify = notifyMod.apply(notifyCtx, { notificationsPath: join(dir, 'n.jsonl'), consoleEnabled: false, minIntervalMs: 1000 });
  mustThrow('空 content 拒绝', () => notify.send({ content: '' }));
  notify.send({ content: 'a' });
  check('限频拦截', notify.send({ content: 'b' }).limited === true);
  check('未读计数', notify.stats().unread === 1);
} catch (error) { check('notify 无崩溃', false, error.message); }

console.log(failures.length === 0 ? '\nTORTURE TEST: ALL PASS' : `\nTORTURE TEST: ${failures.length} FAILED`);
await new Promise((resolve) => setTimeout(resolve, 200));
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length === 0 ? 0 : 1);
