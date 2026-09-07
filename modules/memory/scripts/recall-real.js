/**
 * 跨会话验证·会话B：从 archive profile 的真实记忆库召回（新进程，模拟另一会话）。
 * 用法：node scripts/recall-real.js
 */
import { MemoryCore } from '../lib/core.js';

const core = new MemoryCore({
  dbPath: 'C:/DSH-ARCHIVE/dsh/data/memory.db',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: 'shaw/dmeta-embedding-zh:latest',
});

const queries = [
  '这个项目现在在做什么阶段？',
  '记忆系统用了什么技术方案？',
  '参考资料使用上有什么要求？',
];

console.log('== 会话B：跨进程语义召回 ==');
for (const q of queries) {
  const { results } = await core.recall({ query: q, k: 2 });
  console.log(`\n查询: ${q}`);
  for (const r of results) {
    console.log(`  [${r.score.toFixed(3)}] (${r.kind}) ${r.content.slice(0, 40)}`);
  }
}
const stats = core.stats();
console.log('\n库统计:', JSON.stringify(stats));
core.close();
