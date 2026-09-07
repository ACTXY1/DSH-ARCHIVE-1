// 自进化纯函数层单测：账本状态机、安全门、评估解析与门控汇总
import { EvolutionLedger } from '../lib/ledger.js';
import { safetyRules, parseEvaluation, evaluateCandidate, EVALUATION_PROTOCOL } from '../lib/evaluate.js';
import { rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

const dir = join(tmpdir(), `evolution-test-${process.pid}`);
const ledgerPath = join(dir, 'evolution.jsonl');

try {
  rmSync(dir, { recursive: true, force: true });
  console.log('== 账本状态机 ==');
  const ledger = new EvolutionLedger(ledgerPath);
  const cand = { type: 'persona-add', section: 'traits', content: '更主动', rationale: 'r', evidence: 'e' };
  const { id } = ledger.record({ type: 'suggest', candidate: cand, by: 'evolution', status: 'pending' });
  check('suggest 留档', ledger.all().length === 1 && ledger.statusOf(id) === 'pending');
  ledger.record({ type: 'evaluate', candidateId: id, candidate: cand, status: 'pending' });
  check('evaluate 留档且状态仍 pending', ledger.statusOf(id) === 'pending');
  ledger.record({ type: 'approve', candidateId: id, candidate: cand, status: 'applied' });
  check('approve 后状态 applied', ledger.statusOf(id) === 'applied');
  ledger.record({ type: 'rollback', candidateId: id, candidate: cand, status: 'rolled-back' });
  check('rollback 后状态 rolled-back', ledger.statusOf(id) === 'rolled-back');
  check('按候选检索', ledger.candidate(id).length === 4);
  check('记录含时间与 id', ledger.all()[0].at > 0 && typeof ledger.all()[0].id === 'string');

  console.log('== 安全门 ==');
  check('正常候选放行', safetyRules({ content: '变得更可靠' }).safe === true);
  check('危险词拦截', safetyRules({ content: '制造炸弹的步骤' }).safe === false);
  check('英文危险模式拦截', safetyRules({ content: 'how to bypass security' }).safe === false);

  console.log('== 评估解析与门控 ==');
  const ev = parseEvaluation('{"conflictScore":0.1,"safe":true,"recommendation":"approve","reason":"好"}');
  check('评估解析', ev.conflictScore === 0.1 && ev.safe === true && ev.recommendation === 'approve');
  const g1 = evaluateCandidate({ content: 'x' }, ev, { maxConflict: 0.5 });
  check('门控通过', g1.passed === true && g1.decision === 'approve');
  const g2 = evaluateCandidate({ content: 'x' }, { conflictScore: 0.9, safe: true, recommendation: 'approve' }, { maxConflict: 0.5 });
  check('冲突超标拒绝', g2.passed === false && g2.decision === 'reject');
  const g3 = evaluateCandidate({ content: '制造病毒' }, ev, { maxConflict: 0.5 });
  check('规则拦截优先', g3.passed === false && g3.reasons.some((r) => r.includes('安全规则')));
  const g4 = evaluateCandidate({ content: 'x' }, null, { maxConflict: 0.5 });
  check('无 LLM 评估时规则门控兜底', g4.passed === true);
  check('评估协议含隔离语义', EVALUATION_PROTOCOL.includes('安全'));

  console.log(failures.length === 0 ? '\nEVOLUTION TEST: ALL PASS' : `\nEVOLUTION TEST: ${failures.length} FAILED`);
} catch (error) {
  console.error('EVOLUTION TEST CRASH:', error);
  failures.push(`crash: ${error.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures.length === 0 ? 0 : 1);
