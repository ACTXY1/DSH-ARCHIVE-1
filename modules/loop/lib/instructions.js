/**
 * 思维预设：用户指令注入层（纯函数，便于单测）。
 *
 * 设计初衷：思维循环决定 AI 的自主输出与行为，双 Agent 另加记忆概括与输出审查。
 * 「思维预设」让用户以「预设组 + 指令条目」的方式主动插入要求，规范/调整 AI 输出
 * （风格、语气、禁忌、行动取舍等），并重点适配双 Agent：决策读指令（最高优先级）、
 * 审查员核对指令、对话回复软自检附加 dialogue 范围指令。
 *
 * 概念（不采用其他产品的功能名）：
 *  - 预设（preset）：一组指令条目的容器；同一时刻仅一个活跃预设（activePresetId='' 表示未启用）。
 *  - 指令（entry）：一条用户要求文本。
 *      mode: 'always' 常驻（每轮生效）| 'keys' 关键词触发（决策上下文中命中任一关键词才生效）；
 *      scope: 'loop' 仅思维循环 | 'dialogue' 仅对话回复 | 'both' 两者。
 *      关键词触发只作用于思维循环（对话注入为静态常驻，无法按轮动态命中）。
 *
 * 零配置 = 零行为变化：无活跃预设/无条目时不注入任何内容，与旧流程完全一致。
 */
import { escapeXml } from './scene.js';

export const INSTR_DEFAULTS = Object.freeze({
  presets: [],
  activePresetId: '', // '' = 未启用任何预设
  entries: [],
  injectCapChars: 1200, // 单次决策注入预算护栏（字符）
});

export const INSTR_LIMITS = Object.freeze({
  presetMax: 20,
  entryMax: 200,
  nameMax: 40,
  textMax: 1500,
  keysMax: 10,
  keyMax: 40,
  capMin: 200,
  capMax: 8000,
  dialogueCap: 600, // 对话自检附加文本护栏
});

export function defaultState() {
  return { presets: [], activePresetId: '', entries: [], injectCapChars: INSTR_DEFAULTS.injectCapChars };
}

const asStr = (v) => (typeof v === 'string' ? v : '');

/** 归一化 + 护栏（保存/加载共用；非法输入收敛到安全默认，不抛错）。 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  const presets = (Array.isArray(raw.presets) ? raw.presets : [])
    .slice(0, INSTR_LIMITS.presetMax)
    .map((p, i) => ({ id: asStr(p?.id) || `p${i + 1}`, name: (asStr(p?.name) || '未命名').slice(0, INSTR_LIMITS.nameMax) }));
  const ids = new Set(presets.map((p) => p.id));
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .slice(0, INSTR_LIMITS.entryMax)
    .map((en, i) => {
      const mode = en?.mode === 'keys' ? 'keys' : 'always';
      let scope = en?.scope === 'dialogue' || en?.scope === 'both' ? en.scope : 'loop';
      if (mode === 'keys' && scope !== 'loop') scope = 'loop'; // 关键词触发仅思维循环
      return {
        id: asStr(en?.id) || `e${i + 1}`,
        presetId: ids.has(asStr(en?.presetId)) ? asStr(en.presetId) : '',
        name: (asStr(en?.name) || '未命名').slice(0, INSTR_LIMITS.nameMax),
        mode,
        keys: (Array.isArray(en?.keys) ? en.keys.map(asStr).map((k) => k.trim()).filter(Boolean) : [])
          .slice(0, INSTR_LIMITS.keysMax).map((k) => k.slice(0, INSTR_LIMITS.keyMax)),
        text: asStr(en?.text).slice(0, INSTR_LIMITS.textMax),
        scope,
        enabled: en?.enabled !== false,
        order: Number.isFinite(Number(en?.order)) ? Math.max(0, Math.floor(Number(en.order))) : i,
      };
    })
    .filter((en) => en.presetId !== ''); // 归属已删除预设的孤儿条目丢弃
  let injectCapChars = Number(raw.injectCapChars);
  if (!Number.isFinite(injectCapChars)) injectCapChars = INSTR_DEFAULTS.injectCapChars;
  injectCapChars = Math.min(INSTR_LIMITS.capMax, Math.max(INSTR_LIMITS.capMin, Math.floor(injectCapChars)));
  return {
    presets,
    activePresetId: ids.has(asStr(raw.activePresetId)) ? asStr(raw.activePresetId) : '',
    entries,
    injectCapChars,
  };
}

/** 保存前硬校验（给 UI/调用方明确错误）。 */
export function validateForSave(state) {
  const st = normalizeState(state);
  for (const p of st.presets) {
    if (!p.name.trim()) throw new Error('预设名称不能为空');
  }
  for (const en of st.entries) {
    if (!en.name.trim()) throw new Error(`指令「${en.id}」缺少名称`);
    if (!en.text.trim()) throw new Error(`指令「${en.name}」内容不能为空`);
    if (en.mode === 'keys' && en.keys.length === 0) throw new Error(`关键词触发指令「${en.name}」至少需要一个关键词`);
  }
  return st;
}

/** 活跃预设内启用条目（按 order 升序）。 */
export function activeEntries(st) {
  if (!st?.activePresetId) return [];
  return (Array.isArray(st.entries) ? st.entries : [])
    .filter((en) => en && en.enabled !== false && en.presetId === st.activePresetId)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

/** 命中文本预组装（转小写，供关键词匹配）。 */
export function hitTextOf(texts) {
  return (Array.isArray(texts) ? texts : []).filter((t) => typeof t === 'string' && t).join('\n').toLowerCase();
}

/** 条目是否命中：常驻恒命中；关键词任中其一。 */
export function entryMatched(en, hitText) {
  if (!en || en.mode !== 'keys') return true;
  if (!hitText) return false;
  return (Array.isArray(en.keys) ? en.keys : []).some((k) => k && hitText.includes(String(k).toLowerCase()));
}

/**
 * 组装思维循环决策注入块（纯函数）：
 *  - 只取活跃预设内启用条目；scope='dialogue' 的条目不进决策块（仅进对话自检）；
 *  - 常驻条目不依赖命中；关键词条目按命中文本匹配；
 *  - 按 order 依次注入直至预算上限（首条保证注入，预算满即停，超出的计 truncated）。
 * @returns {{block:string, injectedIds:string[], truncated:number, budgetUsed:number}}
 */
export function assembleInstructions(st, { hitTexts = [], capChars } = {}) {
  const cap = Number.isFinite(Number(capChars))
    ? Math.max(INSTR_LIMITS.capMin, Math.floor(Number(capChars)))
    : (st?.injectCapChars ?? INSTR_DEFAULTS.injectCapChars);
  const hit = hitTextOf(hitTexts);
  const picked = [];
  let used = 0;
  let truncated = 0;
  for (const en of activeEntries(st)) {
    if (en.scope === 'dialogue') continue;
    if (!entryMatched(en, hit)) continue;
    const cost = en.name.length + en.text.length + 32; // 标签/属性/包裹开销
    if (picked.length === 0 || used + cost <= cap) {
      picked.push(en);
      used += cost;
    } else {
      truncated += 1;
      break; // 预算满：停止（截断语义可预测）
    }
  }
  const block = picked
    .map((en) => `<instruction id="${escapeXml(en.id)}" name="${escapeXml(en.name)}">${escapeXml(en.text)}</instruction>`)
    .join('\n');
  return { block, injectedIds: picked.map((en) => en.id), truncated, budgetUsed: used };
}

/** 对话回复软自检的附加文本（仅**活跃预设**内常驻 + scope 含 dialogue 的条目，纯文本拼接，护栏内）。
 *  此前未按 activePresetId 过滤——①未启用任何预设（activePresetId=''）时仍会注入
 * 历史保存过的 dialogue 指令，破坏"零配置=零注入"；②激活 A 预设时 B 预设的 dialogue 指令也被注入，
 * 破坏"同一时刻仅一个活跃预设生效"。此处与 assembleInstructions（经 activeEntries 过滤）语义对齐。 */
export function dialogueInstructionText(st) {
  const actId = st?.activePresetId;
  const lines = (Array.isArray(st?.entries) ? st.entries : [])
    .filter((en) => en && en.enabled !== false && en.mode === 'always'
      && (en.scope === 'dialogue' || en.scope === 'both')
      && en.presetId === actId)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .map((en) => String(en.text ?? '').trim())
    .filter(Boolean);
  let out = '';
  for (const line of lines) {
    if (out && out.length + line.length + 2 > INSTR_LIMITS.dialogueCap) break;
    out += (out ? '\n' : '') + line;
  }
  return out;
}

/** UI 命中预览：返回将注入条目元信息（按指定/当前活跃预设）。 */
export function previewInstructions(st, text, presetId) {
  const st0 = st && typeof st === 'object' ? st : defaultState();
  const pid = presetId === undefined ? st0.activePresetId : (presetId ?? '');
  const st2 = { ...st0, activePresetId: st0.presets.some((p) => p.id === pid) ? pid : '' };
  const res = assembleInstructions(st2, { hitTexts: [String(text ?? '')] });
  const meta = (id) => {
    const en = st0.entries.find((x) => x.id === id);
    return en ? { id: en.id, name: en.name, mode: en.mode, scope: en.scope } : { id };
  };
  return {
    activePresetId: st2.activePresetId,
    injected: res.injectedIds.map(meta),
    truncated: res.truncated,
    budgetUsed: res.budgetUsed,
    injectCapChars: st2.injectCapChars,
  };
}
