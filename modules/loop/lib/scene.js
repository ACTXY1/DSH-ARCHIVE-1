/**
 * 自循环·纯函数层：场景简报组装、决策 JSON 解析、XML 转义。
 * 与插件驱动分离，便于单测。
 */

/** 组装场景简报（XML 块；各输入可为 null/空并自动跳过）。
 *  - memories / loopHistory / recentUserMessages / recentDialogue 支持字符串（旧格式）或 {text, at} 条目；
 *    对象条目自动带 at="MM-DD HH:MM" 真实时间，供模型以时间为准判断新旧。
 *  - userInstructions：思维预设注入内容（内层 XML，null/空串则跳过）。 */
export function buildSceneBrief({ time, userContext, persona, memories, loopHistory, userInput, recentUserMessages, recentDialogue, memorySummaryBlock, userInstructions }) {
  const blocks = [];
  if (time) blocks.push(`<time>${escapeXml(time)}</time>`);
  if (userInput) blocks.push(`<user-input>${escapeXml(userInput)}</user-input>`); // 对话前置思考携带用户最新输入
  // 近期用户消息（感知用户状态的直接证据；时间驱动循环无 <user-input> 时也能判断状态变化）
  // 每条消息带真实时间 at="MM-DD HH:MM"（取自记忆行 createdAt）——
  // 夜行作息下相邻两条用户消息可能相隔数小时/跨天（如 08:57 与 23:59 相隔 15h），
  // 无时间戳会让模型把旧消息误判为"刚发生"。
  if (recentUserMessages && recentUserMessages.length > 0) {
    blocks.push(`<recent-user-messages>\n${recentUserMessages.map(renderMsg).join('\n')}\n</recent-user-messages>`);
  }
  // 最近真实对话实录（用户 ↔ AI 在对话中的回复，role 标注 + at 时间）——主动循环
  // 需看到"AI 刚在对话里说了什么"（记忆只记用户侧），避免主动发言与对话答复撞车/互相推翻；
  // <recent-dialogue> 补齐该信息缺口。
  if (recentDialogue && recentDialogue.length > 0) {
    blocks.push(`<recent-dialogue>\n${recentDialogue.map(renderDialogueTurn).join('\n')}\n</recent-dialogue>`);
  }
  if (userContext) blocks.push(String(userContext)); // 已是 <user-context>…</user-context>
  if (persona) blocks.push(String(persona)); // 已是 <persona>…</persona>
  // 思维预设：用户指令（<user-instructions>，紧跟人格之后、记忆之前注入——
  // 决策协议首步点名其为最高优先级，见 DECISION_PROTOCOL 第 0 步）
  if (userInstructions) blocks.push(`<user-instructions>\n${String(userInstructions)}\n</user-instructions>`);
  // 双 Agent agent1 记忆概括（非空时替代原始 <memories> 注入，agent2 只读概括；
  // 概括内容按 <memory-summary source=…> 分类并带时间，作为数据区提供给决策者）
  if (memorySummaryBlock) blocks.push(`<memory-summary-block>\n${String(memorySummaryBlock)}\n</memory-summary-block>`);
  else if (memories && memories.length > 0) {
    blocks.push(`<memories>\n${memories.map(renderMemory).join('\n')}\n</memories>`);
  }
  if (loopHistory && loopHistory.length > 0) {
    blocks.push(`<loop-history>\n${loopHistory.map(renderDecision).join('\n')}\n</loop-history>`);
  }
  return blocks.join('\n');
}

/** 记忆条目：字符串（旧格式）或 {text, at} → <memory at=…>text</memory>。 */
function renderMemory(item) {
  if (typeof item === 'string') return `<memory>${escapeXml(item)}</memory>`;
  const at = Number(item?.at ?? 0) > 0 ? ` at="${escapeXml(fmtMsgTime(Number(item.at)))}"` : '';
  return `<memory${at}>${escapeXml(item?.text ?? '')}</memory>`;
}
/** 循环历史条目（<loop-history> 用）：字符串或 {text, at} → <decision at=…>text</decision>。 */
function renderDecision(item) {
  if (typeof item === 'string') return `<decision>${escapeXml(item)}</decision>`;
  const at = Number(item?.at ?? 0) > 0 ? ` at="${escapeXml(fmtMsgTime(Number(item.at)))}"` : '';
  return `<decision${at}>${escapeXml(item?.text ?? '')}</decision>`;
}
function renderMsg(item) {
  if (typeof item === 'string') return `<message>${escapeXml(item)}</message>`; // 兼容旧调用方
  const at = Number(item?.at ?? 0) > 0 ? ` at="${escapeXml(fmtMsgTime(Number(item.at)))}"` : '';
  return `<message${at}>${escapeXml(item?.text ?? '')}</message>`;
}
/** 对话实录单条：{at, role: 'user'|'ai', text} → <turn at=… role=…>text</turn>。 */
function renderDialogueTurn(item) {
  const at = Number(item?.at ?? 0) > 0 ? ` at="${escapeXml(fmtMsgTime(Number(item.at)))}"` : '';
  const role = item?.role === 'user' ? 'user' : 'ai';
  return `<turn${at} role="${role}">${escapeXml(item?.text ?? '')}</turn>`;
}

/** 消息时间戳渲染（本地时区 MM-DD HH:MM；与虚拟时钟一致，避免 UTC 混淆）。 */
function fmtMsgTime(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 解析决策 JSON（容忍 markdown 代码围栏与前后缀噪声）。
 * 结构：analysis / shouldSpeak / speakContent / shouldAct / actions[{name,reason}] /
 *       consequenceAssessment / notifyUser
 */
export function parseDecision(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('决策输出为空');
  const matched = text.match(/\{[\s\S]*\}/);
  if (!matched) throw new Error('决策输出未包含 JSON 对象');
  let obj;
  try {
    obj = JSON.parse(matched[0]);
  } catch (error) {
    throw new Error(`决策 JSON 解析失败：${error.message}`);
  }
  if (typeof obj !== 'object' || obj === null) throw new Error('决策 JSON 不是对象');
  return {
    analysis: String(obj.analysis ?? '').slice(0, 500),
    shouldSpeak: Boolean(obj.shouldSpeak),
    speakContent: String(obj.speakContent ?? '').slice(0, 1000),
    shouldAct: Boolean(obj.shouldAct),
    actions: Array.isArray(obj.actions)
      ? obj.actions.slice(0, 5).map((a) => ({
          name: String(a?.name ?? '').slice(0, 100),
          reason: String(a?.reason ?? '').slice(0, 300),
          // 内部动作参数（白名单执行用）；仅保留标量/字符串数组，防注入
          args: sanitizeArgs(a?.args),
        })).filter((a) => a.name !== '')
      : [],
    consequenceAssessment: String(obj.consequenceAssessment ?? '').slice(0, 1000),
    notifyUser: Boolean(obj.notifyUser),
  };
}

/** 决策协议提示词（省 token：简短、严格）。
 *  显式加入"感知用户状态变化"步骤——自推理/思考中也须对照当前状态与
 *  近期用户消息判断状态变化，变化时必须在 actions 中决策 user_state_set/user_state_clear
 *  （与对话面的 user-state-maintenance 指令对齐，补上认知循环侧的状态感知缺口）。
 *  状态推断护栏：过去/将来时陈述与纯静默均不得作为
 *  当前状态推断依据。
 *  时间线护栏：<recent-user-messages> 每条带真实 at 时间，判断新旧一律以 at 为准，
 *  不得假设相邻消息时间接近；<memories>/<loop-history> 中的 <loop-speak>/<loop-decision> 是 AI
 *  自身记录，不得当作用户发言。 */
export const DECISION_PROTOCOL = `你是自主运行智能体。基于场景简报（<time>/<user-input>/<user-context>/<recent-user-messages>/<recent-dialogue>/<persona>/<user-instructions>/<memories>/<loop-history>），按以下流程思考：
0. 最高优先级——遵守用户指令：若简报含 <user-instructions>（用户启用的「思维预设」，每条 instruction 的 name 与正文都是用户的明确要求），你的输出与行为（发言内容、语气风格、禁忌、行动取舍、是否打扰等）一律先满足这些要求；与默认流程或人设模板冲突时以指令为准；仅当指令要求违反安全/隐私/法律底线时才不执行（并可在分析中说明）。
1. 分析当前场景（结合用户输入、用户状态、记忆、人格、当前时间）。
2. 感知用户状态变化：对照 <user-context> 中当前已记录的用户状态，结合 <user-input>（若有）与 <recent-user-messages> 中的用户消息判断状态是否已变化（如 睡眠中/困了/忙碌/离开/在线/开心/伤心/焦虑/专注/饥饿/疲劳 等出现或消失）。
   时间线规则（重要）：<recent-user-messages> 每条带 at="MM-DD HH:MM" 真实时间——相邻两条可能相隔数小时甚至跨天（用户作息可 15h 无消息），判断"最近/刚发生"一律以 at 为准，不得假设相邻消息时间接近，更不得把数小时/数天前的消息当作刚发生的（如"你刚问我…/一分钟前…"）；<memories>/<loop-history> 中的 <loop-speak>/<loop-decision> 是 AI 自身的历史记录，不是用户发言。
   状态推断护栏：用户消息为过去/将来时（如"刚刚睡了会""我去睡了""准备睡"）≠ 当前睡眠中——仅当用户明确表示现在就去睡、对话结束且随后静默才置 睡眠中；禁止仅凭"用户静默 N 分钟/小时"推断 在线/已醒 或改变睡眠状态；evidence 必须引用用户消息原文并匹配 at 真实时间，禁止编造或错位说话时间。状态名用规范中文（英文自动归一）。
   对话延续规则（重要）：<recent-dialogue> 是最近真实对话实录，role="user" 为用户原话、role="ai" 为 AI（你自己）在对话中刚给出的回复——其中 at 是真实时间，判断"刚发生"一律以 at 为准。<recent-dialogue> 里**已经答复/已经推荐/已经处理的事项，本次主动发言必须延续该答复，不得推翻、不得重复推荐同一类替代方案**（例：对话里 AI 刚推荐了 A 并获用户认可，主动发言只能补充/确认 A，绝不能另推 B 或把记忆里更早的推荐当成"我刚才说的"）；只有用户明确否定了对话中的方案时才可改推其他。<memories>/<loop-history> 中的 <memory at=…>/<decision at=…> 同样以 at 判断新旧，不得把数小时/数天前的旧记忆表述为"刚才/刚刚"。
    若判断已变化：必须在 actions 中加入 user_state_set（新状态或改变，args: state/detail/evidence/ttlSeconds）或 user_state_clear（状态消失，args: state）——内部安全动作，可直接执行；状态更新对用户隐藏（notifyUser=false，发言中不得提及"已更新状态"）。状态未变或证据不足则不添加，避免无意义写入。
3. 决定是否主动发言及内容——主动发言等一切主动行为都由此决策。
4. 决定是否采取主动行动：**先评估后果**（可逆性/影响大小/对用户打扰），并**据此决定是否告知用户**——后果无关紧要的小事可以不告知（静默行动）；影响较大或用户应知情的事必须告知。
   notifyUser 语义（重要）：告知内容进通知栏（供用户事后查看，**不是**对话消息）；**user_state_set/user_state_clear/memory_write 是静默内部动作，一律 notifyUser=false**（系统会强制压制）——想让用户知道，就在 speakContent 里用自然语言说；notify_send = 主动推送一条给用户的消息（等效主动发言，仅当值得让用户现在看到时用，对话中请用正常回复）。
若存在 <user-input>，表示用户刚发来消息：决策应围绕该输入（用户要什么/是否需要内部动作配合/是否要主动发言回应）。
actions 支持两类：
  - 内部安全动作（可直接执行）：name ∈ user_state_set / user_state_clear / memory_write / notify_send / schedule_create / loop_configure，带 args 对象
  - 外部动作（经 agent 工具通道执行）：name 为其他任意工具名，仅记录待执行
严格输出 JSON（不要多余文字、不要代码围栏）：
{"analysis":"一句话分析","shouldSpeak":true,"speakContent":"发言内容","shouldAct":true,"actions":[{"name":"内部或外部动作名","args":{},"reason":"理由"}],"consequenceAssessment":"后果评估","notifyUser":true}`;

/** 由循环输出生成留档记忆正文（source='loop'）。 */
export function renderLoopLog({ time, reason, decision }) {
  const speak = decision.shouldSpeak ? `发言：${decision.speakContent}` : '不发言';
  const act = decision.shouldAct
    ? `行动：${decision.actions.map((a) => {
        const r = decision.actionResults?.find((x) => x.name === a.name);
        const status = r ? `[${r.status}]` : '';
        return `${a.name}${status}（${a.reason}）`;
      }).join('；')}`
    : '不行动';
  return `<loop-decision time="${escapeXml(time)}" trigger="${escapeXml(reason)}">\n` +
    `<analysis>${escapeXml(decision.analysis)}</analysis>\n` +
    `<speak>${escapeXml(speak)}</speak>\n` +
    `<act>${escapeXml(act)}</act>\n` +
    `<review>${escapeXml(decision.reviewed || '无')}</review>\n` + // 输出审查标记（revise/cancel/blocked）
    `<consequence>${escapeXml(decision.consequenceAssessment || '无')}</consequence>\n` +
    `<notify-user>${decision.notifyUser}</notify-user>\n</loop-decision>`;
}

/** XML 转义（含双引号转义——原因文本会拼进 trigger="..." 等 XML 属性）。 */
export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 动作参数清洗：仅保留标量、字符串、数字数组（深度 1，限长），防注入。 */
function sanitizeArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (Object.keys(out).length >= 16) break;
    if (typeof value === 'string' && value.length <= 2000) out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.length <= 20 && value.every((v) => typeof v === 'string' && v.length <= 200)) out[key] = value;
  }
  return out;
}
