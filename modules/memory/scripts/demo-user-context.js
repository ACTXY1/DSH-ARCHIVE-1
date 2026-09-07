// 真实库演示：用户画像 + 当前状态（"睡眠中"场景），并渲染注入快照
import { MemoryCore } from '../lib/core.js';

const core = new MemoryCore({
  dbPath: 'C:/DSH-ARCHIVE/dsh/data/memory.db',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: 'shaw/dmeta-embedding-zh:latest',
  defaultStateTtlSeconds: 14400,
});

console.log('== 写入用户画像 ==');
const p1 = core.profileSet({ key: 'language', content: '用户偏好简体中文交流', confidence: 0.9, source: 'user' });
const p2 = core.profileSet({ key: 'shell', content: '用户喜欢用 PowerShell 而不是 cmd', confidence: 0.85, source: 'ai-inference' });
console.log(`  画像: ${p1.key}=${p1.content} (${p1.evidenceCount} 证据) / ${p2.key}=${p2.content}`);

console.log('== 用户说"我去睡觉了" → 状态更新 ==');
const st = core.stateSet({
  state: '睡眠中',
  detail: '用户去睡觉了',
  confidence: 0.95,
  evidence: '用户原话：我去睡觉了',
  source: 'ai-inference',
  ttlSeconds: 8 * 3600,
});
console.log(`  状态: ${st.state} 至 ${st.expiresAt ? new Date(st.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '不过期'}`);

console.log('== AI 每回合注入的"变量"快照 ==');
const snap = core.snapshot();
console.log(snap);

console.log('== 状态统计 ==');
console.log(' ', JSON.stringify(core.stateStats()));
console.log(' ', JSON.stringify(core.profileStats()));
core.close();
