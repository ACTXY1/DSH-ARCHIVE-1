/**
 * 进化评估层（4b）：隔离评估 + 安全门（纯函数可测）。
 * - 规则检查：敏感/危险关键词黑名单（安全门第一道，不依赖 LLM）。
 * - LLM 评估：一致性/冲突/总体建议（隔离评估——评估不产生任何生效变更）。
 */

/** 安全门：命中黑名单即拒绝（不区分大小写）。 */
const BLOCKED_PATTERNS = [
  /炸弹|武器|病毒|恶意|黑客攻击|盗窃|诈骗|非法|自残|自杀|暴力伤害/i,
  /bypass.*security|disable.*safety|ignore.*previous.*instruction/i,
];

export function safetyRules(candidate) {
  const text = JSON.stringify(candidate ?? {}).toLowerCase();
  const hits = BLOCKED_PATTERNS.filter((p) => p.test(text));
  return { safe: hits.length === 0, blocked: hits.map((p) => p.source) };
}

/** 评估提示词（省 token：一次调用完成一致性+安全+建议）。 */
export const EVALUATION_PROTOCOL = `你是进化安全审查员。评估候选改进（persona=人格新增/修正（persona-add/persona-refine，section 为项目人格分区）/ skill=技能草案）：
1) 与现有价值观/行为准则是否冲突（冲突度 0-1）
2) 是否安全、无敏感/危险内容（安全 0-1）
3) 是否值得采纳（recommendation: approve|reject）
严格输出 JSON：{"conflictScore":0.0,"safe":true,"recommendation":"approve","reason":"简短理由"}`;

/** 解析评估 JSON（容忍噪声）。 */
export function parseEvaluation(text) {
  const matched = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!matched) throw new Error('评估输出未包含 JSON');
  const obj = JSON.parse(matched[0]);
  return {
    conflictScore: clamp01(Number(obj.conflictScore) || 0),
    safe: obj.safe !== false,
    recommendation: obj.recommendation === 'approve' ? 'approve' : 'reject',
    reason: String(obj.reason ?? '').slice(0, 500),
  };
}

/**
 * 汇总门控：规则 + LLM 评估 + 阈值。
 * @returns {{passed:boolean, decision:'approve'|'reject', reasons:string[]}}
 */
export function evaluateCandidate(candidate, llmEvaluation, thresholds = { maxConflict: 0.5 }) {
  const reasons = [];
  const rules = safetyRules(candidate);
  if (!rules.safe) reasons.push(`安全规则拦截：${rules.blocked.join(',')}`);
  if (llmEvaluation) {
    if (!llmEvaluation.safe) reasons.push('LLM 评估：存在安全风险');
    if (llmEvaluation.conflictScore > thresholds.maxConflict) reasons.push(`LLM 评估：与人格冲突（${llmEvaluation.conflictScore.toFixed(2)}）`);
    if (llmEvaluation.recommendation === 'reject') reasons.push(`LLM 评估建议拒绝：${llmEvaluation.reason}`);
  }
  const passed = reasons.length === 0;
  return { passed, decision: passed ? 'approve' : 'reject', reasons };
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}
