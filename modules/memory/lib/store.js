/**
 * SQLite 向量存储（阶段二：基于 ollama 的向量数据库之"存储/检索层"）。
 * 使用 Node 内置 node:sqlite（DatabaseSync），零原生编译依赖。
 *
 * - 向量：Float32Array 小端 BLOB；检索：余弦相似度暴力扫描（万级记忆毫秒级完成）。
 * - 混合检索（参照 ACE 经验 60%语义/40%关键词，针对本项目特化）：
 *   FTS5 关键词 + 语义向量联合排序，final = 0.6*cosine + 0.4*bm25norm。
 *   FTS5 不可用时自动退化为纯语义。
 * - 预置未来阶段字段：confidence / last_verified / refresh_interval_days（遗忘与自进化用）。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MEMORY_KINDS = ['thought', 'episodic', 'semantic', 'procedural', 'preference', 'general'];
export const HYBRID_SEMANTIC_WEIGHT = 0.6;
export const HYBRID_KEYWORD_WEIGHT = 0.4;

export function normalizeKind(kind) {
  return MEMORY_KINDS.includes(kind) ? kind : 'general';
}

/** 把 Float32Array 编码为 SQLite BLOB（小端）。 */
export function encodeEmbedding(vec) {
  if (!(vec instanceof Float32Array)) vec = Float32Array.from(vec);
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** 把 BLOB 解码为 Float32Array。 */
export function decodeEmbedding(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** 余弦相似度。 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export class MemoryStore {
  /**
   * @param {string} path  SQLite 数据库文件路径（跨会话全局记忆的落点）
   * @param {object} [options]
   * @param {number} [options.defaultStateTtlSeconds] 用户状态默认有效期（秒，默认 4 小时）
   * @param {number} [options.tauBaseDays] 遗忘半衰期基数（天，默认 30）
   * @param {number} [options.reinforce] 每次召回的强度强化步（默认 0.05）
   * @param {number} [options.softThreshold] 软遗忘强度阈值（默认 0.3）
   * @param {number} [options.archiveGraceDays] 软遗忘→归档宽限（天，默认 30）
   * @param {number} [options.protectImportance] 自动保护重要度阈值（默认 0.8）
   */
  constructor(path, options = {}) {
    this.defaultStateTtlSeconds = options.defaultStateTtlSeconds ?? 14400;
    this.tauBaseDays = options.tauBaseDays ?? 30;
    this.reinforce = options.reinforce ?? 0.05;
    this.softThreshold = options.softThreshold ?? 0.3;
    this.archiveGraceDays = options.archiveGraceDays ?? 30;
    this.protectImportance = options.protectImportance ?? 0.8;
    this.defaultRecencyBias = options.defaultRecencyBias ?? 0.15; // 召回默认轻时效偏置（结合当前时间）
    if (dirname(path)) mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // 2026-08-30：WAL 更频繁自动 checkpoint（500 页 ≈ 2MB），并暴露 checkpoint() 供定时/备份前调用，
    // 防止 WAL 无限增长、断电/强杀时 .db 文件落后过多
    this.db.exec('PRAGMA wal_autocheckpoint = 500');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        content       TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'general',
        importance    REAL NOT NULL DEFAULT 0.5,
        confidence    REAL NOT NULL DEFAULT 1.0,
        last_verified INTEGER,
        refresh_interval_days INTEGER,
        protected     INTEGER NOT NULL DEFAULT 0,
        strength      REAL NOT NULL DEFAULT 1.0,
        forgotten     INTEGER NOT NULL DEFAULT 0,
        source        TEXT NOT NULL DEFAULT 'manual',
        embedding     BLOB,
        tags          TEXT NOT NULL DEFAULT '[]',
        meta          TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        access_count  INTEGER NOT NULL DEFAULT 0,
        last_access_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);

      CREATE TABLE IF NOT EXISTS user_profile (
        id            TEXT PRIMARY KEY,
        key           TEXT UNIQUE,
        content       TEXT NOT NULL,
        confidence    REAL NOT NULL DEFAULT 0.5,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        source        TEXT NOT NULL DEFAULT 'user',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_state (
        id            TEXT PRIMARY KEY,
        state         TEXT NOT NULL,
        detail        TEXT,
        confidence    REAL NOT NULL DEFAULT 0.5,
        evidence      TEXT,
        source        TEXT NOT NULL DEFAULT 'ai-inference',
        set_at        INTEGER NOT NULL,
        expires_at    INTEGER,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_state_expires ON user_state(expires_at);
      CREATE INDEX IF NOT EXISTS idx_user_state_updated ON user_state(updated_at);
    `);
    // 增量列迁移：旧版本库缺列时补上（CREATE TABLE IF NOT EXISTS 不会改已有表）。
    // 注意：新列索引必须在迁移之后创建（旧表无新列时 CREATE INDEX 会报 no such column）。
    this._migrateColumns();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_protected ON memories(protected);
      CREATE INDEX IF NOT EXISTS idx_memories_strength ON memories(strength);
    `);
    // FTS5 关键词索引（独立表，内容冗余存储，trigram 分词）。
    // - 不用 external-content 方案：实测该 SQLite 构建下，对外部内容 FTS5 表
    //   删除/查询不存在的 rowid 会触发 "database disk image is malformed"(267)。
    // - 用 trigram 分词：unicode61 对中文按整句切分、子串无法命中；trigram 支持
    //   ≥3 字中文子串匹配（<3 字查询靠语义侧兜底，见 ftsQueryExpr）。
    this.fts = null;
    try {
      const ftsDef = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
      if (ftsDef && !/tokenize\s*=\s*'trigram'/i.test(ftsDef.sql)) {
        this.db.exec('DROP TABLE IF EXISTS memories_fts'); // 旧分词器定义 → 重建
      }
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tokenize='trigram');");
      this.fts = true;
    } catch {
      this.fts = false;
    }
    this._stmt = {
      insert: this.db.prepare(`
        INSERT INTO memories (id, content, kind, importance, confidence, last_verified, refresh_interval_days, protected, strength, forgotten, source, embedding, tags, meta, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      get: this.db.prepare('SELECT * FROM memories WHERE id = ?'),
      rowid: this.db.prepare('SELECT rowid FROM memories WHERE id = ?'),
      touch: this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_access_at = ?, strength = MIN(1, strength + ?) WHERE id = ?'),
      remove: this.db.prepare('DELETE FROM memories WHERE id = ?'),
      updateMeta: this.db.prepare(`
        UPDATE memories SET content = ?, kind = ?, importance = ?, confidence = ?, last_verified = ?,
          refresh_interval_days = ?, protected = ?, tags = ?, meta = ?, updated_at = ? WHERE id = ?
      `),
      setEmbedding: this.db.prepare('UPDATE memories SET embedding = ? WHERE id = ?'),
      setStrength: this.db.prepare('UPDATE memories SET strength = ?, forgotten = ? WHERE id = ?'),
      setForgotten: this.db.prepare('UPDATE memories SET forgotten = ?, updated_at = ? WHERE id = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM memories'),
      byKind: this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE kind = ?'),
      all: this.db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      // 2026-08-31 审计修复：遗忘列表过滤下推 SQL（此前先 LIMIT 200 再 JS 过滤——活跃记忆超
      // 200 时被遗忘条目全部不可见，遗忘/恢复/遗忘作业复核失效）
      forgotten: this.db.prepare('SELECT * FROM memories WHERE forgotten > 0 ORDER BY created_at DESC LIMIT ?'),
      scan: this.db.prepare('SELECT rowid, id, embedding, content, kind, importance, confidence, protected, strength, forgotten, source, tags, meta, created_at, updated_at, access_count, last_access_at FROM memories'),
      byRowid: this.db.prepare('SELECT * FROM memories WHERE rowid = ?'),
      ftsInsert: this.fts ? this.db.prepare("INSERT INTO memories_fts(rowid, content) VALUES (?, ?)") : null,
      ftsExists: this.fts ? this.db.prepare('SELECT rowid FROM memories_fts WHERE rowid = ?') : null,
      ftsDelete: this.fts ? this.db.prepare("DELETE FROM memories_fts WHERE rowid = ?") : null,
      ftsCount: this.fts ? this.db.prepare('SELECT COUNT(*) AS n FROM memories_fts') : null,
      ftsQuery: this.fts ? this.db.prepare('SELECT rowid, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?') : null,
      profileInsert: this.db.prepare(`
        INSERT INTO user_profile (id, key, content, confidence, evidence_count, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `),
      profileReplace: this.db.prepare(`
        UPDATE user_profile SET content = ?, confidence = ?, source = ?, evidence_count = 1, updated_at = ? WHERE key = ?
      `),
      profileConfirm: this.db.prepare('UPDATE user_profile SET evidence_count = evidence_count + 1, updated_at = ? WHERE key = ?'),
      profileByKey: this.db.prepare('SELECT * FROM user_profile WHERE key = ?'),
      profileList: this.db.prepare('SELECT * FROM user_profile ORDER BY updated_at DESC LIMIT ? OFFSET ?'),
      profileRemove: this.db.prepare('DELETE FROM user_profile WHERE key = ?'),
      profileCount: this.db.prepare('SELECT COUNT(*) AS n FROM user_profile'),
      stateInsert: this.db.prepare(`
        INSERT INTO user_state (id, state, detail, confidence, evidence, source, set_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      stateUpdate: this.db.prepare(`
        UPDATE user_state SET detail = ?, confidence = ?, evidence = ?, source = ?, expires_at = ?, updated_at = ?
        WHERE state = ?
      `),
      stateActive: this.db.prepare('SELECT * FROM user_state WHERE expires_at IS NULL OR expires_at > ? ORDER BY set_at DESC'),
      stateByState: this.db.prepare('SELECT * FROM user_state WHERE state = ?'),
      stateRemove: this.db.prepare('DELETE FROM user_state WHERE state = ?'),
      // 2026-09-03 记忆错乱修复：单槽互斥——写入新状态前把其他仍有效状态标记过期
      //（保留为历史行，仅退出"当前有效"集合；由 core.stateSet 语义层调用）
      stateExpireOthers: this.db.prepare('UPDATE user_state SET expires_at = ?, updated_at = ? WHERE state != ? AND (expires_at IS NULL OR expires_at > ?)'),
      stateHistory: this.db.prepare('SELECT * FROM user_state ORDER BY updated_at DESC LIMIT ?'),
      stateSweep: this.db.prepare('DELETE FROM user_state WHERE expires_at IS NOT NULL AND expires_at < ?'),
      stateCount: this.db.prepare('SELECT COUNT(*) AS n FROM user_state'),
    };
    // FTS 索引回填：内容表有行而索引为空/少于内容（分词器迁移或崩溃残留）时全量重建。
    if (this.fts) {
      const memCount = this._stmt.count.get().n;
      const ftsCount = this._stmt.ftsCount.get().n;
      if (memCount > 0 && ftsCount < memCount) {
        this.db.exec('DELETE FROM memories_fts');
        const fi = this.db.prepare('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)');
        for (const row of this._stmt.scan.all()) {
          if (row.content) fi.run(row.rowid, row.content);
        }
      }
    }
  }

  /** 增量列迁移：按需 ALTER TABLE ADD COLUMN（仅加列，不破坏已有数据）。 */
  _migrateColumns() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
    const migrations = [
      ['confidence', 'ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0'],
      ['last_verified', 'ALTER TABLE memories ADD COLUMN last_verified INTEGER'],
      ['refresh_interval_days', 'ALTER TABLE memories ADD COLUMN refresh_interval_days INTEGER'],
      ['protected', 'ALTER TABLE memories ADD COLUMN protected INTEGER NOT NULL DEFAULT 0'],
      ['strength', 'ALTER TABLE memories ADD COLUMN strength REAL NOT NULL DEFAULT 1.0'],
      ['forgotten', 'ALTER TABLE memories ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, sql] of migrations) {
      if (!cols.has(name)) this.db.exec(sql);
    }
  }

  /**
   * 写入一条记忆。
   * @param {object} input
   * @param {string} input.content
   * @param {Float32Array|number[]} [input.embedding]
   * @param {string} [input.kind]
   * @param {number} [input.importance] 0..1
   * @param {number} [input.confidence] 0..1
   * @param {number} [input.lastVerified] epoch ms
   * @param {number} [input.refreshIntervalDays] 建议复核周期
   * @param {boolean} [input.protected] 显式保护（不可遗忘）
   * @param {string} [input.source]
   * @param {string[]} [input.tags]
   * @param {object} [input.meta]
   * @param {string} [input.id]
   */
  write(input) {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    const kind = normalizeKind(input.kind);
    const importance = clamp01(input.importance ?? 0.5);
    // 2026-08-31 审计修复：tags 归一化（LLM 决策/服务直调可能传非数组 → tags.some TypeError 致写入失败）
    const tags = Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string') : [];
    const content = String(input.content ?? '').trim();
    if (!content) throw new Error('memory.write: content 必填且不能为空字符串');
    const protectedFlag = this._isProtected({ kind, importance, tags, protected: input.protected });
    const createdAt = input.createdAt ?? now; // 支持回填/导入旧记忆
    const updatedAt = input.updatedAt ?? now;
    // 2026-08-30：支持导入时保留遗忘状态（0=活跃 1=软遗忘 2=归档；默认 0）
    const forgotten = [1, 2].includes(Number(input.forgotten)) ? Number(input.forgotten) : 0;
    this._stmt.insert.run(
      id,
      String(input.content),
      kind,
      importance,
      clamp01(input.confidence ?? 1.0),
      input.lastVerified ?? null,
      Number.isFinite(input.refreshIntervalDays) ? input.refreshIntervalDays : null,
      protectedFlag ? 1 : 0,
      protectedFlag ? 1 : initialStrength(importance),
      forgotten,
      String(input.source ?? 'manual'),
      input.embedding ? encodeEmbedding(input.embedding) : null,
      JSON.stringify(tags),
      JSON.stringify(input.meta ?? {}),
      createdAt,
      updatedAt,
    );
    this._syncFts(id);
    return { id, createdAt, protected: protectedFlag, strength: protectedFlag ? 1 : initialStrength(importance) };
  }

  /** @param {string} id */
  get(id) {
    const row = this._stmt.get.get(id);
    return row ? hydrate(row) : null;
  }

  /**
   * 更新记忆正文/类型/重要度/置信度/标签/元数据/保护（保留 embedding 与访问统计）。
   */
  update(id, patch) {
    const row = this._stmt.get.get(id);
    if (!row) return false;
    const old = hydrate(row);
    const importance = clamp01(patch.importance ?? old.importance);
    const kind = normalizeKind(patch.kind ?? old.kind);
    const tags = Array.isArray(patch.tags) ? patch.tags.filter((t) => typeof t === 'string') : (old.tags ?? []);
    const protectedFlag = patch.protected !== undefined
      ? Boolean(patch.protected)
      : this._isProtected({ kind, importance, tags, protected: old.protected });
    this._stmt.updateMeta.run(
      patch.content ?? old.content,
      kind,
      importance,
      clamp01(patch.confidence ?? old.confidence),
      patch.lastVerified !== undefined ? patch.lastVerified : old.lastVerified,
      patch.refreshIntervalDays !== undefined ? patch.refreshIntervalDays : old.refreshIntervalDays,
      protectedFlag ? 1 : 0,
      JSON.stringify(tags),
      JSON.stringify(patch.meta ?? old.meta),
      Date.now(),
      id,
    );
    if (this.fts && patch.content !== undefined && patch.content !== old.content) this._syncFts(id);
    // 2026-08-30 审计修复：content 变化时由上层（core.update）重新向量化，此处同步更新 embedding 列，
    // 避免编辑后的记忆继续用旧向量参与语义检索（内容与语义错位）。
    if (patch.embedding !== undefined) this._stmt.setEmbedding.run(encodeEmbedding(patch.embedding), id);
    return true;
  }

  /** @param {string} id @returns {boolean} 是否删除成功 */
  remove(id) {
    if (this.fts) {
      const r = this._stmt.rowid.get(id);
      if (r) this._ftsDeleteSafe(r.rowid);
    }
    return this._stmt.remove.run(id).changes > 0;
  }

  /** 保护判定：显式标记 / 关键类型 / 关键标签 / 高重要度。 */
  _isProtected({ kind, importance, tags = [], protected: flag }) {
    if (flag) return true;
    if (kind === 'procedural' || kind === 'preference') return true;
    const PROTECT_TAGS = ['lesson', 'rule', 'project', 'directive', 'work-requirement'];
    if (tags.some((t) => PROTECT_TAGS.includes(String(t).toLowerCase()))) return true;
    if (importance >= this.protectImportance) return true;
    return false;
  }

  // ===== 仿生遗忘（Ebbinghaus 衰减 + 强化 + hot/warm/cold 分级 + 归档 + 审计） =====

  /** 写入遗忘审计日志（追加式，与记忆库同目录）。 */
  _forgetAudit(entry) {
    try {
      const logPath = this.path + '.forgetting-log.jsonl';
      appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8');
    } catch { /* 审计失败不阻断 */ }
  }

  /**
   * 遗忘作业：重算全库强度、分级迁移、超期归档、复核队列。
   * @returns {{softened:number, archived:number, reviewQueue:Array<object>}}
   */
  forgetRun() {
    const now = Date.now();
    const softened = [];
    const archived = [];
    const reviewQueue = [];
    for (const row of this._stmt.scan.all()) {
      const m = hydrate(row);
      if (m.protected) continue; // 不可遗忘豁免区
      const base = initialStrength(m.importance);
      const anchor = m.lastAccessAt ?? m.createdAt;
      const ageDays = Math.max(0, (now - anchor) / 86400000);
      const tau = this.tauBaseDays * (0.5 + base);
      const newS = m.strength * Math.exp(-ageDays / tau);
      let forgotten = m.forgotten;
      if (forgotten === 0 && newS < this.softThreshold) {
        forgotten = 1; // 软遗忘：不进默认召回
        softened.push(m.id);
        this._forgetAudit({ id: m.id, action: 'soft-forgotten', content: m.content.slice(0, 120), strengthFrom: m.strength, strengthTo: newS });
      } else if (forgotten === 1 && now - m.updatedAt > this.archiveGraceDays * 86400000) {
        forgotten = 2; // 归档：保留可恢复
        archived.push(m.id);
        this._forgetAudit({ id: m.id, action: 'archived', content: m.content.slice(0, 120), strength: newS });
      }
      this._stmt.setStrength.run(newS, forgotten, row.id);
      // 复核队列：refresh 到期
      if (m.refreshIntervalDays != null && m.lastVerified != null && now - m.lastVerified > m.refreshIntervalDays * 86400000) {
        reviewQueue.push({ id: m.id, content: m.content.slice(0, 120), refreshIntervalDays: m.refreshIntervalDays, lastVerified: m.lastVerified });
      }
    }
    return { softened: softened.length, archived: archived.length, reviewQueue };
  }

  /** 显式恢复一条被遗忘记忆（软遗忘或归档）。 */
  restore(id) {
    const row = this._stmt.get.get(id);
    if (!row) return false;
    const m = hydrate(row);
    this._stmt.setStrength.run(initialStrength(m.importance), 0, id);
    this._forgetAudit({ id, action: 'restored', content: m.content.slice(0, 120), strengthTo: initialStrength(m.importance) });
    return true;
  }

  /** 列出软遗忘/归档记忆（供管理界面与显式检索）。 */
  forgottenList(limit = 50) {
    // 2026-08-31 审计修复：WHERE forgotten>0 下推（原 LIMIT 200 后 JS 过滤，活跃>200 时恒空）
    return this._stmt.forgotten.all(Math.max(1, Math.min(500, limit || 50))).map(hydrate);
  }

  /** 遗忘统计。 */
  forgetStats() {
    const n = this._stmt.count.get().n;
    let soft = 0;
    let archived = 0;
    let protectedCount = 0;
    for (const row of this._stmt.scan.all()) {
      if (row.protected === 1) protectedCount++;
      else if (row.forgotten === 1) soft++;
      else if (row.forgotten === 2) archived++;
    }
    return { total: n, active: n - soft - archived - protectedCount, soft, archived, protected: protectedCount };
  }

  /**
   * 检索。mode: 'hybrid'（默认，语义+关键词加权）| 'semantic' | 'keyword'。
   * 时效性：默认轻时效偏置（新近记忆靠前）；结果附带相对时间与待复核标记；
   * 遗忘联动：软遗忘/归档记忆默认不进入召回（includeForgotten=true 可显式含入）。
   * @param {object} query
   * @param {Float32Array|number[]} query.embedding 查询向量（keyword 模式可省略）
   * @param {string} [query.query] 查询原文（keyword/hybrid 用）
   * @param {number} [query.k]
   * @param {string[]} [query.kinds]
   * @param {number} [query.minScore]
   * @param {number} [query.recencyBias] 0..1；缺省用 defaultRecencyBias（0.15）
   * @param {string} [query.mode]
   * @param {boolean} [query.includeForgotten] 是否包含软遗忘/归档记忆（默认 false）
   */
  recall(query) {
    const k = Math.max(1, Math.min(100, query.k ?? 10));
    const kinds = query.kinds?.length ? new Set(query.kinds) : null;
    const minScore = query.minScore ?? 0;
    const recencyBias = clamp01(query.recencyBias ?? this.defaultRecencyBias);
    const mode = query.mode ?? 'hybrid';
    const includeForgotten = query.includeForgotten === true;
    const now = Date.now();

    const keywordHits = (mode === 'hybrid' || mode === 'keyword') && this.fts
      ? this._ftsSearch(query.query, Math.max(k, 20))
      : new Map();

    const scored = [];
    if (mode === 'keyword') {
      for (const [rowid, rank] of keywordHits) {
        const row = this._byRowid(rowid);
        if (!row || (kinds && !kinds.has(row.kind))) continue;
        if (!includeForgotten && row.forgotten > 0) continue;
        let score = bm25Norm(rank);
        if (row.protected !== 1) score *= strengthFactor(row.strength);
        scored.push({ row, score });
      }
    } else {
      if (query.embedding == null) throw new Error('memory.recall: semantic/hybrid 模式需要 embedding（keyword 模式可省略）');
      const q = Float32Array.from(query.embedding);
      const seen = new Set();
      for (const row of this._stmt.scan.all()) {
        if (kinds && !kinds.has(row.kind)) continue;
        if (!includeForgotten && row.forgotten > 0) continue;
        if (row.embedding == null) continue;
        seen.add(row.rowid);
        const sem = cosineSimilarity(q, decodeEmbedding(row.embedding));
        let score = sem;
        if (mode === 'hybrid' && keywordHits.has(row.rowid)) {
          // 关键词侧只增不减：取 max(纯语义, 混合)，避免弱关键词稀释强语义命中
          const blend = HYBRID_SEMANTIC_WEIGHT * Math.max(0, sem) + HYBRID_KEYWORD_WEIGHT * bm25Norm(keywordHits.get(row.rowid));
          score = Math.max(sem, blend);
        }
        // 遗忘联动：强度系数（受保护记忆恒 1）
        if (row.protected !== 1) score *= strengthFactor(row.strength);
        if (score < minScore) continue;
        scored.push({ row, score });
      }
      // hybrid：无向量的记忆仅靠关键词命中也可召回（否则默认模式永远找不到它们）
      if (mode === 'hybrid') {
        for (const [rowid, rank] of keywordHits) {
          if (seen.has(rowid)) continue;
          const row = this._stmt.byRowid.get(rowid);
          if (!row || (kinds && !kinds.has(row.kind)) || row.embedding != null) continue;
          if (!includeForgotten && row.forgotten > 0) continue;
          let score = HYBRID_KEYWORD_WEIGHT * bm25Norm(rank);
          if (row.protected !== 1) score *= strengthFactor(row.strength);
          if (score < minScore) continue;
          scored.push({ row, score });
        }
      }
    }
    if (recencyBias > 0) {
      for (const item of scored) {
        if (item.row.created_at <= 0) continue;
        const ageDays = Math.max(0, (now - item.row.created_at) / 86400000);
        const recency = Math.exp(-ageDays / 31); // 31 天半衰期
        item.score = item.score * (1 - recencyBias) + recency * recencyBias;
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, k);
    const nowTs = Date.now();
    for (const { row } of top) this._stmt.touch.run(nowTs, this.reinforce, row.id);
    return top.map(({ row, score }) => ({ ...hydrate(row), score, ...recallTimeMeta(row, now) }));
  }

  _ftsSearch(queryText, limit) {
    if (!queryText || typeof queryText !== 'string') return new Map();
    const expr = ftsQueryExpr(queryText);
    if (!expr) return new Map();
    const out = new Map();
    try {
      for (const hit of this._stmt.ftsQuery.all(expr, limit)) out.set(hit.rowid, hit.rank);
    } catch {
      // MATCH 表达式不合规时退化为空命中
    }
    return out;
  }

  _byRowid(rowid) {
    return this._stmt.byRowid.get(rowid);
  }

  _syncFts(id) {
    if (!this.fts) return;
    const r = this._stmt.rowid.get(id);
    if (!r) return;
    const row = this._stmt.get.get(id);
    if (!row) return;
    this._ftsDeleteSafe(r.rowid);
    this._stmt.ftsInsert.run(r.rowid, row.content);
  }

  /**
   * 安全删除 FTS 行：先确认索引中存在该 rowid 再 DELETE。
   * 原因：对外部内容 FTS5 表删除不存在的 rowid 会触发 SQLite "database disk
   * image is malformed"（errcode 267）——首次写入/旧库升级等索引与内容表不同步
   * 的场景下必须避免。已实测确认（scripts/probe-del.js）。
   */
  _ftsDeleteSafe(rowid) {
    if (!this.fts) return;
    const exists = this._stmt.ftsExists.get(rowid);
    if (exists) this._stmt.ftsDelete.run(rowid);
  }

  /** @param {object} [opts] @returns {{n:number, byKind:object, fts:boolean}} */
  stats() {
    const total = this._stmt.count.get().n;
    const byKind = {};
    for (const kind of MEMORY_KINDS) byKind[kind] = this._stmt.byKind.get(kind).n;
    return { total, byKind, fts: Boolean(this.fts) };
  }

  /** @param {{limit?:number, offset?:number}} [opts] 最近写入列表（无向量也可读） */
  list(opts = {}) {
    const limit = Math.min(200, opts.limit ?? 50);
    const offset = opts.offset ?? 0;
    return this._stmt.all.all(limit, offset).map(hydrate);
  }

  // ===== 整合 / 导入（2026-08-30） =====

  /** 按 kind+source+时间范围查询（记忆整合作业用）。
   *  2026-08-30：仅查未保护记忆（WHERE protected = 0）——受保护记忆不参与聚合，
   *  与 softForgetMany 的保护豁免保持一致（保护=不可遗忘、不可凝练合并）。 */
  listBySourceSince({ kind, source, sinceMs, limit = 50 }) {
    return this.db.prepare('SELECT * FROM memories WHERE kind = ? AND source = ? AND created_at >= ? AND protected = 0 ORDER BY created_at DESC LIMIT ?')
      .all(kind, source, sinceMs, Math.min(200, limit)).map(hydrate);
  }

  /** 批量软遗忘（整合作业把被凝练的原条目标记为软遗忘，不进默认召回；受保护条目跳过）。 */
  softForgetMany(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { softened: 0 };
    let n = 0;
    const st = this.db.prepare('UPDATE memories SET forgotten = 1, strength = MIN(strength, 0.2) WHERE id = ? AND protected = 0');
    for (const id of ids) n += st.run(id).changes;
    return { softened: n };
  }

  /** 从备份库合并导入（id 去重、保留现有；embedding 原样复制；画像按 key 去重；状态仅导入仍有效的）。 */
  importFrom(backupDbPath) {
    let bdb;
    try {
      bdb = new DatabaseSync(backupDbPath, { readOnly: true });
    } catch (error) {
      return { ok: false, error: `打开备份库失败：${error.message}` };
    }
    const parseJson = (text, fallback) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : fallback; } catch { return fallback; } };
    let memories = 0; let skipped = 0; let profiles = 0; let states = 0;
    try {
      for (const row of bdb.prepare('SELECT * FROM memories').all()) {
        if (this.get(row.id)) { skipped++; continue; }
        this.write({
          id: row.id, content: row.content, kind: row.kind, importance: row.importance,
          confidence: row.confidence ?? 1.0, source: row.source ?? 'imported',
          tags: parseJson(row.tags, []), meta: parseJson(row.meta, {}),
          protected: row.protected === 1,
          forgotten: row.forgotten ?? 0, // 2026-08-30：保留备份中的遗忘状态，导入不再"复活"已遗忘记忆
          embedding: row.embedding ? decodeEmbedding(row.embedding) : undefined,
          createdAt: row.created_at, updatedAt: row.updated_at,
        });
        memories++;
      }
    } catch (error) {
      try { bdb.close(); } catch { /* ignore */ }
      return { ok: false, error: `导入记忆失败：${error.message}` };
    }
    try {
      for (const p of bdb.prepare('SELECT * FROM user_profile').all()) {
        if (this.profileGet(p.key)) continue;
        this.profileSet({ key: p.key, content: p.content, confidence: p.confidence ?? 0.5, source: p.source ?? 'imported' });
        profiles++;
      }
    } catch { /* 表缺失等：忽略 */ }
    try {
      const existing = new Set(this.stateGet().map((s) => s.state));
      for (const s of bdb.prepare('SELECT * FROM user_state').all()) {
        if (s.expires_at != null && s.expires_at < Date.now()) continue;
        if (existing.has(s.state)) continue;
        this.stateSet({
          state: s.state, detail: s.detail, confidence: s.confidence ?? 0.5, evidence: s.evidence,
          ttlSeconds: s.expires_at != null ? Math.max(60, Math.round((s.expires_at - Date.now()) / 1000)) : 0,
        });
        existing.add(s.state);
        states++;
      }
    } catch { /* 忽略 */ }
    try { bdb.close(); } catch { /* ignore */ }
    return { ok: true, memories, skipped, profiles, states };
  }

  // ===== 用户画像（长期稳定事实，按 key 唯一） =====

  /**
   * 写入/确认一条画像事实。同 key 同内容 → 证据计数 +1；内容变化 → 覆盖并重置计数。
   * @param {object} input
   * @param {string} input.key 规范键（如 name / shell_preference）
   * @param {string} input.content 事实陈述
   * @param {number} [input.confidence] 0..1
   * @param {string} [input.source]
   */
  profileSet(input) {
    const now = Date.now();
    const key = String(input.key ?? '').trim();
    if (!key) throw new Error('profile.set: key 必填');
    const content = String(input.content ?? '').trim();
    if (!content) throw new Error('profile.set: content 必填');
    const existing = this._stmt.profileByKey.get(key);
    if (existing) {
      if (existing.content === content) {
        this._stmt.profileConfirm.run(now, key); // 再次确认 → 证据 +1
      } else {
        this._stmt.profileReplace.run(content, clamp01(input.confidence ?? existing.confidence), String(input.source ?? existing.source), now, key);
      }
    } else {
      this._stmt.profileInsert.run(randomUUID(), key, content, clamp01(input.confidence ?? 0.5), String(input.source ?? 'user'), now, now);
    }
    return hydrateProfile(this._stmt.profileByKey.get(key));
  }

  /** @param {string} key */
  profileGet(key) {
    const row = this._stmt.profileByKey.get(key);
    return row ? hydrateProfile(row) : null;
  }

  /** @param {{limit?:number, offset?:number}} [opts] */
  profileList(opts = {}) {
    const limit = Math.min(200, opts.limit ?? 50);
    const offset = opts.offset ?? 0;
    return this._stmt.profileList.all(limit, offset).map(hydrateProfile);
  }

  /** @param {string} key @returns {boolean} */
  profileRemove(key) {
    return this._stmt.profileRemove.run(key).changes > 0;
  }

  /** @returns {{total:number}} */
  profileStats() {
    return { total: this._stmt.profileCount.get().n };
  }

  // ===== 用户当前状态（短期实时，TTL 过期） =====

  /**
   * 设置当前状态。同状态名已存在 → 更新（set_at 保留为首次设定时间）。
   * @param {object} input
   * @param {string} input.state 状态名（睡眠中/困了/饥饿/伤心…）
   * @param {string} [input.detail] 补充描述
   * @param {number} [input.confidence] 0..1
   * @param {string} [input.evidence] 触发证据（用户原话/语气线索）
   * @param {string} [input.source]
   * @param {number} [input.ttlSeconds] 有效期秒；0=不过期（默认构造器 defaultStateTtlSeconds）
   */
  stateSet(input) {
    const now = Date.now();
    const state = String(input.state ?? '').trim();
    if (!state) throw new Error('state.set: state 必填');
    const ttlSeconds = input.ttlSeconds ?? this.defaultStateTtlSeconds;
    const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : null;
    const existing = this._stmt.stateByState.get(state);
    if (existing) {
      this._stmt.stateUpdate.run(
        input.detail ?? existing.detail,
        clamp01(input.confidence ?? existing.confidence),
        input.evidence ?? existing.evidence,
        String(input.source ?? existing.source),
        expiresAt,
        now,
        state,
      );
    } else {
      this._stmt.stateInsert.run(randomUUID(), state, input.detail ?? null, clamp01(input.confidence ?? 0.5), input.evidence ?? null, String(input.source ?? 'ai-inference'), now, expiresAt, now);
    }
    return hydrateState(this._stmt.stateByState.get(state));
  }

  /** 当前有效状态（未过期）。 */
  stateGet() {
    return this._stmt.stateActive.all(Date.now()).map(hydrateState);
  }

  /** 单槽互斥（2026-09-03 记忆错乱修复）：把"除 state 外仍有效"的状态行标记为已过期
   *  （保留历史，仅退出当前有效集合）。@returns {number} 受影响行数 */
  stateExpireOthers(state) {
    const now = Date.now();
    return this._stmt.stateExpireOthers.run(now, now, state, now).changes;
  }

  /** @param {string} state @returns {boolean} */
  stateClear(state) {
    return this._stmt.stateRemove.run(state).changes > 0;
  }

  /** @param {number} [limit] 最近状态变更（含已过期，供 AI 参考上下文） */
  stateHistory(limit = 20) {
    return this._stmt.stateHistory.all(Math.min(100, limit)).map(hydrateState);
  }

  /** 清理过期状态（保留最近 24h 历史，更早删除）。@returns {number} 删除条数 */
  stateSweep() {
    const cutoff = Date.now() - 86400000;
    return this._stmt.stateSweep.run(cutoff).changes;
  }

  /** @returns {{total:number, active:number}} */
  stateStats() {
    return { total: this._stmt.stateCount.get().n, active: this.stateGet().length };
  }

  close() {
    this.db.close();
  }

  /** 强制 WAL checkpoint（TRUNCATE）：把 WAL 合并回主库并截断，断电/强杀时数据落盘更完整（2026-08-30）。 */
  checkpoint() {
    try {
      const row = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      return { ok: true, busy: row?.busy ?? 0, log: row?.log ?? 0, checkpointed: row?.checkpointed ?? 0 };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** SQLite quick_check：'ok' 表示结构完整（2026-08-30，启动自检用）。 */
  quickCheck() {
    const row = this.db.prepare('PRAGMA quick_check').get();
    const detail = row && Object.values(row)[0];
    return { ok: detail === 'ok', detail: String(detail ?? 'unknown') };
  }
}

/**
 * 把中文查询文本转成 FTS5 trigram MATCH 表达式。
 * trigram 分词器要求匹配串 ≥3 字符（含英文词）；<3 字的查询无法命中关键词侧，
 * 由语义侧（cosine）兜底。规则：
 *  - 按空白切出的 ≥3 字 token 用 OR 连接（任一命中即给关键词加分，BM25 排序区分相关度）；
 *  - 无 ≥3 字 token 时，若整句（去空白）≥3 字则作为单个短语；
 *  - 否则返回 null（关键词侧无命中）。
 */
export function ftsQueryExpr(text) {
  const cleaned = text.replace(/["']/g, ' ').trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length > 0) return tokens.map((t) => `"${t}"`).join(' OR ');
  const compact = cleaned.replace(/\s+/g, '');
  if (compact.length >= 3) return `"${compact}"`;
  return null;
}

/** 把 SQLite bm25() 的负分（越负越差）映射到 0..1（越大越好）。 */
export function bm25Norm(rank) {
  return 1 / (1 + Math.abs(rank));
}

function hydrate(row) {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    importance: row.importance,
    confidence: row.confidence,
    protected: row.protected === 1,
    strength: row.strength,
    forgotten: row.forgotten, // 0=active 1=soft 2=archived
    lastVerified: row.last_verified,
    refreshIntervalDays: row.refresh_interval_days,
    source: row.source,
    tags: safeJson(row.tags, []),
    meta: safeJson(row.meta, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessCount: row.access_count,
    lastAccessAt: row.last_access_at,
    hasEmbedding: row.embedding != null,
  };
}

/** 安全 JSON 解析：单条 tags/meta 损坏（断电/半写/旧数据）不拖垮整条读取链路（2026-08-30 审计修复）。 */
function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 初始记忆强度：0.5 + 0.5×importance（Ebbinghaus 基数）。 */
export function initialStrength(importance) {
  return clamp01(0.5 + 0.5 * clamp01(importance));
}

/** 强度系数：强度 0..1 → 0.5..1（衰减降低可召回性，受保护记忆恒 1）。 */
export function strengthFactor(strength) {
  return clamp01(0.5 + 0.5 * clamp01(strength));
}

/** 召回时效元信息：相对时间 + 待复核标记（结合当前时间）。 */
export function recallTimeMeta(row, now = Date.now()) {
  const ageMs = Math.max(0, now - row.created_at);
  const mins = Math.floor(ageMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let relativeTime = '刚刚';
  if (mins < 1) relativeTime = '刚刚';
  else if (mins < 60) relativeTime = `${mins} 分钟前`;
  else if (hours < 24) relativeTime = `${hours} 小时前`;
  else relativeTime = `${days} 天前`;
  const stale = row.refreshIntervalDays != null && row.last_verified != null
    && now - row.last_verified > row.refreshIntervalDays * 86400000;
  return { relativeTime, stale, createdAt: row.created_at, updatedAt: row.updated_at };
}

function hydrateProfile(row) {
  return {
    id: row.id,
    key: row.key,
    content: row.content,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateState(row) {
  return {
    id: row.id,
    state: row.state,
    detail: row.detail,
    confidence: row.confidence,
    evidence: row.evidence,
    source: row.source,
    setAt: row.set_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    active: row.expires_at == null || row.expires_at > Date.now(),
  };
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}
