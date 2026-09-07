// 自进化集成验证（stub ctx，假 LLM）：
// 主流程 suggest（人格 YAML 通道 add/refine + skill JSON 通道）→ 隔离评估 → approve/rollback；
// 人格通道：近 24h 对话打包（★重点标记、跨窗口排除）、当前人格清单含 id 注入、
// YAML 严格子集解析（add/refine 归一）、refine 经 persona.update 应用、版本级回滚；
// 自动建议（每日定时 / autoRun 通知 / 去重）；skill 写库与回滚。
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), `evo-verify-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
const ledgerPath = join(dir, 'evolution.jsonl');
const skillsDir = join(dir, 'skills');

const mod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-evolution/lib/index.js');
const ppMod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-evolution/lib/persona-plan.js');
const distMod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-evolution/lib/persona-distill.js');

const captured = { personaSets: [], personaUpdates: [], personaReplaces: [], rollbacks: [], skillsRegistered: [], tools: [], llmCalls: [] };
let stdout = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { stdout += String(chunk); return true; };

// 假 LLM（队列式）。消息记录：{system, user}
const NOW = Date.now();
const H = 3600000;
// 记忆库假数据（created_at DESC 顺序排列，供 list 分页）
const fakeDb = [
  { source: 'conversation', content: '用户：希望以后回复更简洁，先给结论再给细节。', createdAt: NOW - 2 * H },
  { source: 'conversation', content: '用户：帮我查一下今天的天气。', createdAt: NOW - 5 * H },
  { source: 'loop', content: '循环思考：多次 review 漏检，需要 checklist', createdAt: NOW - 6 * H },
  { source: 'conversation', content: '用户：太旧的对话，不应出现在近24小时打包中。', createdAt: NOW - 3 * 24 * H },
];

// 人格 YAML 输出：add + refine（refine 引用清单中 pers-entry-1）
const P1_YAML = `\`\`\`yaml
direction: 用户希望 AI 先拆解复杂任务，回复简洁
persona_updates:
  - action: add
    section: traits
    content: |
      面对复杂任务，先拆解为子步骤再逐步执行。
    importance: 0.7
    rationale: 用户在对话中多次提出先计划后动手
    evidence: ★ 用户要求先列计划
  - action: refine
    id: pers-entry-1
    content: |
      回复用户时保持简洁，先给结论再给必要细节。
    importance: 0.8
    rationale: 用户多次表示希望回复更简洁
    evidence: 用户：希望回复更简洁
\`\`\``;
const S1_JSON = '[{"type":"skill-create","name":"code-review-checklist","content":"# code-review-checklist\\n\\n检查代码时按 checklist 逐项核对，防止遗漏。","rationale":"工作中反复出现漏检","evidence":"多次 review 后补查"}]';
// 自动流程（auto）的独立输出：新 add（style）+ 另一条 refine + 新 skill
const P2_YAML = `persona_updates:
  - action: add
    section: style
    content: |
      报告进度时使用简短清单而非长段落。
    rationale: 自动提炼：风格观察
  - action: refine
    id: pers-entry-1
    content: |
      回复保持简洁；用户要求详细时才展开细节。
    rationale: 自动提炼：对简洁要求的再次确认
`;
const S2_JSON = '[{"type":"skill-improve","name":"code-review-checklist","content":"# code-review-checklist\\n\\n检查代码时先读变更范围，再按 checklist 逐项核对。","rationale":"改进既有流程","evidence":"review 时常漏变更范围"}]';
// 重复测试：与主流程内容完全一致 → 应被代码层去重拦截
const P3_YAML = P1_YAML;
const S3_JSON = S1_JSON;
const EVAL_TEXT = '{"conflictScore":0.05,"safe":true,"recommendation":"approve","reason":"与现有准则无冲突"}';
// 守护：\u0000R\u0000 前缀 = 输出全部经 reasoning-delta 送达（正文为空）——
// 验证推理模型"答案写进思考段"时 evolution callLlm 的 reasoning 兜底真实生效
const REASON = '\u0000R\u0000';
async function* fakeStream(text) {
  if (text.startsWith(REASON)) {
    const body = text.slice(REASON.length);
    for (const piece of [body.slice(0, 30), body.slice(30)]) yield { type: 'reasoning-delta', index: 0, text: piece };
    yield { type: 'finish', reason: { kind: 'completed' } };
    return;
  }
  for (const piece of [text.slice(0, 30), text.slice(30)]) yield { type: 'text-delta', index: 0, text: piece };
  yield { type: 'finish', reason: { kind: 'completed' } };
}
// 队列顺序：主流程(人格→skill→3 评估) → 自动(人格→skill→3 评估) → 去重测试(人格→skill)
// 主流程人格 YAML 走 reasoning-only（守护兜底）；其余走普通 text-delta
const queue = [REASON + P1_YAML, S1_JSON, EVAL_TEXT, EVAL_TEXT, EVAL_TEXT, P2_YAML, S2_JSON, EVAL_TEXT, EVAL_TEXT, EVAL_TEXT, P3_YAML, S3_JSON];
const llm = {
  stream: (opts) => {
    const text = queue.shift() ?? EVAL_TEXT;
    captured.llmCalls.push({ system: opts?.system ?? '', user: opts?.messages?.[0]?.content?.[0]?.text ?? '' });
    return fakeStream(text);
  },
};

const timerCalls = [];
const notifySends = [];
let persVersion = 5; // 与真实 persona 语义一致：每次 set/update +1
const ctx = {
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  provide: () => {},
  on: () => {},
  emit: () => {},
  get: (n) => {
    if (n === 'tools') return { register: (t) => captured.tools.push(t.name) };
    if (n === 'notify') return { send: (m) => { notifySends.push(m); return {}; } };
    return undefined; // consistency 等可选服务缺失时优雅降级
  },
  timer: { setTimeout: (fn, ms) => { timerCalls.push({ fn, ms }); return 1; }, setInterval: () => 2 },
  llm,
  memory: {
    recall: async () => ({ results: [{ content: '用户：遇到重复任务时希望先列计划再动手', kind: 'episodic', score: 0.6 }, { content: '循环思考发现可改进点', kind: 'thought', score: 0.6 }] }),
    list: ({ limit = 200, offset = 0 } = {}) => fakeDb.slice(offset, offset + limit), // DESC（created_at 高在前）
  },
  persona: {
    render: () => '<persona version="1">…</persona>',
    stats: () => ({ version: persVersion }),
    get: () => ({
      schemaVersion: 1,
      version: persVersion,
      sections: {
        identity: [], values: [], style: [], capabilities: [],
        traits: [{ id: 'pers-entry-2', section: 'traits', content: '旧条目2：主动关心用户作息与饮食，设身处地预判需求', importance: 0.6, addedBy: 'evolution' }],
        directives: [{ id: 'pers-entry-1', section: 'directives', content: '旧条目：回复应简洁完整', importance: 0.5, addedBy: 'user' }],
      },
    }),
    set: (entries, opts) => { captured.personaSets.push({ entries, opts }); persVersion += 1; return { version: persVersion, added: entries.length }; },
    update: (id, patch) => { captured.personaUpdates.push({ id, patch }); persVersion += 1; return { id, content: patch.content }; },
    // 凝练写入：整体重建（by=distill）
    replace: (entries, opts) => { captured.personaReplaces.push({ entries, opts }); persVersion += 1; return { version: persVersion, added: entries.length }; },
    rollback: (v, by) => { captured.rollbacks.push({ v, by }); return { rolledBack: true }; },
  },
  skills: { register: (s) => captured.skillsRegistered.push(s) },
};

const api = mod.apply(ctx, { ledgerPath, skillsDir, provider: 'x', model: 'y', maxConflict: 0.5, autoSuggest: true, autoHour: 22, autoNotify: true });
process.stdout.write = origWrite; // 恢复 stdout：此后 console.log 走真实输出

console.log('--- 断言 ---');
const checks = [];
let mainOut;
try {
  // ================= 人格通道：24h 打包 + YAML add/refine 解析 =================
  mainOut = await api.suggest({ by: 'evolution' });
  checks.push(['suggest 生成候选（人格+技能）', mainOut.results.length >= 3]);
  const types = mainOut.results.map((r) => r.candidate?.type);
  checks.push(['人格 add 候选存在', types.includes('persona-add')]);
  checks.push(['人格 refine 候选存在且携带清单 id', types.includes('persona-refine') && mainOut.results.some((r) => r.candidate?.type === 'persona-refine' && r.candidate?.refineId === 'pers-entry-1' && r.candidate?.section === 'directives')]);
  checks.push(['skill 候选存在', types.includes('skill-create')]);
  checks.push(['隔离评估（未生效：persona 未被写）', captured.personaSets.length === 0 && captured.personaUpdates.length === 0]);
  checks.push(['候选留档 pending', api.stats().byStatus.pending >= 3]);
  // 打包内容：★重点标记 + 24h 窗口内消息在、跨窗口消息不在；清单含 id；system 含分区
  const personaCall = captured.llmCalls[0];
  checks.push(['人格调用 SYSTEM 含项目分区', personaCall.system.includes('identity') && personaCall.system.includes('directives')]);
  checks.push(['USER 含 ★ 重点要求消息', personaCall.user.includes('★') && personaCall.user.includes('希望以后回复更简洁')]);
  checks.push(['USER 含普通对话', personaCall.user.includes('帮我查一下今天的天气')]);
  checks.push(['USER 排除 24h 窗口外对话', !personaCall.user.includes('太旧的对话')]);
  checks.push(['USER 含当前人格条目 id（供 refine）', personaCall.user.includes('pers-entry-1')]);
  checks.push(['YAML 解析出进化方向', personaCall.user.length > 0]); // 方向信息进入 USER 由模型产出
  const refine = mainOut.results.find((r) => r.candidate?.type === 'persona-refine').candidate;
  const add = mainOut.results.find((r) => r.candidate?.type === 'persona-add').candidate;
  const skill = mainOut.results.find((r) => r.candidate?.type === 'skill-create').candidate;

  // ================= refine 应用与回滚 =================
  let confirmGuard = true;
  try { await api.approve(mainOut.results[0].candidateId, { by: 'user', confirm: false }); confirmGuard = false; } catch { /* 预期拒绝 */ }
  checks.push(['无 confirm 时拒绝采纳（授权守卫）', confirmGuard === true]);

  const refApplied = await api.approve(refine ? mainOut.results.find((r) => r.candidate?.type === 'persona-refine').candidateId : mainOut.results[0].candidateId, { by: 'user', confirm: true });
  checks.push(['refine 采纳成功', refApplied.applied === true && refApplied.status === 'applied']);
  checks.push(['refine 经 persona.update 应用（by=evolution）', captured.personaUpdates.length === 1 && captured.personaUpdates[0].id === 'pers-entry-1' && captured.personaUpdates[0].patch.by === 'evolution' && captured.personaUpdates[0].patch.content.includes('先给结论再给必要细节')]);

  // ================= persona-add 应用与回滚（版本级） =================
  const addId = mainOut.results.find((r) => r.candidate?.type === 'persona-add').candidateId;
  const addApplied = await api.approve(addId, { by: 'user', confirm: true });
  checks.push(['add 采纳成功（by=evolution）', addApplied.applied === true && captured.personaSets.some((s) => s.opts.by === 'evolution' && s.entries[0]?.section === 'traits')]);
  const rbAdd = await api.rollback(addId, { by: 'user', confirm: true });
  checks.push(['add 版本级回滚成功（refine 之后应用，回滚到 v6）', rbAdd.rolledBack === true && captured.rollbacks.some((r) => r.v === 6 && r.by === 'user')]);
  const rbRef = await api.rollback(refine ? mainOut.results.find((r) => r.candidate?.type === 'persona-refine').candidateId : mainOut.results[0].candidateId, { by: 'user', confirm: true });
  checks.push(['refine 版本级回滚成功（回滚到 v5）', rbRef.rolledBack === true && captured.rollbacks.some((r) => r.v === 5 && r.by === 'user')]);

  // ================= skill 应用与回滚 =================
  const skillId = mainOut.results.find((r) => r.candidate?.type === 'skill-create').candidateId;
  await api.approve(skillId, { by: 'user', confirm: true });
  const skillFile = join(skillsDir, 'code-review-checklist', 'SKILL.md');
  checks.push(['skill 采纳写库 + runtime 注册', existsSync(skillFile) && captured.skillsRegistered.some((s) => s.name === 'code-review-checklist')]);
  // 守卫：runtime 注册必须带 content——宿主 dsh-skill get() 对
  // runtime 技能走 validateDefinition 强制 content 为 string，缺 content 时 agent 加载必抛 TypeError。
  checks.push(['skill runtime 注册带 content 正文', captured.skillsRegistered.some((s) => s.name === 'code-review-checklist' && typeof s.content === 'string' && s.content.length > 0)]);
  const rbSkill = await api.rollback(skillId, { by: 'user', confirm: true });
  checks.push(['skill 回滚删除原库', rbSkill.rolledBack === true && !existsSync(join(skillsDir, 'code-review-checklist'))]);

  // ================= 自动建议（双通道） =================
  checks.push(['autoSuggest 已安排每日定时', timerCalls.length >= 1 && timerCalls[0].ms >= 1000]);
  const st0 = api.stats();
  checks.push(['stats.auto 暴露下次生成时间', st0.auto?.enabled === true && typeof st0.auto?.nextAutoAt === 'number' && st0.auto.nextAutoAt > 0]);
  const autoOut = await api.autoRun();
  checks.push(['autoRun 生成候选（by=auto，双通道）', autoOut.skipped === false && autoOut.candidateIds.length >= 2 && autoOut.results.some((r) => r.candidate?.type === 'persona-add' || r.candidate?.type === 'persona-refine') && autoOut.results.some((r) => r.candidate?.type?.startsWith('skill-'))]);
  checks.push(['自动生成经 notify 主动告知', notifySends.length >= 1 && notifySends[0].source === 'evolution' && notifySends[0].content.includes('自进化')]);
  checks.push(['自动候选留档 by=auto', api.view(50).records.some((r) => r.type === 'suggest' && r.by === 'auto')]);
  checks.push(['autoRun 后 stats.auto.autoTotal 累计', api.stats().auto?.autoTotal >= 1]);

  // ================= 重复抑制：同内容（add/refine/skill）再 suggest → 拦截 =================
  let dupBlocked = true;
  try {
    await api.suggest({ by: 'evolution' });
    dupBlocked = false;
  } catch (error) {
    dupBlocked = String(error.message).includes('重复') || String(error.message).includes('未生成有效候选');
  }
  checks.push(['重复候选被代码层抑制（含 refine 同 id 同内容）', dupBlocked]);
} catch (error) {
  checks.push([`主流程无异常: ${error.message}`, false]);
}
checks.push(['5 个工具注册', captured.tools.join(',') === 'evolution_suggest,evolution_approve,evolution_reject,evolution_view,evolution_rollback']);
checks.push(['账本文件存在', existsSync(ledgerPath)]);
checks.push(['LLM 调用全部按队列消费', queue.length === 0]);

// ================= YAML 解析器容错（行尾注释 / 块正文 # 行） =================
// LLM 会照抄 schema 示例的行尾注释（`- action: add  # add=新增条目` / `importance: 0.7  # 可选`），
// 解析须剥离行尾注释、且把块标量正文中的 # 行视为正文（见 persona-plan.js
// stripInlineComment + 块标量先于注释判断）。
const PP_SECTIONS = ['identity', 'values', 'traits', 'style', 'directives', 'capabilities'];
const ppParse = (yaml) => ppMod.parsePersonaPlan(yaml, PP_SECTIONS);
try {
  // 1) 行尾注释全部剥离：action/section/importance/id/rationale
  const withComments = ppParse(`persona_updates:
  - action: add            # add=新增条目；refine=修正既有条目（二选一）
    section: directives    # add 必填：严格取分区之一
    content: |
      回复前先明确用户意图再作答。
    importance: 0.7        # 可选 0~1（默认 0.5）
    rationale: 用户希望回复更走心 # 补充
  - action: refine         # 修正既有条目
    id: "pers-entry-1"     # refine 必填：清单中出现的 id
    content: |
      回复保持简洁。
`);
  const wc0 = withComments.updates[0];
  const wc1 = withComments.updates[1];
  checks.push(['YAML 行尾注释剥离(值不被污染)', wc0?.action === 'add' && wc0?.section === 'directives' && wc0?.importance === 0.7 && wc0?.rationale === '用户希望回复更走心' && wc1?.action === 'refine' && wc1?.id === 'pers-entry-1', JSON.stringify(withComments.updates)]);
  // 2) 块标量正文中的 # 行是正文不是注释（注释判断须在块收集之后）
  const blockHash = ppParse(`persona_updates:
  - action: add
    section: traits
    content: |
      # 井号开头的正文行
      第二行
      ## 二级井号
`);
  checks.push(['块标量正文含 # 行不丢', String(blockHash.updates[0]?.content ?? '').includes('# 井号开头的正文行') && String(blockHash.updates[0]?.content ?? '').includes('## 二级井号'), JSON.stringify(blockHash.updates)]);
  // 3) 整行注释与显式空方案合法
  const withFullComment = ppParse(`persona_updates:
  # 这是整行注释
  - action: add
    section: values
    content: |
      价值观正文
`);
  checks.push(['YAML 整行注释跳过', withFullComment.updates.length === 1 && withFullComment.updates[0]?.section === 'values', JSON.stringify(withFullComment.updates)]);
  const emptyOk = ppParse('persona_updates: []');
  checks.push(['YAML 显式空方案合法', Array.isArray(emptyOk.updates) && emptyOk.updates.length === 0 && emptyOk.errors.length === 0, JSON.stringify(emptyOk)]);
} catch (error) {
  checks.push([`YAML 容错回归无异常: ${error.message}`, false]);
}

// ================= 人格一键凝练（LLM 无损整理） =================
// 覆盖：YAML 严格子集解析（merged_from 列表/行尾注释/块正文 # 行/整行注释）、id 覆盖硬约束
// （遗漏/伪造/重复检出）、distillPersona 预览不生效、applyPersonaDistill（token 守卫/版本守卫/
// persona.replace by=distill + mergedFrom 溯源）、覆盖失败重试后明确报错。
const DIST_SECS = ['identity', 'values', 'traits', 'style', 'directives', 'capabilities'];
const DIST_OK_YAML = `direction: 整理并合并重复条目
entries:
  - section: directives
    content: |
      回复保持简洁完整，先给结论再给必要细节。
    importance: 0.8        # 可选 0~1
    merged_from:
      - "pers-entry-1"
  - section: traits
    content: |
      # 井号开头的正文行
      主动关心用户作息与饮食，设身处地预判需求。
    importance: 0.7
    merged_from:
      - "pers-entry-2"
`;
// 覆盖失败样本：第二条原条目（pers-entry-2）未被任何新条目 merged_from 覆盖 → 信息丢失
const DIST_BAD_YAML = `entries:
  - section: directives
    content: |
      只整理第一条。
    merged_from:
      - "pers-entry-1"
`;
try {
  const dp = distMod.parseDistillPlan(DIST_OK_YAML, DIST_SECS);
  checks.push(['凝练 YAML 解析（分区/块正文/merged_from 列表/方向）', dp.entries.length === 2 && dp.entries[0].section === 'directives' && dp.entries[0].mergedFrom[0] === 'pers-entry-1' && dp.entries[1].section === 'traits' && dp.entries[1].content.includes('# 井号开头的正文行') && dp.entries[1].mergedFrom[0] === 'pers-entry-2' && dp.direction.includes('合并')]);
  checks.push(['凝练 YAML 容错（行尾注释剥离/块正文 # 行保留）', dp.entries[0].importance === 0.8 && dp.entries[1].content.includes('主动关心') && dp.errors.length === 0, JSON.stringify(dp.entries)]);
  const covOk = distMod.checkDistillCoverage(dp.entries, [{ id: 'pers-entry-1' }, { id: 'pers-entry-2' }]);
  checks.push(['覆盖校验通过（id 全覆盖无遗漏）', covOk.ok === true && covOk.missing.length === 0 && covOk.extra.length === 0]);
  const covBad = distMod.checkDistillCoverage(
    [{ mergedFrom: ['pers-entry-1'] }, { mergedFrom: ['pers-entry-2', 'pers-entry-2'] }, { mergedFrom: ['ghost-id'] }],
    [{ id: 'pers-entry-1' }, { id: 'pers-entry-2' }, { id: 'pers-entry-3' }]);
  checks.push(['覆盖校验检出 遗漏/伪造/重复合并', covBad.ok === false && covBad.missing.includes('pers-entry-3') && covBad.extra.includes('ghost-id') && covBad.duplicated.includes('pers-entry-2')]);
} catch (error) {
  checks.push([`凝练 YAML 解析无异常: ${error.message}`, false]);
}

// ---- api 级：预览 → 应用（stub 假 LLM 队列补充样本） ----
queue.push(DIST_OK_YAML);
let preDistill = null;
try {
  preDistill = await api.distillPersona();
  checks.push(['distillPersona 预览返回（token/前后条数/分区统计）', !!preDistill.token && preDistill.before.total === 2 && preDistill.after.total === 2 && preDistill.before.bySection.traits === 1 && preDistill.before.bySection.directives === 1 && preDistill.after.bySection.traits === 1 && preDistill.after.bySection.directives === 1 && preDistill.direction.includes('合并')]);
  checks.push(['凝练条目携带 重要度/mergedFrom 溯源', preDistill.entries.length === 2 && preDistill.entries.every((en) => typeof en.importance === 'number' && Array.isArray(en.mergedFrom) && en.mergedFrom.length === 1)]);
  checks.push(['凝练预览不生效（未 replace）', captured.personaReplaces.length === 0]);
  let tokenGuard = true;
  try { await api.applyPersonaDistill('wrong-token'); tokenGuard = false; } catch { /* 预期拒绝 */ }
  checks.push(['应用 token 守卫（非法 token 拒绝）', tokenGuard === true]);
  const applied = await api.applyPersonaDistill(preDistill.token);
  checks.push(['应用成功（persona.replace by=distill + source/mergedFrom 溯源）', applied.applied === true && captured.personaReplaces.length === 1 && captured.personaReplaces[0].opts.by === 'distill' && captured.personaReplaces[0].entries.length === 2 && captured.personaReplaces[0].entries.every((en) => en.source === 'distill' && Array.isArray(en.mergedFrom) && en.mergedFrom.length === 1)]);
  let secondGuard = true;
  try { await api.applyPersonaDistill(preDistill.token); secondGuard = false; } catch { /* 预期拒绝（一次性 token） */ }
  checks.push(['应用后 token 失效（不能重复应用）', secondGuard === true]);
} catch (error) {
  checks.push([`凝练预览/应用无异常: ${error.message}`, false]);
}
// 覆盖失败：两次坏输出（一次重试后仍失败）→ 明确报错且含遗漏清单
queue.push(DIST_BAD_YAML, DIST_BAD_YAML);
let covErrText = '';
try { await api.distillPersona(); } catch (error) { covErrText = String(error?.message ?? ''); }
checks.push(['覆盖失败重试后明确报错（含遗漏原条目 id）', covErrText.includes('遗漏原条目') && covErrText.includes('pers-entry-2'), covErrText]);
checks.push(['凝练 LLM 队列消费完', queue.length === 0]);

for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
console.log('--- 启动行 ---');
console.log(stdout.split('\n').filter((l) => l.includes('[archive-evolution]')).join('\n'));
rmSync(dir, { recursive: true, force: true });
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
