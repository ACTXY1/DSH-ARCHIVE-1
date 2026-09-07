// 性能压测：5000 条合成记忆的召回延迟（验证暴力余弦扫描的规模边界）
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `perf-${process.pid}.db`);
const { MemoryStore } = await import('../lib/store.js');
const store = new MemoryStore(dbPath);

// 用确定性伪随机生成 768 维向量（避免依赖 ollama，测存储/扫描本身）
function pseudoVec(seed) {
  const v = new Float32Array(768);
  let s = seed >>> 0;
  for (let i = 0; i < 768; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = ((s >>> 16) & 0xffff) / 65535 - 0.5;
  }
  return v;
}

const N = 5000;
console.log(`写入 ${N} 条合成记忆...`);
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  store.write({
    content: `合成记忆 ${i}：用于性能压测的项目事实记录，编号 ${i}`,
    kind: 'semantic',
    importance: 0.5,
    source: 'perf',
    embedding: pseudoVec(i + 1),
  });
}
console.log(`写入耗时 ${Date.now() - t0}ms (${(N / ((Date.now() - t0) / 1000)).toFixed(0)} 条/秒)`);

const q = pseudoVec(12345);
for (const k of [10, 50]) {
  const t1 = Date.now();
  const r = store.recall({ embedding: q, k, minScore: -2 });
  console.log(`recall k=${k}: ${Date.now() - t1}ms, 返回 ${r.length} 条`);
}
const t2 = Date.now();
for (let i = 0; i < 20; i++) store.recall({ embedding: q, k: 10, minScore: -2 });
console.log(`20 次连续召回平均 ${((Date.now() - t2) / 20).toFixed(1)}ms/次`);

const stats = store.stats();
console.log('stats:', JSON.stringify(stats));
store.close();
rmSync(dbPath, { force: true });
for (const s of ['-wal', '-shm']) rmSync(dbPath + s, { force: true });
