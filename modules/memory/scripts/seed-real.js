/**
 * 跨会话验证·会话A：向 archive profile 的真实记忆库写入种子记忆。
 * 与插件完全相同的代码路径（lib/core.js），dbPath 与 cordis.patch.yml 一致。
 * 用法：node scripts/seed-real.js
 */
import { MemoryCore } from '../lib/core.js';

const core = new MemoryCore({
  dbPath: 'C:/DSH-ARCHIVE/dsh/data/memory.db',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: 'shaw/dmeta-embedding-zh:latest',
});

const seeds = [
  { content: '用户确认 DSH-ARCHIVE 项目进入阶段二：跨会话全局记忆系统', kind: 'episodic', importance: 0.8, tags: ['project', 'milestone'] },
  { content: '记忆系统技术选型：ollama shaw/dmeta-embedding-zh 生成 768 维向量，SQLite(node:sqlite) 存储', kind: 'semantic', importance: 0.75, tags: ['tech', 'decision'] },
  { content: '冒烟测试曾发现 FTS5 外部内容表陷阱：删除不存在的 rowid 触发 SQLite 损坏，已改用独立 FTS5 表+存在性守卫', kind: 'episodic', importance: 0.65, tags: ['bug', 'lesson'] },
  { content: '用户要求项目文档中提到的参考资料只允许参照经验、特化后应用，禁止照搬', kind: 'preference', importance: 0.9, tags: ['user', 'rule'] },
];

console.log('== 会话A：写入种子记忆到真实库 ==');
for (const item of seeds) {
  const { id } = await core.write({ ...item, source: 'session-A' });
  console.log(`  写入 ${item.kind}: ${item.content.slice(0, 30)}... id=${id.slice(0, 8)}`);
}
const stats = core.stats();
console.log('真实库统计:', JSON.stringify(stats));
core.close();
