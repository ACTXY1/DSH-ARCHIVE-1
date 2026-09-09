/**
 * 人格存储单测：CRUD、版本化、溯源、留档账本、回滚接口、持久化。
 * 用法：node scripts/persona-test.js
 */
import { rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaStore } from '../lib/persona-store.js';

const dir = join(tmpdir(), `persona-test-${process.pid}`);
const path = join(dir, 'persona.json');
const historyPath = join(dir, 'persona-history.jsonl');
const failures = [];

function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

try {
  rmSync(dir, { recursive: true, force: true });
  const store = new PersonaStore({ path, historyPath });

  console.log('== 设定基础人格 ==');
  const r1 = store.set([
    { section: 'identity', content: '我是 DSH-ARCHIVE 的全能 AI 助手', importance: 1.0 },
    { section: 'values', content: '诚实、可靠、尊重用户', importance: 0.9 },
    { section: 'traits', content: '沉稳、细致、主动', importance: 0.8 },
    { section: 'style', content: '简洁清晰的中文表达', importance: 0.7 },
    { section: 'directives', content: '改动代码必须同步检查所有关联部分', importance: 0.95 },
    { section: 'capabilities', content: '记忆/检索/画像/状态感知', importance: 0.6 },
  ]);
  check('批量写入 6 条', r1.added === 6 && r1.version === 1, `version=${r1.version}`);
  check('stats 统计', store.stats().total === 6 && store.stats().version === 1);
  check('渲染为 XML 块', store.render().startsWith('<persona version="1">') && store.render().includes('<identity>我是 DSH-ARCHIVE 的全能') && store.render().endsWith('</persona>'));
  check('分区以标签呈现', store.render().includes('<directives>改动代码') && store.render().includes('<style>简洁'));

  console.log('== 自进化增补（by=evolution）与溯源 ==');
  const all = store.get();
  const firstId = all.sections.identity[0].id;
  const r2 = store.update(firstId, { content: '我是 DSH-ARCHIVE 的长时自主运行 AI 全能助手', by: 'evolution' });
  check('evolution 更新生效', r2?.modifiedBy === 'evolution' && r2.content.includes('长时自主运行'), `version=${store.stats().version}`);
  check('版本递增', store.stats().version === 2);

  console.log('== 留档账本（含快照）==');
  const hist = store.history();
  check('账本记录 2 条', hist.length === 2, `n=${hist.length}`);
  check('账本含完整快照', hist[0].sections?.identity?.length === 1 && hist[0].version === 2);
  check('账本含修改者', hist[0].by === 'evolution');

  console.log('== 回滚接口 ==');
  const okRoll = store.rollback(1, 'user');
  check('回滚到 v1 成功', okRoll === true && store.stats().version === 3);
  const entryAfter = store.getEntry(firstId);
  check('回滚后内容恢复 v1', entryAfter?.content.includes('全能 AI 助手') && !entryAfter.content.includes('长时自主运行'));
  check('回滚也留档', store.history()[0].summary.includes('回滚'));

  console.log('== 删除 ==');
  const removeId = store.get().sections.traits[0].id;
  check('删除条目', store.remove(removeId) === true && store.getEntry(removeId) === null);
  check('删除留档', store.history()[0].summary.includes('删除'));

  console.log('== 持久化（重开）==');
  const store2 = new PersonaStore({ path, historyPath });
  check('重开数据完好', store2.stats().total === 5 && store2.stats().version === 4);
  check('重开账本仍在', store2.history().length >= 4);

  console.log('== 非法输入防护 ==');
  try { store2.set([{ section: 'bad', content: 'x' }]); check('非法 section 抛错', false); } catch { check('非法 section 抛错', true); }
  try { store2.set([{ section: 'identity', content: '' }]); check('空 content 抛错', false); } catch { check('空 content 抛错', true); }

  console.log('== XML 转义（不影响版本计数）==');
  const esc = store2.set([{ section: 'traits', content: '喜欢 <代码> 与 & 符号' }]);
  const escRender = store2.render();
  check('特殊字符被转义', escRender.includes('&lt;代码&gt;') && escRender.includes('&amp;') && !escRender.includes('<代码>'));
  check('转义后块仍闭合', escRender.endsWith('</persona>'));

  console.log('== 整体重建 replace（2026-09-08 一键凝练写入）==');
  // 独立小库验证：set 2 条（不同分区）→ replace 为 1 条合并条目（带 mergedFrom 溯源）→ 版本只 +1、
  // 空分区保留、账本含旧快照、回滚回到 replace 前
  const dirR = join(dir, 'r');
  const storeR = new PersonaStore({ path: join(dirR, 'persona.json'), historyPath: join(dirR, 'persona-history.jsonl') });
  const rSet = storeR.set([
    { section: 'traits', content: '主动关心用户作息', importance: 0.6, by: 'user' },
    { section: 'traits', content: '设身处地预判用户需求', importance: 0.6, by: 'user' },
  ], { by: 'user', summary: '初始' });
  const vBefore = rSet.version;
  const id1 = storeR.get().sections.traits[0].id;
  const id2 = storeR.get().sections.traits[1].id;
  const rRep = storeR.replace([{
    section: 'traits', content: '主动为用户着想：预判需求与作息，在恰当时主动关心。', importance: 0.8,
    source: 'distill', mergedFrom: [id1, id2],
  }], { by: 'distill', summary: '手动凝练：重建为 1 条' });
  check('replace 版本 +1 且 added=1', rRep.version === vBefore + 1 && rRep.added === 1);
  const rData = storeR.get();
  check('replace 后仅目标分区有条目（其余空分区保留）', rData.sections.traits.length === 1 && rData.sections.identity.length === 0 && rData.sections.values.length === 0 && rData.sections.style.length === 0 && rData.sections.directives.length === 0 && rData.sections.capabilities.length === 0);
  const rEntry = rData.sections.traits[0];
  check('replace 条目溯源（by=distill/source/mergedFrom）', rEntry.addedBy === 'distill' && rEntry.source === 'distill' && Array.isArray(rEntry.mergedFrom) && rEntry.mergedFrom.length === 2 && rEntry.importance === 0.8);
  check('replace 留档（新快照 + 旧快照在前条可回滚）', storeR.history()[0].summary.includes('凝练') && storeR.history()[0].sections.traits.length === 1 && storeR.history()[1].sections.traits.length === 2);
  check('replace 后回滚到凝练前', storeR.rollback(vBefore, 'user') === true && storeR.stats().version === vBefore + 2 && storeR.get().sections.traits.length === 2);
  try { storeR.replace([{ section: 'nope', content: 'x' }]); check('replace 非法 section 抛错', false); } catch { check('replace 非法 section 抛错', true); }
  try { storeR.replace([{ section: 'traits', content: '' }]); check('replace 空 content 抛错', false); } catch { check('replace 空 content 抛错', true); }

  console.log('== 损坏文件降级启动 ==');
  writeFileSync(path, '{ 这不是合法 JSON', 'utf8');
  const store3 = new PersonaStore({ path, historyPath });
  check('损坏文件以空人格启动', store3.stats().total === 0 && store3.stats().version === 0);
  const corruptFiles = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  check('损坏文件已改名保留', corruptFiles.length === 1, `files=${corruptFiles.join(',')}`);
  check('账本仍可读（可回滚恢复）', store3.history().length >= 4);

  console.log(failures.length === 0 ? '\nPERSONA TEST: ALL PASS' : `\nPERSONA TEST: ${failures.length} FAILED`);
} catch (error) {
  console.error('PERSONA TEST CRASH:', error);
  failures.push(`crash: ${error.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures.length === 0 ? 0 : 1);
