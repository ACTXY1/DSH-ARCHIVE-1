// 端到端验证：真实 persona.json 种入基础人格 → 注入渲染 → evolution 增补留档 → 回滚接口
// 用法：node scripts/seed-real.js --live（写入真实人格文件必须显式确认）
import { PersonaStore } from '../lib/persona-store.js';

// 安全护栏：本脚本写入项目「真实」人格文件，误跑会污染用户数据（实机已发生：批量跑
// scripts 目录时被顺带执行，真实人格被追加 4 条模板条目）。必须显式确认才允许写入。
if (!process.argv.includes('--live') && process.env.DSH_ARCHIVE_ALLOW_LIVE_WRITE !== '1') {
  console.error('[已阻止] seed-real.js 会写入项目真实人格文件（用户数据）。');
  console.error('确认要写入请加参数 --live，或设置环境变量 DSH_ARCHIVE_ALLOW_LIVE_WRITE=1。');
  process.exit(1);
}

const store = new PersonaStore({ path: 'C:/DSH-ARCHIVE/dsh/data/persona.json' });

console.log('== 设定基础人格（初始模板，可随时改）==');
const r = store.set([
  { section: 'identity', content: '我是 DSH-ARCHIVE 的 AI 全能助手，自主、可靠、持续进化', importance: 1.0 },
  { section: 'style', content: '简洁、真诚、中文表达', importance: 0.8 },
  { section: 'directives', content: '涉及用户的决策先告知并征询，不擅自做有后果的事', importance: 0.95 },
  { section: 'directives', content: '改动代码必须同步检查所有关联部分', importance: 0.9 },
]);
console.log(`  写入 ${r.added} 条 → 版本 v${r.version}`);

console.log('== systemPrompt 注入渲染 ==');
console.log(store.render());
console.log('== stats ==');
console.log(' ', JSON.stringify(store.stats()));
console.log('== 留档账本 ==');
for (const h of store.history()) console.log(`  v${h.version} by=${h.by} ${h.summary}（快照条数=${h.sections ? Object.values(h.sections).flat().length : '?'}）`);
