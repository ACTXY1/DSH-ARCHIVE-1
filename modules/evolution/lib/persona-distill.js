/**
 * dsh-archive-evolution 人格一键凝练辅助（2026-09-08 用户需求：人格页手动触发）。
 *
 * 用户需求：人格页按下按钮 → 调 LLM 自动凝练全部人格条目，按项目已有分类（六分区）
 * 及原条目的分类归类后，**严格按 YAML** 重新编写条目；凝练同时不丢失人格信息与要求，
 * 并合并相同/相似条目。
 *
 * 本文件承担纯函数部分：
 *  - buildDistillSystem / buildDistillUser：把当前人格全量条目打包给 LLM（无损：正文不截断）；
 *  - parseDistillPlan：零依赖"严格 YAML 子集"解析（schema 见 buildDistillSystem，
 *    复用 persona-plan.js 导出的 YAML 基础工具），条目 schema：
 *      entries:
 *        - section: 六分区之一
 *          content: |（块标量正文）
 *          importance: 0~1（可选）
 *          merged_from:（原条目 id 列表，必填）
 *  - checkDistillCoverage：**无损硬约束**——每条原条目 id 必须恰好出现在某条新条目的
 *    merged_from 中（不遗漏 = 信息不丢；不重复 = 无重复合并；不引用清单外 id = 不伪造）。
 *
 * LLM 调用与"预览→确认→应用"流程在 lib/index.js（ctx.evolution.distillPersona /
 * applyPersonaDistill），写入走 persona.replace（整体重建 + 版本留档 + 可回滚）。
 */

import { leadingSpaces, dedentBlock, unquote, stripInlineComment } from './persona-plan.js';

/** 项目固定六分区中文标签（与 control 人格页一致）。 */
export const DISTILL_SECTION_LABELS = {
  identity: '身份',
  values: '价值观',
  traits: '性格',
  style: '表达风格',
  directives: '行为准则',
  capabilities: '能力清单',
};

const truncate = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

const pad2 = (n) => String(n).padStart(2, '0');

/** 时间戳 → MM-DD（溯源标注用）。 */
function dateLabel(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const BY_LABEL = { user: '用户', evolution: '自进化', distill: '凝练', auto: '自动' };

/** 来源显示名。 */
function byLabel(by) {
  return BY_LABEL[String(by ?? '')] ?? String(by ?? '');
}

/**
 * SYSTEM 提示词：任务 + 严格 schema（分区清单动态拼接）。
 * @param {string[]} sections 项目六分区（含空分区，允许模型归入任意分区）
 */
export function buildDistillSystem(sections) {
  const secList = sections.map((s) => `${s}（${DISTILL_SECTION_LABELS[s] ?? s}）`).join(' / ');
  return `你是 DSH-ARCHIVE 的人格凝练整理专家。任务：对【当前人格清单】中的全部条目做一次"无损凝练整理"：

1. 归类：条目一律归入项目固定分区（${secList}）。单条整理/保留时沿用该条目的原分区；仅当语义明显属于另一分区时才调整；合并多条时，以被合并条目中语义更主要的原分区为准；
2. 合并：语义相同/高度相似的条目合并为一条，信息取并集、消除重复表述；互不重复的条目逐一保留（措辞可微调），不得凭空增删主题；
3. 无损：完整保留每条原文中的信息、要求、约束、偏好与具体细节——允许改述与精简赘述，但不得丢失任何语义要点（尤其"不要/必须/总是/用户要求/称呼/语气"类硬性要求与具体细节），改写后仍须自包含；
4. 产出严格 YAML（只输出 YAML 正文；不要代码围栏、不要任何解释或前后缀；键缩进 2 空格；长文本用 | 块标量、块内容缩进 4 空格）：

direction: 一句话说明本次整理策略（无则省略此行）
entries:
  - section: traits          # 必填：严格取分区之一：${sections.join(' / ')}
    content: |
      凝练后的自包含条目正文（第一人称陈述）
    importance: 0.7          # 可选 0~1；缺省时程序按合并来源重要度取最大值
    merged_from:             # 必填：本条合并/改写自哪些原条目
      - "原条目完整id"

要求：
- merged_from 必须覆盖全部原条目 id：每条原条目 id 恰好出现在一条新条目的 merged_from 中（不遗漏、不重复；1:1 保留的条目也要列出其 id）——遗漏即信息丢失，输出会被程序拒绝并重试；
- section 只能取上述分区，不得自造分区；
- 合并后条目数应明显少于原条目数（存在可合并内容时）；若全部互不重复，也照常输出（每条对应一个原 id）。`;
}

/**
 * USER 素材：全量条目（正文不截断，保证无损信息输入）。
 * @param {Array<{id:string, section:string, content:string, importance?:number,
 *                addedBy?:string, addedAt?:number}>} source
 */
export function buildDistillUser(source) {
  const rows = [];
  const bySection = new Map();
  for (const s of source) {
    if (!bySection.has(s.section)) bySection.set(s.section, []);
    bySection.get(s.section).push(s);
  }
  for (const [sec, list] of bySection) {
    const label = DISTILL_SECTION_LABELS[sec] ?? sec;
    rows.push(`【${sec} ${label}（${list.length} 条）】`);
    list.forEach((e, i) => {
      const imp = e.importance === undefined || e.importance === null ? 0.5 : clamp01(e.importance);
      const when = e.addedAt ? ` · ${dateLabel(e.addedAt)}` : '';
      const by = e.addedBy ? `（来源 ${byLabel(e.addedBy)}${when}）` : '';
      // 原文正文整段保留（仅续行缩进对齐，不截断）
      const body = String(e.content).trim().replace(/\n/g, '\n      ');
      rows.push(`  ${i + 1}. id=${e.id} 重要度=${imp}${by}\n     原文：${body}`);
    });
    rows.push('');
  }
  return `【当前人格清单（共 ${source.length} 条；请按"无损凝练"要求输出，id 必须原样引用）】
${rows.join('\n')}
请输出凝练后的人格 YAML（entries:）。`;
}

const ALLOWED_KEYS = new Set(['section', 'content', 'importance', 'merged_from']);

/**
 * 严格 YAML 子集解析（零依赖；schema 见 buildDistillSystem）。
 * 容 ``` 代码围栏、行尾注释、整行注释、块标量正文中的 # 行。
 * @returns {{direction:string, entries:Array<{section:string, content:string,
 *           importance?:number, mergedFrom?:string[]}>, errors:string[]}}
 * 结构硬伤（找不到 entries）时抛错，由调用方带纠正提示重试一次。
 */
export function parseDistillPlan(text, sections) {
  const errors = [];
  let doc = String(text ?? '').replace(/\r\n?/g, '\n');
  const fence = doc.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)(?:```|$)/i);
  if (fence) doc = fence[1];
  const lines = doc.split('\n');
  let idx = lines.findIndex((l) => l.trim().startsWith('entries:'));
  let direction = '';
  if (idx < 0) {
    // 顶层 entries: 缺失时允许裸条目列表（"- section: …"），direction 不可得
    idx = lines.findIndex((l) => /^\s*-\s+section:/.test(l));
    if (idx < 0) throw new Error('YAML 未包含顶层 entries: 或 "- section:" 条目');
  } else {
    for (let i = 0; i < idx; i++) {
      const m = lines[i].trim().match(/^direction:\s*(.*)$/);
      if (m && m[1]) direction = unquote(stripInlineComment(m[1]));
    }
  }
  const body = lines.slice(idx + 1);
  const out = [];
  let cur = null;
  let blockKey = null; // 正在收集块标量正文的键（content）
  let blockLines = null;
  let blockIndent = 0;
  let listIndent = -1; // 正在收集 merged_from 缩进列表（- "id"）时的最小缩进
  const flushBlock = () => {
    if (blockKey && cur) {
      cur[blockKey] = dedentBlock(blockLines);
      blockKey = null;
      blockLines = null;
    }
  };
  const endItem = () => {
    flushBlock();
    if (cur) {
      if (cur.section && cur.content) out.push(cur);
      else errors.push(`条目缺少 ${!cur.section ? 'section' : 'content'}（忽略）`);
    }
    cur = null;
    listIndent = -1;
  };
  const setScalarOrBlock = (key, valRaw, indent) => {
    const val = stripInlineComment(String(valRaw ?? '')); // 行尾注释剥离（schema 示例带 # 注释，模型易照抄）
    if (key === 'merged_from') {
      cur.mergedFrom = cur.mergedFrom ?? [];
      // 行内列表：merged_from: ["id1","id2"] 或 merged_from: "id1"
      const inline = val.match(/["'][^"']+["']/g);
      if (inline) {
        for (const x of inline) { const v = unquote(x); if (v) cur.mergedFrom.push(v); }
      } else if (val.trim() === '') {
        listIndent = indent; // 空值 → 后续缩进行逐行收集
      } else {
        const v = unquote(val);
        if (v) cur.mergedFrom.push(v);
      }
      return;
    }
    if (val.trim() === '' || /^[|>]/.test(val)) {
      blockKey = key;
      blockLines = [];
      blockIndent = indent;
      cur[key] = '';
    } else {
      cur[key] = unquote(val);
    }
  };
  for (const rawLine of body) {
    const trimmed = rawLine.trim();
    const indent = leadingSpaces(rawLine);
    // 块标量优先于注释/空行判断（块正文里的 # 行与空行是正文，2026-09-03 同款教训）
    if (blockKey) {
      if (indent > blockIndent || trimmed === '') { blockLines.push(rawLine); continue; }
      flushBlock();
    } else if (listIndent >= 0) {
      const li = trimmed.match(/^-\s*(.*)$/);
      if (li && indent > listIndent) {
        const v = unquote(stripInlineComment(li[1]));
        if (v) cur.mergedFrom.push(v);
        continue;
      }
      listIndent = -1;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const itemMatch = trimmed.match(/^-\s*(.*)$/);
    if (itemMatch) {
      endItem();
      cur = { mergedFrom: [] };
      listIndent = -1;
      const rest = itemMatch[1];
      const km = rest ? rest.match(/^([A-Za-z_]+):\s*(.*)$/) : null;
      if (km) {
        const key = km[1];
        if (!ALLOWED_KEYS.has(key)) { errors.push(`非法条目键 ${key}（忽略）`); continue; }
        setScalarOrBlock(key, km[2], indent);
      }
      // 形如 "- xxx"（无键）的行忽略
      continue;
    }
    const keyMatch = trimmed.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!keyMatch) { errors.push(`无法解析的行（忽略）：${truncate(trimmed, 40)}`); continue; }
    const key = keyMatch[1];
    if (!cur) { errors.push(`条目外出现键 ${key}（忽略）`); continue; }
    if (!ALLOWED_KEYS.has(key)) { errors.push(`非法键 ${key}（忽略）`); continue; }
    setScalarOrBlock(key, keyMatch[2], indent);
  }
  endItem();
  // 归一化：section 限定、content 非空、merged_from 必须有
  const normalized = [];
  for (const e of out) {
    const section = String(e.section ?? '').trim();
    if (!sections.includes(section)) {
      errors.push(`非法分区：${section || '(空)'}（可选：${sections.join('/')}）`);
      continue;
    }
    const content = String(e.content ?? '').trim();
    if (!content) { errors.push(`条目缺少 content（分区 ${section}）`); continue; }
    const n = { section, content: content.slice(0, 3000) };
    if (e.importance !== undefined && e.importance !== null && e.importance !== '') n.importance = clamp01(Number(e.importance));
    const mf = Array.isArray(e.mergedFrom)
      ? e.mergedFrom.map((x) => String(x).trim()).filter(Boolean).slice(0, 80)
      : [];
    if (mf.length === 0) {
      // merged_from 必填：无来源的新条目视为"凭空新增"，不允许进入方案（宁缺毋滥，
      // 后续覆盖校验会据此报出遗漏的原条目 id 触发重试）
      errors.push(`条目缺少 merged_from（分区 ${section}）：每条新条目必须由 ≥1 条原条目合并而来`);
      continue;
    }
    n.mergedFrom = mf;
    normalized.push(n);
  }
  if (normalized.length === 0) {
    throw new Error(`YAML 解析无有效条目（${errors[0] ?? '格式不符'}）`);
  }
  return { direction, entries: normalized, errors };
}

/**
 * 无损硬约束校验：每条原条目 id 恰好出现在一条新条目的 merged_from 中。
 * @param {Array<{mergedFrom?:string[]}>} entries 解析后的凝练条目
 * @param {Array<{id:string}>} sourceEntries 原条目
 * @returns {{ok:boolean, missing:string[], extra:string[], duplicated:string[]}}
 *   missing=遗漏（信息将丢失）；extra=清单外伪造 id；duplicated=同一 id 被多条新条目合并
 */
export function checkDistillCoverage(entries, sourceEntries) {
  const sourceIds = new Set((sourceEntries ?? []).map((s) => String(s?.id ?? '').trim()).filter(Boolean));
  const seen = new Map();
  const extra = [];
  for (const e of entries ?? []) {
    for (const id of Array.isArray(e?.mergedFrom) ? e.mergedFrom : []) {
      if (!sourceIds.has(id)) { extra.push(id); continue; }
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
  }
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const missing = [...sourceIds].filter((id) => !seen.has(id));
  return {
    ok: missing.length === 0 && extra.length === 0 && duplicated.length === 0,
    missing,
    extra,
    duplicated,
  };
}
