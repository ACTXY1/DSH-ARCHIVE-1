/**
 * 自循环·防护层（纯函数，可单测）：行动预算、发言限频、日计数重置。
 */
export class LoopGuards {
  /**
   * @param {object} opts
   * @param {number} opts.maxActionsPerCycle
   * @param {number} opts.maxActionsPerDay
   * @param {number} opts.minSpeakIntervalMs
   */
  constructor(opts) {
    this.maxPerCycle = opts.maxActionsPerCycle;
    this.maxPerDay = opts.maxActionsPerDay;
    this.minSpeakMs = opts.minSpeakIntervalMs;
    this.dayKey = todayKey(Date.now());
    this.dayActions = 0;
    this.lastSpeakAt = 0;
  }

  /** 发言限频：距上次主动发言达到最小间隔才允许。通过则记录。 */
  checkSpeak(now = Date.now()) {
    const neverSpoke = this.lastSpeakAt === 0;
    const ok = neverSpoke || now - this.lastSpeakAt >= this.minSpeakMs;
    if (ok) this.lastSpeakAt = now > 0 ? now : Date.now(); // 防 0 时间戳污染"从未发言"判定
    return ok;
  }

  /**
   * 行动预算：单循环不超过 maxPerCycle；按自然日累计不超过 maxPerDay。
   * @param {number} count 本循环行动数
   */
  checkActions(count, now = Date.now()) {
    if (count <= 0) return true;
    if (count > this.maxPerCycle) return false;
    const key = todayKey(now);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayActions = 0;
    }
    if (this.dayActions + count > this.maxPerDay) return false;
    this.dayActions += count;
    return true;
  }

  stats() {
    return {
      dayKey: this.dayKey,
      dayActions: this.dayActions,
      lastSpeakAt: this.lastSpeakAt,
    };
  }
}

/** 本地日期键 YYYY-MM-DD（与虚拟时钟同语义）。 */
export function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
