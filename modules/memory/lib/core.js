/**
 * 记忆系统核心门面：把 ollama 向量化 + SQLite 存储组合为一个可注入的
 * MemoryCore 实例。Cordis 插件（lib/index.js）与自检脚本共用本模块，
 * 保证插件运行路径与测试路径完全一致。
 */
import { OllamaEmbedder } from './embedder.js';
import { MemoryStore } from './store.js';

export class MemoryCore {
  /**
   * @param {object} options
   * @param {string} options.dbPath
   * @param {string} [options.ollamaBaseUrl]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   */
  constructor(options) {
    this.dbPath = options.dbPath;
    this.embedder = new OllamaEmbedder({
      baseUrl: options.ollamaBaseUrl,
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
    this.store = new MemoryStore(options.dbPath, {
      defaultStateTtlSeconds: options.defaultStateTtlSeconds,
      tauBaseDays: options.tauBaseDays,
      reinforce: options.reinforce,
      softThreshold: options.softThreshold,
      archiveGraceDays: options.archiveGraceDays,
      protectImportance: options.protectImportance,
      defaultRecencyBias: options.defaultRecencyBias,
    });
    this._lastDims = null;
    this._stateMaxProfileEntries = options.stateMaxProfileEntries ?? 8;
  }

  /** 写入一条记忆（自动向量化）。 */
  async write(input) {
    if (typeof input?.content !== 'string' || input.content.trim() === '') {
      throw new Error('memory.write: content 必填且不能为空字符串');
    }
    const embedding = await this.embedder.embed(input.content.trim());
    this._lastDims = embedding.length;
    const record = this.store.write({ ...input, content: input.content.trim(), embedding });
    return { id: record.id, createdAt: record.createdAt };
  }

  /** 语义召回。 */
  async recall(query) {
    if (typeof query?.query !== 'string' || query.query.trim() === '') {
      throw new Error('memory.recall: query 必填且不能为空字符串');
    }
    const q = query.query.trim();
    //  keyword 模式不生成 embedding——ollama 挂起时 keyword 检索本应作为
    // 不依赖向量服务的兜底，此前无条件 embed 会 60s 挂起且每次 keyword 召回都浪费一次 embedding
    const mode = query.mode ?? 'hybrid';
    const embedding = mode === 'keyword' ? undefined : await this.embedder.embed(q);
    if (embedding !== undefined) this._lastDims = embedding.length;
    const results = this.store.recall({
      ...(embedding !== undefined ? { embedding } : {}),
      query: q,
      k: query.k,
      kinds: query.kinds,
      minScore: query.minScore,
      recencyBias: query.recencyBias,
      mode,
      includeForgotten: query.includeForgotten,
    });
    return { query: q, results };
  }

  forget(id) {
    if (typeof id !== 'string' || id === '') throw new Error('memory.forget: id 必填');
    return { removed: this.store.remove(id) };
  }

  get(id) {
    return this.store.get(id);
  }

  /** 更新记忆（重要度/保护/内容/标签等）。
   *  content 变化时重新向量化并同步 embedding 列（此前语义检索继续用旧向量）。 */
  async update(id, patch) {
    if (typeof id !== 'string' || id === '') throw new Error('memory.update: id 必填');
    const p = patch ?? {};
    if (typeof p.content === 'string' && p.content.trim() !== '') {
      const cur = this.store.get(id);
      if (cur && p.content !== cur.content) {
        const embedding = await this.embedder.embed(p.content.trim());
        this._lastDims = embedding.length;
        return { updated: this.store.update(id, { ...p, content: p.content.trim(), embedding }) };
      }
    }
    return { updated: this.store.update(id, p) };
  }

  /** 遗忘作业：重算强度/分级/归档/复核队列。 */
  forgetRun() {
    return this.store.forgetRun();
  }

  /** 显式恢复被遗忘记忆。 */
  restore(id) {
    return { restored: this.store.restore(id) };
  }

  /** 软遗忘/归档记忆列表（管理用）。 */
  forgottenList(limit) {
    return this.store.forgottenList(limit);
  }

  forgetStats() {
    return this.store.forgetStats();
  }

  list(opts = {}) {
    return this.store.list(opts);
  }

  /** 按 kind+source+时间查询（整合作业用）。 */
  listBySourceSince(opts) {
    return this.store.listBySourceSince(opts);
  }

  /** 批量软遗忘（整合后原条目标记）。 */
  softForgetMany(ids) {
    return this.store.softForgetMany(ids);
  }

  /** 从备份库合并导入。 */
  importFrom(backupDbPath) {
    return this.store.importFrom(backupDbPath);
  }

  stats() {
    return this.store.stats();
  }

  // ===== 用户画像（长期） =====

  profileSet(input) {
    return this.store.profileSet(input);
  }

  profileGet(key) {
    return this.store.profileGet(key);
  }

  profileList(opts = {}) {
    return this.store.profileList(opts);
  }

  profileRemove(key) {
    return { removed: this.store.profileRemove(key) };
  }

  profileStats() {
    return this.store.profileStats();
  }

  // ===== 用户当前状态（短期实时） =====

  /**
   * 设置用户当前状态（ 记忆错乱修复）：
   * 1) 状态名归一：sleeping/asleep/sleep 等英文与口语化名称自动归一为规范中文
   *    （'睡眠中'），awake/active/online 等归一为 '在线'——杜绝 loop 只认 '睡眠中'
   *    而库中却存 'sleeping' 导致的"睡眠闸门失效/自相矛盾"；
   * 2) 单槽互斥：写入新状态前把其他仍有效状态标记过期（保留历史行），
   *    同一时刻只保留一个当前状态（曾出现 sleeping 与 active 同时有效互相矛盾）。
   * 存储层（store）保持逐行原义（备份导入等历史语义不受影响）。
   */
  stateSet(input) {
    const state = canonicalState(input.state);
    if (!state) throw new Error('state.set: state 必填');
    const othersExpired = this.store.stateExpireOthers(state);
    const record = this.store.stateSet({ ...input, state });
    return { ...record, othersExpired };
  }

  stateGet() {
    return this.store.stateGet();
  }

  /** 清除状态：按规范名清除（clear('sleeping') 会清掉 '睡眠中' 行），
   *  传入非规范名时同时清除同义行，防旧数据残留。 */
  stateClear(state) {
    const canonical = canonicalState(state);
    let removed = this.store.stateClear(canonical);
    if (canonical !== String(state ?? '').trim() && canonical !== '') {
      const rawRemoved = this.store.stateClear(state);
      removed = removed || rawRemoved;
    }
    return { removed };
  }

  stateHistory(limit) {
    return this.store.stateHistory(limit);
  }

  stateSweep() {
    return { swept: this.store.stateSweep() };
  }

  stateStats() {
    return this.store.stateStats();
  }

  /**
   * 生成"当前用户状态 + 画像要点"快照文本（作为提供给 AI 的变量，
   * 每回合经 systemPrompt 动态 context 注入）。无有效状态且无画像时返回 null。
   * 采用 XML 标签包裹（与人格注入风格一致）：明确块边界、便于模型遵守与程序解析。
   */
  snapshot() {
    const states = this.store.stateGet();
    const profile = this.store.profileList({ limit: this._stateMaxProfileEntries });
    if (states.length === 0 && profile.length === 0) return null;
    const lines = [];
    for (const s of states) {
      const parts = [];
      if (s.detail) parts.push(escapeXml(s.detail));
      if (s.evidence) parts.push(`证据：${escapeXml(s.evidence)}`);
      const until = s.expiresAt ? ` until="${new Date(s.expiresAt).toLocaleString('zh-CN', { hour12: false })}"` : '';
      //：注入名用归一化规范名（历史遗留 sleeping/active 行也按规范呈现）
      lines.push(`<user-state name="${escapeXml(canonicalState(s.state))}" confidence="${s.confidence.toFixed(2)}"${until}>${parts.join('；')}</user-state>`);
    }
    for (const p of profile) {
      lines.push(`<user-profile key="${escapeXml(p.key)}">${escapeXml(p.content)}</user-profile>`);
    }
    return `<user-context>\n${lines.join('\n')}\n</user-context>`;
  }

  /** @returns {{states: object[], profile: object[], rendered: string|null}} */
  snapshotData() {
    const states = this.store.stateGet();
    const profile = this.store.profileList({ limit: this._stateMaxProfileEntries });
    return { states, profile, rendered: this.snapshot() };
  }

  /** 健康检查：存储与 embedding 服务可达性。 */
  async health() {
    let embedOk = false;
    let embedDetail = '';
    try {
      const vec = await this.embedder.embed('连通性测试');
      embedOk = vec.length > 0;
      this._lastDims = vec.length;
    } catch (error) {
      embedDetail = error.message;
    }
    const stats = this.store.stats();
    return {
      ok: embedOk,
      dbPath: this.dbPath,
      model: this.embedder.model,
      dims: this._lastDims,
      total: stats.total,
      byKind: stats.byKind,
      embedError: embedDetail || null,
    };
  }

  close() {
    this.store.close();
  }

  /** 强制 WAL checkpoint（供定时与备份前调用）。 */
  checkpoint() {
    return this.store.checkpoint();
  }

  /** 启动完整性检查（quick_check；损坏时给出明确信号）。 */
  checkIntegrity() {
    try {
      const row = this.store.quickCheck();
      return { ok: row?.ok === true, detail: row?.detail ?? 'unknown' };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }
}

/** XML 转义（防止内容破坏注入块结构； 补双引号转义——状态名/详情会拼进 name="…" 属性）。 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 用户状态名归一（ 记忆错乱修复）：英文/口语化状态名 → 规范中文。
 * 根源：user_state_set 由 LLM 自由命名，曾写入 sleeping/active 等英文名，
 * 而 loop 睡眠闸门只精确匹配 '睡眠中' → 睡眠期间照常发主动消息、状态自相矛盾。
 * 注意：core 与 loop 各持一份同义映射（loop 不能反向依赖 memory 包），改动须同步。
 * @param {unknown} raw
 * @returns {string} 归一后的状态名；空输入返回 ''
 */
export function canonicalState(raw) {
  const t = String(raw ?? '').trim();
  if (t === '') return '';
  const map = {
    sleeping: '睡眠中', asleep: '睡眠中', sleep: '睡眠中', '睡着了': '睡眠中',
    '睡觉中': '睡眠中', '已入睡': '睡眠中', 睡眠: '睡眠中',
    awake: '在线', active: '在线', online: '在线', '醒着': '在线', 清醒: '在线',
    '已醒': '在线', 醒来: '在线', '在线': '在线',
  };
  return map[t.toLowerCase()] ?? t;
}
