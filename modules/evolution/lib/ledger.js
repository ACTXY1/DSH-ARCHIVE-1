/**
 * 进化账本（4b）：追加式 jsonl，记录候选生成/评估/采纳/拒绝/回滚全过程。
 * 每次记录含完整候选与前后对比——满足"每次进化留档"；回滚接口据此恢复。
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const EVOLUTION_STATUS = ['pending', 'applied', 'rejected', 'rolled-back', 'failed'];

export class EvolutionLedger {
  /** @param {string} path 账本文件路径 */
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  /**
   * 记录一条进化事件。
   * @param {object} event {type:'suggest'|'evaluate'|'approve'|'reject'|'rollback'|'fail', candidate, evaluation?, status?, before?, after?, by?}
   * @returns {{id:string, at:number}}
   */
  record(event) {
    const id = randomUUID();
    appendFileSync(this.path, JSON.stringify({
      id,
      at: Date.now(),
      ...event,
    }) + '\n', 'utf8');
    return { id, at: Date.now() };
  }

  /** 全部记录（新→旧）。 */
  all(limit = 200) {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit)
      .reverse();
  }

  /** 按候选 id 取相关记录（suggest 起；后续事件以 candidateId 关联）。
   * 此前先 all(limit) 截窗再 filter → 账本超窗后旧候选
   * 记录落在窗口外，approve/reject/rollback 报"候选不存在"；改为全量解析后先按 id
   * 过滤再截取最新 limit 条。 */
  candidate(id, limit = 100) {
    if (!existsSync(this.path)) return [];
    return this.all().filter((r) => r.candidate?.id === id || r.candidateId === id || r.id === id).slice(0, limit);
  }

  /** 候选当前状态（按 suggest 记录 + 后续状态变更折叠）。 */
  statusOf(candidateId) {
    const records = this.candidate(candidateId, 100).filter((r) => r.type !== 'suggest');
    const status = records[0]?.status;
    return status ?? 'pending';
  }
}
