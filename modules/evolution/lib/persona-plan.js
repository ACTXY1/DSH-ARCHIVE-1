/**
 * dsh-archive-evolution 人格更新方案生成辅助（2026-09-02 用户需求定稿）。
 *
 * 用户需求：人格更新方案改由独立 API 调用大模型生成；生成时把
 *   ① 近 24 小时对话记录（★重点标记：用户对 AI 提出的要求/建议/期望/纠正类对话）
 *   ② 人格发展轨迹（当前人格清单（含条目 id）+ 已采纳进化方向 + 近期回复轨迹，
 *      参照人格一致性校验器的轨迹语义）
 * 正确封装、分类打包后发送给模型；模型分析用户想要的进化方向，输出**严格 YAML**
 * 格式的人格提示词条目；条目 section 严格按项目人格系统分区分类，支持：
 *   - action: add（新增条目，须给出 section）
 *   - action: refine（修正既有条目，须原样引用清单中出现的条目 id）
 *
 * 解析器说明：dsh node_modules 未内置 js-yaml 等 YAML 库（2026-09-02 查证），
 * 本模块实现零依赖的"严格 YAML 子集"解析器——仅支持本方案约定的 schema
 * （顶层 direction?/persona_updates:，条目 - action/section/id/content/importance/
 * rationale/evidence；content 等长文本用 | 块标量）。解析失败由调用方带
 * 纠正提示重试一次（与候选 JSON 解析同模式）。
 */

export const PERSONA_FALLBACK_SECTIONS = ['identity', 'values', 'traits', 'style', 'directives', 'capabilities'];

/** ★ 重点标记启发式：命中即视为"用户对 AI 提出要求/建议/期望/纠正"类对话（供 LLM 优先分析）。 */
const EMPHASIS_RULES = [
  /(请你|希望你|希望|期望|建议|要求|想让你|我(想|要)你|我建议)/,
  /(以后|下次|接下来|之后).{0,12}(你|回复|说话|回答|记住|记得|不要|别|希望)/,
  /(记住|记得|要记住|别忘了|牢记)/,
  /(不要|别(?!人)|禁止|不允许|不许|不能|不可以)/,
  /(必须|一定要|务必|应该|应当|最好|尽量)/,
  /(回复|说话|回答|表达|用词|语气|称呼|态度|风格|输出).{0,8}(简洁|简短|直接|详细|礼貌|客气|严谨|认真|温柔|热情|活泼|冷静|客观|专业)/,
  /(改成|改为|调整为|优化|改进|纠正|修正|调整|重新).{0,8}(你|回复|方式|风格|表达|做法|流程)/,
  /(帮我|给我|教|告诉|让我).{0,12}(你|ai|助手|之后|以后|做法|流程|风格)/,
  /(对用户|对我).{0,6}(称呼|态度|回应)/,
];

/** 命中 → true（打包时该条加 ★）。 */
export function isUserDirective(text) {
  const t = String(text ?? '');
  if (t.length < 4) return false;
  return EMPHASIS_RULES.some((r) => r.test(t));
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 时间标签 MM-DD HH:mm（近 24h 素材用，避免"刚刚/小时前"在跨天时失真）。 */
export function tsLabel(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

function stripUserPrefix(text) {
  let t = String(text ?? '').trim();
  if (t.startsWith('用户：')) t = t.slice('用户：'.length).trim();
  return t;
}

/**
 * 采集近 24 小时对话记录（用户侧；记忆库 source='conversation'）。
 * 用 memory.list 分页（created_at DESC）翻到窗口边界即停，避免 list 上限 200 截断。
 * 返回按时间升序（旧→新）的 [{ts, label, marked, text}]，保留最新 max 条（超限丢最旧）。
 */
export async function collectConversation24h(ctx, opts = {}) {
  const windowMs = opts.windowMs ?? 24 * 3600 * 1000;
  const max = opts.max ?? 40;
  const maxChars = opts.maxChars ?? 160;
  const maxCharsMarked = opts.maxCharsMarked ?? 220;
  const since = Date.now() - windowMs;
  const raw = [];
  try {
    let offset = 0;
    const memory = ctx.get('memory') ?? ctx.memory;
    if (!memory || typeof memory.list !== 'function') throw new Error('memory 服务不可用');
    for (let guard = 0; guard < 8; guard++) { // 防御：最多 8 页（1600 条）
      const page = await memory.list({ limit: 200, offset });
      if (!Array.isArray(page) || page.length === 0) break;
      let crossed = false;
      for (const r of page) {
        const ts = Number(r?.createdAt ?? 0);
        if (ts > 0 && ts < since) { crossed = true; break; } // DESC：已越过窗口边界
        if (ts >= since && r?.source === 'conversation') raw.push({ ts, content: r.content });
      }
      if (crossed || page.length < 200) break;
      offset += page.length;
    }
  } catch (error) {
    try { ctx.root?.logger?.('archive-evolution')?.warn?.(`archive-evolution: 24h 对话采集失败：${error?.message ?? error}`); } catch { /* 降级 */ }
  }
  // 最新优先截断 → 时间升序返回
  const sorted = raw.sort((a, b) => b.ts - a.ts).slice(0, max);
  return sorted
    .map((r) => {
      const text = stripUserPrefix(r.content);
      const marked = isUserDirective(text);
      return { ts: r.ts, label: tsLabel(r.ts), marked, text: truncate(text, marked ? maxCharsMarked : maxChars) };
    })
    .sort((a, b) => a.ts - b.ts);
}

/**
 * 打包"人格发展轨迹"与当前人格清单（含条目 id，供 refine 原样引用）。
 * @param {object} ctx
 * @param {{adopted?: Array<object>}} [deps] adopted：已采纳进化方向记录（evolution 账本
 *   approve/auto-apply，candidate.type 为 persona-*），与一致性"航点"同源。
 * @returns {{sections:string[], personaLines:string[], adoptedLines:string[], replyLines:string[]}}
 */
export async function gatherPersonaContext(ctx, deps = {}) {
  const sections = [];
  const personaLines = [];
  const entryById = {};
  const persona = (() => { try { return ctx.persona?.get?.(); } catch { return null; } })();
  const rawSections = persona?.sections;
  if (rawSections && typeof rawSections === 'object') {
    // 分区集合 = 全部分区（含空分区）——空分区同样允许模型 add 新条目（2026-09-02 修复）
    for (const sec of Object.keys(rawSections)) {
      sections.push(sec);
      const list = Array.isArray(rawSections[sec]) ? rawSections[sec] : [];
      const lines = [];
      for (const e of list.slice(0, 10)) {
        if (!e?.content) continue;
        entryById[e.id] = { id: e.id, section: sec, content: String(e.content), importance: e.importance };
        lines.push(`- id=${e.id} 重要度=${e.importance == null ? 0.5 : clamp01(e.importance)}：${truncate(e.content, 220)}`);
      }
      if (lines.length > 0) personaLines.push(`【${sec}】\n${lines.join('\n')}`);
    }
  }
  if (sections.length === 0) {
    // 人格为空/服务不可用：给模型规范分区占位，仍可 add
    for (const s of PERSONA_FALLBACK_SECTIONS) sections.push(s);
    personaLines.push('（当前人格为空）');
  }
  const adoptedLines = [];
  const adopted = Array.isArray(deps.adopted) ? deps.adopted : [];
  for (const rec of adopted.slice(0, 6)) {
    const c = rec?.candidate ?? {};
    if (!c.content) continue;
    const when = rec?.at ? `[${tsLabel(rec.at)}] ` : '';
    const kind = c.type === 'persona-refine' ? '修正' : '增补';
    adoptedLines.push(`${when}${kind}（${c.section ?? '-'}）：${truncate(c.content, 160)}`);
  }
  const replyLines = [];
  try {
    const consistency = ctx.get('consistency');
    const texts = Array.isArray(consistency?.trajectoryText?.(8)) ? consistency.trajectoryText(8) : [];
    for (const t of texts.slice(0, 8)) {
      const s = String(t ?? '').trim();
      if (s) replyLines.push(`- ${truncate(s, 120)}`);
    }
  } catch { /* 一致性不可用不影响人格生成 */ }
  return { sections, personaLines, adoptedLines, replyLines, entryById };
}

/** 人格生成 SYSTEM 提示词（schema 随项目实际分区动态拼接）。 */
export function personaProtocol(sections) {
  const secList = sections.join(' / ');
  return `你是 DSH-ARCHIVE 的人格自进化分析器。基于「近 24 小时对话记录」「人格清单与发展轨迹」「近期候选」，
分析用户希望 AI 朝哪个方向进化，输出一份严格 YAML 的人格更新方案（只输出 YAML 正文，不要代码围栏、不要任何解释或前后缀）。

严格 schema（键缩进 2 空格；长文本一律用 | 块标量，块内容缩进 4 空格）：

direction: 一句话概括用户想要的进化方向（无则省略此行）
persona_updates:
  - action: add            # add=新增条目；refine=修正既有条目（二选一）
    section: directives    # add 必填：严格取分区之一：${secList}；refine 省略（沿用原条目分区）
    id: "条目完整id"        # refine 必填：必须是【当前人格清单】中出现的 id，原样照抄；add 省略
    content: |
      人格提示词条目正文：自包含、可直接作为人格约束注入的第一人称陈述句
    importance: 0.7        # 可选 0~1（默认 0.5）
    rationale: 为什么值得固化或修正   # 可选
    evidence: 对话原文片段             # 可选

要求：
1. 优先分析带 ★ 的对话（用户对 AI 提出的要求/建议/期望/纠正）；一般性事务请求不构成人格条目；
2. section 只能取上述分区，不得发明分类；refine 只能修正清单中真实存在的条目（id 原样回填）；
3. 不得与「当前人格清单」「近期候选」重复或冲突；没有值得新增/修正的点时输出：persona_updates: []
4. 每条 content ≤ 400 字；updates 最多 4 条。`;
}

/** 人格生成 USER 提示词（数据打包：对话分类打包 + 轨迹 + 近期候选）。 */
export function personaUserText(context, conversation, recent) {
  const convLines = conversation.length
    ? conversation.map((c, i) => `${i + 1}. ${c.marked ? '★' : ' '} [${c.label}] 用户：${c.text}`).join('\n')
    : '（无）';
  const personaLines = context.personaLines.length ? context.personaLines.join('\n') : '（无）';
  const adoptedLines = context.adoptedLines.length ? context.adoptedLines.map((l, i) => `${i + 1}. ${l}`).join('\n') : '（无）';
  const replyLines = context.replyLines.length ? context.replyLines.join('\n') : '（无）';
  const recentLines = recent.length ? recent.join('\n') : '（无）';
  return `【近 24 小时对话记录（★=用户对 AI 提出要求/建议/期望/纠正，优先分析）】
${convLines}

【当前人格清单（含条目 id；refine 必须原样引用 id）】
${personaLines}

【人格发展轨迹】
已采纳进化方向（与人格一致性模块航点同源，最新在前）：
${adoptedLines}
近期回复轨迹（AI 近期实际行为样本）：
${replyLines}

【近期候选】（避免与其重复）
${recentLines}

请分析用户想要的进化方向并输出 YAML 人格更新方案。`;
}

const clampSection = (v) => String(v ?? '').trim().slice(0, 40);
const clampId = (v) => String(v ?? '').trim().slice(0, 60);
const clampContent = (v) => String(v ?? '').trim().slice(0, 4000);
const clampShort = (v, n) => String(v ?? '').trim().slice(0, n);

/** 供 persona-distill.js（凝练解析）复用：行缩进/块标量/引号/行尾注释剥离 */
export function leadingSpaces(line) {
  const m = String(line).match(/^ */);
  return m ? m[0].length : 0;
}

export function dedentBlock(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const nonEmpty = arr.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return '';
  const minIndent = Math.min(...nonEmpty.map((l) => leadingSpaces(l)));
  const body = arr.map((l) => (l.trim() === '' ? '' : l.slice(minIndent))).join('\n');
  return body.trim();
}

export function unquote(v) {
  let s = String(v ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.length >= 2) s = s.slice(1, -1);
  }
  return s;
}

/** 去掉标量值行尾的 YAML 内联注释（` # …`）。schema 示例里就带行尾注释
 *  （`- action: add  # add=新增条目…`），模型照抄示例时会把这些注释原样带进输出——
 *  不剥离会导致 action 值变成 "add  # add=…" 而匹配失败、条目被静默丢弃（2026-09-03 修复）。
 *  仅当 # 前是空白且在引号外时视为注释（content 块正文按块标量整体收集，不走此路径）。 */
export function stripInlineComment(v) {
  const s = String(v ?? '');
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).replace(/\s+$/, '');
    }
  }
  return s;
}

const ALLOWED_KEYS = new Set(['action', 'section', 'id', 'content', 'importance', 'rationale', 'evidence']);

/**
 * 严格 YAML 子集解析（零依赖）。schema 见 personaProtocol()。
 * @returns {{direction:string, updates:Array<object>, errors:string[]}}
 * 解析到硬伤（找不到条目区）时抛错，由调用方带纠正提示重试一次。
 */
export function parsePersonaPlan(text, sections) {
  const errors = [];
  let doc = String(text ?? '').replace(/\r\n?/g, '\n');
  const fence = doc.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)(?:```|$)/i);
  if (fence) doc = fence[1];
  const lines = doc.split('\n');
  let idx = lines.findIndex((l) => l.trim().startsWith('persona_updates:'));
  if (idx < 0) idx = lines.findIndex((l) => l.trim().startsWith('- action:'));
  if (idx < 0) throw new Error('YAML 未包含 persona_updates 顶层键或 - action 条目');
  let direction = '';
  for (let i = 0; i < idx; i++) {
    const m = lines[i].trim().match(/^direction:\s*(.*)$/);
    if (m && m[1]) direction = unquote(stripInlineComment(m[1]));
  }
  const body = lines.slice(idx + 1);
  const updates = [];
  let cur = null;
  let blockKey = null;
  let blockLines = null;
  let blockIndent = 0;
  const flushBlock = () => {
    if (blockKey && cur) {
      cur[blockKey] = dedentBlock(blockLines);
      blockKey = null; blockLines = null;
    }
  };
  const pushItem = () => {
    flushBlock();
    if (cur && (cur.action === 'add' || cur.action === 'refine')) updates.push(cur);
    cur = null;
  };
  const applyKey = (target, key, value, isBlock) => {
    if (isBlock) {
      blockKey = key; blockLines = []; blockIndent = leadingSpaces(currentLineRaw);
      target[key] = ''; // 占位，flushBlock 时回填
    } else {
      target[key] = unquote(value);
    }
  };
  let currentLineRaw = '';
  for (const rawLine of body) {
    currentLineRaw = rawLine;
    const trimmed = rawLine.trim();
    if (blockKey) {
      const indent = leadingSpaces(rawLine);
      if (indent > blockIndent || trimmed === '') { blockLines.push(rawLine); continue; }
      flushBlock();
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const itemMatch = trimmed.match(/^-\s*(.*)$/);
    if (itemMatch) {
      pushItem();
      cur = {};
      const rest = itemMatch[1];
      const km = rest ? rest.match(/^([A-Za-z_]+):\s*(.*)$/) : null;
      if (km) {
        const key = km[1];
        if (!ALLOWED_KEYS.has(key)) { errors.push(`非法条目键 ${key}（忽略）`); continue; }
        const val = stripInlineComment(km[2]);
        if (val === '' || /^[|>]/.test(val)) applyKey(cur, key, val, true);
        else cur[key] = unquote(val);
      }
      // 其余形如 "- xxx" 的无键行忽略
      continue;
    }
    const keyMatch = trimmed.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!keyMatch) { errors.push(`无法解析的行（忽略）：${truncate(trimmed, 40)}`); continue; }
    const key = keyMatch[1];
    if (!cur) cur = {}; // 条目区后出现顶层级键：宽容并入
    if (!ALLOWED_KEYS.has(key)) { errors.push(`非法键 ${key}（忽略）`); continue; }
    const val = stripInlineComment(keyMatch[2]);
    if (val === '' || /^[|>]/.test(val)) applyKey(cur, key, val, true);
    else cur[key] = unquote(val);
  }
  pushItem();
  if (updates.length === 0) {
    // 显式空方案（persona_updates: [] / 仅有顶层键无条目）为合法输出；其余视为解析失败（触发重试）
    const headerLine = lines[idx] ?? '';
    const explicitEmpty = /persona_updates:\s*\[\s*\]/.test(headerLine) || /persona_updates:\s*$/.test(headerLine);
    if (!explicitEmpty && errors.length > 0) throw new Error(`YAML 解析无有效条目（${errors[0]}）`);
  }
  // 归一化条目
  const normalized = updates.map((u) => {
    const out = { action: String(u.action ?? '').trim() };
    if (out.action === 'add') {
      out.section = clampSection(u.section);
      out.content = clampContent(u.content);
      if (u.importance !== undefined && u.importance !== null && u.importance !== '') out.importance = clamp01(Number(u.importance));
      if (u.rationale !== undefined) out.rationale = clampShort(u.rationale, 500);
      if (u.evidence !== undefined) out.evidence = clampShort(u.evidence, 300);
    } else if (out.action === 'refine') {
      out.id = clampId(u.id);
      out.section = clampSection(u.section); // 校验用；最终以清单条目为准
      out.content = clampContent(u.content);
      if (u.importance !== undefined && u.importance !== null && u.importance !== '') out.importance = clamp01(Number(u.importance));
      if (u.rationale !== undefined) out.rationale = clampShort(u.rationale, 500);
      if (u.evidence !== undefined) out.evidence = clampShort(u.evidence, 300);
    } else {
      errors.push(`非法 action：${out.action || '(空)'}`);
      return null;
    }
    if (!out.content) { errors.push(`条目缺少 content（action=${out.action}）`); return null; }
    return out;
  }).filter(Boolean);
  return { direction, updates: normalized, errors };
}

/**
 * 把解析出的更新条目映射为进化候选（add → persona-add；refine → persona-refine，
 * section 一律以清单中真实条目为准，id 不存在即丢弃并记录）。
 * @returns {{candidates:Array<object>, issues:string[]}}
 */
export function buildPersonaCandidates(plan, sections, entryById) {
  const candidates = [];
  const issues = [];
  for (const u of plan.updates) {
    if (u.action === 'add') {
      if (!sections.includes(u.section)) {
        issues.push(`add 分区非法：${u.section || '(空)'}（可选：${sections.join('/')}）`);
        continue;
      }
      candidates.push({
        type: 'persona-add',
        section: u.section,
        content: u.content,
        ...(u.importance !== undefined ? { importance: u.importance } : {}),
        ...(u.rationale !== undefined ? { rationale: u.rationale } : {}),
        ...(u.evidence !== undefined ? { evidence: u.evidence } : {}),
      });
    } else {
      const entry = entryById?.get?.(u.id) ?? null;
      if (!entry) {
        issues.push(`refine 条目 id 不存在：${u.id || '(空)'}`);
        continue;
      }
      if (u.section && u.section !== entry.section) {
        issues.push(`refine 分区 ${u.section} 与条目实际分区 ${entry.section} 不一致（以实际为准）`);
      }
      candidates.push({
        type: 'persona-refine',
        refineId: entry.id,
        section: entry.section,
        content: u.content,
        ...(u.importance !== undefined ? { importance: u.importance } : {}),
        ...(u.rationale !== undefined ? { rationale: u.rationale } : {}),
        ...(u.evidence !== undefined ? { evidence: u.evidence } : {}),
      });
    }
  }
  return { candidates, issues };
}
