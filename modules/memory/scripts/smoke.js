/**
 * 冒烟测试：直接以 Node 运行，验证 ollama 向量化 + SQLite 存储/召回全链路。
 * 覆盖：写入、语义召回排序、混合检索、关键词检索、类型/阈值过滤、访问统计、
 *       删除、跨进程持久化（模拟跨会话）、FTS5 可用性。
 * 用法：node scripts/smoke.js [--keep]
 * 通过则打印 PASS 摘要并以 0 退出；失败以非 0 退出。
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaEmbedder } from '../lib/embedder.js';
import { MemoryStore } from '../lib/store.js';

const keep = process.argv.includes('--keep');
const dbPath = join(tmpdir(), `dsh-archive-memory-smoke-${process.pid}.db`);
const embedder = new OllamaEmbedder();
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

const seed = [
  // preference 用户偏好
  { content: '用户喜欢用 PowerShell 而不是 cmd 执行系统命令', kind: 'preference', importance: 0.9, tags: ['user', 'shell'] },
  { content: '用户做项目时要求严谨自检：改动一处必须同步检查所有关联部分', kind: 'preference', importance: 0.95, tags: ['user', 'rule'] },
  { content: '用户偏好中文交流，回复时使用简体中文', kind: 'preference', importance: 0.8, tags: ['user', 'language'] },
  { content: '用户希望参考资料只允许参照经验、针对本项目特化后应用，禁止照搬', kind: 'preference', importance: 0.9, tags: ['user', 'rule'] },
  // semantic 语义/项目知识
  { content: '项目 DSH-ARCHIVE 阶段一已完成：无插件基础 DSH 实例位于工作区 dsh 目录', kind: 'semantic', importance: 0.8, tags: ['project'] },
  { content: 'DSH-ARCHIVE 项目目标：仿生、长时自主运行、自循环思考、自进化的 AI 智能体全能助手', kind: 'semantic', importance: 0.85, tags: ['project', 'goal'] },
  { content: 'ollama 已拉取中文 embedding 模型 shaw/dmeta-embedding-zh，向量维度 768', kind: 'semantic', importance: 0.6, tags: ['env'] },
  { content: 'dsh CLI 版本 0.1.1-rc.2，DSH_HOME 位于 C:\\Users\\ACTXY\\.dsh', kind: 'semantic', importance: 0.5, tags: ['env'] },
  { content: '记忆系统使用 SQLite 存储向量，Node 内置 node:sqlite 免原生编译', kind: 'semantic', importance: 0.7, tags: ['tech', 'memory'] },
  { content: '本机没有可用的系统级向量数据库服务，采用 SQLite+ollama 自建方案', kind: 'semantic', importance: 0.6, tags: ['tech', 'decision'] },
  { content: '项目文档规定五个阶段：基础DSH、记忆系统、人格系统、虚拟时钟与自进化、其他能力', kind: 'semantic', importance: 0.75, tags: ['project', 'roadmap'] },
  // episodic 事件
  { content: '2026-08-28 完成阶段一验收：archive profile 启动测试 12 秒无报错', kind: 'episodic', importance: 0.7, tags: ['milestone'] },
  { content: '2026-08-28 记忆系统冒烟测试首次运行发现 scan 语句漏选 tags 列导致崩溃，已修复', kind: 'episodic', importance: 0.6, tags: ['bug', 'lesson'] },
  { content: '2026-08-28 确认 ollama embedding 接口可用，dmeta 模型返回 768 维向量', kind: 'episodic', importance: 0.5, tags: ['milestone'] },
  { content: '窗外下雨了，今天出门要带伞', kind: 'episodic', importance: 0.3, tags: ['life'] },
  // procedural 过程/经验
  { content: '写代码时改动一处必须同步检查并更新所有关联部分，避免遗漏', kind: 'procedural', importance: 0.9, tags: ['rule', 'dev'] },
  { content: '排查问题先看直接证据（日志、数据库内容），不要凭猜测下结论', kind: 'procedural', importance: 0.85, tags: ['dev', 'lesson'] },
  { content: '给 SQLite 表加列前先确认所有 SELECT 语句都覆盖新列', kind: 'procedural', importance: 0.7, tags: ['dev', 'lesson'] },
  // general 一般事实
  { content: 'PowerShell 支持管道、对象化输出，适合 Windows 系统管理', kind: 'general', importance: 0.4, tags: ['tech'] },
  { content: 'SQLite 的 WAL 模式允许多进程并发读写同一数据库文件', kind: 'general', importance: 0.4, tags: ['tech'] },
  { content: '余弦相似度用于衡量两个向量的方向一致性，取值 -1 到 1', kind: 'general', importance: 0.3, tags: ['tech'] },
  { content: 'FTS5 是 SQLite 内置全文检索扩展，支持 BM25 排序', kind: 'general', importance: 0.4, tags: ['tech'] },
];

const store = new MemoryStore(dbPath);
try {
  console.log(`== 写入 ${seed.length} 条真实中文记忆（ollama 向量化）==`);
  const ids = [];
  for (const item of seed) {
    const vec = await embedder.embed(item.content);
    const { id } = store.write({ ...item, embedding: vec, source: 'smoke', lastVerified: Date.now() });
    ids.push(id);
  }
  check('全部写入成功', store.stats().total === seed.length, `total=${store.stats().total}`);
  check('FTS5 可用', store.stats().fts === true);
  const sample = store.get(ids[1]);
  check('新字段写入（confidence/lastVerified）', sample.confidence === 1 && typeof sample.lastVerified === 'number');

  console.log('== 语义召回（hybrid 默认）==');
  const q1 = await embedder.embed('用户偏好用什么命令行工具？');
  const r1 = store.recall({ embedding: q1, query: '命令行 工具 偏好', k: 3 });
  check('偏好命中第一', r1[0]?.content.includes('PowerShell'), `top=${r1[0]?.content.slice(0, 20)} score=${r1[0]?.score.toFixed(3)}`);

  const q2 = await embedder.embed('自进化 AI 智能体助手的项目目标？');
  const r2 = store.recall({ embedding: q2, query: '自进化 AI 智能体', k: 3 });
  const r2sem = store.recall({ embedding: q2, query: '自进化 AI 智能体', k: 3, mode: 'semantic' });
  const goalHyb = r2.find((m) => m.content.includes('仿生'));
  const goalSem = r2sem.find((m) => m.content.includes('仿生'));
  check('项目目标记忆语义命中第一', r2[0]?.content.includes('仿生'), `top=${r2[0]?.content.slice(0, 18)}`);
  check('关键词提升目标记忆得分', Boolean(goalHyb && goalSem && goalHyb.score >= goalSem.score), `hyb=${goalHyb?.score.toFixed(3)} sem=${goalSem?.score.toFixed(3)}`);

  const q3 = await embedder.embed('做开发时有什么纪律要求？');
  const r3 = store.recall({ embedding: q3, query: '开发 纪律 检查', k: 4 });
  check('开发纪律记忆召回', r3.some((m) => m.content.includes('关联部分')), `top=${r3[0]?.content.slice(0, 20)}`);

  console.log('== keyword 纯关键词模式 ==');
  const kw = store.recall({ query: 'PowerShell', k: 3, mode: 'keyword' });
  check('关键词命中 PowerShell 记忆', kw.some((m) => m.content.includes('PowerShell')), `n=${kw.length}`);

  console.log('== 无向量记忆的混合召回 ==');
  const noEmb = store.write({ content: '临时备注：明天 14 点与用户开会讨论人格系统设计', kind: 'episodic', importance: 0.4, source: 'smoke-noembed' });
  const hybNoEmb = store.recall({ embedding: await embedder.embed('人格系统会议安排'), query: '人格系统 开会', k: 30 });
  const noEmbHit = hybNoEmb.find((m) => m.id === noEmb.id);
  check('hybrid 可召回无向量记忆（关键词路径）', Boolean(noEmbHit), `score=${noEmbHit?.score.toFixed(3)}`);
  check('无向量记忆获得关键词得分', Boolean(noEmbHit && noEmbHit.score > 0));
  const semNoEmb = store.recall({ embedding: await embedder.embed('人格系统会议安排'), query: '人格系统 开会', k: 30, mode: 'semantic' });
  check('semantic 模式不返回无向量记忆（符合设计）', !semNoEmb.some((m) => m.id === noEmb.id));
  store.remove(noEmb.id);

  console.log('== semantic 纯语义模式 ==');
  const sem = store.recall({ embedding: q1, query: '命令行', k: 3, mode: 'semantic' });
  check('纯语义也能命中偏好', sem[0]?.content.includes('PowerShell'), `top=${sem[0]?.content.slice(0, 16)}`);

  console.log('== 过滤与阈值 ==');
  const kinds = store.recall({ embedding: q1, query: '偏好', k: 10, kinds: ['preference'] });
  check('kind 过滤只返回 preference', kinds.every((m) => m.kind === 'preference') && kinds.length >= 1);
  const strict = store.recall({ embedding: q1, query: '命令行', k: 5, minScore: 0.95 });
  check('minScore=0.95 过滤低分', strict.every((m) => m.score >= 0.95));

  console.log('== 访问统计与删除 ==');
  const before = store.get(ids[0]).accessCount;
  void store.recall({ embedding: q1, query: '命令行', k: 1 });
  check('召回后 access_count 递增', store.get(ids[0]).accessCount > before);
  check('删除', store.remove(ids[20]) === true && store.get(ids[20]) === null);
  check('删除后关键词不再命中', !store.recall({ query: '余弦相似度', k: 3, mode: 'keyword' }).some((m) => m.id === ids[20]));

  console.log('== 跨进程持久化（模拟跨会话）==');
  store.close();
  const store2 = new MemoryStore(dbPath);
  const persisted = store2.stats().total;
  check('重开数据库后记忆仍在', persisted === seed.length - 1, `total=${persisted}`);
  const qr = await embedder.embed('用户的开发纪律是什么');
  const r4 = store2.recall({ embedding: qr, query: '开发 纪律', k: 2 });
  check('重开后混合检索正常', r4.length >= 1, `top=${r4[0]?.content.slice(0, 20)}`);

  console.log('== 用户画像（长期稳定事实）==');
  const p1 = store2.profileSet({ key: 'shell', content: '用户喜欢用 PowerShell 而不是 cmd', confidence: 0.9, source: 'smoke' });
  check('画像写入', p1.key === 'shell' && p1.evidenceCount === 1);
  const p2 = store2.profileSet({ key: 'shell', content: '用户喜欢用 PowerShell 而不是 cmd' }); // 同内容再确认
  check('同内容再确认证据计数+1', p2.evidenceCount === 2, `evidence=${p2.evidenceCount}`);
  const p3 = store2.profileSet({ key: 'shell', content: '用户喜欢用 pwsh 执行命令' }); // 内容变化 → 覆盖重置
  check('内容变化覆盖并重置计数', p3.content.includes('pwsh') && p3.evidenceCount === 1);
  check('画像按 key 读取', store2.profileGet('shell')?.content.includes('pwsh'));
  const pList = store2.profileList();
  check('画像列表', pList.length === 1 && pList[0].key === 'shell');
  store2.profileSet({ key: 'name', content: '用户偏好中文交流', source: 'smoke' });
  check('画像统计', store2.profileStats().total === 2);
  check('画像删除', store2.profileRemove('shell') === true && store2.profileGet('shell') === null);

  console.log('== 用户当前状态（短期实时 + TTL）==');
  const s1 = store2.stateSet({ state: '睡眠中', detail: '用户去睡觉了', confidence: 0.95, evidence: '用户说：我去睡觉了', ttlSeconds: 3600 });
  check('状态写入', s1.state === '睡眠中' && s1.expiresAt > Date.now());
  store2.stateSet({ state: '困了', evidence: '语气低沉', ttlSeconds: 0.001 }); // 立即过期
  await sleep(10); // 等 1ms TTL 到期，避免毫秒级竞态
  const active1 = store2.stateGet();
  check('有效状态仅含未过期', active1.length === 1 && active1[0].state === '睡眠中', `active=${active1.map((s) => s.state).join(',')}`);
  const s3 = store2.stateSet({ state: '睡眠中', detail: '仍在睡', evidence: '2 小时后仍无回应' }); // 同状态更新保留 set_at
  const active2 = store2.stateGet();
  check('同状态更新保留首次设定时间', active2[0].setAt === s1.setAt && active2[0].detail === '仍在睡');
  const hist = store2.stateHistory(10);
  check('状态历史含已过期条目', hist.some((s) => s.state === '困了'));
  check('状态清除', store2.stateClear('睡眠中') === true && store2.stateGet().length === 0);
  check('状态统计（过期条目留作历史）', store2.stateStats().total === 1);

  store2.close();

  console.log(failures.length === 0 ? '\nSMOKE RESULT: ALL PASS' : `\nSMOKE RESULT: ${failures.length} FAILED`);
} catch (error) {
  console.error('SMOKE CRASH:', error);
  failures.push(`crash: ${error.message}`);
} finally {
  try { store.close(); } catch {}
  if (!keep) rmSync(dbPath, { force: true });
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
}
process.exit(failures.length === 0 ? 0 : 1);
