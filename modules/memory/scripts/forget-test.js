// 仿生遗忘系统单测：保护自动判定、强度衰减、软遗忘、归档、恢复、
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, initialStrength } from '../lib/store.js';

const dbPath = join(tmpdir(), `forget-test-${process.pid}.db`);
const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

// 加速遗忘参数：τ 极小 → 立即衰减；归档宽限 0 天
const store = new MemoryStore(dbPath, {
  tauBaseDays: 0.0001,
  reinforce: 0.05,
  softThreshold: 0.3,
  archiveGraceDays: 0,
  protectImportance: 0.8,
});

try {
  console.log('== 保护自动判定 ==');
  const p1 = store.write({ content: '经验教训：改动必须同步检查关联', kind: 'procedural', importance: 0.5 });
  check('procedural 类型自动保护', store.get(p1.id).protected === true);
  const p2 = store.write({ content: '项目信息：DSH-ARCHIVE 五阶段', kind: 'semantic', importance: 0.9 });
  check('高重要度自动保护', store.get(p2.id).protected === true);
  const p3 = store.write({ content: '一条普通记录', kind: 'general', importance: 0.3, tags: ['lesson'] });
  check('lesson 标签自动保护', store.get(p3.id).protected === true);
  const p4 = store.write({ content: '普通日常记录', kind: 'general', importance: 0.2, createdAt: Date.now() - 10 * 86400000, updatedAt: Date.now() - 2 * 86400000 });
  check('普通记忆不保护', store.get(p4.id).protected === false);
  check('初始强度公式', Math.abs(initialStrength(0.9) - 0.95) < 1e-9 && Math.abs(initialStrength(0.2) - 0.6) < 1e-9);

  console.log('== 遗忘作业：软遗忘与归档 ==');
  const r1 = store.forgetRun(); // 第一轮：软遗忘
  check('普通记忆被软遗忘', store.get(p4.id).forgotten === 1, `softened=${r1.softened}`);
  check('受保护记忆不衰减不遗忘', store.get(p1.id).forgotten === 0 && store.get(p1.id).strength === 1);
  const r1b = store.forgetRun(); // 第二轮：超期归档（宽限 0 天 + 回填 updatedAt 已过 2 天）
  check('归档', r1b.archived >= 1 && store.get(p4.id).forgotten === 2, `archived=${r1b.archived}`);

  console.log('== 召回联动 ==');
  const r2 = store.recall({ query: '经验教训 检查', k: 10, mode: 'keyword' });
  check('软遗忘/归档记忆不进默认召回', !r2.some((m) => m.id === p4.id));
  const r3 = store.recall({ query: '普通日常记录', k: 10, mode: 'keyword', includeForgotten: true });
  check('includeForgotten 可含入', r3.some((m) => m.id === p4.id));
  check('召回结果含相对时间', typeof r2[0]?.relativeTime === 'string' && r2[0].relativeTime.length > 0);
  check('召回结果含保护标记', typeof r2[0]?.protected === 'boolean' && r2[0].protected === true);

  console.log('== 恢复与统计 ==');
  check('恢复被遗忘记忆', store.restore(p4.id) === true && store.get(p4.id).forgotten === 0 && store.get(p4.id).strength >= initialStrength(0.2));
  const fs = store.forgetStats();
  check('遗忘统计', fs.total === 4 && fs.protected === 3 && (fs.active + fs.soft + fs.archived) === 1, JSON.stringify(fs));
  check('遗忘审计文件存在', existsSync(dbPath + '.forgetting-log.jsonl'));

  console.log(failures.length === 0 ? '\nFORGET TEST: ALL PASS' : `\nFORGET TEST: ${failures.length} FAILED`);
} catch (error) {
  console.error('FORGET TEST CRASH:', error);
  failures.push(`crash: ${error.message}`);
} finally {
  try { store.close(); } catch {}
  rmSync(dbPath, { force: true });
  for (const s of ['-wal', '-shm', '.forgetting-log.jsonl']) rmSync(dbPath + s, { force: true });
}
process.exit(failures.length === 0 ? 0 : 1);
