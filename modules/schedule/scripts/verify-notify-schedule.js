// notify + schedule 集成验证（stub ctx，从 profile 副本导入）
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), `ns-verify-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

const notifyPath = join(dir, 'notifications.jsonl');
const tasksDb = join(dir, 'tasks.db');

// 捕获 timer 回调（schedule 用）
const timers = { intervals: [], timeouts: [] };
const timerStub = {
  setInterval: (fn) => { timers.intervals.push(fn); return 1; },
  setTimeout: () => 1,
};
const writes = [];
const triggers = [];
const ctxBase = {
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  provide: () => {},
  on: () => {},
  emit: () => {},
  get: (n) => n === 'tools' ? { register: () => {} } : undefined,
  timer: timerStub,
  virtualClock: { format: () => '2026-08-28 22:00:00' },
  memory: { write: async (input) => { writes.push(input); return { id: 'x' }; } },
  loop: { trigger: (r) => triggers.push(r) },
};

// --- notify ---
const notifyMod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-notify/lib/index.js');
const notifyCtx = { ...ctxBase, root: { logger: () => ({ info: () => {}, warn: () => {} }) } };
let notifyOut = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { notifyOut += String(chunk); return true; };
const notifyApi = notifyMod.apply(notifyCtx, { notificationsPath: notifyPath, consoleEnabled: true, minIntervalMs: 0 });
process.stdout.write = origWrite;
console.log('== notify ==');
const s1 = notifyApi.send({ content: '测试通知', source: 'verify' });
check('发送成功', s1.sent === true && s1.limited === false);
const s2 = notifyApi.send({ content: '第二条' });
check('限频为 0 时不拦截', s2.sent === true);
check('通知流水可查', notifyApi.view().notifications.length === 2);
check('未读统计', notifyApi.stats().unread === 2);
check('标记已读', notifyApi.markRead()?.marked === 2 && notifyApi.stats().unread === 0);
check('控制台输出', notifyOut.includes('[archive-notify]'));

// 按来源组限频（2026-08-30）：loop 与 schedule 互不挤兑；同组内仍限频
const notifyG = notifyMod.apply({ ...notifyCtx, timer: { setInterval: () => 1 } }, { notificationsPath: notifyPath + '.g', consoleEnabled: false, minIntervalMs: 60000 });
const g1 = notifyG.send({ content: 'loop 发言', source: 'loop' });
const g2 = notifyG.send({ content: 'schedule 提醒', source: 'schedule' });
const g3 = notifyG.send({ content: 'loop 再发言', source: 'loop' });
check('不同来源组互不挤兑', g1.sent === true && g2.sent === true);
check('同组 30s 内限频', g3.limited === true);

// 清理（2026-08-30）：未超期已读不清；保留期 0 的实例启动即清已读、未读永不清理
notifyApi.send({ content: '未读保留条', source: 'verify' });
check('保留期默认不清未超期已读', notifyApi.cleanup().removed === 0 && notifyApi.stats().total === 3);
const notifyApi0 = notifyMod.apply({ ...notifyCtx, timer: { setInterval: () => 1 } }, { notificationsPath: notifyPath, consoleEnabled: false, minIntervalMs: 0, cleanupRetentionDays: 0 });
const after0 = notifyApi0.view().notifications;
check('保留期 0 启动即清超期已读', after0.length === 1 && after0[0].content === '未读保留条');

// --- schedule ---
const schedMod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-schedule/lib/index.js');
let limitedNext = false;
const schedCtx = {
  ...ctxBase,
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  notify: { send: (input) => { writes.push({ source: 'notify', content: input.content }); return { sent: !limitedNext, limited: limitedNext }; } },
};
const schedApi = schedMod.apply(schedCtx, { dbPath: tasksDb, checkMs: 1000 });
console.log('== schedule ==');
const t1 = schedApi.create({ task: '下午3点提醒我喝水', type: 'message', schedule: 'one-time', at: Date.now() + 1000 });
check('创建一次性任务', t1.id && t1.status === 'pending' && t1.schedule === 'one-time');
const t2 = schedApi.create({ task: '每天8点晨间总结', type: 'work', schedule: 'daily', at: Date.now() });
check('创建 daily 任务', t2.schedule === 'daily' && t2.dueAt > Date.now());
const t3 = schedApi.create({ task: '每5分钟检查', schedule: 'interval', intervalMinutes: 5 });
check('创建 interval 任务', t3.schedule === 'interval' && t3.dueAt > Date.now());
check('列表 3 条', schedApi.list().length === 3);
check('取消任务', schedApi.cancel(t2.id).cancelled === true);
check('取消后状态', schedApi.list().find((t) => t.id === t2.id).status === 'cancelled');

// 触发一次到期检查（t1 1 秒后到期 → 消息通知）
await new Promise((resolve) => setTimeout(resolve, 1200));
for (const fn of timers.intervals) fn();
check('到期 message 任务经 notify 发送', writes.some((w) => w.source === 'notify' && w.content.includes('提醒我喝水')));
check('一次性任务 fired', schedApi.list().find((t) => t.id === t1.id).status === 'fired');

// work 型：造一个到期 work 任务并触发
const t4 = schedApi.create({ task: '检查项目状态', type: 'work', schedule: 'one-time', at: Date.now() + 500 });
await new Promise((resolve) => setTimeout(resolve, 700));
for (const fn of timers.intervals) fn();
check('到期 work 任务生成待办记忆', writes.some((w) => w.source === 'task-due'));
check('work 触发自循环', triggers.includes('task-due'));

// 2026-08-30 修复验证：提醒被 notify 限频时任务保持 pending 并推迟重试（不假 fired）
const t5 = schedApi.create({ task: '限频重试验证', type: 'message', schedule: 'one-time', at: Date.now() + 100 });
const dueBefore = t5.dueAt;
await new Promise((resolve) => setTimeout(resolve, 300));
limitedNext = true; // 模拟 notify 限频窗口
for (const fn of timers.intervals) fn();
const t5after = schedApi.list().find((t) => t.id === t5.id);
check('限频时提醒不标记 fired', t5after.status === 'pending');
check('限频时任务推迟重试', t5after.dueAt > dueBefore);
const firedCountBefore = schedApi.list().filter((t) => t.status === 'fired').length;
limitedNext = false; // 限频结束
await new Promise((resolve) => setTimeout(resolve, 5300)); // 等待推迟的重试窗口（fire 推迟 5s）
for (const fn of timers.intervals) fn();
const t5final = schedApi.list().find((t) => t.id === t5.id);
check('限频结束后提醒送达并 fired', t5final.status === 'fired' && writes.some((w) => w.source === 'notify' && w.content.includes('限频重试验证')));
check('重试期间未重复发送（单次送达）', schedApi.list().filter((t) => t.id === t5.id && t.status === 'fired').length === 1);

// 持久化（重开）
const schedApi2 = schedMod.apply({ ...schedCtx }, { dbPath: tasksDb, checkMs: 1000 });
check('tasks.db 跨重启持久', schedApi2.list().length === 5);

// 清理（2026-08-30）：默认保留期不清未超期任务；保留期 0 启动即清 fired/cancelled，pending 永不清理
check('保留期默认不清未超期任务', schedApi2.cleanup().removed === 0 && schedApi2.list().length === 5);
const schedApi0 = schedMod.apply({ ...schedCtx }, { dbPath: tasksDb, checkMs: 1000, cleanupRetentionDays: 0 });
const afterClean = schedApi0.list();
check('保留期 0 启动即清历史任务', afterClean.length === 1 && afterClean[0].status === 'pending');
check('pending 任务永不被清理', afterClean[0].id === t3.id);

console.log(failures.length === 0 ? '\nNOTIFY+SCHEDULE VERIFY: ALL PASS' : `\nVERIFY: ${failures.length} FAILED`);
try { schedApi.close(); } catch { /* ignore */ }
try { schedApi2.close(); } catch { /* ignore */ }
await new Promise((resolve) => setTimeout(resolve, 100));
try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ }
process.exit(failures.length === 0 ? 0 : 1);
