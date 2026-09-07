// 真实库验证：迁移结果 + 完整性 + 跨进程召回
import { MemoryCore } from '../lib/core.js';

const c = new MemoryCore({ dbPath: 'C:/DSH-ARCHIVE/dsh/data/memory.db' });
console.log('stats:', JSON.stringify(c.stats()));
const fts = c.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='memories_fts'").get();
console.log('fts DDL:', fts.sql);
const integ = c.store.db.prepare('PRAGMA integrity_check').get();
console.log('integrity:', integ.integrity_check);
const ftsCount = c.store.db.prepare('SELECT COUNT(*) AS n FROM memories_fts').get();
console.log('fts rows:', ftsCount.n);
const { results } = await c.recall({ query: '项目现在做什么阶段', k: 3 });
for (const r of results) console.log(`  [${r.score.toFixed(3)}] (${r.kind}) ${r.content.slice(0, 36)}`);
c.close();
