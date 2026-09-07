// 检查 missed 任务与通知（演示用）
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const db = new DatabaseSync('C:/DSH-ARCHIVE/dsh/data/tasks.db');
const t = db.prepare("SELECT id, status, missed_note, substr(task_text,1,40) AS task FROM tasks WHERE source='test'").get();
console.log('test task:', JSON.stringify(t));
db.close();

const lines = readFileSync('C:/DSH-ARCHIVE/dsh/data/notifications.jsonl', 'utf8').split('\n').filter(Boolean);
console.log('notifications total:', lines.length);
for (const line of lines.slice(-4)) {
  const n = JSON.parse(line);
  console.log(`  [${n.source}] ${n.content.slice(0, 70)}`);
}
