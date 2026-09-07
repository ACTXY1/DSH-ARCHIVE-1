// 自循环纯函数层单测：场景简报、决策解析、循环日志、防护
import { buildSceneBrief, parseDecision, DECISION_PROTOCOL, renderLoopLog } from '../lib/scene.js';
import { LoopGuards, todayKey } from '../lib/guards.js';

const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

console.log('== buildSceneBrief ==');
const brief = buildSceneBrief({
  time: '2026-08-28 10:00:00',
  userContext: '<user-context>\n<user-state name="睡眠中">…</user-state>\n</user-context>',
  persona: '<persona version="1">…</persona>',
  memories: ['记忆A', '记忆B'],
  loopHistory: ['分析1'],
  recentUserMessages: [{ text: '我去睡觉了', at: new Date('2026-09-02T08:57:00+08:00').getTime() }, '用户说：晚安（旧格式字符串兼容）'],
});
check('含 time 块', brief.includes('<time>2026-08-28 10:00:00</time>'));
check('透传 user-context', brief.includes('<user-context>'));
check('透传 persona', brief.includes('<persona'));
check('含 memories 块', brief.includes('<memories>') && brief.includes('<memory>记忆A</memory>'));
check('含 loop-history 块', brief.includes('<loop-history>'));
check('含 recent-user-messages 块', brief.includes('<recent-user-messages>'));
check('消息块带真实时间 at=MM-DD HH:MM', brief.includes('<message at="09-02 08:57">我去睡觉了</message>'), brief);
check('旧格式字符串消息兼容', brief.includes('<message>用户说：晚安（旧格式字符串兼容）</message>'));
check('空输入返回空串', buildSceneBrief({}) === '');

console.log('== parseDecision ==');
const d1 = parseDecision('{"analysis":"a","shouldSpeak":true,"speakContent":"你好","shouldAct":false,"actions":[],"consequenceAssessment":"无","notifyUser":false}');
check('解析基本字段', d1.analysis === 'a' && d1.shouldSpeak === true && d1.speakContent === '你好');
const d2 = parseDecision('```json\n{"analysis":"a","shouldAct":true,"actions":[{"name":"x","reason":"r"}],"consequenceAssessment":"c","notifyUser":true}\n```');
check('容忍代码围栏', d2.shouldAct === true && d2.actions[0].name === 'x' && d2.notifyUser === true);
const d3 = parseDecision('前缀 {"analysis":"x"} 后缀');
check('容忍前后缀', d3.analysis === 'x');
check('缺省字段布尔化', d3.shouldSpeak === false && d3.shouldAct === false);
let threw = false;
try { parseDecision('没有 JSON'); } catch { threw = true; }
check('无 JSON 抛错', threw);
try { parseDecision('{"bad json'); } catch { threw = true; }
check('坏 JSON 抛错', threw);

console.log('== renderLoopLog ==');
const log = renderLoopLog({ time: 't', reason: 'fallback', decision: { analysis: '分析', shouldSpeak: true, speakContent: '说 <话>', shouldAct: false, actions: [], consequenceAssessment: '无', notifyUser: false } });
check('循环日志为 XML 块', log.includes('<loop-decision') && log.includes('<analysis>分析</analysis>'));
check('循环日志转义', log.includes('&lt;话&gt;') && !log.includes('<话>'));
check('决策协议含主动能力唯一决策点', DECISION_PROTOCOL.includes('一切主动行为都由此决策'));
check('决策协议含用户状态感知步骤', DECISION_PROTOCOL.includes('感知用户状态变化') && DECISION_PROTOCOL.includes('user_state_set') && DECISION_PROTOCOL.includes('user_state_clear'));

console.log('== LoopGuards ==');
const g = new LoopGuards({ maxActionsPerCycle: 1, maxActionsPerDay: 3, minSpeakIntervalMs: 1000 });
check('发言限频：首发言允许', g.checkSpeak(1_000_000) === true);
check('发言限频：短间隔拒绝', g.checkSpeak(1_000_500) === false);
check('发言限频：间隔后允许', g.checkSpeak(1_001_001) === true);
check('行动预算：单循环超限拒绝', g.checkActions(2, 2000) === false);
check('行动预算：单循环限额内允许', g.checkActions(1, 2001) === true);
check('行动预算：日累计超限拒绝', g.checkActions(3, 2002) === false);
check('行动预算：0 个行动恒允许', g.checkActions(0, 2003) === true);
check('todayKey 格式', /^\d{4}-\d{2}-\d{2}$/.test(todayKey(0)));

console.log(failures.length === 0 ? '\nLOOP TEST: ALL PASS' : `\nLOOP TEST: ${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
