// 清理测试数据：删除 source='test' 的任务与对应通知
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';

const db = new DatabaseSync('C:/DSH-ARCHIVE/dsh/data/tasks.db');
const del = db.prepare("DELETE FROM tasks WHERE source = 'test'").run();
console.log('deleted test tasks:', del.changes);
db.close();

const p = 'C:/DSH-ARCHIVE/dsh/data/notifications.jsonl';
const kept = readFileSync(p, 'utf8').split('\n').filter(Boolean).filter((l) => {
  try { return !JSON.parse(l).content.includes('测试：项目关闭期间到期的任务'); } catch { return true; }
});
writeFileSync(p, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
console.log('notifications kept:', kept.length);
