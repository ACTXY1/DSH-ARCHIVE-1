// 验证插件 apply：persona systemPrompt context 注册 + 注入文本 + 工具注册
// 断言用结构校验而非写死内容：真实 persona.json 是自进化产物（version 随采纳递增、identity 分区可能为空），写死会误报 FAIL。
const pluginUrl = 'file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-persona/lib/index.js';
const mod = await import(pluginUrl);

const registeredContexts = [];
const registeredTools = [];
const ctx = {
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  provide: () => {},
  on: () => {},
  get: (name) => name === 'tools' ? { register: (t) => registeredTools.push(t.name) } : undefined,
  systemPrompt: { context: (c) => registeredContexts.push(c) },
};

mod.apply(ctx, { personaPath: 'C:/DSH-ARCHIVE/dsh/data/persona.json', injectOrder: 500, injectEnabled: true });

const ctxReg = registeredContexts.find((c) => c.name === 'persona-identity');
const rendered = ctxReg?.text?.({});
console.log('--- persona 注入文本 ---');
console.log(rendered);
console.log('--- 断言 ---');
const checks = [
  ['注册 persona-identity context', Boolean(ctxReg)],
  ['order 正确', ctxReg?.order === 500],
  ['text 为函数且渲染非空', typeof ctxReg?.text === 'function' && typeof rendered === 'string' && rendered.length > 0],
  ['注入为 XML 块', rendered?.startsWith('<persona') && rendered?.endsWith('</persona>')],
  ['版本属性存在且为数字', /<persona version="\d+">/.test(rendered ?? '')],
  ['内容分区 XML 标签成对闭合', (() => { const tags = [...String(rendered).matchAll(/<(\w+)>/g)].map((m) => m[1]); return tags.length > 0 && tags.every((t) => rendered.includes(`</${t}>`)); })()],
  ['3 个工具注册', registeredTools.join(',') === 'persona_view,persona_set,persona_update'],
];
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
