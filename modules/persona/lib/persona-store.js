/**
 * 人格权威存储（）：persona.json 当前状态 + persona-history.jsonl 追加式留档账本。
 *
 * - persona.json：唯一权威（当前人格），原子写（tmp+rename）；结构校验。
 * - persona-history.jsonl：追加式账本，每次变更记录 {version, at, by, summary, sections}
 *   （含完整快照）——既是"每次进化留档"，也让"回滚接口"可直接恢复任意版本。
 * - 溯源：每个条目带 addedBy/addedAt/modifiedBy/modifiedAt；version 随每次变更 +1。
 * - 为预留：update/add 可传 by='evolution'；rollback(version, by) 恢复历史快照。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PERSONA_SECTIONS = ['identity', 'values', 'traits', 'style', 'directives', 'capabilities'];

/** 空人格（新文件模板）。 */
export function emptyPersona() {
  const now = Date.now();
  return {
    schemaVersion: 1,
    version: 0,
    meta: { createdAt: now, updatedAt: now, lastModifiedBy: 'system' },
    sections: Object.fromEntries(PERSONA_SECTIONS.map((s) => [s, []])),
  };
}

function newEntry(section, content, { importance, confidence, by, source, mergedFrom }) {
  const now = Date.now();
  const entry = {
    id: randomUUID(),
    section,
    content: String(content).trim(),
    importance: clamp01(importance ?? 0.5),
    confidence: clamp01(confidence ?? 1.0),
    addedBy: by ?? 'user',
    addedAt: now,
    modifiedBy: null,
    modifiedAt: null,
    source: source ?? null,
  };
  //  凝练溯源：整体重建（replace）时记录"本条由哪些旧条目合并而来"（旧 id 清单）。
  if (Array.isArray(mergedFrom)) {
    const ids = mergedFrom.map((x) => String(x).trim()).filter(Boolean).slice(0, 64);
    if (ids.length > 0) entry.mergedFrom = ids;
  }
  return entry;
}

export class PersonaStore {
  /**
   * @param {object} options
   * @param {string} options.path persona.json 路径（当前状态）
   * @param {string} [options.historyPath] 留档账本路径（默认 <dir>/persona-history.jsonl）
   */
  constructor(options) {
    this.path = options.path;
    this.historyPath = options.historyPath ?? join(dirname(this.path), 'persona-history.jsonl');
    mkdirSync(dirname(this.path), { recursive: true });
    this.data = this._load();
  }

  _load() {
    if (!existsSync(this.path)) return emptyPersona();
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      if (raw?.schemaVersion !== 1 || typeof raw.sections !== 'object') {
        throw new Error(`persona 文件结构不符（schemaVersion=${raw?.schemaVersion}）`);
      }
      return {
        ...emptyPersona(),
        ...raw,
        sections: Object.fromEntries(PERSONA_SECTIONS.map((s) => [s, Array.isArray(raw.sections[s]) ? raw.sections[s] : []])),
      };
    } catch (error) {
      // 损坏文件不阻断启动：改名为 .corrupt-<ts> 保留现场（账本仍可回滚恢复），
      // 以空人格降级启动并提示。
      const corruptPath = `${this.path}.corrupt-${Date.now()}`;
      try { renameSync(this.path, corruptPath); } catch { /* 改名失败则保留原文件 */ }
      console.error(`[archive-persona] persona.json 损坏，已保留为 ${corruptPath}，以空人格启动。原错误：${error.message}`);
      return emptyPersona();
    }
  }

  /** 原子写 persona.json（tmp + rename）。 */
  _save() {
    this.data.meta.updatedAt = Date.now();
    const tmp = this.path + `.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  /** 追加一条留档账本记录（含完整快照，append-only）。 */
  _ledger(by, summary) {
    appendFileSync(this.historyPath, JSON.stringify({
      version: this.data.version,
      at: Date.now(),
      by,
      summary,
      sections: this.data.sections,
    }) + '\n', 'utf8');
  }

  /** 完整人格对象。 */
  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  /**
   * 批量写入条目（设定基础人格用）。
   * @param {Array<{section:string, content:string, importance?:number, confidence?:number, by?:string}>} entries
   * @param {{by?:string, summary?:string}} [opts]
   */
  set(entries, opts = {}) {
    const by = opts.by ?? 'user';
    const list = Array.isArray(entries) ? entries : [entries];
    if (list.length === 0) return { version: this.data.version, added: 0 };
    //  先全量校验再写入——此前循环内逐条 push，中途一条非法（section/content）
    // 抛错时前面的条目已进内存但未落盘 → 内存与磁盘不一致，下次任何 _save 会落盘脏数据
    const prepared = list.map((e) => {
      const section = PERSONA_SECTIONS.includes(e?.section) ? e.section : null;
      if (!section) throw new Error(`persona.set: 非法 section "${e?.section}"（可选：${PERSONA_SECTIONS.join('/')}）`);
      const content = String(e.content ?? '').trim();
      if (!content) throw new Error('persona.set: content 必填');
      return { section, entry: newEntry(section, content, { ...e, by }) };
    });
    for (const { section, entry } of prepared) this.data.sections[section].push(entry);
    const added = prepared.length;
    this.data.version++;
    this.data.meta.lastModifiedBy = by;
    this._save();
    this._ledger(by, opts.summary ?? `新增 ${added} 条人格条目`);
    return { version: this.data.version, added };
  }

  /**
   * 整体重建全部人格条目（ 一键凝练用）。
   * 与 set（追加）/update（改一条）/remove（删一条）不同：以给定条目列表一次性替换全部分区，
   * 一次原子落盘 + 一条留档账本（账本含旧完整快照，回滚即回到凝练前版本）。
   * 条目可携带 mergedFrom（合并来源的旧条目 id 清单，溯源展示用）。
   * @param {Array<{section:string, content:string, importance?:number, confidence?:number,
   *                 source?:string|null, mergedFrom?:Array<string>}>} entries 新人格的全部条目
   * @param {{by?:string, summary?:string}} [opts]
   */
  replace(entries, opts = {}) {
    const by = opts.by ?? 'user';
    const list = Array.isArray(entries) ? entries : [];
    // 先全量校验再写入（ set 同款教训：中途一条非法抛错会留下内存与磁盘不一致）
    const prepared = list.map((e) => {
      const section = PERSONA_SECTIONS.includes(e?.section) ? e.section : null;
      if (!section) throw new Error(`persona.replace: 非法 section "${e?.section}"（可选：${PERSONA_SECTIONS.join('/')}）`);
      const content = String(e.content ?? '').trim();
      if (!content) throw new Error('persona.replace: content 必填');
      return { section, entry: newEntry(section, content, { ...e, by }) };
    });
    const next = Object.fromEntries(PERSONA_SECTIONS.map((s) => [s, []]));
    for (const { section, entry } of prepared) next[section].push(entry);
    this.data.sections = next;
    this.data.version++;
    this.data.meta.lastModifiedBy = by;
    this._save();
    this._ledger(by, opts.summary ?? `整体重建人格为 ${prepared.length} 条`);
    return { version: this.data.version, added: prepared.length };
  }

  /**
   * 更新一条已存在条目（增补/修正，自进化用 by='evolution'）。
   * @param {string} id
   * @param {{content?:string, importance?:number, confidence?:number, by?:string}} patch
   */
  update(id, patch = {}) {
    const hit = this._find(id);
    if (!hit) return null;
    const { section, entry } = hit;
    const by = patch.by ?? 'user';
    const now = Date.now();
    if (patch.content !== undefined) {
      const content = String(patch.content).trim();
      if (!content) throw new Error('persona.update: content 不能为空');
      entry.content = content;
    }
    if (patch.importance !== undefined) entry.importance = clamp01(patch.importance);
    if (patch.confidence !== undefined) entry.confidence = clamp01(patch.confidence);
    entry.modifiedBy = by;
    entry.modifiedAt = now;
    this.data.version++;
    this.data.meta.lastModifiedBy = by;
    this._save();
    this._ledger(by, `更新条目 ${entry.id.slice(0, 8)}（${section}）`);
    return this.getEntry(id);
  }

  /** @param {string} id @param {{by?:string}} [opts] @returns {boolean} */
  remove(id, opts = {}) {
    const hit = this._find(id);
    if (!hit) return false;
    const by = opts.by ?? 'user';
    const { section, entry } = hit;
    this.data.sections[section] = this.data.sections[section].filter((e) => e.id !== id);
    this.data.version++;
    this.data.meta.lastModifiedBy = by;
    this._save();
    this._ledger(by, `删除条目 ${entry.id.slice(0, 8)}（${section}）`);
    return true;
  }

  /** 回滚到指定版本（从账本快照恢复）。@returns {boolean} */
  rollback(version, by = 'user') {
    const records = this.history();
    const target = records.find((r) => r.version === version);
    if (!target) return false;
    this.data.sections = JSON.parse(JSON.stringify(target.sections));
    this.data.version++; // 回滚也是一次新变更：当前版本 +1
    this.data.meta.lastModifiedBy = by;
    this._save();
    this._ledger(by, `回滚到版本 ${target.version}`);
    return true;
  }

  getEntry(id) {
    const hit = this._find(id);
    return hit ? { ...hit.entry } : null;
  }

  /**
   * 渲染为人格文本（systemPrompt 注入用；空人格返回 null）。
   * 采用 XML 标签整体包裹：明确块边界（结构化指令 vs 对话文本），模型更易遵守，
   * 也便于程序解析；条目内容做 XML 转义，保证块格式良好。
   * 格式：<persona version="N"> 下每个条目一行 <section>content</section>（同分区多条目=重复标签）。
   */
  render() {
    const sections = [];
    for (const section of PERSONA_SECTIONS) {
      const entries = this.data.sections[section];
      if (entries.length === 0) continue;
      for (const e of entries) sections.push(`<${section}>${escapeXml(e.content)}</${section}>`);
    }
    if (sections.length === 0) return null;
    return `<persona version="${this.data.version}">\n${sections.join('\n')}\n</persona>`;
  }

  stats() {
    const entriesBySection = {};
    for (const s of PERSONA_SECTIONS) entriesBySection[s] = this.data.sections[s].length;
    return {
      version: this.data.version,
      entriesBySection,
      total: Object.values(entriesBySection).reduce((a, b) => a + b, 0),
      updatedAt: this.data.meta.updatedAt,
      lastModifiedBy: this.data.meta.lastModifiedBy,
      historyPath: this.historyPath,
    };
  }

  /** 留档账本（倒序，最近在前）。 */
  history(limit = 50) {
    if (!existsSync(this.historyPath)) return [];
    const lines = readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean);
    return lines
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean)
      .slice(-limit)
      .reverse();
  }

  _find(id) {
    for (const section of PERSONA_SECTIONS) {
      const entry = this.data.sections[section].find((e) => e.id === id);
      if (entry) return { section, entry };
    }
    return null;
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

/** XML 转义（防止人格内容破坏注入块结构）。 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
